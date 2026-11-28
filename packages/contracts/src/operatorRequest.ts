import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { NodeId, RunId, ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

const IsoDateTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
);

const ExpiresAt = IsoDateTime.check(
  Schema.makeFilter(
    (value) => {
      const date = DateTime.make(`${value.slice(0, 10)}T00:00:00Z`);
      return (
        Number.isFinite(Date.parse(value)) &&
        Option.isSome(date) &&
        DateTime.formatIso(date.value).startsWith(value.slice(0, 10))
      );
    },
    { expected: "a valid ISO 8601 timestamp" },
  ),
);

const isJson = Schema.is(Schema.Json);
const secretKey =
  /^(?:authorization|cookie|setcookie|password|passphrase|secret|token|accesstoken|refreshtoken|apikey|privatekey|credential|credentials)$/i;
const Metadata = Schema.Record(Schema.String, Schema.Unknown)
  .check(
    Schema.makeFilter(
      (value) => {
        try {
          let hasSecretKey = false;
          const json = JSON.stringify(value, (key, entry: unknown) => {
            hasSecretKey ||= secretKey.test(key.replace(/[-_]/g, ""));
            return entry;
          });
          return !hasSecretKey && new TextEncoder().encode(json).length <= 4096 && isJson(value);
        } catch {
          return false;
        }
      },
      { expected: "non-secret JSON metadata of at most 4096 bytes" },
    ),
  )
  .annotate({
    description:
      "Non-secret JSON metadata (up to 4096 bytes). Never include credentials or private answers.",
  });

export const OperatorRequestKind = Schema.Literals(["vagrant", "agenix", "ops", "custom"]);
export type OperatorRequestKind = typeof OperatorRequestKind.Type;
export const OperatorRequestPrivilege = Schema.Literals([
  "user",
  "fido2-user",
  "elevated-external",
]);
export type OperatorRequestPrivilege = typeof OperatorRequestPrivilege.Type;
export const OPERATOR_REQUEST_TERMINAL_STATUSES = [
  "submitted",
  "declined",
  "cancelled",
  "expired",
] as const;
export const OperatorRequestStatus = Schema.Literals([
  "pending",
  "active",
  ...OPERATOR_REQUEST_TERMINAL_STATUSES,
]);
export type OperatorRequestStatus = typeof OperatorRequestStatus.Type;
export function isOperatorRequestTerminalStatus(
  status: OperatorRequestStatus,
): status is (typeof OPERATOR_REQUEST_TERMINAL_STATUSES)[number] {
  return status !== "pending" && status !== "active";
}

export const OperatorRequestWaitMode = Schema.Literals(["sync", "async"]);
export type OperatorRequestWaitMode = typeof OperatorRequestWaitMode.Type;
export const OperatorRequestTimeoutPolicy = Schema.Literals(["demote_to_async", "cancel"]);
export type OperatorRequestTimeoutPolicy = typeof OperatorRequestTimeoutPolicy.Type;
export const OperatorRequestWaitPolicy = Schema.Struct({
  mode: OperatorRequestWaitMode,
  syncTimeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3_600_000 })),
  ),
  onTimeout: Schema.optional(OperatorRequestTimeoutPolicy),
});
export type OperatorRequestWaitPolicy = typeof OperatorRequestWaitPolicy.Type;

