import {
  type AuthGrantScope,
  AuthMcpClientAccess,
  AuthSessionId,
  AuthStandardClientScopes,
  PrincipalId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, CliError, Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

import {
  formatIssuedPairingCredential,
  formatIssuedSession,
  formatPairingCredentialList,
  formatSessionList,
} from "../cliAuthFormat.ts";
import * as ServerConfig from "../config.ts";
import { authScopesFlag } from "./authScopes.ts";
import {
  authLocationFlags,
  type CliAuthLocationFlags,
  DurationFromString,
  resolveCliAuthConfig,
} from "./config.ts";
import { writeSecretFile } from "./secretFile.ts";

const runWithEnvironmentAuth = Effect.fn("auth.runWithEnvironmentAuth")(function* <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<A, E, R>,
  options?: {
    readonly quietLogs?: boolean;
  },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, options);
  const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* run(environmentAuth);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(EnvironmentAuth.layerRuntime).pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const ttlFlag = Flag.String("ttl").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("TTL, for example `5m`, `1h`, `30d`, or `15 minutes`."),
  Flag.optional,
);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const labelFlag = Flag.String("label").pipe(
  Flag.withDescription("Optional human-readable label."),
  Flag.optional,
);

const subjectFlag = Flag.String("subject").pipe(
  Flag.withDescription("Optional session subject."),
  Flag.optional,
);

const principalFlag = Flag.String("principal").pipe(
  Flag.withSchema(PrincipalId),
  Flag.withDescription(
    "Bind the credential to a principal that sees only its own threads; limited to orchestration scopes.",
  ),
  Flag.optional,
);

// The flag substitutes the standard set when no scope is given; a principal then falls back to its own default.
const scopeInput = (flags: {
  readonly scopes: ReadonlyArray<AuthGrantScope>;
  readonly principal: Option.Option<string>;
}) =>
  Option.isSome(flags.principal) &&
  flags.scopes.length === AuthStandardClientScopes.length &&
  AuthStandardClientScopes.every((scope) => flags.scopes.includes(scope))
    ? {}
    : { scopes: flags.scopes };

const baseUrlFlag = Flag.String("base-url").pipe(
  Flag.withSchema(
    Schema.URLFromString.pipe(
      Schema.check(
        Schema.makeFilter((url) => url.protocol === "http:" || url.protocol === "https:", {
          expected: "an http:// or https:// URL",
        }),
      ),
    ),
  ),
  Flag.withDescription("Optional public base URL used to print a ready `/pair#token=...` link."),
  Flag.optional,
);

const tokenOnlyFlag = Flag.Boolean("token-only").pipe(
  Flag.withDescription("Print only the issued bearer token."),
  Flag.withDefault(false),
);

const mcpAccessFlag = Flag.Literals("mcp-access", AuthMcpClientAccess.literals).pipe(
  Flag.withDescription(
    "Issue an MCP client token at this access level instead of a general bearer session; combine with --principal to bind it.",
  ),
  Flag.optional,
);

const tokenFileFlag = Flag.String("token-file").pipe(
  Flag.withDescription("Write the token to this absolute path (mode 0600) instead of printing it."),
  Flag.optional,
);

const hasExplicitScopes = (scopes: ReadonlyArray<AuthGrantScope>) =>
  scopes.length !== AuthStandardClientScopes.length ||
  !AuthStandardClientScopes.every((scope) => scopes.includes(scope));

/**
 * A write failure must not leave the just-issued credential live: revoke it
 * and rethrow the write error, which names the file and never its contents.
 */
export const writeIssuedSessionToken = (
  environmentAuth: Pick<EnvironmentAuth.EnvironmentAuth["Service"], "revokeSession">,
  issued: { readonly sessionId: AuthSessionId; readonly token: string },
  tokenFile: string,
) =>
  writeSecretFile(tokenFile, issued.token).pipe(
    Effect.tapError(() =>
      environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
    ),
  );

const pairingCreateCommand = Command.make("create", {
  ...authLocationFlags,
  scopes: authScopesFlag(AuthStandardClientScopes),
  ttl: ttlFlag,
  label: labelFlag,
  principal: principalFlag,
  baseUrl: baseUrlFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Issue a new client pairing token."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const issued = yield* environmentAuth.createPairingLink({
            ...scopeInput(flags),
            subject: "one-time-token",
            ...(Option.isSome(flags.principal) ? { principal: flags.principal.value } : {}),
            ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
            ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
          });
          const output = formatIssuedPairingCredential(issued, {
            json: flags.json,
            ...(Option.isSome(flags.baseUrl) ? { baseUrl: flags.baseUrl.value.href } : {}),
          });
          yield* Console.log(output);
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const pairingListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active client pairing tokens without revealing their secrets."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const pairingLinks = yield* environmentAuth.listPairingLinks({
            excludeSubjects: [EnvironmentAuth.INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT],
          });
          yield* Console.log(formatPairingCredentialList(pairingLinks, { json: flags.json }));
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const pairingRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  id: Argument.String("id").pipe(Argument.withDescription("Pairing credential id to revoke.")),
}).pipe(
  Command.withDescription("Revoke an active client pairing token."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(flags, (environmentAuth) =>
      Effect.gen(function* () {
        const revoked = yield* environmentAuth.revokePairingLink(flags.id);
        yield* Console.log(
          revoked
            ? `Revoked pairing credential ${flags.id}.\n`
            : `No active pairing credential found for ${flags.id}.\n`,
        );
      }),
    ),
  ),
);

