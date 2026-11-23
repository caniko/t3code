// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite and lstat read the native session log.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ProtobufReader } from "effect/protobuf";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";

import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

// CORTEX_STEP_TYPE_ERROR_MESSAGE in the native trajectory.
const ERROR_STEP_TYPE = 17;
// CORTEX_STEP_TYPE_PLANNER_RESPONSE: the model answered within this turn.
const PLANNER_RESPONSE_STEP_TYPE = 15;
// The harness error text leads the payload; a Go stack trace follows it.
const MAX_ERROR_PAYLOAD_BYTES = 16_384;
const POOL_DENIAL = "request failed (code 429): all eligible accounts are rate limited";
const GOOGLE_POOL_DENIAL = "RESOURCE_EXHAUSTED (code 429): all eligible accounts are rate limited";
const POOL_DENIALS = [POOL_DENIAL, GOOGLE_POOL_DENIAL].map((message) => ({
  message,
  bytes: new TextEncoder().encode(message),
}));
const POOL_QUOTA_HEADER = /^x-fleetix-pool-quota$/i;
const MAX_POOL_RESET_MS = 7 * 24 * 60 * 60 * 1000;
// The Go harness's rendering of a Google API error, as the agent's api_errors.py reads it.
// Status is a gRPC code, or an HTTP status line such as "502 Bad Gateway". A message
// stops at the next error, so each start scans its own span and the match stays linear.
const API_ERROR =
  /Error (\d{3}), Message: ((?:(?!, Status: |Error \d{3}, Message: ).)+), Status: ([A-Z_]+|\d{3}[^,\r\n]*)/s;
// Antigravity 1.5 with a Google account writes "STATUS (code NNN): message" in a protobuf string
// whose length varint (65-90, 95) can be an uppercase ASCII byte immediately before STATUS.
const STATUS_ERROR =
  /(CANCELLED|UNKNOWN|INVALID_ARGUMENT|DEADLINE_EXCEEDED|NOT_FOUND|ALREADY_EXISTS|PERMISSION_DENIED|RESOURCE_EXHAUSTED|FAILED_PRECONDITION|ABORTED|OUT_OF_RANGE|UNIMPLEMENTED|INTERNAL|UNAVAILABLE|DATA_LOSS|UNAUTHENTICATED) \(code (\d{3})\): (\P{Cc}+)/u;
// Newer Antigravity builds attach the HTTP JSON body (pretty-printed or compact) to the error step.
const ERROR_JSON_START = /\{\s*"error"\s*:/g;
const decodeVerificationError = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({
        code: Schema.Literal(403),
        status: Schema.Literal("PERMISSION_DENIED"),
        details: Schema.Array(Schema.Unknown),
      }),
    }),
  ),
);
const decodeVerificationErrorInfo = Schema.decodeUnknownOption(
  Schema.Struct({
    "@type": Schema.Literal("type.googleapis.com/google.rpc.ErrorInfo"),
    domain: Schema.Literal("cloudcode-pa.googleapis.com"),
    reason: Schema.Literal("VALIDATION_REQUIRED"),
    metadata: Schema.optionalKey(
      Schema.NullOr(Schema.Struct({ validation_url: Schema.optionalKey(Schema.Unknown) })),
    ),
  }),
);
const QUOTA_EXHAUSTED = /(?:"reason"\s*:\s*"QUOTA_EXHAUSTED"|\breason:QUOTA_EXHAUSTED\b)/;
// Claude rejects a saved thinking block without a valid signature. It sits in the native
// history, so every later prompt to that session fails the same way.
const INVALID_THINKING_SIGNATURE =
  /\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block)/;
const GO_DURATION = "(?:\\d+(?:\\.\\d+)?(?:ns|us|µs|μs|ms|h|m|s))+";
const delayPattern = (field: string) =>
  new RegExp(
    `(?:"${field}"\\s*:\\s*"(${GO_DURATION})"|\\b${field}:(${GO_DURATION})(?=[\\s\\],}]|$))`,
  );
