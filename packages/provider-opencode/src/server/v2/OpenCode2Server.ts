// One OpenCode 2 process serves all directories; share it across instance threads.
import type { OpenCodeClient } from "@opencode/client/effect";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as P from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as HttpClientError from "effect/http/HttpClientError";

import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";
import * as OpenCodeServerOwner from "../OpenCodeServerOwner.ts";
import * as OpenCode2Client from "./OpenCode2Client.ts";

const INFO_TIMEOUT = "5 seconds";

export interface OpenCode2Connection extends OpenCode2Client.OpenCode2Api {
  readonly url: string;
  readonly version: string;
  readonly external: boolean;
}

export class OpenCode2Server extends Context.Service<
  OpenCode2Server,
  {
    readonly withConnection: <A, E, R>(
      use: (connection: OpenCode2Connection) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | OpenCodeRuntime.OpenCodeRuntimeError, R>;
    /** The server a thread runs in: its owner's runner, or this process for the server user. */
    readonly withThreadConnection: <A, E, R>(
      threadId: string,
      use: (connection: OpenCode2Connection) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | OpenCodeRuntime.OpenCodeRuntimeError, R>;
  }
>()("@t3tools/provider-opencode/server/v2/OpenCode2Server") {}

/**
 * OpenCode 2 always requires one and prints a generated one to stdout
 * otherwise, so T3 supplies its own and keeps it in memory.
 */
const generatePassword = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const bytes = yield* random.randomBytes(32);
  return Redacted.make(Base64Url.encode(bytes), { label: "OPENCODE_PASSWORD" });
});

/** OPENCODE_PASSWORD overrides OPENCODE_SERVER_PASSWORD; drop the inherited 1.x variable. */
export const serverEnvironment = (
  environment: NodeJS.ProcessEnv,
  password: Redacted.Redacted,
): NodeJS.ProcessEnv => {
  const { OPENCODE_SERVER_PASSWORD: _inherited, ...rest } = environment;
  return { ...rest, OPENCODE_PASSWORD: Redacted.value(password) };
};

const httpFailureOf = (cause: unknown): HttpClientError.HttpClientError | undefined => {
  if (HttpClientError.isHttpClientError(cause)) return cause;
  if (
    P.isTagged(cause, "ClientError") &&
    P.hasProperty(cause, "cause") &&
    HttpClientError.isHttpClientError(cause.cause)
  ) {
    return cause.cause;
  }
  return undefined;
};

// Empty 401s still reject passwords; undecodable 2xx may be 1.x HTML, not OpenCode 2.
const describeInfoFailure = (cause: unknown) => {
  const failure = httpFailureOf(cause);
  if (failure?.reason._tag === "TransportError") {
    return "Could not reach the OpenCode server.";
  }
  const status = failure?.response?.status;
  if (status === 401) return "The OpenCode server rejected the server password.";
  if (status !== undefined && (status < 200 || status >= 300)) {
    return `The OpenCode server returned HTTP ${status}.`;
  }
  return "The server is not an OpenCode 2 server.";
};

/** Only server info proves readiness; keep credential-bearing failure details out of client text. */
export const verifyServer = (client: OpenCodeClient) =>
  client.server.info().pipe(
    Effect.timeoutOrElse({
      duration: INFO_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "server.info",
            detail: "Timed out waiting for the OpenCode server.",
          }),
        ),
    }),
    Effect.catchTags({
      UnauthorizedError: (cause) =>
        Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "server.info",
            detail: "The OpenCode server rejected the server password.",
            cause,
          }),
        ),
    }),
    Effect.mapError((cause) =>
      OpenCodeRuntime.isOpenCodeRuntimeError(cause)
        ? cause
        : new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "server.info",
            detail: describeInfoFailure(cause),
            cause,
          }),
    ),
    Effect.map((info) => info.version),
  );