const pairingCommand = Command.make("pairing").pipe(
  Command.withDescription("Manage one-time client pairing tokens."),
  Command.withSubcommands([pairingCreateCommand, pairingListCommand, pairingRevokeCommand]),
);

const sessionIssueCommand = Command.make("issue", {
  ...authLocationFlags,
  scopes: authScopesFlag(AuthStandardClientScopes),
  ttl: ttlFlag,
  label: labelFlag,
  subject: subjectFlag,
  principal: principalFlag,
  tokenOnly: tokenOnlyFlag,
  tokenFile: tokenFileFlag,
  mcpAccess: mcpAccessFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Issue a scoped bearer access token for headless or remote clients."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const tokenFile = Option.getOrUndefined(flags.tokenFile);
          if (tokenFile !== undefined && flags.tokenOnly) {
            return yield* new CliError.UserError({
              cause: "--token-file and --token-only cannot be combined.",
            });
          }
          if (tokenFile !== undefined) {
            const path = yield* Path.Path;
            if (!path.isAbsolute(tokenFile)) {
              return yield* new CliError.UserError({
                cause: "--token-file must be an absolute path.",
              });
            }
          }
          if (Option.isSome(flags.mcpAccess) && Option.isSome(flags.subject)) {
            return yield* new CliError.UserError({
              cause: "--mcp-access derives the token subject; omit --subject.",
            });
          }
          if (Option.isSome(flags.mcpAccess) && hasExplicitScopes(flags.scopes)) {
            return yield* new CliError.UserError({
              cause: "--mcp-access sets the token scopes; omit --scope.",
            });
          }
          const issued = Option.isNone(flags.mcpAccess)
            ? yield* environmentAuth.issueSession({
                ...scopeInput(flags),
                ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
                ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
                ...(Option.isSome(flags.subject) ? { subject: flags.subject.value } : {}),
                ...(Option.isSome(flags.principal) ? { principal: flags.principal.value } : {}),
              })
            : yield* environmentAuth.issueMcpClientSession({
                label: Option.getOrUndefined(flags.label) ?? "t3 CLI token",
                access: flags.mcpAccess.value,
                peerLink: false,
                client: { deviceType: "bot" },
                ...(Option.isSome(flags.principal) ? { principal: flags.principal.value } : {}),
                ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
              });
          if (tokenFile !== undefined) {
            yield* writeIssuedSessionToken(environmentAuth, issued, tokenFile);
            yield* Console.log(formatIssuedSession(issued, { json: flags.json, tokenFile }));
            return;
          }
          yield* Console.log(
            formatIssuedSession(issued, { json: flags.json, tokenOnly: flags.tokenOnly }),
          );
        }),
      {
        quietLogs: flags.json || flags.tokenOnly || Option.isSome(flags.tokenFile),
      },
    ),
  ),
);

const sessionListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active sessions without revealing bearer tokens."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const sessions = yield* environmentAuth.listSessions();
          yield* Console.log(formatSessionList(sessions, { json: flags.json }));
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const sessionRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  sessionId: Argument.String("session-id").pipe(
    Argument.withDescription("Session id to revoke."),
    Argument.withSchema(AuthSessionId),
  ),
}).pipe(
  Command.withDescription("Revoke an active session."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(flags, (environmentAuth) =>
      Effect.gen(function* () {
        const revoked = yield* environmentAuth.revokeSession(flags.sessionId);
        yield* Console.log(
          revoked
            ? `Revoked session ${flags.sessionId}.\n`
            : `No active session found for ${flags.sessionId}.\n`,
        );
      }),
    ),
  ),
);

const sessionCommand = Command.make("session").pipe(
  Command.withDescription("Manage bearer sessions."),
  Command.withSubcommands([sessionIssueCommand, sessionListCommand, sessionRevokeCommand]),
);

export const authCommand = Command.make("auth").pipe(
  Command.withDescription("Manage the local auth control plane for headless deployments."),
  Command.withSubcommands([pairingCommand, sessionCommand]),
);