const RESET_TIMESTAMP =
  /(?:"quotaResetTimeStamp"\s*:\s*"([^"\s]+)"|\bquotaResetTimeStamp:([^\s\],}]+))/;
const RESET_DELAY = delayPattern("quotaResetDelay");
// google.rpc.RetryInfo, which plain rate limits carry instead of a quota reset.
const RETRY_DELAY = delayPattern("retryDelay");
// Antigravity 1.5 may state the reset only in the message: "... Resets in 4m42s.".
const RESETS_IN = /\bResets in ((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?!\w|\.\d)/;
const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g;
const GO_DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};
const NATIVE_SESSION_ID = /^[\w-]+$/;

interface LastStep {
  readonly type: number;
  readonly payload: Uint8Array | null;
  readonly reachedModel: boolean;
}

class AntigravitySessionLogError extends Schema.TaggedError<AntigravitySessionLogError>()(
  "AntigravitySessionLogError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the Antigravity session log.";
  }
}

const sessionLogError = (cause: unknown) => new AntigravitySessionLogError({ cause });

const readSteps = <A>(file: string, read: (database: NodeSqlite.DatabaseSync) => A) =>
  Effect.try({
    try: () => {
      const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
      try {
        database.exec("PRAGMA busy_timeout = 100");
        const hasSteps =
          database
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'")
            .get() !== undefined;
        return hasSteps ? read(database) : undefined;
      } finally {
        database.close();
      }
    },
    catch: sessionLogError,
  });

const lastStepIndex = (database: NodeSqlite.DatabaseSync) => {
  const index = database.prepare("SELECT max(idx) AS idx FROM steps").get()?.idx;
  return typeof index === "number" ? index : -1;
};

const lastStepAfter =
  (index: number) =>
  (database: NodeSqlite.DatabaseSync): LastStep | undefined => {
    const row = database
      .prepare(
        `SELECT step_type AS type, substr(step_payload, 1, ?) AS payload
         FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1`,
      )
      .get(MAX_ERROR_PAYLOAD_BYTES, index);
    if (typeof row?.type !== "number") return undefined;
    const reachedModel =
      database
        .prepare("SELECT 1 FROM steps WHERE idx > ? AND step_type = ? LIMIT 1")
        .get(index, PLANNER_RESPONSE_STEP_TYPE) !== undefined;
    return {
      type: row.type,
      payload: row.payload instanceof Uint8Array ? row.payload : null,
      reachedModel,
    };
  };

function matchedValue(match: RegExpExecArray | null): string | undefined {
  return match?.[1] ?? match?.[2];
}

function parsePositiveDelayMs(delay: string | undefined): number | undefined {
  if (delay === undefined) return undefined;
  let delayMs = 0;
  for (const [, amount, unit] of delay.matchAll(GO_DURATION_PART)) {
    delayMs += Number(amount) * (GO_DURATION_UNIT_MS[unit!] ?? 0);
  }
  return delayMs > 0 ? Math.ceil(delayMs) : undefined;
}

function resetAtFrom(text: string, now: DateTime.Utc | undefined): string | undefined {
  // makeProviderFailure drops an unparsable timestamp, and recovery ignores one at or before now.
  const timestamp = matchedValue(RESET_TIMESTAMP.exec(text));
  const parsedTimestamp = timestamp === undefined ? Option.none() : DateTime.make(timestamp);
  if (
    Option.isSome(parsedTimestamp) &&
    (now === undefined || DateTime.isGreaterThan(parsedTimestamp.value, now))
  ) {
    return timestamp;
  }
  if (now === undefined) return undefined;
  const delayMs =
    parsePositiveDelayMs(matchedValue(RESET_DELAY.exec(text))) ??
    parsePositiveDelayMs(matchedValue(RETRY_DELAY.exec(text))) ??
    parsePositiveDelayMs(RESETS_IN.exec(text)?.[1]);
  return delayMs !== undefined
    ? DateTime.formatIso(DateTime.add(now, { milliseconds: delayMs }))
    : Option.isSome(parsedTimestamp)
      ? timestamp
      : undefined;
}

