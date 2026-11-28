import {
  OperatorRequestCancelInput,
  OperatorRequestCreateInput,
  OperatorRequestDecidedVia,
  OperatorRequestListPendingInput,
  OperatorRequestRecord,
  OperatorRequestReceipt,
  OperatorRequestResolveInput,
  OperatorRequestStatusInput,
  OperatorRequestSurfaces,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";

const { threadId, kind, privilege, title, externalId, surfaces, waitPolicy, expiresAt, metadata } =
  OperatorRequestCreateInput.fields;
const lookup = { threadId, externalId, requestId: OperatorRequestStatusInput.fields.requestId };

export const OperatorRequestCreateParameters = Schema.Struct({
  threadId,
  kind,
  privilege,
  title,
  summary: TrimmedNonEmptyString,
  prompt: Schema.optional(Schema.String),
  externalId,
  surfaces,
  waitPolicy,
  expiresAt,
  metadata,
});
export const OperatorRequestStatusParameters = Schema.Struct(lookup);
export const OperatorRequestListParameters = Schema.Struct({
  threadId,
  pending: Schema.optional(Schema.Boolean),
  kind: OperatorRequestListPendingInput.fields.kind,
});
const { status, summary, actionId, answers, receiptPath, artifacts, wakeThread } =
  OperatorRequestResolveInput.fields;
export const OperatorRequestResolveParameters = Schema.Struct({
  ...lookup,
  status,
  decidedVia: OperatorRequestDecidedVia,
  summary,
  actionId,
  answers,
  receiptPath,
  artifacts,
  wakeThread,
});
export const OperatorRequestCancelParameters = Schema.Struct({
  ...lookup,
  reason: OperatorRequestCancelInput.fields.reason,
});

const mcpRecord = Schema.Struct({
  ...OperatorRequestRecord.fields,
  // The preview URL carries the operator's write-capable bearer token.
  surfaces: Schema.optional(OperatorRequestSurfaces.mapFields(Struct.omit(["previewUrl"]))),
});
const shared = {
  success: mcpRecord,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext, ThreadManagementService],
};
const withPrivateReceipt = Schema.Struct({
  ...mcpRecord.fields,
  privateReceipt: Schema.optional(OperatorRequestReceipt),
});

export const OperatorRequestToolkit = Toolkit.make(
  Tool.make("t3_operator_request", {
    ...shared,
    success: withPrivateReceipt,
    description:
      "Ask the operator for input. Defaults to this thread and async; sync can demote on timeout.",
    parameters: OperatorRequestCreateParameters,
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_operator_request_status", {
    ...shared,
    success: withPrivateReceipt,
    description: "Read an operator request by requestId or externalId.",
    parameters: OperatorRequestStatusParameters,
  }).annotate(Tool.Readonly, true),
  Tool.make("t3_operator_request_list", {
    ...shared,
    description: "List operator requests. Set pending to exclude terminal requests.",
    parameters: OperatorRequestListParameters,
    success: Schema.Struct({ requests: Schema.Array(mcpRecord) }),
  }).annotate(Tool.Readonly, true),
  Tool.make("t3_operator_request_resolve", {
    ...shared,
    description: "Record an operator decision. Requires a writable operator credential.",
    parameters: OperatorRequestResolveParameters,
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_operator_request_cancel", {
    ...shared,
    description: "Cancel an operator request. Requires a writable operator credential.",
    parameters: OperatorRequestCancelParameters,
  }).annotate(Tool.Destructive, true),
);
