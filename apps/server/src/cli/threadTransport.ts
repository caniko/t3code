import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { readSecretFile } from "./secretFile.ts";

export const THREAD_SERVER_URL_ENV = "T3CODE_SERVER_URL";
export const THREAD_AUTH_TOKEN_FILE_ENV = "T3CODE_AUTH_TOKEN_FILE";

export type ThreadTransport =
  | { readonly kind: "local" }
  | {
      readonly kind: "remote";
      readonly origin: string;
      readonly authorization: string;
    };

export class ThreadTransportError extends Schema.TaggedError<ThreadTransportError>()(
  "ThreadTransportError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

const local: ThreadTransport = { kind: "local" };
const decodeUrl = Schema.decodeEffect(Schema.URLFromString);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Error text may quote the request or its headers; never render the bearer token. */
export const redactCredentials = (message: string, token: string) => {
  const withoutToken = token.length > 0 ? message.split(token).join("[redacted]") : message;
  return withoutToken.replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]");
};

/** Both variables select the remote MCP endpoint; neither keeps the same-user local server. */
export const resolveThreadTransport = Effect.fn("cli.threadTransport.resolve")(function* (
  env: NodeJS.ProcessEnv = process.env,
) {
  const rawOrigin = env[THREAD_SERVER_URL_ENV]?.trim() ?? "";
  const tokenFile = env[THREAD_AUTH_TOKEN_FILE_ENV]?.trim() ?? "";
  if (rawOrigin.length === 0 && tokenFile.length === 0) return local;
  if (rawOrigin.length === 0 || tokenFile.length === 0) {
    return yield* new ThreadTransportError({
      reason: `${THREAD_SERVER_URL_ENV} and ${THREAD_AUTH_TOKEN_FILE_ENV} go together`,
    });
  }
  const url = yield* decodeUrl(rawOrigin).pipe(
    Effect.mapError(
      () => new ThreadTransportError({ reason: `${THREAD_SERVER_URL_ENV} is not a URL` }),
    ),
  );
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.pathname !== "/" && url.pathname.length > 0) ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    return yield* new ThreadTransportError({
      reason: `${THREAD_SERVER_URL_ENV} must be an http(s) origin without credentials, a path, a query or a fragment`,
    });
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return yield* new ThreadTransportError({
      reason: `${THREAD_SERVER_URL_ENV} must use https unless it is a loopback address; a bearer token must not cross the network in clear text`,
    });
  }
  const token = yield* readSecretFile(tokenFile);
  return {
    kind: "remote",
    origin: url.origin,
    authorization: `Bearer ${token}`,
  } satisfies ThreadTransport;
});
