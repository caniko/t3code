import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  isOperatorRequestTerminalStatus,
  type OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { McpSchema, McpServer } from "effect/ai";

import * as OperatorRequests from "../operatorRequests/OperatorRequests.ts";
import {
  DispatchModeLimit,
  exceededDispatchModeLimit,
} from "../orchestration-v2/DispatchModeLimit.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { layerInProcessMcpServer, layerOperatorRequestToolkit } from "./McpHttpServer.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import * as Testkit from "./McpToolAccess.testkit.ts";

const operator = {
  environmentId: EnvironmentId.make("operator-request-mcp"),
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
  requestNamespace: "operator",
  thread: undefined,
  client: { sessionId: "operator", label: "CLI", access: "full-access" },
} satisfies McpInvocationScope;

const profile = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "operator-request-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "operator-request-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const create = {
  kind: "custom",
  privilege: "user",
  title: "Review output",
  summary: "Check the generated report.",
  externalId: "report-1",
};
const ownThread = ThreadId.make("caller");
const otherThread = ThreadId.make("another-thread");
const caller = {
  ...operator,
  client: undefined,
  thread: {
    threadId: ownThread,
    providerInstanceId: Testkit.liveThreadShell(ownThread).providerInstanceId,
    providerSessionId: "caller",
  },
};
const RequestCreated = Context.Reference<Deferred.Deferred<void> | undefined>(
  "test/OperatorRequestMcp/RequestCreated",
  { defaultValue: () => undefined },
);

const call = (name: string, args: Record<string, unknown>, scope: McpInvocationScope = operator) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, profile),
  );

const layerTest = layerOperatorRequestToolkit.pipe(
  Layer.provideMerge(layerInProcessMcpServer),
  Layer.provide(
    Layer.mock(ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed({
          ...Testkit.liveThreadShell(threadId),
          ownerPrincipal: threadId === ownThread ? "alice" : "bob",
        }),
    }),
  ),
  Layer.provideMerge(
    Layer.effect(
      OperatorRequests.OperatorRequests,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cards = new Map<
          string,
          Extract<OrchestrationV2TurnItem, { type: "operator_request" }>
        >();
        return yield* OperatorRequests.make({
          stateDir: yield* fs.makeTempDirectoryScoped(),
          desktop: { getUid: () => 1000 },
          projection: {
            getThread: () => Effect.succeed({}),
            listOperatorRequests: (input) =>
              Effect.sync(() =>
                [...cards.values()].filter(
                  (card) =>
                    (input.threadId === undefined || input.threadId === card.threadId) &&
                    (input.turnItemId === undefined || input.turnItemId === card.id) &&
                    (input.requestId === undefined || input.requestId === card.request.requestId) &&
                    (input.externalId === undefined ||
                      input.externalId === card.request.externalId) &&
                    (input.includeTerminal === true ||
                      !isOperatorRequestTerminalStatus(card.request.status)),
                ),
              ),
          },
          orchestrator: {
            dispatch: (command) =>
              Effect.gen(function* () {
                if (command.type !== "operator_request.record")
                  throw new Error("Unexpected command.");
                const limit = yield* DispatchModeLimit;
                const modes = { runtimeMode: "full-access", interactionMode: "default" } as const;
                const mode =
                  limit === undefined ? undefined : exceededDispatchModeLimit(limit, modes);
                if (mode !== undefined) {
                  if (limit?.refused !== undefined) {
                    yield* Ref.set(limit.refused, { threadId: command.threadId, ...modes, mode });
                  }
                  return yield* new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause: "Above caller limit",
                  });
                }
                const { request } = command;
                const now = DateTime.makeUnsafe(request.updatedAt);
                const terminal = isOperatorRequestTerminalStatus(request.status);
                cards.set(command.turnItemId, {
                  type: "operator_request",
                  id: command.turnItemId,
                  threadId: command.threadId,
                  title: request.title,
                  status: terminal ? "completed" : "waiting",
                  request,
                  runId: null,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 1,
                  startedAt: now,
                  completedAt: terminal ? now : null,
                  updatedAt: now,
                });
                const created = yield* RequestCreated;
                if (created !== undefined) yield* Deferred.succeed(created, undefined);
                return { sequence: cards.size, storedEvents: [] };
              }),
          },
        });
      }),
    ),
  ),
  Layer.provide(NodeServices.layer),
  Layer.provide(NodeCrypto.layer),
);

