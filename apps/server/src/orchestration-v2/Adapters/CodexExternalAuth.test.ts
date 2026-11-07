import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { assert, describe, it } from "@effect/vitest";

import {
  codexExternalCredentialUnavailable,
  installCodexExternalAuth,
  makeCodexExternalCredentialAcquirer,
  type CodexExternalCredentialResult,
} from "./CodexExternalAuth.ts";

const credential = (accountId: string, accessToken = `token-${accountId}`) => ({
  accountId,
  accessToken,
  expiresAt: Number.MAX_SAFE_INTEGER,
});

const makeFakeClient = () => {
  const events: Array<
    | { readonly type: "notify"; readonly method: string }
    | { readonly type: "request"; readonly method: string; readonly payload: unknown }
  > = [];
  let refresh:
    | ((params: {
        readonly previousAccountId?: string | null;
        readonly reason: "unauthorized";
      }) => Effect.Effect<
        { readonly accessToken: string; readonly chatgptAccountId: string },
        CodexErrors.CodexAppServerError
      >)
    | undefined;
  const client = {
    notify: (method: string) =>
      Effect.sync(() => {
        events.push({ type: "notify", method });
      }),
    request: (method: string, payload: unknown) =>
      Effect.sync(() => {
        events.push({ type: "request", method, payload });
        return method === "account/login/start" ? { type: "chatgptAuthTokens" } : {};
      }),
    handleServerRequest: (method: string, handler: typeof refresh) =>
      Effect.sync(() => {
        if (method === "account/chatgptAuthTokens/refresh") refresh = handler;
      }),
  } as unknown as CodexClient.CodexAppServerClient["Service"];
  return {
    client,
    events,
    refresh: () => {
      assert.isDefined(refresh);
      return refresh!;
    },
  };
};

