import { buildPairingAppLink, setPairingTokenOnUrl } from "@t3tools/shared/remote";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { OidcLogin, OidcLoginError, type OidcClient } from "./OidcLogin.ts";
import { deriveAuthClientMetadata } from "./utils.ts";
import { requestUrl } from "../requestUrl.ts";

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };
const PAIRING_TTL = Duration.minutes(2);

const STATUS: Record<OidcLoginError["reason"], number> = {
  disabled: 404,
  origin: 400,
  state: 400,
  provider: 502,
  token: 403,
  group: 403,
  principal: 403,
};

const failure = (status: number, text: string) =>
  HttpServerResponse.text(text, { status, headers: NO_STORE });

const refuse = (error: OidcLoginError) =>
  failure(STATUS[error.reason], "Sign-in was refused. Close this tab and try again.");

const requestOrigin = Effect.map(HttpServerRequest.HttpServerRequest, (request) => {
  const url = requestUrl(request);
  return url._tag === "Some" ? url.value.origin : "";
});

const startRoute = HttpRouter.add(
  "GET",
  "/auth/oidc/start",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const query = new URLSearchParams(request.url.split("?", 2)[1] ?? "");
    const client: OidcClient = query.get("client") === "desktop" ? "desktop" : "web";
    const oidc = yield* OidcLogin;
    const origin = yield* requestOrigin;
    return yield* oidc.start({ client, origin }).pipe(
      Effect.map((location) =>
        HttpServerResponse.redirect(location, { status: 302, headers: NO_STORE }),
      ),
      Effect.catchTags({ OidcLoginError: (error) => Effect.succeed(refuse(error)) }),
    );
  }).pipe(Effect.withSpan("auth.oidc.start")),
);

const callbackRoute = HttpRouter.add(
  "GET",
  "/auth/oidc/callback",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const query = new URLSearchParams(request.url.split("?", 2)[1] ?? "");
    const state = query.get("state");
    const code = query.get("code");
    if (query.has("error") || !state || !code) {
      return failure(403, "Sign-in was refused. Close this tab and try again.");
    }
    const oidc = yield* OidcLogin;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const login = yield* oidc.complete({ state, code });
    const metadata = deriveAuthClientMetadata({ request });
    if (login.client === "desktop") {
      const link = yield* auth.createPairingLink({
        principal: login.principal,
        ttl: PAIRING_TTL,
        label: `${login.principal} (desktop)`,
      });
      const pairingUrl = setPairingTokenOnUrl(new URL("/pair", login.origin), link.credential);
      return HttpServerResponse.redirect(buildPairingAppLink(pairingUrl.toString()), {
        status: 302,
        headers: NO_STORE,
      });
    }
    const session = yield* auth.issuePrincipalBrowserSession(login.principal, metadata);
    return yield* HttpServerResponse.redirect("/", { status: 302, headers: NO_STORE }).pipe(
      HttpServerResponse.setCookie(session.cookieName, session.sessionToken, {
        expires: DateTime.toDate(session.expiresAt),
        httpOnly: true,
        path: "/",
        sameSite: "lax",
      }),
    );
  }).pipe(
    Effect.catchTags({ OidcLoginError: (error) => Effect.succeed(refuse(error)) }),
    Effect.catch((error) =>
      Effect.logError("OIDC sign-in failed after verification", { cause: error }).pipe(
        Effect.as(failure(500, "Sign-in failed. Close this tab and try again.")),
      ),
    ),
    Effect.withSpan("auth.oidc.callback"),
  ),
);

export const layer = Layer.mergeAll(startRoute, callbackRoute);