// Reorders STATUS_ERROR's groups to API_ERROR's: HTTP status, message, status name.
function statusError(text: string) {
  const match = STATUS_ERROR.exec(text);
  return match === null ? null : ([match[0], match[2], match[3], match[1]] as const);
}

function balancedJsonObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function verificationErrorInfo(text: string) {
  for (const match of text.matchAll(ERROR_JSON_START)) {
    const json = balancedJsonObject(text, match.index);
    if (json === undefined) continue;
    const response = Option.getOrUndefined(decodeVerificationError(json));
    if (response === undefined) continue;
    for (const detail of response.error.details) {
      const info = Option.getOrUndefined(decodeVerificationErrorInfo(detail));
      if (info !== undefined) return info;
    }
  }
  return undefined;
}

function delimitedField(bytes: Uint8Array, field: number) {
  const reader = ProtobufReader.make(bytes);
  let value: Uint8Array | undefined;
  while (!reader.isDone()) {
    const tag = reader.tag();
    if (
      ProtobufReader.fieldNumber(tag) === field &&
      ProtobufReader.wireType(tag) === ProtobufReader.WireType.Len
    ) {
      value = reader.bytesView();
    } else {
      reader.skip(tag);
    }
  }
  return value;
}

function poolDenial(payload: Uint8Array, trustHeader: boolean, now: DateTime.Utc | undefined) {
  try {
    // Antigravity 1.5.12 stores the normalized message at 24.3.2 and 24.3.9, not in HTTP diagnostics.
    const errorStep = delimitedField(payload, 24);
    const error = errorStep && delimitedField(errorStep, 3);
    if (error === undefined) return undefined;
    for (const field of [2, 9]) {
      const normalized = delimitedField(error, field);
      const match =
        normalized && POOL_DENIALS.find(({ bytes }) => Buffer.compare(normalized, bytes) === 0);
      if (match === undefined) continue;
      const { message } = match;
      if (!trustHeader || now === undefined) return { message };
      const diagnostic = delimitedField(error, 3);
      return {
        message,
        resetAt:
          diagnostic === undefined
            ? undefined
            : poolQuotaResetAt(diagnostic, DateTime.toEpochMillis(now)),
      };
    }
  } catch (error) {
    if (error instanceof ProtobufReader.ProtobufReaderError) return undefined;
    throw error;
  }
}

function poolQuotaResetAt(diagnostic: Uint8Array, nowMs: number): string | undefined {
  const bytes = Buffer.from(diagnostic);
  const lf = bytes.indexOf("\n\n");
  const crlf = bytes.indexOf("\r\n\r\n");
  const headEnd = lf < 0 ? crlf : crlf < 0 ? lf : Math.min(lf, crlf);
  if (headEnd < 0) return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, headEnd),
    );
    const [status, ...head] = text.split(/\r?\n/);
    if (!/^HTTP(?:\/1\.[01])? 429 /.test(status ?? "")) return undefined;
    const headers = head.filter((line) => line.startsWith("Headers: "));
    if (headers.length !== 1) return undefined;
    const json = headers[0]!.slice("Headers: ".length);
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    // JSON.parse collapses exact duplicate keys, so count decoded key tokens before trusting it.
    const keys = [...json.matchAll(/("(?:[^"\\]|\\.)*")\s*(:)?/g)].filter(
      ([, token, colon]) => colon !== undefined && POOL_QUOTA_HEADER.test(JSON.parse(token!)),
    );
    if (keys.length !== 1) return undefined;
    const values: unknown = Object.entries(parsed).find(([key]) =>
      POOL_QUOTA_HEADER.test(key),
    )?.[1];
    if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== "string")
      return undefined;
    const [version, ...fields] = values[0].split(";");
    if (version !== "v1" || fields.length !== 2) return undefined;
    const stamp = fields.find((field) => field.startsWith("retry_at="))?.slice("retry_at=".length);
    const model = fields
      .find((field) => field.startsWith("wire_model="))
      ?.slice("wire_model=".length);
    if (
      !model ||
      /[\s\p{Cc}\p{Cf}]/u.test(model) ||
      stamp === undefined ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(stamp)
    )
      return undefined;
    const parsedStamp = DateTime.make(stamp);
    if (Option.isNone(parsedStamp)) return undefined;
    const ms = DateTime.toEpochMillis(parsedStamp.value);
    if (
      Number.isFinite(ms) &&
      ms > nowMs &&
      ms <= nowMs + MAX_POOL_RESET_MS &&
      DateTime.formatIso(parsedStamp.value).slice(0, 19) === stamp.slice(0, 19)
    )
      return stamp;
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
  }
}