const makeSpawner = (input: { readonly stdout: string; readonly code?: number }) => {
  const commands: string[] = [];
  const spawner = ChildProcessSpawner.make(() => {
    commands.push("credential");
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.code ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(input.stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { spawner, commands };
};

describe("CodexExternalAuth", () => {
  it.effect("logs in with the external credential after the native initialized notification", () =>
    Effect.gen(function* () {
      const fake = makeFakeClient();
      const accessToken = "secret-access-token";
      const client = yield* installCodexExternalAuth({
        client: fake.client,
        acquire: () => Effect.succeed({ ...credential("account-1"), accessToken }),
      });

      yield* client.notify("initialized", undefined);

      assert.deepEqual(fake.events, [
        { type: "notify", method: "initialized" },
        {
          type: "request",
          method: "account/login/start",
          payload: {
            type: "chatgptAuthTokens",
            accessToken,
            chatgptAccountId: "account-1",
          },
        },
      ]);
    }),
  );

  it.effect("leaves native login unchanged when the initial credential is null", () =>
    Effect.gen(function* () {
      const fake = makeFakeClient();
      const client = yield* installCodexExternalAuth({
        client: fake.client,
        acquire: () => Effect.succeed(null),
      });

      yield* client.notify("initialized", undefined);
      yield* client.notify("initialized", undefined);

      assert.deepEqual(fake.events, [
        { type: "notify", method: "initialized" },
        { type: "notify", method: "initialized" },
      ]);
    }),
  );

  it.effect("reruns the credential callback on refresh and keeps the account stable", () =>
    Effect.gen(function* () {
      const fake = makeFakeClient();
      const hints: Array<string | undefined> = [];
      const credentials: CodexExternalCredentialResult[] = [
        credential("account-1", "initial-token"),
        credential("account-1", "refreshed-token"),
      ];
      const client = yield* installCodexExternalAuth({
        client: fake.client,
        acquire: (previousAccountId) =>
          Effect.sync(() => {
            hints.push(previousAccountId);
            return credentials.shift()!;
          }),
      });

      yield* client.notify("initialized", undefined);
      const response = yield* fake.refresh()({
        reason: "unauthorized",
        previousAccountId: "account-1",
      });

      assert.deepEqual(hints, [undefined, "account-1"]);
      assert.deepEqual(response, {
        accessToken: "refreshed-token",
        chatgptAccountId: "account-1",
      });
    }),
  );

  it.effect("fails closed when a refresh loses the binding or changes account", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<CodexExternalCredentialResult> = [
        null,
        credential("account-2", "other-account-token"),
      ];
      for (const next of cases) {
        const fake = makeFakeClient();
        let calls = 0;
        const client = yield* installCodexExternalAuth({
          client: fake.client,
          acquire: () =>
            Effect.succeed(calls++ === 0 ? credential("account-1", "initial-token") : next),
        });
        yield* client.notify("initialized", undefined);

        const error = yield* fake
          .refresh()({ reason: "unauthorized", previousAccountId: "account-1" })
          .pipe(Effect.flip);

        assert.include(error.message, "External OpenAI credential is unavailable.");
        assert.notInclude(JSON.stringify(error), "other-account-token");
        assert.notInclude(JSON.stringify(error), "accessToken");
      }
    }),
  );

  it.effect("fails closed when refresh reports a different previous account", () =>
    Effect.gen(function* () {
      const fake = makeFakeClient();
      let calls = 0;
      const client = yield* installCodexExternalAuth({
        client: fake.client,
        acquire: () =>
          Effect.sync(() => {
            calls += 1;
            return credential("account-1");
          }),
      });
      yield* client.notify("initialized", undefined);

      const error = yield* fake
        .refresh()({ reason: "unauthorized", previousAccountId: "account-2" })
        .pipe(Effect.flip);

      assert.include(error.message, "External OpenAI credential is unavailable.");
      assert.equal(calls, 1);
    }),
  );

  it.effect("sanitizes a native login rejection without falling back", () =>
    Effect.gen(function* () {
      const fake = makeFakeClient();
      const rejectedToken = "rejected-secret-token";
      const client = yield* installCodexExternalAuth({
        client: {
          ...fake.client,
          request: () =>
            Effect.fail(
              CodexErrors.CodexAppServerRequestError.internalError(
                `Codex rejected ${rejectedToken}`,
              ),
            ),
        } as CodexClient.CodexAppServerClient["Service"],
        acquire: () => Effect.succeed(credential("account-1", rejectedToken)),
      });

      const error = yield* client.notify("initialized", undefined).pipe(Effect.flip);

      assert.include(error.message, "External OpenAI credential is unavailable.");
      assert.notInclude(error.message, rejectedToken);
      assert.notInclude(JSON.stringify(error), rejectedToken);
    }),
  );

  it.effect("fails closed when refreshing before any external login", () =>
    Effect.gen(function* () {
      const fake = makeFakeClient();
      yield* installCodexExternalAuth({
        client: fake.client,
        acquire: () => Effect.succeed(credential("account-1")),
      });

      const error = yield* fake.refresh()({ reason: "unauthorized" }).pipe(Effect.flip);

      assert.include(error.message, "External OpenAI credential is unavailable.");
    }),
  );

  it.effect("turns malformed or non-zero credential output into a sanitized error", () =>
    Effect.gen(function* () {
      const secret = "super-secret-value";
      for (const output of [
        { stdout: `{"accessToken":"${secret}"`, code: 0 },
        { stdout: JSON.stringify({ accessToken: secret, accountId: "account-1" }), code: 0 },
        { stdout: JSON.stringify({ ...credential("account-1"), refreshToken: secret }), code: 0 },
        {
          stdout: JSON.stringify({ ...credential("account-1"), accessToken: "token\nvalue" }),
          code: 0,
        },
        {
          stdout: JSON.stringify({ ...credential("account-1"), accountId: "account\nvalue" }),
          code: 0,
        },
        { stdout: secret, code: 7 },
      ] as const) {
        const { spawner, commands } = makeSpawner(output);
        const acquire = yield* makeCodexExternalCredentialAcquirer({
          command: "/nix/store/provenance-credential",
          spawner,
        });
        const error = yield* acquire().pipe(Effect.flip);

        assert.deepEqual(commands, ["credential"]);
        assert.include(error.message, "External OpenAI credential is unavailable.");
        assert.notInclude(JSON.stringify(error), secret);
      }
    }),
  );

  it.effect("rejects an expired credential and keeps a live one", () =>
    Effect.gen(function* () {
      const now = 1_800_000_000_000;
      for (const expiresAt of [
        (now + 120_000) / 1_000,
        String(now + 120_000),
        "2099-01-01T00:00:00.000Z",
      ]) {
        const fixture = makeSpawner({
          stdout: JSON.stringify({ accessToken: "token", accountId: "account-1", expiresAt }),
        });
        const acquire = yield* makeCodexExternalCredentialAcquirer({
          command: "/fixture/helper",
          spawner: fixture.spawner,
          now: Effect.succeed(now),
        });
        yield* acquire().pipe(Effect.flip);
      }
      const expired = makeSpawner({
        stdout: JSON.stringify({
          accessToken: "expired-token",
          accountId: "account-1",
          expiresAt: now + 30_000,
        }),
      });
      const acquireExpired = yield* makeCodexExternalCredentialAcquirer({
        command: "/nix/store/provenance-credential",
        spawner: expired.spawner,
        now: Effect.succeed(now),
      });
      const error = yield* acquireExpired().pipe(Effect.flip);
      assert.include(error.message, "External OpenAI credential is unavailable.");

      const live = makeSpawner({
        stdout: JSON.stringify({
          accessToken: "live-token",
          accountId: "account-1",
          expiresAt: now + 120_000,
        }),
      });
      const acquireLive = yield* makeCodexExternalCredentialAcquirer({
        command: "/nix/store/provenance-credential",
        spawner: live.spawner,
        now: Effect.succeed(now),
      });
      assert.deepEqual(yield* acquireLive(), {
        accessToken: "live-token",
        accountId: "account-1",
        expiresAt: now + 120_000,
      });
    }),
  );

  it.effect("uses the runner spawner for the credential executable", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        commands.push(
          ChildProcess.isStandardCommand(command) ? command.command : "non-standard-command",
        );
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      });
      const acquire = yield* makeCodexExternalCredentialAcquirer({
        command: "/nix/store/provenance-credential",
        spawner,
      });

      yield* acquire().pipe(Effect.flip);

      assert.deepEqual(commands, ["/nix/store/provenance-credential"]);
    }),
  );

  it("defines one sanitized error type for every failure", () => {
    const first = codexExternalCredentialUnavailable();
    const second = codexExternalCredentialUnavailable();
    assert.strictEqual(first._tag, "CodexAppServerRequestError");
    assert.strictEqual(second.message, "External OpenAI credential is unavailable.");
    assert.isUndefined(first.cause);
    assert.isUndefined(first.data);
  });
});