export const make = Effect.fn("OpenCode2Server.make")(function* (input: {
  readonly binaryPath: string;
  readonly serverUrl: string;
  readonly serverPassword: string;
  readonly directory: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const opencode = yield* OpenCode2Client.OpenCode2Client;
  const processes = yield* OpenCodeRuntime.OpenCodeThreadProcesses;
  // Servers are built lazily, after `make`'s own scope and crypto have gone; keep them here.
  const ownerContext = Context.make(Scope.Scope, yield* Effect.scope).pipe(
    Context.add(SecureRandom.SecureRandom, yield* SecureRandom.SecureRandom),
    Context.add(OpenCodeRuntime.OpenCodeRuntime, yield* OpenCodeRuntime.OpenCodeRuntime),
  );
  const connectTo = Effect.fn("OpenCode2Server.connectTo")(function* (
    url: string,
    password: Redacted.Redacted,
    external: boolean,
  ) {
    const api = yield* opencode.connect({ baseUrl: url, password });
    const version = yield* verifyServer(api.client);
    return { ...api, url, version, external } satisfies OpenCode2Connection;
  });

  const serverUrl = input.serverUrl.trim();
  if (serverUrl.length > 0) {
    let latest: OpenCode2Connection | undefined;
    const remember = (connection: OpenCode2Connection) =>
      Effect.sync(() => {
        latest = connection;
      });
    const connect = connectTo(serverUrl, Redacted.make(input.serverPassword), true).pipe(
      Effect.tap(remember),
    );
    const withConnection: OpenCode2Server["Service"]["withConnection"] = Effect.fn(
      "OpenCode2Server.withConnection",
    )(function (use) {
      return Effect.suspend(() => (latest === undefined ? connect : Effect.succeed(latest))).pipe(
        Effect.flatMap(use),
      );
    });
    return OpenCode2Server.of({
      withConnection,
      withThreadConnection: Effect.fn("OpenCode2Server.withThreadConnection")(
        function (_threadId, use) {
          return withConnection(use);
        },
      ),
    });
  }

  /** Each owner gets its own server: one process cannot read two users' files or logins. */
  const serverFor = Effect.fn("OpenCode2Server.serverFor")(function* (
    spawner: OpenCodeRuntime.OpenCodeThreadProcess["spawner"] | undefined,
  ) {
    const password = yield* generatePassword;
    let latest: OpenCode2Connection | undefined;
    const remember = (connection: OpenCode2Connection) =>
      Effect.sync(() => {
        latest = connection;
        return connection.version;
      });
    const owner = yield* OpenCodeServerOwner.make({
      binaryPath: input.binaryPath,
      directory: input.directory,
      environment: serverEnvironment(input.environment, password),
      verify: (url) => connectTo(url, password, false).pipe(Effect.flatMap(remember)),
      ...(spawner === undefined ? {} : { spawner }),
    });
    const withConnection: OpenCode2Server["Service"]["withConnection"] = Effect.fn(
      "OpenCode2Server.withConnection",
    )(function (use) {
      return owner.withServer((server) =>
        latest?.url === server.url
          ? use(latest)
          : Effect.die(new Error("OpenCode 2 server was lent before verification.")),
      );
    });
    return withConnection;
  });

  const inProcess = yield* serverFor(undefined);
  const runnerServers = new Map<string, OpenCode2Server["Service"]["withConnection"]>();
  const runners = yield* Semaphore.make(1);
  const serverForThread = Effect.fn("OpenCode2Server.serverForThread")(function* (
    threadId: string,
  ) {
    const process = yield* processes.forThread(threadId);
    if (process === undefined) return inProcess;
    return yield* runners.withPermit(
      Effect.suspend(() => {
        const known = runnerServers.get(process.owner);
        if (known !== undefined) return Effect.succeed(known);
        return serverFor(process.spawner).pipe(
          Effect.provide(ownerContext),
          Effect.tap((started) =>
            Effect.sync(() => {
              runnerServers.set(process.owner, started);
            }),
          ),
        );
      }),
    );
  });

  return OpenCode2Server.of({
    withConnection: inProcess,
    withThreadConnection: Effect.fn("OpenCode2Server.withThreadConnection")(
      function (threadId, use) {
        return serverForThread(threadId).pipe(
          Effect.flatMap((withConnection) => withConnection(use)),
        );
      },
    ),
  });
});
