import {
  AuthMcpClientAccess,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  PeerLinkError,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

/**
 * Links live in this environment's database and secret store, so these
 * commands work whether or not its server is running.
 */
const runWithPeerLinks = Effect.fn("environment.runWithPeerLinks")(function* <A, E>(
  flags: CliAuthLocationFlags,
  run: (links: PeerLinks.PeerLinks["Service"]) => Effect.Effect<A, E>,
  options?: { readonly quietLogs?: boolean },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, options);
  return yield* PeerLinks.PeerLinks.pipe(
    Effect.flatMap(run),
    Effect.provide(
      PeerLinks.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSecretStore.layer,
            SqlitePersistence.layerCliConfig,
            FetchHttpClient.layer,
          ),
        ),
        Layer.provide(ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer))),
        Layer.provide(
          ServerSettings.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                ServerSecretStore.layer,
                SqlitePersistence.layerCliConfig,
                ManagedPolicy.layer,
              ),
            ),
          ),
        ),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(
          Layer.succeed(References.MinimumLogLevel, options?.quietLogs ? "Error" : config.logLevel),
        ),
      ),
    ),
  );
});

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const encodeLinks = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.toEncoded(Schema.Unknown))),
);

const encodeEnvironmentDescriptor = Schema.encodeEffect(
  Schema.fromJsonString(ExecutionEnvironmentDescriptor),
);

const formatLinks = (links: ReadonlyArray<PeerLinkSummary>) =>
  links.length === 0
    ? "No linked environments.\n"
    : `${links
        .map(
          (link) =>
            `${link.label} (${link.environmentId})\n  ${link.status}, access ${link.access}, expires ${DateTime.formatIso(link.expiresAt)}\n  ${link.urls.join(", ")}${link.lastError === null ? "" : `\n  last error: ${link.lastError}`}`,
        )
        .join("\n\n")}\n`;

/** @public */
export const readPairingCode = Effect.fn("cli.environment.readPairingCode")(function* (
  argument: string,
) {
  if (argument !== "-") return argument;
  const stdio = yield* Stdio.Stdio;
  const code = (yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.mapError(
      (cause) =>
        new PeerLinkError({
          reason: "pairing_rejected",
          message: "Could not read the pairing code from standard input.",
          cause,
        }),
    ),
  )).trim();
  if (code.length === 0) {
    return yield* new PeerLinkError({
      reason: "pairing_rejected",
      message: "The pairing code read from standard input is empty.",
    });
  }
  return code;
});

const environmentLinkCommand = Command.make("link", {
  ...authLocationFlags,
  url: Argument.String("url").pipe(
    Argument.withDescription(
      "Where the other environment answers: its T3 Connect, Tailscale, LAN or loopback address.",
    ),
  ),
  alternateUrl: Flag.String("url").pipe(
    Flag.withDescription("Another address for the same environment, tried after the first."),
    Flag.atLeast(0),
  ),
  pairingCode: Flag.String("pairing-code").pipe(
    Flag.withDescription(
      "A pairing code from the other environment (`t3 pair` there), or - to read it from stdin.",
    ),
  ),
  expectedEnvironmentId: Flag.String("expect-environment-id").pipe(
    Flag.withDescription(
      "Only send the pairing code to addresses that answer as this environment.",
    ),
    Flag.optional,
  ),
  access: Flag.Literals("access", AuthMcpClientAccess.literals).pipe(
    Flag.withDescription(
      "What this environment's agents may do there: read-only, or the broadest runtime mode.",
    ),
    Flag.withDefault("approval-required" as const),
  ),
}).pipe(
  Command.withDescription(
    "Link another T3 Code environment, so agents here can work there. It shows up there under Authorized clients in Settings → Sharing & access, where it can be revoked.",
  ),
  Command.withHandler((flags) =>
    readPairingCode(flags.pairingCode).pipe(
      Effect.flatMap((pairingCode) =>
        runWithPeerLinks(flags, (links) =>
          Effect.gen(function* () {
            const linked = yield* links.link({
              url: flags.url,
              alternateUrls: flags.alternateUrl,
              pairingCode,
              access: flags.access,
              ...Option.match(flags.expectedEnvironmentId, {
                onNone: () => ({}),
                onSome: (value) => ({ expectedEnvironmentId: EnvironmentId.make(value) }),
              }),
            });
            yield* Console.log(
              `Linked ${linked.label} (${linked.environmentId}) with ${linked.access} access, until ${DateTime.formatIso(linked.expiresAt)}.\n`,
            );
          }),
        ),
      ),
    ),
  ),
);

const environmentDescribeCommand = Command.make("describe", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show this environment's id, platform and capabilities without starting its server.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: flags.json });
      const descriptor = yield* Effect.gen(function* () {
        const environment = yield* ServerEnvironment.ServerEnvironment;
        return yield* environment.getDescriptor;
      }).pipe(
        Effect.provide(
          ServerEnvironment.layer.pipe(
            Layer.provide(ServerSecretStore.layer),
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(
              Layer.succeed(References.MinimumLogLevel, flags.json ? "Error" : config.logLevel),
            ),
          ),
        ),
      );
      yield* Console.log(
        flags.json
          ? `${yield* encodeEnvironmentDescriptor(descriptor)}\n`
          : `${descriptor.label} (${descriptor.environmentId})\n`,
      );
    }),
  ),
);

const environmentListCommand = Command.make("list", { ...authLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("List linked environments and whether each answers now."),
  Command.withHandler((flags) =>
    runWithPeerLinks(
      flags,
      (links) =>
        Effect.gen(function* () {
          const listed = yield* links.list;
          yield* Console.log(flags.json ? `${yield* encodeLinks(listed)}\n` : formatLinks(listed));
        }),
      { quietLogs: flags.json },
    ),
  ),
);

const environmentUnlinkCommand = Command.make("unlink", {
  ...authLocationFlags,
  environmentId: Argument.String("environment-id").pipe(
    Argument.withDescription("The linked environment's id, from `t3 environment list`."),
  ),
}).pipe(
  Command.withDescription(
    "Forget a linked environment here. Revoke it in that environment's Sharing & access to end its session there too.",
  ),
  Command.withHandler((flags) =>
    runWithPeerLinks(flags, (links) =>
      Effect.gen(function* () {
        const removed = yield* links.unlink(EnvironmentId.make(flags.environmentId));
        yield* Console.log(
          removed
            ? `Forgot ${flags.environmentId}. Revoke it in that environment's Sharing & access to end its session there.\n`
            : `No linked environment ${flags.environmentId}.\n`,
        );
      }),
    ),
  ),
);

export const environmentCommand = Command.make("environment").pipe(
  Command.withDescription(
    "Link other T3 Code environments, or show this one's id and capabilities.",
  ),
  Command.withSubcommands([
    environmentDescribeCommand,
    environmentLinkCommand,
    environmentListCommand,
    environmentUnlinkCommand,
  ]),
);
