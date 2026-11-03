// @effect-diagnostics nodeBuiltinImport:off - the fake issuer verifies PKCE with Node hashing.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCryptoPlatform from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { getPairingTokenFromUrl, readPairingAppLink } from "@t3tools/shared/remote";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as OidcHttp from "./oidcHttp.ts";
import * as OidcLogin from "./OidcLogin.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const ISSUER = "https://idm.test/oauth2/openid/t3code";
const ORIGIN = "http://127.0.0.1";
const CLIENT_ID = "t3code";
const CLIENT_SECRET = "s3cret value";

const secretDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-oidc-test-"));
const secretFile = NodePath.join(secretDir, "client-secret");
NodeFS.writeFileSync(secretFile, `${CLIENT_SECRET}\n`);

const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };

interface Claims {
  groups: unknown;
  preferred_username: unknown;
  nonce?: string;
  expiresAt: number;
}
const goodClaims = (): Claims => ({
  groups: ["t3code_users@idm.test", "other@idm.test"],
  preferred_username: "dejana",
  expiresAt: 4_102_444_800,
});

const makeFakeIssuer = () => {
  const issuer = {
    claims: goodClaims(),
    codes: new Map<string, { nonce: string; challenge: string }>(),
  };
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
      });
    }
    if (url.pathname.endsWith("/jwks")) return json({ keys: [jwk] });
    if (url.pathname.endsWith("/token")) {
      const headers = new Headers(init?.headers);
      const expected = Buffer.from(`${CLIENT_ID}:${encodeURIComponent(CLIENT_SECRET)}`).toString(
        "base64",
      );
      if (headers.get("authorization") !== `Basic ${expected}`)
        return new Response("", { status: 401 });
      const form = new URLSearchParams(String(init?.body));
      const pending = issuer.codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
      if (!pending || pending.challenge !== challenge) return new Response("", { status: 400 });
      const { expiresAt, nonce, ...rest } = issuer.claims;
      const idToken = await new SignJWT({ ...rest, nonce: nonce ?? pending.nonce })
        .setProtectedHeader({ alg: "ES256", kid: "k1" })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setSubject("uuid-1")
        .setIssuedAt(1)
        .setExpirationTime(expiresAt)
        .sign(privateKey);
      return json({ id_token: idToken });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { issuer, fetchImpl };
};

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      oidc: {
        issuer: ISSUER,
        clientId: CLIENT_ID,
        clientSecretFile: secretFile,
        allowedGroup: "t3code_users",
        principalClaim: "preferred_username",
        publicOrigins: [ORIGIN],
      },
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-oidc-http-test-" })));

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(layerConfig),
);

const probeRoute = HttpRouter.add(
  "GET",
  "/probe",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateHttpRequest(request);
    return yield* HttpServerResponse.json({ subject: session.subject, method: session.method });
  }),
);

const makeRoutes = (fetchImpl: typeof fetch) =>
  Layer.mergeAll(OidcHttp.layer, probeRoute).pipe(
    Layer.provideMerge(Layer.effect(OidcLogin.OidcLogin, OidcLogin.makeWith(fetchImpl))),
    Layer.provideMerge(layerEnvironmentAuth),
    Layer.provide(layerConfig),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCryptoPlatform.layer)),
  );

const withServer = <A>(
  use: (
    fake: ReturnType<typeof makeFakeIssuer>["issuer"],
    get: (path: string, headers?: Record<string, string>) => Promise<Response>,
  ) => Promise<A>,
) =>
  Effect.gen(function* () {
    const digest = yield* Digest.Digest;
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Digest.Digest, digest).pipe(
      Context.add(SecureRandom.SecureRandom, random),
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    const { issuer, fetchImpl } = makeFakeIssuer();
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(makeRoutes(fetchImpl), { disableLogger: true })),
      (server) =>
        Effect.tryPromise(() =>
          use(issuer, (path, headers) =>
            server.handler(
              new Request(path.startsWith("http") ? path : `${ORIGIN}${path}`, {
                headers: {
                  host: new URL(path.startsWith("http") ? path : ORIGIN).host,
                  ...headers,
                },
                redirect: "manual",
              }),
              requestContext,
            ),
          ),
        ),
      (server) => Effect.promise(() => server.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCryptoPlatform.layer)));

/** Starts a login and returns the callback path the provider would send the browser to. */
const beginLogin = async (
  fake: ReturnType<typeof makeFakeIssuer>["issuer"],
  get: (path: string) => Promise<Response>,
  client: "web" | "desktop" = "web",
) => {
  const started = await get(`/auth/oidc/start?client=${client}`);
  expect(started.status).toBe(302);
  const location = new URL(started.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe(`${ISSUER}/authorize`);
  expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/oidc/callback`);
  const state = location.searchParams.get("state") ?? "";
  fake.codes.set("code-1", {
    nonce: location.searchParams.get("nonce") ?? "",
    challenge: location.searchParams.get("code_challenge") ?? "",
  });
  return `/auth/oidc/callback?state=${state}&code=code-1`;
};

it.effect("signs a group member in with a principal browser session", () =>
  withServer(async (fake, get) => {
    const callback = await beginLogin(fake, get);
    const response = await get(callback);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    const cookie = response.headers.getSetCookie().find((entry) => entry.startsWith("t3_session_"));
    expect(cookie).toContain("HttpOnly");
    const probe = await get("/probe", { cookie: cookie?.split(";", 1)[0] ?? "" });
    expect(await probe.json()).toEqual({
      subject: "principal:dejana",
      method: "browser-session-cookie",
    });
  }),
);

it.effect("hands the desktop a principal pairing link through the app deep link", () =>
  withServer(async (fake, get) => {
    const response = await get(await beginLogin(fake, get, "desktop"));
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("t3code://pair?")).toBe(true);
    const pairingUrl = new URL(readPairingAppLink(location) ?? "");
    expect(pairingUrl.origin + pairingUrl.pathname).toBe(`${ORIGIN}/pair`);
    expect(getPairingTokenFromUrl(pairingUrl)).toBeTruthy();
  }),
);

it.effect("refuses a user outside the allowed group", () =>
  withServer(async (fake, get) => {
    fake.claims.groups = ["t3code_users_extra@idm.test", "other"];
    const response = await get(await beginLogin(fake, get));
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
  }),
);

it.effect("refuses an ID token whose nonce does not match", () =>
  withServer(async (fake, get) => {
    fake.claims.nonce = "someone-elses-nonce";
    const response = await get(await beginLogin(fake, get));
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
  }),
);

it.effect("refuses an expired ID token", () =>
  withServer(async (fake, get) => {
    fake.claims.expiresAt = 2;
    const response = await get(await beginLogin(fake, get));
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
  }),
);

it.effect("refuses a principal claim that is not a valid principal id", () =>
  withServer(async (fake, get) => {
    fake.claims.preferred_username = "owner";
    const response = await get(await beginLogin(fake, get));
    expect(response.status).toBe(403);
  }),
);

it.effect("refuses a reused or unknown state, and a start from an unlisted origin", () =>
  withServer(async (fake, get) => {
    const callback = await beginLogin(fake, get);
    expect((await get(callback)).status).toBe(302);
    expect((await get(callback)).status).toBe(400);
    expect((await get("/auth/oidc/callback?state=nope&code=code-1")).status).toBe(400);
    const foreign = await get("http://evil.example/auth/oidc/start");
    expect(foreign.status).toBe(400);
  }),
);