function turnFailure(
  stopReason: EffectAcpSchema.StopReason,
  step: LastStep | undefined,
  now: DateTime.Utc | undefined,
  trustFleetixPoolQuotaHeader = false,
  retired = false,
):
  | {
      readonly failure: OrchestrationV2ProviderFailure;
      readonly threadDisposition: "reusable" | "broken";
      readonly resumeWith?: string;
    }
  | undefined {
  const payload = step?.type === ERROR_STEP_TYPE ? step.payload : undefined;
  if (payload === undefined && stopReason !== "refusal") return undefined;
  const reusable = (failure: OrchestrationV2ProviderFailure) =>
    ({ failure, threadDisposition: "reusable" }) as const;
  const pool = payload == null ? undefined : poolDenial(payload, trustFleetixPoolQuotaHeader, now);
  if (pool !== undefined) {
    return reusable(
      makeProviderFailure({
        class: "usage_limit",
        message: pool.message,
        code: "FLEETIX_POOL_QUOTA",
        retryable: true,
        resetAt: pool.resetAt ?? null,
      }),
    );
  }
  const text = payload == null ? "" : new TextDecoder().decode(payload);
  const apiError = API_ERROR.exec(text) ?? statusError(text);
  // The agent maps only the SDK's QUOTA_EXHAUSTED stop reason to `refusal`.
  if (stopReason === "refusal" || QUOTA_EXHAUSTED.test(text)) {
    return reusable(
      makeProviderFailure({
        class: "usage_limit",
        message: "You have reached your Antigravity quota for this period.",
        code: apiError?.[3] ?? "QUOTA_EXHAUSTED",
        retryable: true,
        resetAt: resetAtFrom(text, retired ? undefined : now) ?? null,
      }),
    );
  }
  if (INVALID_THINKING_SIGNATURE.test(text)) {
    return {
      failure: makeProviderFailure({
        class: "provider_error",
        message:
          "Antigravity's saved conversation can no longer be sent to the model. The next message starts a fresh Antigravity session with this thread's context.",
        code: "INVALID_THINKING_SIGNATURE",
        retryable: true,
      }),
      threadDisposition: "broken",
    };
  }
  const verification = verificationErrorInfo(text);
  if (verification !== undefined) {
    return reusable(
      makeProviderFailure({
        class: "permission_error",
        message: "Verify your Google account, then retry this turn.",
        code: "VALIDATION_REQUIRED",
        retryable: false,
        verificationUrl: verification.metadata?.validation_url,
      }),
    );
  }
  if (apiError === null) {
    return reusable(
      makeProviderFailure({
        class: "provider_error",
        message: "Antigravity stopped this turn because of an error.",
      }),
    );
  }
  const [, httpStatus, message, status] = apiError;
  const rateLimited = httpStatus === "429" || status === "RESOURCE_EXHAUSTED";
  // A 404 before the model answered is an unknown or unentitled model; after, a transient edge error.
  const transientNotFound = httpStatus === "404" && step?.reachedModel === true;
  const failure = makeProviderFailure({
    class: rateLimited ? "usage_limit" : "provider_error",
    message: message!.trim(),
    code: status ?? null,
    retryable: rateLimited || transientNotFound || Number(httpStatus) >= 500,
    resetAt: resetAtFrom(text, retired ? undefined : now) ?? null,
  });
  return transientNotFound
    ? { failure, threadDisposition: "reusable", resumeWith: "continue" }
    : reusable(failure);
}

