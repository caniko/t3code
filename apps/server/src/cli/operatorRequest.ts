import { OperatorRequestListPendingResult, OperatorRequestRecord } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";

import {
  OperatorRequestCancelParameters,
  OperatorRequestCreateParameters,
  OperatorRequestListParameters,
  OperatorRequestResolveParameters,
  OperatorRequestStatusParameters,
} from "../mcp/toolkits/operatorRequest/tools.ts";
import { projectLocationFlags } from "./config.ts";
import {
  ThreadServerNotRunningError,
  ThreadServerUnreachableError,
  ThreadUsageError,
  withThreadTools,
} from "./thread.ts";
import { ThreadTransportError } from "./threadTransport.ts";

const usage = (detail: string) => new ThreadUsageError({ detail });
const jsonFlag = Flag.String("json").pipe(
  Flag.withDescription("JSON object, file path, or - to read stdin."),
  Flag.optional,
);
const optionalString = (name: string) => Flag.String(name).pipe(Flag.optional);
const threadFlag = optionalString("thread");
const lookupFlags = {
  requestId: optionalString("request-id"),
  externalId: optionalString("external-id"),
  threadId: threadFlag,
};

const readJson = Effect.fn("cli.operatorRequest.readJson")(function* <
  S extends Schema.Decoder<object>,
>(argument: Option.Option<string>, schema: S) {
  if (Option.isNone(argument))
    return yield* usage("Supply --json <file-or-inline-json> or --json -.");
  const value = argument.value;
  const text =
    value === "-"
      ? yield* Stdio.Stdio.pipe(
          Effect.flatMap((stdio) => stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)),
          Effect.mapError(() => usage("Could not read operator request JSON from stdin.")),
        )
      : /^\s*(?:\{|\[)/.test(value)
        ? value
        : yield* FileSystem.FileSystem.pipe(
            Effect.flatMap((fs) => fs.readFileString(value)),
            Effect.mapError(() => usage("Could not read operator request JSON file.")),
          );
  return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => usage("Invalid operator request JSON.")));
});

const decodeOptions = <S extends Schema.Decoder<object>>(schema: S, options: unknown) =>
  Schema.decodeUnknownEffect(schema)(options).pipe(
    Effect.mapError(() => usage("Invalid operator request options.")),
  );

const requireLookup = <T extends typeof OperatorRequestStatusParameters.Type>(input: T) =>
  (input.requestId === undefined) === (input.externalId === undefined)
    ? Effect.fail(usage("Supply exactly one request ID or external ID."))
    : Effect.succeed(input);

const call = <S extends Schema.Decoder<unknown>>(
  flags: { readonly baseDir: Option.Option<string> },
  tool: string,
  args: Readonly<Record<string, unknown>>,
  schema: S,
) =>
  withThreadTools(flags, (tools) => tools.call(tool, args, schema)).pipe(
    Effect.catchTags({
      ThreadToolFailedError: () =>
        Effect.fail(usage(`The T3 Code server rejected ${tool} or returned an invalid result.`)),
    }),
    Effect.flatMap((result) => Console.log(JSON.stringify(result))),
  );

const isReportedError = Schema.is(
  Schema.Union([
    ThreadUsageError,
    ThreadServerNotRunningError,
    ThreadServerUnreachableError,
    ThreadTransportError,
  ]),
);
const reportErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      isReportedError(error)
        ? usage(error.message)
        : usage("Could not connect to the T3 Code operator request service."),
    ),
    Effect.tapError((error) => Console.error(error.message)),
    Effect.provideService(Logger.LogToStderr, true),
  );

const createCommand = Command.make("create", { ...projectLocationFlags, json: jsonFlag }).pipe(
  Command.withHandler((flags) =>
    readJson(flags.json, OperatorRequestCreateParameters).pipe(
      Effect.flatMap((input) => call(flags, "t3_operator_request", input, OperatorRequestRecord)),
      reportErrors,
    ),
  ),
);

const resolveCommand = Command.make("resolve", { ...projectLocationFlags, json: jsonFlag }).pipe(
  Command.withHandler((flags) =>
    readJson(flags.json, OperatorRequestResolveParameters).pipe(
      Effect.flatMap(requireLookup),
      Effect.flatMap((input) =>
        call(flags, "t3_operator_request_resolve", input, OperatorRequestRecord),
      ),
      reportErrors,
    ),
  ),
);

const lookupOptions = (flags: {
  readonly requestId: Option.Option<string>;
  readonly externalId: Option.Option<string>;
  readonly threadId: Option.Option<string>;
}) => ({
  requestId: Option.getOrUndefined(flags.requestId),
  externalId: Option.getOrUndefined(flags.externalId),
  threadId: Option.getOrUndefined(flags.threadId),
});

const statusCommand = Command.make("status", { ...projectLocationFlags, ...lookupFlags }).pipe(
  Command.withHandler((flags) =>
    decodeOptions(OperatorRequestStatusParameters, lookupOptions(flags)).pipe(
      Effect.flatMap(requireLookup),
      Effect.flatMap((input) =>
        call(flags, "t3_operator_request_status", input, OperatorRequestRecord),
      ),
      reportErrors,
    ),
  ),
);

const listCommand = Command.make("list", {
  ...projectLocationFlags,
  threadId: threadFlag,
  pending: Flag.Boolean("pending").pipe(Flag.withDefault(false)),
  kind: optionalString("kind"),
}).pipe(
  Command.withHandler((flags) =>
    decodeOptions(OperatorRequestListParameters, {
      threadId: Option.getOrUndefined(flags.threadId),
      pending: flags.pending || undefined,
      kind: Option.getOrUndefined(flags.kind),
    }).pipe(
      Effect.flatMap((input) =>
        call(flags, "t3_operator_request_list", input, OperatorRequestListPendingResult),
      ),
      reportErrors,
    ),
  ),
);

const cancelCommand = Command.make("cancel", {
  ...projectLocationFlags,
  ...lookupFlags,
  reason: optionalString("reason"),
}).pipe(
  Command.withHandler((flags) =>
    decodeOptions(OperatorRequestCancelParameters, {
      ...lookupOptions(flags),
      reason: Option.getOrUndefined(flags.reason),
    }).pipe(
      Effect.flatMap(requireLookup),
      Effect.flatMap((input) =>
        call(flags, "t3_operator_request_cancel", input, OperatorRequestRecord),
      ),
      reportErrors,
    ),
  ),
);

export const operatorRequestCommand = Command.make("operator-request").pipe(
  Command.withDescription("Create, inspect, and decide operator requests on the running server."),
  Command.withSubcommands([
    createCommand,
    resolveCommand,
    statusCommand,
    listCommand,
    cancelCommand,
  ]),
);
