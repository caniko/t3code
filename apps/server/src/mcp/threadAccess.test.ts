import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { readThread } from "./threadAccess.ts";

const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
const client: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:thread-access"),
  requestNamespace: "client:thread-access",
  thread: undefined,
  client: { sessionId: "thread-access", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const readBare = (existing: ReadonlyArray<ThreadId>) =>
  readThread(bareId).pipe(
    Effect.flip,
    Effect.provideService(McpInvocationContext.McpInvocationContext, client),
    Effect.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(existing.includes(threadId) ? liveThreadShell(threadId) : null),
      }),
    ),
  );

it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
  Effect.gen(function* () {
    const error = yield* readBare([ThreadId.make(`mcp:${bareId}`)]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe(`The thread was not found. Did you mean \`mcp:${bareId}\`?`);
  }),
);

it.effect.each([
  { caller: undefined, owner: "alice", visible: true },
  { caller: "bob", owner: "alice", visible: false },
  { caller: "alice", owner: undefined, visible: false },
  { caller: "alice", owner: "alice", visible: true },
])(
  "hides a thread of another principal from $caller callers like a missing one",
  ({ caller, owner, visible }) =>
    Effect.gen(function* () {
      const target = ThreadId.make("thread:owned");
      const callerThread = ThreadId.make("thread:caller");
      const shells = new Map([
        [
          target,
          { ...liveThreadShell(target), ...(owner === undefined ? {} : { ownerPrincipal: owner }) },
        ],
        [
          callerThread,
          {
            ...liveThreadShell(callerThread),
            ...(caller === undefined ? {} : { ownerPrincipal: caller }),
          },
        ],
      ]);
      const result = yield* readThread(target).pipe(
        Effect.result,
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...client,
          thread: caller === undefined ? undefined : { threadId: callerThread },
        } as McpInvocationContext.McpInvocationScope),
        Effect.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
            getProjectThreadRecords: () => Effect.succeed({ thread: shells.get(target) } as never),
          }),
        ),
      );
      expect(result._tag).toBe(visible ? "Success" : "Failure");
      if (!visible && result._tag === "Failure")
        expect(result.failure.code).toBe("thread_not_found");
    }),
);
