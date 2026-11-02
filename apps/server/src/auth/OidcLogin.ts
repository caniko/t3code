// @effect-diagnostics nodeBuiltinImport:off - PKCE and state need Node hashing and randomness.
// @effect-diagnostics globalFetch:off - jose fetches the JWKS with the same injectable fetch, not an HttpClient.
import * as NodeCrypto from "node:crypto";
import { DEFAULT_PRINCIPAL_ID, PrincipalId } from "@t3tools/contracts";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

export type OidcClient = "web" | "desktop";

const LOGIN_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_PENDING_LOGINS = 1_000;

export class OidcLoginError extends Schema.TaggedError<OidcLoginError>()("OidcLoginError", {
  reason: Schema.Literals([
    "disabled",
    "origin",
    "state",
    "provider",
    "token",
    "group",
    "principal",
  ]),
}) {
  override get message(): string {
    return `OIDC sign-in refused: ${this.reason}.`;
  }
}

const Discovery = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  jwks_uri: Schema.String,
});
const TokenResponse = Schema.Struct({ id_token: Schema.String });
const decodeDiscovery = Schema.decodeUnknownEffect(Discovery);
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);
const isPrincipalId = Schema.is(PrincipalId);

interface PendingLogin {
  readonly nonce: string;
  readonly verifier: string;
  readonly client: OidcClient;
  readonly origin: string;
  readonly expiresAt: number;
}

export class OidcLogin extends Context.Service<
  OidcLogin,
  {
    readonly start: (input: {
      readonly client: OidcClient;
      readonly origin: string;
    }) => Effect.Effect<string, OidcLoginError>;
    readonly complete: (input: {
      readonly state: string;
      readonly code: string;
    }) => Effect.Effect<
      { readonly principal: string; readonly client: OidcClient; readonly origin: string },
      OidcLoginError
    >;
  }
>()("t3/auth/OidcLogin") {}

const random = () => NodeCrypto.randomBytes(32).toString("base64url");
const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("base64url");

const callbackUrl = (origin: string) => `${origin}/auth/oidc/callback`;

/** Kanidm emits `name@domain`; a bare name matches too. */
const inGroup = (groups: unknown, allowed: string) =>
  Array.isArray(groups) &&
  groups.some(
    (group) => group === allowed || (typeof group === "string" && group.startsWith(`${allowed}@`)),
  );

export const makeWith = Effect.fn("OidcLogin.make")(function* (fetchImpl: typeof fetch) {
  const { oidc } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  // ponytail: pending logins live in this process; a restart drops them and the user signs in again.
  const pending = new Map<string, PendingLogin>();
  let discovered:
    | { readonly meta: typeof Discovery.Type; readonly jwks: ReturnType<typeof createRemoteJWKSet> }
    | undefined;

  const request = (url: string, init?: RequestInit) =>
    Effect.tryPromise(async () => {
      const response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as unknown;
    }).pipe(
      Effect.tapError((cause) => Effect.logWarning("OIDC provider request failed", { cause })),
      Effect.mapError(() => new OidcLoginError({ reason: "provider" })),
    );

  const discover = Effect.fn("OidcLogin.discover")(function* (issuer: string) {
    if (discovered) return discovered;
    const meta = yield* request(`${issuer}/.well-known/openid-configuration`).pipe(
      Effect.flatMap(decodeDiscovery),
      Effect.mapError(() => new OidcLoginError({ reason: "provider" })),
    );
    if (meta.issuer !== issuer) return yield* new OidcLoginError({ reason: "provider" });
    discovered = {
      meta,
      jwks: createRemoteJWKSet(new URL(meta.jwks_uri), { [customFetch]: fetchImpl }),
    };
    return discovered;
  });

  const start: OidcLogin["Service"]["start"] = Effect.fn("OidcLogin.start")(function* (input) {
    if (!oidc) return yield* new OidcLoginError({ reason: "disabled" });
    if (!oidc.publicOrigins.includes(input.origin)) {
      return yield* new OidcLoginError({ reason: "origin" });
    }
    const { meta } = yield* discover(oidc.issuer);
    const now = yield* Clock.currentTimeMillis;
    for (const [key, login] of pending) if (login.expiresAt <= now) pending.delete(key);
    if (pending.size >= MAX_PENDING_LOGINS) return yield* new OidcLoginError({ reason: "state" });
    const state = random();
    const verifier = random();
    const nonce = random();
    pending.set(state, {
      nonce,
      verifier,
      client: input.client,
      origin: input.origin,
      expiresAt: now + LOGIN_TTL_MS,
    });
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: oidc.clientId,
      redirect_uri: callbackUrl(input.origin),
      scope: "openid profile groups",
      state,
      nonce,
      code_challenge: sha256(verifier),
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  });

  const complete: OidcLogin["Service"]["complete"] = Effect.fn("OidcLogin.complete")(
    function* (input) {
      if (!oidc) return yield* new OidcLoginError({ reason: "disabled" });
      const login = pending.get(input.state);
      pending.delete(input.state);
      const now = yield* Clock.currentTimeMillis;
      if (!login || login.expiresAt <= now) return yield* new OidcLoginError({ reason: "state" });
      const { meta, jwks } = yield* discover(oidc.issuer);
      const secret = yield* fileSystem.readFileString(oidc.clientSecretFile).pipe(
        Effect.map((value) => value.trim()),
        Effect.mapError(() => new OidcLoginError({ reason: "provider" })),
      );
      const basic = Buffer.from(
        `${encodeURIComponent(oidc.clientId)}:${encodeURIComponent(secret)}`,
      ).toString("base64");
      const { id_token } = yield* request(meta.token_endpoint, {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: callbackUrl(login.origin),
          code_verifier: login.verifier,
        }),
      }).pipe(
        Effect.flatMap(decodeTokenResponse),
        Effect.mapError(() => new OidcLoginError({ reason: "provider" })),
      );
      const payload = yield* Effect.tryPromise(() =>
        jwtVerify(id_token, jwks, {
          issuer: oidc.issuer,
          audience: oidc.clientId,
          algorithms: ["ES256", "RS256"],
          requiredClaims: ["exp"],
        }),
      ).pipe(
        Effect.map((verified) => verified.payload),
        Effect.mapError(() => new OidcLoginError({ reason: "token" })),
      );
      if (payload.nonce !== login.nonce) return yield* new OidcLoginError({ reason: "token" });
      if (!inGroup(payload.groups, oidc.allowedGroup)) {
        return yield* new OidcLoginError({ reason: "group" });
      }
      const principal = payload[oidc.principalClaim];
      if (
        typeof principal !== "string" ||
        !isPrincipalId(principal) ||
        principal === DEFAULT_PRINCIPAL_ID
      ) {
        return yield* new OidcLoginError({ reason: "principal" });
      }
      return { principal, client: login.client, origin: login.origin };
    },
  );

  return OidcLogin.of({ start, complete });
});

export const layer = Layer.effect(
  OidcLogin,
  makeWith((input, init) => globalThis.fetch(input, init)),
);