const Values = Schema.Record(Schema.String, Schema.Unknown);
export const OperatorRequestFieldType = Schema.Literals([
  "text",
  "textarea",
  "select",
  "multiselect",
  "boolean",
]);
export type OperatorRequestFieldType = typeof OperatorRequestFieldType.Type;
export const OperatorRequestFieldOption = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
  description: Schema.optional(Schema.String),
});
export type OperatorRequestFieldOption = typeof OperatorRequestFieldOption.Type;
export const OperatorRequestField = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: Schema.String,
  type: OperatorRequestFieldType,
  required: Schema.optional(Schema.Boolean),
  options: Schema.optional(Schema.Array(OperatorRequestFieldOption)),
  defaultValue: Schema.optional(Schema.Unknown),
});
export type OperatorRequestField = typeof OperatorRequestField.Type;
export const OperatorRequestQuickAction = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: Schema.String,
  style: Schema.optional(Schema.Literals(["primary", "secondary", "danger"])),
  payload: Schema.optional(Values),
});
export type OperatorRequestQuickAction = typeof OperatorRequestQuickAction.Type;
export const OperatorRequestInlineForm = Schema.Struct({
  fields: Schema.optional(Schema.Array(OperatorRequestField)),
  quickActions: Schema.optional(Schema.Array(OperatorRequestQuickAction)),
  allowFreeformNote: Schema.optional(Schema.Boolean),
});
export type OperatorRequestInlineForm = typeof OperatorRequestInlineForm.Type;
export const OperatorRequestDesktopAction = Schema.Struct({
  kind: Schema.Literal("vagrant"),
  requestId: TrimmedNonEmptyString,
  label: Schema.optional(Schema.String),
  socketPath: Schema.optional(Schema.String),
  commandHint: Schema.optional(Schema.String),
});
export type OperatorRequestDesktopAction = typeof OperatorRequestDesktopAction.Type;
export const OperatorRequestSurfaces = Schema.Struct({
  inlineForm: Schema.optional(OperatorRequestInlineForm),
  /** The preview host supplies a request-specific `token` query parameter. */
  previewUrl: Schema.optional(Schema.String),
  desktopAction: Schema.optional(OperatorRequestDesktopAction),
  cliCommand: Schema.optional(Schema.String),
});
export type OperatorRequestSurfaces = typeof OperatorRequestSurfaces.Type;

export const OperatorRequestDecidedVia = Schema.Literals([
  "inline",
  "preview",
  "desktop",
  "cli",
  "external",
]);
export type OperatorRequestDecidedVia = typeof OperatorRequestDecidedVia.Type;
export const OperatorRequestArtifact = Schema.Struct({
  label: Schema.String,
  path: Schema.String,
  sha256: Schema.optional(Schema.String),
});
export type OperatorRequestArtifact = typeof OperatorRequestArtifact.Type;
export const OperatorRequestReceiptMetadata = Schema.Struct({
  status: Schema.Literals(OPERATOR_REQUEST_TERMINAL_STATUSES),
  decidedAt: IsoDateTime,
  decidedVia: OperatorRequestDecidedVia,
  summary: Schema.optional(Schema.String),
  actionId: Schema.optional(Schema.String),
  receiptPath: Schema.optional(Schema.String),
  artifacts: Schema.optional(Schema.Array(OperatorRequestArtifact)),
});
export type OperatorRequestReceiptMetadata = typeof OperatorRequestReceiptMetadata.Type;
export const OperatorRequestReceipt = Schema.Struct({
  ...OperatorRequestReceiptMetadata.fields,
  answers: Schema.optional(Values),
  note: Schema.optional(Schema.String),
});
export type OperatorRequestReceipt = typeof OperatorRequestReceipt.Type;

const Target = {
  threadId: Schema.optional(ThreadId),
  runId: Schema.optional(RunId),
  nodeId: Schema.optional(NodeId),
  turnItemId: Schema.optional(TurnItemId),
};
const Description = {
  externalId: Schema.optional(TrimmedNonEmptyString),
  kind: OperatorRequestKind,
  privilege: OperatorRequestPrivilege,
  title: TrimmedNonEmptyString,
  reason: Schema.optional(Schema.String),
  surfaces: Schema.optional(OperatorRequestSurfaces),
  expiresAt: Schema.optional(ExpiresAt),
  metadata: Schema.optional(Metadata),
};
export const OperatorRequestCreateInput = Schema.Struct({
  ...Target,
  ...Description,
  requestId: Schema.optional(TrimmedNonEmptyString),
  waitPolicy: Schema.optional(OperatorRequestWaitPolicy),
});
export type OperatorRequestCreateInput = typeof OperatorRequestCreateInput.Type;
export const OperatorRequestRecord = Schema.Struct({
  ...Target,
  ...Description,
  surfaces: Schema.optional(
    OperatorRequestSurfaces.mapFields((fields) => ({
      ...fields,
      previewAvailable: Schema.optional(Schema.Literal(true)),
    })),
  ),
  requestId: TrimmedNonEmptyString,
  waitPolicy: OperatorRequestWaitPolicy,
  status: OperatorRequestStatus,
  demotedToAsync: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  receipt: Schema.optional(OperatorRequestReceiptMetadata),
});
export type OperatorRequestRecord = typeof OperatorRequestRecord.Type;
export const isOperatorRequestDue = (
  request: Pick<OperatorRequestRecord, "expiresAt" | "status">,
  nowMillis: number,
) =>
  !isOperatorRequestTerminalStatus(request.status) &&
  request.expiresAt !== undefined &&
  Date.parse(request.expiresAt) <= nowMillis;