it.live("advertises the five tools and round-trips a demoted request by external ID", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.map(({ tool }) => tool.name).sort()).toEqual([
      "t3_operator_request",
      "t3_operator_request_cancel",
      "t3_operator_request_list",
      "t3_operator_request_resolve",
      "t3_operator_request_status",
    ]);
    const tool = server.tools.find(({ tool }) => tool.name === "t3_operator_request")?.tool;
    expect(tool?.inputSchema).toMatchObject({
      required: expect.arrayContaining(["kind", "privilege", "title", "summary"]),
      properties: { threadId: expect.any(Object), waitPolicy: expect.any(Object) },
    });
    const schemas = Object.fromEntries(
      server.tools.map(({ tool }) => [tool.name, tool.inputSchema]),
    );
    expect(schemas).toMatchObject({
      t3_operator_request_status: {
        properties: { requestId: expect.any(Object), externalId: expect.any(Object) },
      },
      t3_operator_request_list: {
        properties: { pending: expect.any(Object), kind: expect.any(Object) },
      },
      t3_operator_request_resolve: { required: expect.arrayContaining(["status", "decidedVia"]) },
      t3_operator_request_cancel: {
        properties: { requestId: expect.any(Object), reason: expect.any(Object) },
      },
    });
    const failed = yield* call("t3_operator_request", { ...create, kind: "invalid" }).pipe(
      Effect.result,
    );
    expect(failed._tag === "Failure" || failed.success.isError).toBe(true);
    const created = yield* call("t3_operator_request", {
      ...create,
      expiresAt: "2099-01-01T00:00:00Z",
      metadata: { source: "mcp" },
      waitPolicy: { mode: "sync", syncTimeoutMs: 1, onTimeout: "demote_to_async" },
    });
    const lookup = { externalId: create.externalId };
    expect(created.structuredContent).toMatchObject({
      status: "pending",
      demotedToAsync: true,
      expiresAt: "2099-01-01T00:00:00Z",
      metadata: { source: "mcp" },
    });
    expect((yield* call("t3_operator_request_status", lookup)).structuredContent).toEqual(
      created.structuredContent,
    );
    expect(
      (yield* call("t3_operator_request_list", { pending: true, kind: "custom" }))
        .structuredContent,
    ).toEqual({ requests: [created.structuredContent] });
    const resolved = yield* call("t3_operator_request_resolve", {
      ...lookup,
      status: "submitted",
      decidedVia: "cli",
      answers: { accepted: true },
    });
    expect(resolved.structuredContent).toMatchObject({
      status: "submitted",
      receipt: { decidedVia: "cli" },
    });
    expect(resolved.structuredContent).not.toHaveProperty("receipt.answers");
    expect((yield* call("t3_operator_request_list", { pending: true })).structuredContent).toEqual({
      requests: [],
    });
    const other = { externalId: "report-2" };
    yield* call("t3_operator_request", { ...create, ...other });
    expect((yield* call("t3_operator_request_cancel", other)).structuredContent).toMatchObject({
      status: "cancelled",
    });
  }).pipe(Effect.provide(layerTest)),
);

