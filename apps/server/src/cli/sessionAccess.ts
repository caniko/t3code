import {
  DEFAULT_PRINCIPAL_ID,
  PrincipalId,
  SessionGroupId,
  SessionRole,
  SessionAccessSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as GlobalFlag from "effect/cli/GlobalFlag";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SessionAccess from "../orchestration-v2/SessionAccess.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

const asFlag = Flag.String("as").pipe(
  Flag.withDescription(
    "Act as this principal. Defaults to the environment owner, who may manage everything.",
  ),
  Flag.withDefault(DEFAULT_PRINCIPAL_ID),
  Flag.withSchema(PrincipalId),
);

const roleFlag = Flag.Literals("role", SessionRole.literals).pipe(
  Flag.withDescription("viewer reads; participant also sends messages and steers turns."),
  Flag.withDefault("viewer" as const),
);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const groupArg = Argument.String("group").pipe(
  Argument.withDescription("The group id, from `t3 group list`."),
  Argument.withSchema(SessionGroupId),
);
const threadArg = Argument.String("thread").pipe(Argument.withSchema(ThreadId));
const principalArg = Argument.String("principal").pipe(Argument.withSchema(PrincipalId));

/** Groups and shares live in this environment's database, so these work whether or not its server runs. */
const runWithSessionAccess = Effect.fn("sessionAccess.run")(function* <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (access: SessionAccess.SessionAccess["Service"]) => Effect.Effect<A, E, R>,
  options?: { readonly quietLogs?: boolean },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, options);
  return yield* SessionAccess.SessionAccess.pipe(
    Effect.flatMap(run),
    Effect.provide(
      SessionAccess.layer.pipe(
        Layer.provide(SqlitePersistence.layerConfig),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(
          Layer.succeed(References.MinimumLogLevel, options?.quietLogs ? "Error" : config.logLevel),
        ),
      ),
    ),
  );
});

const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(SessionAccessSnapshot));

const formatGroups = (snapshot: SessionAccessSnapshot) =>
  snapshot.groups.length === 0
    ? "No groups.\n"
    : `${snapshot.groups
        .map(
          (group) =>
            `${group.name} (${group.id}) owned by ${group.ownerPrincipal}, you: ${group.callerRole}\n  members: ${group.members.map((member) => `${member.principal}:${member.role}`).join(", ") || "none"}\n  threads: ${group.threadIds.join(", ") || "none"}`,
        )
        .join("\n\n")}\n`;

const groupCreate = Command.make("create", {
  ...authLocationFlags,
  as: asFlag,
  name: Argument.String("name"),
}).pipe(
  Command.withDescription("Create a session group you own."),
  Command.withHandler((flags) =>
    runWithSessionAccess(flags, (access) =>
      Effect.gen(function* () {
        const random = yield* SecureRandom.SecureRandom;
        const groupId = SessionGroupId.make(Hex.encode(yield* random.randomBytes(8)));
        yield* access.mutate(flags.as, { type: "group.create", groupId, name: flags.name });
        yield* Console.log(`${groupId}\n`);
      }),
    ),
  ),
);

const groupList = Command.make("list", { ...authLocationFlags, as: asFlag, json: jsonFlag }).pipe(
  Command.withDescription("List the groups you own or belong to."),
  Command.withHandler((flags) =>
    runWithSessionAccess(
      flags,
      (access) =>
        Effect.gen(function* () {
          const snapshot = yield* access.snapshot(flags.as);
          yield* Console.log(
            flags.json ? `${yield* encodeSnapshot(snapshot)}\n` : formatGroups(snapshot),
          );
        }),
      { quietLogs: flags.json },
    ),
  ),
);

const groupDelete = Command.make("delete", {
  ...authLocationFlags,
  as: asFlag,
  group: groupArg,
}).pipe(
  Command.withDescription("Delete a group. Its threads stay, and its members lose access to them."),
  Command.withHandler((flags) =>
    runWithSessionAccess(flags, (access) =>
      access.mutate(flags.as, { type: "group.delete", groupId: flags.group }),
    ),
  ),
);

const groupAddThread = Command.make("add-thread", {
  ...authLocationFlags,
  as: asFlag,
  group: groupArg,
  thread: threadArg,
}).pipe(
  Command.withDescription("Put one of your threads in a group. A thread belongs to one group."),
  Command.withHandler((flags) =>
    runWithSessionAccess(flags, (access) =>
      access.mutate(flags.as, {
        type: "group.thread.add",
        groupId: flags.group,
        threadId: flags.thread,
      }),
    ),
  ),
);

const groupInvite = Command.make("invite", {
  ...authLocationFlags,
  as: asFlag,
  group: groupArg,
  principal: principalArg,
  role: roleFlag,
}).pipe(
  Command.withDescription("Invite a principal to a group, or change their role."),
  Command.withHandler((flags) =>
    runWithSessionAccess(flags, (access) =>
      access.mutate(flags.as, {
        type: "group.member.invite",
        groupId: flags.group,
        principal: flags.principal,
        role: flags.role,
      }),
    ),
  ),
);

const groupRemove = Command.make("remove", {
  ...authLocationFlags,
  as: asFlag,
  group: groupArg,
  principal: principalArg,
}).pipe(
  Command.withDescription("Remove a member from a group."),
  Command.withHandler((flags) =>
    runWithSessionAccess(flags, (access) =>
      access.mutate(flags.as, {
        type: "group.member.remove",
        groupId: flags.group,
        principal: flags.principal,
      }),
    ),
  ),
);

export const groupCommand = Command.make("group").pipe(
  Command.withDescription("Manage session groups: threads shared with a set of principals."),
  Command.withSubcommands([
    groupCreate,
    groupList,
    groupDelete,
    groupAddThread,
    groupInvite,
    groupRemove,
  ]),
);

export const shareCommand = Command.make("share", {
  ...authLocationFlags,
  as: asFlag,
  thread: threadArg,
  principal: principalArg,
  role: roleFlag,
}).pipe(
  Command.withDescription("Share one of your threads with a principal."),
  Command.withHandler((flags) =>
    runWithSessionAccess(flags, (access) =>
      access.mutate(flags.as, {
        type: "thread.share",
        threadId: flags.thread,
        principal: flags.principal,
        role: flags.role,
      }),
    ),
  ),
);

export const unshareCommand = Command.make("unshare", {
  ...authLocationFlags,
  as: asFlag,
  thread: threadArg,
  principal: principalArg,
}).pipe(
  Command.withDescription("Stop sharing one of your threads with a principal."),
  Command.withHandler((flags) =>
    runWithSessionAccess(flags, (access) =>
      access.mutate(flags.as, {
        type: "thread.unshare",
        threadId: flags.thread,
        principal: flags.principal,
      }),
    ),
  ),
);