export const OperatorRequestCreateResult = OperatorRequestRecord;
export type OperatorRequestCreateResult = OperatorRequestRecord;

const Lookup = {
  threadId: Target.threadId,
  requestId: Schema.optional(TrimmedNonEmptyString),
  turnItemId: Target.turnItemId,
  externalId: Description.externalId,
};
export const OperatorRequestStatusInput = Schema.Struct(Lookup);
export type OperatorRequestStatusInput = typeof OperatorRequestStatusInput.Type;
export const OperatorRequestStatusResult = OperatorRequestRecord;
export type OperatorRequestStatusResult = OperatorRequestRecord;
export const OperatorRequestAnswerInput = Schema.Struct({
  ...Lookup,
  status: Schema.Literals(["submitted", "declined", "cancelled"]),
  decidedVia: Schema.optional(OperatorRequestDecidedVia),
  summary: OperatorRequestReceiptMetadata.fields.summary,
  actionId: OperatorRequestReceiptMetadata.fields.actionId,
  answers: OperatorRequestReceipt.fields.answers,
  note: OperatorRequestReceipt.fields.note,
  receiptPath: OperatorRequestReceiptMetadata.fields.receiptPath,
  artifacts: OperatorRequestReceiptMetadata.fields.artifacts,
  wakeThread: Schema.optional(Schema.Boolean),
});
export type OperatorRequestAnswerInput = typeof OperatorRequestAnswerInput.Type;
export const OperatorRequestAnswerResult = OperatorRequestRecord;
export type OperatorRequestAnswerResult = OperatorRequestRecord;
export const OperatorRequestResolveInput = Schema.Struct({
  ...OperatorRequestAnswerInput.fields,
  status: OperatorRequestReceiptMetadata.fields.status,
});
export type OperatorRequestResolveInput = typeof OperatorRequestResolveInput.Type;
export const OperatorRequestResolveResult = OperatorRequestRecord;
export type OperatorRequestResolveResult = OperatorRequestRecord;
export const OperatorRequestCancelInput = Schema.Struct({
  ...Lookup,
  reason: Schema.optional(Schema.String),
});
export type OperatorRequestCancelInput = typeof OperatorRequestCancelInput.Type;
export const OperatorRequestCancelResult = OperatorRequestRecord;
export type OperatorRequestCancelResult = OperatorRequestRecord;
export const OperatorRequestListPendingInput = Schema.Struct({
  threadId: Target.threadId,
  kind: Schema.optional(OperatorRequestKind),
  includeTerminal: Schema.optional(Schema.Boolean),
});
export type OperatorRequestListPendingInput = typeof OperatorRequestListPendingInput.Type;
export const OperatorRequestListPendingResult = Schema.Struct({
  requests: Schema.Array(OperatorRequestRecord),
});
export type OperatorRequestListPendingResult = typeof OperatorRequestListPendingResult.Type;
export const OperatorRequestLaunchDesktopInput = Schema.Struct({
  threadId: Lookup.threadId,
  requestId: Lookup.requestId,
  turnItemId: Lookup.turnItemId,
});
export type OperatorRequestLaunchDesktopInput = typeof OperatorRequestLaunchDesktopInput.Type;
export const OperatorRequestLaunchDesktopResult = Schema.Struct({
  ok: Schema.Boolean,
  method: Schema.Literals(["socket", "spawn"]),
  requestId: TrimmedNonEmptyString,
  message: Schema.optional(Schema.String),
});
export type OperatorRequestLaunchDesktopResult = typeof OperatorRequestLaunchDesktopResult.Type;
export const OperatorRequestFailureReason = Schema.Literals([
  "not_found",
  "already_terminal",
  "invalid_request",
  "root_forbidden",
  "desktop_unavailable",
  "storage_failed",
]);
export type OperatorRequestFailureReason = typeof OperatorRequestFailureReason.Type;
export class OperatorRequestError extends Schema.TaggedError<OperatorRequestError>()(
  "OperatorRequestError",
  { reason: OperatorRequestFailureReason, message: Schema.String },
) {}