it.live("allows read-only lookups but reserves decisions for non-linked writable clients", () =>
  Effect.gen(function* () {
    const readOnly = { ...operator, client: { ...operator.client, access: "read-only" as const } };
    const linked = { ...operator, client: { ...operator.client, linked: true } };
    yield* call("t3_operator_request", create);
    const lookup = { externalId: create.externalId };
    expect((yield* call("t3_operator_request_status", lookup, readOnly)).isError).not.toBe(true);
    expect((yield* call("t3_operator_request_list", {}, readOnly)).isError).not.toBe(true);
    expect((yield* call("t3_operator_request", create, readOnly)).isError).toBe(true);
    for (const scope of [readOnly, linked, caller]) {
      expect((yield* call("t3_operator_request_cancel", lookup, scope)).isError).toBe(true);
      expect(
        (yield* call(
          "t3_operator_request_resolve",
          {
            ...lookup,
            status: "submitted",
            decidedVia: "cli",
          },
          scope,
        )).isError,
      ).toBe(true);
    }
    expect((yield* call("t3_operator_request_status", lookup, caller)).isError).toBe(true);
    expect((yield* call("t3_operator_request_status", lookup)).structuredContent).toMatchObject({
      status: "pending",
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps the operator preview URL in the turn item but out of every MCP reply", () =>
  Effect.gen(function* () {
    const previewUrl = "http://127.0.0.1:8123/request?token=operator-only";
    const cliCommand = "vagrant request status";
    const input = { ...create, surfaces: { previewUrl, cliCommand } };
    const id = { threadId: ownThread, externalId: input.externalId };
    const operatorScope = { ...operator, principal: "alice" };
    const created = yield* call("t3_operator_request", input, caller);
    const requests = yield* OperatorRequests.OperatorRequests;
    expect((yield* requests.status(id)).surfaces?.previewUrl).toBe(previewUrl);
    expect(created.structuredContent).toMatchObject({
      ...id,
      requestId: expect.any(String),
      status: "pending",
      surfaces: { cliCommand },
    });
    const listed = yield* call("t3_operator_request_list", { pending: true }, caller);
    expect(listed.structuredContent).toEqual({ requests: [created.structuredContent] });
    const resolved = yield* call(
      "t3_operator_request_resolve",
      { ...id, status: "submitted", decidedVia: "inline" },
      operatorScope,
    );
    const status = yield* call("t3_operator_request_status", id, operatorScope);
    expect(status.structuredContent).toMatchObject({
      ...id,
      requestId: expect.any(String),
      status: "submitted",
      receipt: { decidedVia: "inline", status: "submitted" },
    });
    const other = { ...id, externalId: "report-2" };
    yield* call("t3_operator_request", { ...input, ...other }, caller);
    const cancelled = yield* call("t3_operator_request_cancel", other, operatorScope);
    expect(resolved.structuredContent).toMatchObject({ status: "submitted" });
    expect(cancelled.structuredContent).toMatchObject({ status: "cancelled" });
    for (const reply of [created, listed, resolved, status, cancelled]) {
      expect(JSON.stringify(reply)).not.toMatch(/previewUrl|operator-only/);
    }
  }).pipe(Effect.provide(layerTest)),
);

it.live("defaults to the calling thread and fences a principal credential to owned requests", () =>
  Effect.gen(function* () {
    const alice = { ...operator, principal: "alice" };
    const bob = { ...operator, principal: "bob" };
    const id = { externalId: create.externalId };
    expect((yield* call("t3_operator_request", create, caller)).structuredContent).toMatchObject({
      threadId: ownThread,
      runId: Testkit.liveThreadShell(ownThread).activeRunId,
      status: "pending",
    });
    expect(
      (yield* call("t3_operator_request", { ...create, threadId: otherThread }, caller)).isError,
    ).toBe(true);
    expect(
      (yield* call("t3_operator_request", { ...create, threadId: otherThread }, alice)).isError,
    ).toBe(true);
    expect((yield* call("t3_operator_request_status", id, bob)).isError).toBe(true);
    expect((yield* call("t3_operator_request_cancel", id, bob)).isError).toBe(true);
    const decision = { ...id, status: "submitted", decidedVia: "cli", answers: { approved: true } };
    expect((yield* call("t3_operator_request_resolve", decision, caller)).isError).toBe(true);
    expect((yield* call("t3_operator_request_status", id, alice)).structuredContent).toMatchObject({
      status: "pending",
    });
    expect((yield* call("t3_operator_request_list", {}, alice)).structuredContent).toMatchObject({
      requests: [{ threadId: ownThread }],
    });
    const narrowed = {
      ...alice,
      client: {
        ...alice.client,
        narrowedTo: { runtimeMode: "approval-required", interactionMode: "plan" },
      },
    } satisfies McpInvocationScope;
    const denied = yield* call("t3_operator_request_resolve", decision, narrowed);
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain("above this caller");
    expect(
      (yield* call("t3_operator_request_resolve", decision, alice)).structuredContent,
    ).toMatchObject({
      status: "submitted",
    });
    for (const scope of [alice, caller]) {
      expect(
        (yield* call("t3_operator_request_status", id, scope)).structuredContent,
      ).toMatchObject({
        privateReceipt: { answers: { approved: true } },
      });
    }
    expect((yield* call("t3_operator_request_list", {}, alice)).structuredContent).toMatchObject({
      requests: [expect.not.objectContaining({ privateReceipt: expect.anything() })],
    });
    const explicit = { threadId: ownThread, externalId: "principal-created" };
    expect(
      (yield* call("t3_operator_request", { ...create, ...explicit }, alice)).structuredContent,
    ).toMatchObject({
      threadId: ownThread,
      status: "pending",
    });
    expect(
      (yield* call("t3_operator_request_cancel", explicit, alice)).structuredContent,
    ).toMatchObject({
      status: "cancelled",
    });
  }).pipe(Effect.provide(layerTest)),
);

it.live("includes the private receipt in a synchronous agent response", () =>
  Effect.gen(function* () {
    const created = yield* Deferred.make<void>();
    const waiting = yield* call(
      "t3_operator_request",
      { ...create, waitPolicy: { mode: "sync" } },
      caller,
    ).pipe(Effect.provideService(RequestCreated, created), Effect.forkChild);
    yield* Deferred.await(created);
    const resolved = yield* call(
      "t3_operator_request_resolve",
      {
        threadId: ownThread,
        externalId: create.externalId,
        status: "submitted",
        decidedVia: "inline",
        answers: { accepted: true },
        artifacts: [{ label: "Report", path: "/report" }],
      },
      { ...operator, principal: "alice" },
    );
    expect(resolved.structuredContent).not.toHaveProperty("privateReceipt");
    expect((yield* Fiber.join(waiting)).structuredContent).toMatchObject({
      status: "submitted",
      privateReceipt: {
        answers: { accepted: true },
        artifacts: [{ label: "Report", path: "/report" }],
      },
    });
  }).pipe(Effect.provide(layerTest)),
);

it.live("isolates standalone requests between principal credentials", () =>
  Effect.gen(function* () {
    const alice = { ...operator, principal: "alice" };
    const bob = { ...operator, principal: "bob" };
    const id = { externalId: "standalone" };
    const request = yield* call("t3_operator_request", { ...create, ...id }, alice);
    expect(request.structuredContent).toMatchObject({ ...id, status: "pending" });
    expect(request.structuredContent).not.toHaveProperty("threadId");
    for (const scope of [operator, bob]) {
      expect((yield* call("t3_operator_request_status", id, scope)).isError).toBe(true);
      expect((yield* call("t3_operator_request_cancel", id, scope)).isError).toBe(true);
      expect((yield* call("t3_operator_request_list", {}, scope)).structuredContent).toEqual({
        requests: [],
      });
    }
    expect((yield* call("t3_operator_request_status", id, alice)).structuredContent).toEqual(
      request.structuredContent,
    );
    expect((yield* call("t3_operator_request_cancel", id, alice)).structuredContent).toMatchObject({
      status: "cancelled",
    });
  }).pipe(Effect.provide(layerTest)),
);
