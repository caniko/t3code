import {
  OrchestratorMcpFailure,
  type OperatorRequestError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { canAccessThread, type ThreadAction } from "../../../orchestration-v2/ThreadOwnership.ts";
import { OperatorRequests } from "../../../operatorRequests/OperatorRequests.ts";
import { assertSameLink } from "../../linkOrigin.ts";
import * as Access from "../../McpToolAccess.ts";
import { callerPrincipal, readCaller, unavailable, type Caller } from "../../threadAccess.ts";
import {
  OperatorRequestToolkit,
  type OperatorRequestCancelParameters,
  type OperatorRequestCreateParameters,
  type OperatorRequestListParameters,
  type OperatorRequestResolveParameters,
  type OperatorRequestStatusParameters,
} from "./tools.ts";

const missing = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: "Operator request was not found.",
  });

const requestFailure = (error: OperatorRequestError) =>
  error.reason === "storage_failed"
    ? unavailable()
    : new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const visible = Effect.fn("mcp.operatorRequest.visible")(function* (
  caller: Caller,
  threadId: ThreadId | undefined,
  action: ThreadAction,
) {
  const principal = callerPrincipal(caller);
  if (threadId === undefined) {
    return caller.scope.thread === undefined && caller.scope.client?.linked !== true;
  }
  const thread =
    caller.caller?.id === threadId
      ? caller.caller
      : yield* caller.threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
  return (
    thread !== null &&
    thread.deletedAt === null &&
    canAccessThread(principal, thread, action) &&
    (action === "read" || (yield* assertSameLink(caller, thread).pipe(Effect.isSuccess)))
  );
});

const requestScope = (caller: Caller, action: ThreadAction) => ({
  ownerPrincipal:
    caller.scope.thread !== undefined || caller.scope.client?.linked === true
      ? null
      : callerPrincipal(caller),
  allowThread: (threadId: ThreadId) => visible(caller, threadId, action),
});

export const layer = Access.toLayer(
  OperatorRequestToolkit,
  Effect.gen(function* () {
    const requests = yield* OperatorRequests;
    const lookup = Effect.fn("mcp.operatorRequest.lookup")(function* (
      input: typeof OperatorRequestStatusParameters.Type,
      caller: Caller,
      action: ThreadAction,
    ) {
      const threadId = input.threadId ?? caller.scope.thread?.threadId;
      if (threadId !== undefined && !(yield* visible(caller, threadId, action))) {
        return yield* missing();
      }
      return yield* requests
        .status({ ...input, threadId }, requestScope(caller, action))
        .pipe(Effect.mapError(requestFailure));
    });
    return {
      t3_operator_request: Access.createsOperatorRequest(
        (input: typeof OperatorRequestCreateParameters.Type, caller) =>
          Effect.gen(function* () {
            const { summary, prompt, ...request } = input;
            const threadId = request.threadId ?? caller.scope.thread?.threadId;
            if (!(yield* visible(caller, threadId, "write"))) {
              return yield* new OrchestratorMcpFailure({
                code: "capability_denied",
                message: "This credential cannot create operator requests for that target.",
              });
            }
            return yield* requests
              .create(
                {
                  ...request,
                  ...(threadId === undefined ? {} : { threadId }),
                  reason: prompt ? `${summary}\n\n${prompt}` : summary,
                },
                requestScope(caller, "write"),
              )
              .pipe(Effect.mapError(requestFailure));
          }),
      ),
      t3_operator_request_status: Access.reads(
        (input: typeof OperatorRequestStatusParameters.Type) =>
          readCaller().pipe(Effect.flatMap((caller) => lookup(input, caller, "read"))),
      ),
      t3_operator_request_list: Access.reads((input: typeof OperatorRequestListParameters.Type) =>
        Effect.gen(function* () {
          const caller = yield* readCaller();
          const threadId = input.threadId ?? caller.scope.thread?.threadId;
          if (threadId !== undefined && !(yield* visible(caller, threadId, "read"))) {
            return yield* missing();
          }
          return yield* requests
            .listPending(
              {
                threadId,
                kind: input.kind,
                includeTerminal: input.pending !== true,
              },
              requestScope(caller, "read"),
            )
            .pipe(Effect.mapError(requestFailure));
        }),
      ),
      t3_operator_request_resolve: Access.decidesOperatorRequest(
        (input: typeof OperatorRequestResolveParameters.Type, caller) =>
          Effect.gen(function* () {
            const { requestId, threadId } = yield* lookup(input, caller, "write");
            return yield* requests
              .resolve({ ...input, requestId, threadId }, requestScope(caller, "write"))
              .pipe(Effect.mapError(requestFailure));
          }),
      ),
      t3_operator_request_cancel: Access.decidesOperatorRequest(
        (input: typeof OperatorRequestCancelParameters.Type, caller) =>
          Effect.gen(function* () {
            const { requestId, threadId } = yield* lookup(input, caller, "write");
            return yield* requests
              .cancel({ ...input, requestId, threadId }, requestScope(caller, "write"))
              .pipe(Effect.mapError(requestFailure));
          }),
      ),
    };
  }),
);
