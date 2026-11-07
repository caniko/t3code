import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/process";

import { make as makeProcessRunner } from "../../processRunner.ts";

export interface CodexExternalCredential {
  readonly accessToken: string;
  readonly accountId: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

/** `null` means the runner has no managed OpenAI binding, not that auth failed. */
export type CodexExternalCredentialResult = CodexExternalCredential | null;

const CREDENTIAL_TIMEOUT = "8 seconds";
const MAX_CREDENTIAL_OUTPUT_BYTES = 64 * 1024;
const MIN_CREDENTIAL_LIFETIME_MS = 60_000;
const CREDENTIAL_UNAVAILABLE = "External OpenAI credential is unavailable.";

/**
 * Codex's own error type, with no command output, parser input, or cause attached.
 * Every failure path for an opted-in credential must end here.
 */
export const codexExternalCredentialUnavailable = () =>
  CodexErrors.CodexAppServerRequestError.internalError(CREDENTIAL_UNAVAILABLE);

const failClosed = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, CodexErrors.CodexAppServerRequestError, R> =>
  effect.pipe(
    Effect.mapError(() => codexExternalCredentialUnavailable()),
    Effect.catchDefect(() => codexExternalCredentialUnavailable()),
  );

const decodeCredential = (raw: string, now: number): CodexExternalCredentialResult | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["accessToken", "accountId", "expiresAt"].includes(key)))
    return undefined;
  const accessToken =
    typeof record.accessToken === "string" && /^[\x21-\x7e]+$/.test(record.accessToken)
      ? record.accessToken
      : undefined;
  const accountId =
    typeof record.accountId === "string" &&
    record.accountId.length <= 256 &&
    /^[\x21-\x7e]+$/.test(record.accountId)
      ? record.accountId
      : undefined;
  const expiresAt =
    typeof record.expiresAt === "number" && Number.isSafeInteger(record.expiresAt)
      ? record.expiresAt
      : undefined;
  if (
    accessToken === undefined ||
    accountId === undefined ||
    expiresAt === undefined ||
    expiresAt - now <= MIN_CREDENTIAL_LIFETIME_MS
  ) {
    return undefined;
  }
  return { accessToken, accountId, expiresAt };
};

/**
 * Runs the trusted credential executable through the same per-thread runner spawner as Codex.
 * The executable gets no arguments, no cwd, and no shell.
 */
export const makeCodexExternalCredentialAcquirer = Effect.fn("CodexExternalAuth.makeAcquirer")(
  function* (input: {
    readonly command: string;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly now?: Effect.Effect<number>;
  }) {
    const runner = yield* makeProcessRunner().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner),
    );
    const now = input.now ?? Clock.currentTimeMillis;

    return (): Effect.Effect<
      CodexExternalCredentialResult,
      CodexErrors.CodexAppServerRequestError
    > =>
      failClosed(
        Effect.gen(function* () {
          const output = yield* runner.run({
            command: input.command,
            args: [],
            timeout: CREDENTIAL_TIMEOUT,
            maxOutputBytes: MAX_CREDENTIAL_OUTPUT_BYTES,
            outputMode: "error",
          });
          if (output.code !== 0) {
            return yield* codexExternalCredentialUnavailable();
          }
          const currentTime = yield* now;
          const credential = decodeCredential(output.stdout, currentTime);
          if (credential === undefined) {
            return yield* codexExternalCredentialUnavailable();
          }
          return credential;
        }),
      );
  },
);

/**
 * Adds Codex external auth to a freshly built native client. The refresh request handler is
 * installed before the first `initialized` notification so Codex can never ask first.
 *
 * An initial `null` leaves a native user login untouched. Once a credential has driven an
 * external login, a missing or changed account fails closed on refresh.
 */
export const installCodexExternalAuth = Effect.fn("CodexExternalAuth.install")(function* (input: {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly acquire: (
    previousAccountId?: string,
  ) => Effect.Effect<CodexExternalCredentialResult, CodexErrors.CodexAppServerRequestError>;
}) {
  let accountId: string | undefined;
  let initialLoginComplete = false;
  const initialLoginPermit = yield* Semaphore.make(1);

  yield* input.client.handleServerRequest("account/chatgptAuthTokens/refresh", (params) => {
    const previousAccountId = params.previousAccountId ?? undefined;
    return failClosed(
      Effect.gen(function* () {
        if (
          accountId === undefined ||
          (previousAccountId !== undefined && previousAccountId !== accountId)
        ) {
          return yield* codexExternalCredentialUnavailable();
        }
        const credential = yield* input.acquire(previousAccountId);
        if (credential === null || credential.accountId !== accountId) {
          return yield* codexExternalCredentialUnavailable();
        }
        return {
          accessToken: credential.accessToken,
          chatgptAccountId: credential.accountId,
        };
      }),
    );
  });

  const notify: CodexClient.CodexAppServerClient["Service"]["notify"] = (method, payload) =>
    input.client.notify(method, payload).pipe(
      Effect.flatMap(() => {
        if (method !== "initialized") return Effect.void;
        return initialLoginPermit.withPermit(
          failClosed(
            Effect.gen(function* () {
              if (initialLoginComplete) return;
              const credential = yield* input.acquire(undefined);
              if (credential === null) {
                initialLoginComplete = true;
                return;
              }
              yield* input.client.request("account/login/start", {
                type: "chatgptAuthTokens",
                accessToken: credential.accessToken,
                chatgptAccountId: credential.accountId,
              });
              accountId = credential.accountId;
              initialLoginComplete = true;
            }),
          ),
        );
      }),
    );

  return { ...input.client, notify };
});