const conversationSegments = ["antigravity-acp", "conversations"];

/**
 * Antigravity reports an upstream API failure as a chat message and `end_turn`. Its
 * session log ends that turn with an error step, so the check reads only steps the
 * current prompt added, read-only, from this session's own unlinked database. Without
 * that evidence a typed `refusal` still fails the turn.
 */
export const watchAntigravityPromptOutcome = Effect.fn("AntigravityTurnOutcome.watch")(function* (
  profileDirectory: string,
  sessionId: string,
  route?: { readonly trustFleetixPoolQuotaHeader?: boolean },
) {
  const typedOnly = (result: EffectAcpSchema.PromptResponse) =>
    DateTime.now.pipe(Effect.map((now) => turnFailure(result.stopReason, undefined, now)));
  if (!NATIVE_SESSION_ID.test(sessionId)) return typedOnly;
  const segments = [...conversationSegments, `${sessionId}.db`];
  const before = yield* Effect.tryPromise({
    try: async () => {
      const root = await antigravityProfileRoot(profileDirectory);
      if (root === undefined) return undefined;
      if ((await antigravityManagedPath(root, conversationSegments, "directory")) === undefined) {
        return undefined;
      }
      const database = await antigravityManagedPath(root, segments, "file");
      // A path that exists but fails the proof is a link or other foreign entry.
      if (database === undefined) {
        const present = await NodeFSP.lstat(NodePath.join(root, ...segments)).then(
          () => true,
          () => false,
        );
        return present ? undefined : { root, identity: undefined, startIndex: -1 };
      }
      return { root, identity: database.info, startIndex: undefined };
    },
    catch: sessionLogError,
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (before === undefined) {
    yield* Effect.logWarning("The Antigravity session log is not this session's own file.");
    return typedOnly;
  }
  const startIndex =
    before.startIndex ??
    (yield* readSteps(NodePath.join(before.root, ...segments), lastStepIndex).pipe(
      Effect.map((index) => index ?? -1),
      Effect.orElseSucceed(() => undefined),
    ));
  if (startIndex === undefined) {
    yield* Effect.logWarning("Could not read the Antigravity session log before the prompt.");
    return typedOnly;
  }
  return Effect.fn("AntigravityTurnOutcome.check")(function* (
    result: EffectAcpSchema.PromptResponse,
    options?: { readonly retired?: boolean },
  ) {
    // The same file as before the prompt, or one this prompt created, still unlinked.
    const after = yield* Effect.tryPromise({
      try: () => antigravityManagedPath(before.root, segments, "file"),
      catch: sessionLogError,
    }).pipe(Effect.orElseSucceed(() => undefined));
    const sameFile =
      after !== undefined &&
      (before.identity === undefined ||
        (after.info.dev === before.identity.dev && after.info.ino === before.identity.ino));
    const step = sameFile
      ? yield* readSteps(after.path, lastStepAfter(startIndex)).pipe(
          Effect.tapError(() =>
            Effect.logWarning("Could not read the Antigravity session log after the prompt."),
          ),
          Effect.orElseSucceed(() => undefined),
        )
      : undefined;
    // A retired prompt's check runs long after the error, so a relative delay has no anchor.
    const now = yield* DateTime.now;
    return turnFailure(
      result.stopReason,
      step,
      now,
      route?.trustFleetixPoolQuotaHeader === true,
      options?.retired === true,
    );
  });
});
