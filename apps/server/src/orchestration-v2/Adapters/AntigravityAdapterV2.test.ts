import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ChatFileAttachment,
  CommandId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  compactDynamicToolOutput,
  htmlRenderFromToolItem,
  previewRecordingIdFromToolItem,
  sentMessageFromToolItem,
} from "@t3tools/shared/toolOutput";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeAcpAdapterV2 } from "@t3tools/provider-acp/server/adapter";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import { makeAntigravityAcpRuntime } from "../../provider/acp/AntigravityAcpSupport.ts";
import { normalizeAntigravitySessionUpdate } from "../../provider/acp/AntigravityProtocol.ts";
import { ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE } from "../../provider/antigravityAuthSupport.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  type AntigravityAdapterV2Options,
  type AntigravityAdapterV2RuntimeInput,
  makeAntigravityAcpAdapterFlavor,
  makeAntigravityAdapterV2,
} from "./AntigravityAdapterV2.ts";

const flavor = makeAntigravityAcpAdapterFlavor({
  instanceId: ProviderInstanceId.make("antigravity-test"),
  random: undefined as never,
  fileSystem: undefined as never,
  path: undefined as never,
  host: undefined as never,
  selfInvocation: undefined as never,
  makeRuntime: () => Effect.die("not spawned in this test"),
  withProcess: (_stop, task) => task,
  defaultModel: Effect.undefined,
});

function permissionRequest(
  toolCallId: string,
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    options,
    toolCall: { toolCallId, title: "Which branch?" },
  };
}

describe("AntigravityAdapterV2 flavor", () => {
  it("keeps a successful subagent launch running until the parent turn becomes idle", () => {
    const batch = flavor.extractSubagentUpdate?.({
      toolCallId: "trajectory:4",
      title: "Running start_subagent",
      kind: "other",
      status: "completed",
      data: { rawOutput: "Started two agents." },
    });
    assert.equal(batch?.status, "running");
    assert.equal(batch?.prompt, "Started two agents.");
    assert.isNull(batch?.result);
    assert.isTrue(flavor.subagentsIdleOnTurnCompletion);

    // Permission prompts carry the launch; later updates for the same call do not.
    const launch = flavor.extractSubagentUpdate?.({
      toolCallId: "35bea692fa95447fbdae6333fec5515f",
      title: "Run invoke_subagent?",
      kind: "other",
      status: "pending",
      data: {
        rawInput: {
          Subagents: [{ TypeName: "research", Role: "Readme Reader", Prompt: "Read README.md" }],
        },
      },
    });
    assert.equal(launch?.title, "Readme Reader");
    assert.equal(launch?.prompt, "Read README.md");

    // agy 1.5.x auto-approves one subagent per call with a flat input.
    const single = flavor.extractSubagentUpdate?.({
      toolCallId: "call_16976942396429577770",
      title: "Run invoke_subagent",
      kind: "other",
      status: "completed",
      data: {
        rawInput: { TypeName: "research", Role: "Codebase Researcher", Prompt: "Read README.md" },
      },
    });
    assert.equal(single?.status, "running");
    assert.equal(single?.title, "Codebase Researcher");
    assert.equal(single?.prompt, "Read README.md");
  });

  it("routes interaction_* permission requests to the question card", () => {
    const question = flavor.extractPermissionQuestion?.(
      permissionRequest("interaction_1", [
        { optionId: "main", name: "main", kind: "allow_once" },
        { optionId: "dev", name: "dev", kind: "allow_once" },
      ]),
    );
    assert.isDefined(question);
    assert.deepEqual(
      question?.question.options.map((option) => option.label),
      ["main", "dev"],
    );
    assert.deepEqual(question?.respond({ interaction_1: "dev" }), {
      outcome: { outcome: "selected", optionId: "dev" },
    });
    assert.isUndefined(question?.respond({ interaction_1: "nope" }));
    assert.isUndefined(
      flavor.extractPermissionQuestion?.(
        permissionRequest("tool_1", [{ optionId: "allow", name: "Allow", kind: "allow_once" }]),
      ),
    );
  });

  it("keeps the question card to the agent's own options so a typed answer cannot be sent", () => {
    const question = flavor.extractPermissionQuestion?.(
      permissionRequest("interaction_2", [
        { optionId: "opt-main", name: "main", kind: "allow_once" },
        { optionId: "opt-dev", name: "dev", kind: "allow_once" },
      ]),
    );
    assert.strictEqual(question?.question.allowCustomAnswer, false);
    assert.deepEqual(
      question?.question.options.map((option) => option.value),
      ["opt-main", "opt-dev"],
    );
    assert.deepEqual(question?.respond({ interaction_2: "opt-dev" }), {
      outcome: { outcome: "selected", optionId: "opt-dev" },
    });
  });

  it("shows each ask_question question as the question body, not the generic form message", () => {
    // agy's ask_question puts each question in its field's title, with no description,
    // and a generic count in the form message.
    const choice = (title: string) => ({
      type: "string",
      title,
      oneOf: [
        { const: "npm", title: "npm" },
        { const: "pnpm", title: "pnpm" },
      ],
    });
    const form = flavor.extractElicitationForm?.({
      sessionId: "session-1",
      mode: "form",
      message: "The agent has 2 questions.",
      requestedSchema: {
        type: "object",
        properties: {
          q0: choice("Which package manager should this new TypeScript project use?"),
          q0_other: { type: "string", title: "Other" },
          q1: choice("Which package manager should the docs site use?"),
          q1_other: { type: "string", title: "Other" },
        },
      },
    } as EffectAcpSchema.CreateElicitationRequest);
    assert.deepEqual(
      form?.questions.map((question) => question.question),
      [
        "Which package manager should this new TypeScript project use?",
        "Which package manager should the docs site use?",
      ],
    );
    for (const question of form?.questions ?? []) {
      assert.notStrictEqual(question.header, question.question);
    }
  });
});

const layerSession = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

it.live("sends the T3 HTTP bridge and profile MCP servers on new and resumed sessions", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const random = yield* SecureRandom.SecureRandom;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const mockAgentPath = yield* path.fromFileUrl(
      new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
    );
    const profileDirectory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-mcp-" });
    const requestLog = path.join(profileDirectory, "requests.ndjson");
    yield* fileSystem.makeDirectory(path.join(profileDirectory, "config"));
    yield* fileSystem.writeFileString(
      path.join(profileDirectory, "config", "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          fleetix: { command: "fleetix", args: ["mcp"] },
          "open-pencil": { url: "https://pencil.example.com/mcp" },
          "t3-code": { command: "not-the-t3-bridge" },
        },
      }),
    );
    const adapterFlavor = makeAntigravityAcpAdapterFlavor({
      instanceId: ProviderInstanceId.make("antigravity-mcp-test"),
      profileDirectory,
      fileSystem,
      path,
      random,
      host: yield* ProviderHost.ProviderHost,
      selfInvocation: yield* resolveSelfInvocation(),
      withProcess: (_stop, task) => task,
      defaultModel: Effect.undefined,
      makeRuntime: (input) =>
        makeAntigravityAcpRuntime({
          ...input,
          childProcessSpawner,
          spawn: {
            command: process.execPath,
            args: [mockAgentPath],
            cwd: input.cwd,
            env: {
              T3_ACP_ANTIGRAVITY: "1",
              T3_ACP_MCP_HTTP: "1",
              T3_ACP_REQUEST_LOG_PATH: requestLog,
            },
          },
        }).pipe(Effect.provideService(SecureRandom.SecureRandom, random)),
    });
    const bridge = { name: "t3-code", command: "stdio-bridge", args: [], env: [] };
    const httpBridge = (token: string) => ({
      type: "http" as const,
      name: "t3-code",
      url: "http://localhost:4321/mcp",
      headers: [{ name: "Authorization", value: token }],
    });
    const runtime = yield* adapterFlavor.makeRuntime!({
      cwd: profileDirectory,
      runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        cwd: profileDirectory,
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
      mcpServers: [bridge],
      httpMcpServers: [httpBridge("new-session")],
      clientCapabilities: {},
      clientInfo: { name: "t3-code", version: "0.0.0" },
      protocolLogging: {},
      onTermination: () => Effect.void,
    });
    yield* runtime.start();
    yield* runtime.resumeSession("mock-session-1", {
      mcpServers: [bridge],
      httpMcpServers: [httpBridge("resumed-session")],
    });
    const expected = (token: string) => [
      httpBridge(token),
      { type: "stdio", name: "fleetix", command: "fleetix", args: ["mcp"], env: [] },
      { type: "http", name: "open-pencil", url: "https://pencil.example.com/mcp", headers: [] },
    ];
    const activations = (yield* fileSystem.readFileString(requestLog))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string; params?: { mcpServers?: unknown } })
      .filter(({ method }) => method === "session/new" || method === "session/resume")
      .map(({ method, params }) => [method, params?.mcpServers]);
    assert.deepEqual(activations, [
      ["session/new", expected("new-session")],
      ["session/resume", expected("resumed-session")],
    ]);
  }).pipe(Effect.provide(layerSession)),
);

describe("AntigravityAdapterV2 compaction", () => {
  it.live.each([
    { nativeGoals: false, compact: false, resume: "none" },
    { nativeGoals: true, compact: false, resume: "load" },
    { nativeGoals: false, compact: true, resume: "resume" },
  ])(
    "negotiates native goals ($nativeGoals), compaction ($compact) and thread resume ($resume)",
    ({ nativeGoals, compact, resume }) =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* SecureRandom.SecureRandom;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const logs = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-compact-" });
        const requestLog = path.join(logs, "requests.ndjson");
        const instanceId = ProviderInstanceId.make("antigravity-compaction-test");
        const goalSupport = yield* Ref.make(false);
        const startupMilestone = yield* Deferred.make<void>();
        const consumeStartupCommands = yield* Deferred.make<void>();
        const workspaceCommands = yield* Ref.make<{
          readonly names: ReadonlyArray<string>;
          readonly cwd: string;
        } | null>(null);
        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: {
                  T3_ACP_ANTIGRAVITY: "1",
                  T3_ACP_AVAILABLE_COMMANDS: compact ? "compact" : "",
                  T3_ACP_REQUEST_LOG_PATH: requestLog,
                },
              },
            }).pipe(
              Effect.provideService(SecureRandom.SecureRandom, crypto),
              Effect.map((runtime) => ({
                ...runtime,
                start: () =>
                  runtime.start().pipe(
                    Effect.map((started) => ({
                      ...started,
                      initializeResult: {
                        ...started.initializeResult,
                        agentCapabilities: {
                          ...started.initializeResult.agentCapabilities,
                          loadSession: resume === "load",
                          sessionCapabilities: resume === "resume" ? { resume: {} } : {},
                        },
                      },
                    })),
                  ),
                drainEvents: Deferred.succeed(startupMilestone, undefined).pipe(
                  Effect.andThen(runtime.drainEvents),
                ),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
          supportsNativeGoals: Ref.get(goalSupport).pipe(
            Effect.tap(() => Deferred.succeed(startupMilestone, undefined)),
          ),
          onSessionEvent: (event, cwd) =>
            event._tag === "AvailableCommandsUpdated"
              ? Deferred.await(consumeStartupCommands).pipe(
                  Effect.andThen(Ref.set(goalSupport, nativeGoals)),
                  Effect.andThen(
                    Ref.set(workspaceCommands, {
                      names: event.availableCommands.map((command) => command.name),
                      cwd,
                    }),
                  ),
                )
              : Effect.void,
        });
        const threadId = ThreadId.make("thread-antigravity-compaction");
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const opening = yield* adapter
          .openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("provider-session-antigravity-compaction"),
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(startupMilestone);
        yield* Deferred.succeed(consumeStartupCommands, undefined);
        const session = yield* Fiber.join(opening);
        assert.deepEqual(yield* Ref.get(workspaceCommands), {
          names: compact ? ["compact"] : ["plan", "logout"],
          cwd: process.cwd(),
        });
        const compactThread = session.compactThread;
        assert.isDefined(compactThread);
        assert.equal(session.providerSession.capabilities.turns.supportsNativeGoals, nativeGoals);
        assert.equal(
          session.providerSession.capabilities.threads.canResumeNativeThread,
          resume !== "none",
        );
        assert.isFalse(session.providerSession.capabilities.turns.supportsNativeResume);
        assert.equal((yield* adapter.getCapabilities()).turns.supportsNativeGoals, nativeGoals);
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const turnInput = makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          modelSelection,
          runtimePolicy,
          now: yield* DateTime.now,
          messageText: "Compact the conversation.",
        });
        if (compact) {
          yield* compactThread!(turnInput);
          const events = yield* session.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          );
          assert.isTrue(
            events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "compaction" &&
                event.turnItem.status === "completed",
            ),
          );
        } else {
          const error = yield* compactThread!(turnInput).pipe(Effect.flip);
          assert.instanceOf(error, ProviderAdapter.ProviderAdapterTurnStartError);
          assert.instanceOf(error.cause, ProviderAdapter.ProviderCompactionUnsupportedError);
        }
        const prompts = (yield* fileSystem.readFileString(requestLog))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { method?: string; params?: { prompt?: unknown } })
          .filter((request) => request.method === "session/prompt")
          .map((request) => request.params?.prompt);
        assert.deepEqual(prompts, compact ? [[{ type: "text", text: "/compact" }]] : []);
      }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 skill mentions", () => {
  it.effect("inlines user-only skills only when the user mentions them on the current turn", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      const skillPath = path.join(home, "ship", "SKILL.md");
      const ordinaryPath = path.join(home, "review", "SKILL.md");
      yield* fileSystem.makeDirectory(path.dirname(skillPath), { recursive: true });
      yield* fileSystem.makeDirectory(path.dirname(ordinaryPath), { recursive: true });
      yield* fileSystem.writeFileString(skillPath, "Ship instructions.\n");
      yield* fileSystem.writeFileString(ordinaryPath, "Review instructions.\n");
      const instanceId = ProviderInstanceId.make("antigravity-test");
      const { rewriteUserText } = makeAntigravityAcpAdapterFlavor({
        instanceId,
        random: undefined as never,
        fileSystem,
        path,
        host: undefined as never,
        selfInvocation: undefined as never,
        makeRuntime: () => Effect.die("not spawned in this test"),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
        discoverSkills: () =>
          Effect.succeed([
            {
              name: "ship",
              path: skillPath,
              scope: "user",
              enabled: true,
              userInvocationOnly: true,
            },
            { name: "review", path: ordinaryPath, scope: "user", enabled: true },
          ]),
      });
      const history = "<history>\nuser: $ship\n</history>\n\n";
      const rewrite = (text: string, messageCreatedBy: "user" | "agent" = "user") =>
        rewriteUserText!(`${history}${text}`, {
          ...makeTurnInput({
            threadId: ThreadId.make("thread-antigravity-skills"),
            providerThread: { id: "provider-thread" } as never,
            instanceId,
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: process.cwd(),
            }),
            now: DateTime.makeUnsafe(0),
            messageCreatedBy,
            messageCreationSource: messageCreatedBy === "agent" ? "provider" : "web",
            messageText: `${history}${text}`,
          }),
          inlineContextLength: history.length,
        });

      assert.equal(yield* rewrite("Fix the typo"), `${history}Fix the typo`);
      assert.equal(
        yield* rewrite("Fix it. $ship $ship"),
        `${history}Fix it. $ship $ship\n\nThe user invoked these skills. Follow their instructions:\n\n<skill name="ship" path="${skillPath}">\nShip instructions.\n</skill>`,
      );
      assert.equal(yield* rewrite("Fix it. $ship $ship", "agent"), `${history}Fix it. $ship $ship`);
      const delegated = yield* rewrite("$ship €review", "agent");
      assert.include(delegated, "Review instructions.");
      assert.notInclude(delegated, "Ship instructions.");
      assert.notInclude(delegated, "The user invoked");
      yield* fileSystem.writeFileString(skillPath, "x".repeat(128 * 1024));
      assert.equal(yield* rewrite("$ship"), `${history}$ship`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("AntigravityAdapterV2 session open", () => {
  it.effect.each([
    {
      name: "browser sign-in",
      cause: new EffectAcpErrors.AcpTransportError({
        detail: ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
        cause: undefined,
      }),
      requiresSignIn: true,
    },
    {
      name: "ACP authentication required",
      cause: EffectAcpErrors.AcpRequestError.authRequired(),
      requiresSignIn: true,
    },
    {
      name: "transport failure",
      cause: new EffectAcpErrors.AcpTransportError({
        detail: "Connection closed",
        cause: undefined,
      }),
      requiresSignIn: undefined,
    },
  ] as const)("classifies $name during session open", ({ cause, requiresSignIn }) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("antigravity-sign-in-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: () => Effect.fail(cause),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const threadId = ThreadId.make("thread-antigravity-sign-in");
      const error = yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-sign-in"),
          modelSelection: { instanceId, model: "gemini-test-low" },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
          }),
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterOpenSessionError");
      assert.equal(
        error._tag === "ProviderAdapterOpenSessionError" && error.requiresSignIn,
        requiresSignIn,
      );
    }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 client file system", () => {
  it.effect("serves confined reads and leaves edits to the agent's diff tools", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      // effect-acp keeps the last handler registered per method; so does this.
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      let writeTextFile: Parameters<RuntimeService["handleWriteTextFile"]>[0] | undefined;
      const logs = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-log-" });
      const requestLog = path.join(logs, "requests.ndjson");
      const crypto = yield* SecureRandom.SecureRandom;
      const instanceId = ProviderInstanceId.make("antigravity-containment-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1", T3_ACP_REQUEST_LOG_PATH: requestLog },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleReadTextFile: (handler) =>
                Effect.sync(() => {
                  readTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
              handleWriteTextFile: (handler) =>
                Effect.sync(() => {
                  writeTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleWriteTextFile(handler))),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-workspace-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-outside-",
      });
      const outsideFile = path.join(outside, "secret.txt");
      yield* fileSystem.writeFileString(outsideFile, "secret");
      const attachment = path.join(host.paths.attachmentsDir, "pasted.txt");
      yield* fileSystem.writeFileString(attachment, "pasted");

      const threadId = ThreadId.make("thread-antigravity-containment");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-containment"),
        modelSelection,
        runtimePolicy,
      });
      yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
      const requests = (yield* fileSystem.readFileString(requestLog))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              params?: {
                clientCapabilities?: { fs?: unknown };
                clientInfo?: { name?: string };
                additionalDirectories?: unknown;
              };
            },
        );
      const initialize = requests.find((request) => request.method === "initialize");
      // agy runs shell commands from its lexicographically first root, so attachments
      // must reach it through client reads, never as an extra workspace root.
      assert.isUndefined(
        requests.find((request) => request.method === "session/new")?.params?.additionalDirectories,
      );
      assert.deepEqual(initialize?.params?.clientCapabilities?.fs, {
        readTextFile: true,
        writeTextFile: false,
      });
      assert.equal(initialize?.params?.clientInfo?.name, "t3-code");
      assert.isUndefined(writeTextFile);
      if (readTextFile === undefined) {
        return yield* Effect.die("Antigravity sessions must serve client file reads");
      }
      const context = (method: string) => ({ requestId: `test-${method}`, method });

      const insidePath = path.join(workspace, "src", "inside.ts");
      yield* fileSystem.makeDirectory(path.dirname(insidePath), { recursive: true });
      yield* fileSystem.writeFileString(insidePath, "inside");
      const pasted = yield* readTextFile(
        { sessionId: "mock-session-1", path: attachment },
        context("fs/read_text_file"),
      );
      assert.equal(pasted.content, "pasted");
      yield* fileSystem.writeFileString(insidePath, "\uFEFFfirst\né中🙂\nlast");
      const sliced = yield* readTextFile(
        { sessionId: "mock-session-1", path: insidePath, line: 2, limit: 1 },
        context("fs/read_text_file"),
      );
      assert.equal(sliced.content, "é中🙂");
      yield* fileSystem.writeFileString(insidePath, "inside");
      for (const [name, bytes] of [
        ["image.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        ["data.bin", new Uint8Array([0x61, 0, 0x62])],
      ] as const) {
        const binaryPath = path.join(workspace, name);
        yield* fileSystem.writeFile(binaryPath, bytes);
        const binaryRead = yield* readTextFile(
          { sessionId: "mock-session-1", path: binaryPath },
          context("fs/read_text_file"),
        ).pipe(Effect.flip);
        assert.propertyVal(binaryRead, "code", -32602, `${name} is refused as binary`);
      }

      const outsideRead = yield* readTextFile(
        { sessionId: "mock-session-1", path: outsideFile },
        context("fs/read_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(outsideRead));
      const linkPath = path.join(workspace, "linked-secret.txt");
      yield* fileSystem.symlink(outsideFile, linkPath);
      const linkedRead = yield* readTextFile(
        { sessionId: "mock-session-1", path: linkPath },
        context("fs/read_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(linkedRead), "a read through an escaping symlink is denied");
      const insideLink = path.join(workspace, "inside-link.ts");
      yield* fileSystem.symlink(insidePath, insideLink);
      const viaInsideLink = yield* readTextFile(
        { sessionId: "mock-session-1", path: insideLink },
        context("fs/read_text_file"),
      );
      assert.equal(viaInsideLink.content, "inside");
    }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 workspace changes", () => {
  it.effect("confines file requests to the workspace of the turn in progress", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const promptReceived = yield* Deferred.make<Parameters<RuntimeService["prompt"]>[0]>();
      const host = yield* ProviderHost.ProviderHost;
      const document = ChatFileAttachment.make({
        type: "file",
        id: "native-pdf",
        name: "diagram.pdf",
        mimeType: "application/pdf",
        sizeBytes: 9,
      });
      const documentPath = host.resolveAttachmentPath(document)!;
      yield* fileSystem.writeFileString(documentPath, "%PDF-1.7");
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-workspace-change-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1", T3_ACP_HANG_PROMPT_FOREVER: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              prompt: (request) =>
                Deferred.succeed(promptReceived, request).pipe(
                  Effect.andThen(runtime.prompt(request)),
                ),
              start: () =>
                runtime.start().pipe(
                  Effect.map((started) => ({
                    ...started,
                    initializeResult: {
                      ...started.initializeResult,
                      agentCapabilities: {
                        ...started.initializeResult.agentCapabilities,
                        promptCapabilities: { image: true, audio: true, embeddedContext: true },
                      },
                    },
                  })),
                ),
              handleReadTextFile: (handler) =>
                Effect.sync(() => {
                  readTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const workspaceA = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-a-" });
      const workspaceB = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-b-" });
      yield* fileSystem.writeFileString(path.join(workspaceA, "a.txt"), "from a");
      yield* fileSystem.writeFileString(path.join(workspaceB, "b.txt"), "from b");
      const policyFor = (cwd: string) =>
        ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd,
        });
      const threadId = ThreadId.make("thread-antigravity-workspace-change");
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-workspace-change"),
        modelSelection,
        runtimePolicy: policyFor(workspaceA),
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policyFor(workspaceA),
      });
      const now = yield* DateTime.now;
      yield* session
        .startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project-antigravity-workspace-change"),
            title: "Antigravity workspace change",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: workspaceB,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make("run-antigravity-workspace-change"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("attempt-antigravity-workspace-change"),
          rootNodeId: NodeId.make("node-antigravity-workspace-change"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-antigravity-workspace-change"),
            text: "read b.txt",
            attachments: [document],
          },
          modelSelection,
          runtimePolicy: policyFor(workspaceB),
        })
        .pipe(Effect.forkScoped);
      yield* session.events.pipe(
        Stream.filter((event) => event.type === "provider_turn.updated"),
        Stream.runHead,
      );
      const sent = yield* Deferred.await(promptReceived);
      assert.deepEqual(
        sent.prompt.filter((block) => block.type === "resource_link"),
        [
          {
            type: "resource_link",
            uri: (yield* path.toFileUrl(documentPath)).href,
            name: "diagram.pdf",
            mimeType: "application/pdf",
            size: 8,
          },
        ],
      );
      assert.include(JSON.stringify(sent.prompt), JSON.stringify(documentPath).slice(1, -1));
      if (readTextFile === undefined) {
        return yield* Effect.die("Antigravity sessions must serve client file requests");
      }
      const context = { requestId: "test-read", method: "fs/read_text_file" };
      const fromB = yield* readTextFile(
        { sessionId: "mock-session-1", path: path.join(workspaceB, "b.txt") },
        context,
      );
      assert.equal(fromB.content, "from b");
      const fromA = yield* readTextFile(
        { sessionId: "mock-session-1", path: path.join(workspaceA, "a.txt") },
        context,
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(fromA), "the previous workspace is no longer readable");
    }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 html_render pages", () => {
  it.effect("shows the page html_render published when the agent reports only a summary", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-html-render-test");
      const threadId = ThreadId.make("thread-antigravity-html-render");
      const page = (name: string) => ({
        attachmentId: `${threadId}-${name}-html`,
        title: "Revenue",
        height: 240,
      });
      // Long enough that Antigravity bounds the html the adapter sees.
      const rows = Array.from({ length: 500 }, (_, row) => `<tr><td>Row ${row}</td></tr>`);
      const report = { html: `<table>${rows.join("")}</table>`, title: "Revenue", height: 240 };
      const failed = { ...report, html: "<p>Revenue</p>" };
      const errored = { ...report, html: "<p>Revenue error</p>" };
      const telemetry = {
        html: `<ul>${rows.join("").replaceAll("tr", "li")}</ul>`,
        title: "Telemetry",
        height: 411,
      };
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdate = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              // agy_acp_server 1.3/1.4 without a permission prompt: the call is
              // titled "Running <tool>" and completes with the step's summary
              // in place of the MCP result.
              prompt: () =>
                Effect.gen(function* () {
                  const send = (update: EffectAcpSchema.SessionUpdate) =>
                    sessionUpdate === undefined
                      ? Effect.die("the adapter must handle session updates")
                      : sessionUpdate(
                          normalizeAntigravitySessionUpdate({
                            sessionId: "mock-session-1",
                            update,
                          }),
                        );
                  const calls = [
                    ["published", report],
                    ["unpublished", { ...report, html: "<p>Costs</p>" }],
                    ["failed", failed],
                    ["error", errored],
                  ] as const;
                  for (const [toolCallId, rawInput] of calls) {
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title: "Running html_render",
                      kind: "other",
                      status: "in_progress",
                      rawInput,
                    });
                  }
                  yield* mcpSessions.recordHtmlRender(threadId, report, page("report"));
                  yield* mcpSessions.recordHtmlRender(threadId, failed, page("failed"));
                  yield* mcpSessions.recordHtmlRender(threadId, errored, page("error"));
                  for (const [toolCallId, status] of [
                    ["unpublished", "completed"],
                    ["failed", "failed"],
                    ["published", "completed"],
                    ["published", "completed"],
                  ] as const) {
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status,
                      rawOutput: `Summary of ${toolCallId}`,
                    });
                  }
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "error",
                    status: "completed",
                    rawOutput: { result: { isError: true, content: [] } },
                  });
                  for (const [name, rawInput] of [
                    ["failed", failed],
                    ["error", errored],
                  ] as const) {
                    const toolCallId = `${name}-retry`;
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title: "Running html_render",
                      kind: "other",
                      status: "in_progress",
                      rawInput,
                    });
                    yield* mcpSessions.recordHtmlRender(threadId, rawInput, page(toolCallId));
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId: name,
                      status: name === "failed" ? "failed" : "completed",
                      rawOutput:
                        name === "failed"
                          ? "Summary of failed"
                          : { result: { isError: true, content: [] } },
                    });
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status: "completed",
                      rawOutput: `Summary of ${toolCallId}`,
                    });
                  }
                  yield* mcpSessions.recordHtmlRender(threadId, report, page("replacement"));
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "published",
                    status: "completed",
                    rawOutput: { htmlRender: page("replacement") },
                  });
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "published",
                    status: "completed",
                    rawOutput: "Summary of published",
                  });
                  // agy 1.5.8 titles the call with its MCP name and completes without any output.
                  yield* send({
                    sessionUpdate: "tool_call",
                    toolCallId: "agy-1.5.8",
                    title: "Run mcp_t3-code_html_render",
                    kind: "other",
                    status: "in_progress",
                    rawInput: { ...telemetry, toolSummary: "Render telemetry" },
                  });
                  yield* mcpSessions.recordHtmlRender(threadId, telemetry, page("agy-1.5.8"));
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "agy-1.5.8",
                    status: "completed",
                  });
                  return { stopReason: "end_turn" as const };
                }),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-html-render"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* session.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project-antigravity-html-render"),
          title: "Antigravity html_render",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make("run-antigravity-html-render"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-antigravity-html-render"),
        rootNodeId: NodeId.make("node-antigravity-html-render"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-antigravity-html-render"),
          text: "chart the revenue",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      const events = Array.from(
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const tool = (nativeId: string) => {
        const event = events.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId,
        );
        if (event?.type !== "turn_item.updated" || event.turnItem.type !== "dynamic_tool") {
          return undefined;
        }
        const item = event.turnItem;
        return {
          status: item.status,
          toolName: item.toolName,
          page: htmlRenderFromToolItem(item),
          output: item.output,
        };
      };

      assert.deepEqual(tool("published"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: page("replacement"),
        output: { htmlRender: page("replacement") },
      });
      assert.deepEqual(tool("unpublished"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: "Summary of unpublished",
      });
      assert.deepEqual(tool("failed"), {
        status: "failed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: "Summary of failed",
      });
      assert.deepEqual(tool("error"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: [],
      });
      assert.deepEqual(
        events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.nativeItemRef?.nativeId === "published" &&
          event.turnItem.status === "completed"
            ? [htmlRenderFromToolItem(event.turnItem)]
            : [],
        ),
        [page("report"), page("report"), page("replacement"), page("replacement")],
      );
      for (const name of ["failed-retry", "error-retry", "agy-1.5.8"]) {
        assert.deepEqual(tool(name), {
          status: "completed",
          toolName: "t3-code.html_render",
          page: page(name),
          output: { htmlRender: page(name) },
        });
      }
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, report), undefined);
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, failed), undefined);
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, errored), undefined);
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, telemetry), undefined);
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect(
    "recovers T3 MCP tool results across omitted outputs, replays, errors, and turn boundaries",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const path = yield* Path.Path;
        const crypto = yield* SecureRandom.SecureRandom;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        let promptIndex = 0;
        let turn1Epoch = 0;
        const instanceId = ProviderInstanceId.make("antigravity-mcp-result-test");
        const threadId = ThreadId.make("thread-antigravity-mcp-result");
        const statusUpdate = "### Current Status\n\nAll checks are passing.";
        const inProgressText = "Streamed while running.";
        const lateText = "Confirmed on a later completion.";
        const lateErrorText = "Late explicit error.";
        const unfinishedText = "Still running when turn ended.";
        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: { T3_ACP_ANTIGRAVITY: "1" },
              },
            }).pipe(
              Effect.provideService(SecureRandom.SecureRandom, crypto),
              Effect.map((runtime): RuntimeService => ({
                ...runtime,
                handleSessionUpdate: (handler) =>
                  Effect.sync(() => {
                    sessionUpdate = handler;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
                prompt: () =>
                  Effect.gen(function* () {
                    promptIndex += 1;
                    const send = (update: EffectAcpSchema.SessionUpdate) =>
                      sessionUpdate === undefined
                        ? Effect.die("the adapter must handle session updates")
                        : sessionUpdate(
                            normalizeAntigravitySessionUpdate({
                              sessionId: "mock-session-1",
                              update,
                            }),
                          );
                    const startTool = (
                      toolCallId: string,
                      toolName: string,
                      rawInput: Record<string, unknown>,
                    ) =>
                      send({
                        sessionUpdate: "tool_call",
                        toolCallId,
                        title: `Run mcp_t3-code_${toolName}`,
                        kind: "other",
                        status: "in_progress",
                        rawInput,
                      });
                    const updateTool = (
                      toolCallId: string,
                      status: "in_progress" | "completed" | "failed",
                      rawOutput?: unknown,
                    ) =>
                      send({
                        sessionUpdate: "tool_call_update",
                        toolCallId,
                        status,
                        ...(rawOutput === undefined ? {} : { rawOutput }),
                      });
                    const recordSend = (message: string) =>
                      mcpSessions.recordToolResult(
                        threadId,
                        "send_to_user",
                        { message },
                        { sentMessage: message },
                      );

                    if (promptIndex === 2) {
                      // A Turn 1 handler finishing after Turn 1 closed must be rejected by epoch.
                      yield* mcpSessions.recordToolResult(
                        threadId,
                        "send_to_user",
                        { message: unfinishedText },
                        { sentMessage: unfinishedText },
                        { epoch: turn1Epoch },
                      );
                      yield* startTool("turn2-leaked-check", "send_to_user", {
                        message: unfinishedText,
                      });
                      yield* updateTool("turn2-leaked-check", "completed", "Summary of turn 2");
                      return { stopReason: "end_turn" as const };
                    }

                    turn1Epoch = yield* mcpSessions.toolResultEpoch(threadId);

                    // agy 1.5.x adds toolSummary and omits output on completion, then may replay.
                    yield* startTool("send-empty", "send_to_user", {
                      message: statusUpdate,
                      toolSummary: "Send status update",
                    });
                    yield* recordSend(statusUpdate);
                    yield* updateTool("send-empty", "completed");
                    yield* updateTool("send-empty", "in_progress");
                    yield* updateTool("send-empty", "completed", "Summary replay");

                    // Streaming output during in_progress still drains on completion.
                    yield* startTool("send-streaming", "send_to_user", { message: inProgressText });
                    yield* recordSend(inProgressText);
                    yield* updateTool("send-streaming", "in_progress", {
                      sentMessage: inProgressText,
                    });
                    yield* updateTool("send-streaming", "completed", {
                      sentMessage: inProgressText,
                    });
                    yield* startTool("send-streaming-unpublished", "send_to_user", {
                      message: inProgressText,
                    });
                    yield* updateTool("send-streaming-unpublished", "completed");

                    // Explicit MCP error preserves diagnostic content across summary replays.
                    yield* startTool("send-errored", "send_to_user", { message: "Denied" });
                    yield* updateTool("send-errored", "completed", {
                      result: {
                        isError: true,
                        structuredContent: { sentMessage: "Denied" },
                        content: [{ type: "text", text: "Denied by policy" }],
                      },
                    });
                    yield* updateTool("send-errored", "completed", "Summary of denied");

                    // Initial miss -> late explicit success or error still drains its new record.
                    yield* startTool("send-late", "send_to_user", { message: lateText });
                    yield* updateTool("send-late", "completed");
                    yield* recordSend(lateText);
                    yield* updateTool("send-late", "completed", { sentMessage: lateText });
                    yield* startTool("send-late-unpublished", "send_to_user", {
                      message: lateText,
                    });
                    yield* updateTool("send-late-unpublished", "completed");

                    yield* startTool("send-late-error", "send_to_user", { message: lateErrorText });
                    yield* updateTool("send-late-error", "completed");
                    yield* mcpSessions.recordToolResult(
                      threadId,
                      "send_to_user",
                      { message: lateErrorText },
                      { isError: true },
                    );
                    yield* updateTool("send-late-error", "completed", {
                      result: { isError: true, content: [{ type: "text", text: "Denied late" }] },
                    });
                    yield* startTool("send-late-error-sibling", "send_to_user", {
                      message: lateErrorText,
                    });
                    yield* updateTool("send-late-error-sibling", "completed");

                    // Empty-input completion that misses still recovers once a later completion brings arguments,
                    // and replacing arguments on the same call ID re-matches against the new arguments.
                    yield* startTool("send-late-args", "send_to_user", {});
                    yield* recordSend("First args");
                    yield* updateTool("send-late-args", "completed");
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId: "send-late-args",
                      status: "completed",
                      rawInput: { message: "First args" },
                    });
                    yield* recordSend("Second args");
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId: "send-late-args",
                      status: "completed",
                      rawInput: { message: "Second args" },
                      rawOutput: "Summary of second",
                    });

                    // Bare failure without reported output must not consume a sibling call's cached result.
                    yield* startTool("send-bare-fail", "send_to_user", { message: "Shared ready" });
                    yield* startTool("send-bare-fail-sibling", "send_to_user", {
                      message: "Shared ready",
                    });
                    yield* recordSend("Shared ready");
                    yield* updateTool("send-bare-fail", "failed");
                    yield* updateTool("send-bare-fail-sibling", "completed");

                    // preview_recording_stop recovers its recording id.
                    yield* startTool("recording-stop", "preview_recording_stop", {
                      toolSummary: "Stop preview recording",
                    });
                    yield* mcpSessions.recordToolResult(
                      threadId,
                      "preview_recording_stop",
                      {},
                      { id: `${threadId}-rec-1` },
                    );
                    yield* updateTool("recording-stop", "completed");

                    // Unfinished call projected at turn end must not claim or leak to Turn 2.
                    yield* startTool("send-unfinished", "send_to_user", {
                      message: unfinishedText,
                    });
                    yield* recordSend(unfinishedText);

                    return { stopReason: "end_turn" as const };
                  }),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-mcp-result"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        const runTurn = (ordinal: number) =>
          Effect.gen(function* () {
            yield* session.startTurn(
              makeTurnInput({
                threadId,
                providerThread,
                instanceId,
                runtimePolicy,
                now,
                ordinal,
                modelSelection,
              }),
            );
            return Array.from(
              yield* session.events.pipe(
                Stream.takeUntil((event) => event.type === "turn.terminal"),
                Stream.runCollect,
              ),
            );
          });
        const turn1Events = yield* runTurn(1);
        const turn2Events = yield* runTurn(2);
        const toolIn = (events: ReadonlyArray<(typeof turn1Events)[number]>, nativeId: string) => {
          const event = events.findLast(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === nativeId,
          );
          return event?.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
            ? event.turnItem
            : undefined;
        };
        const tool = (nativeId: string) => toolIn(turn1Events, nativeId);

        const sendEmptyUpdates = turn1Events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.nativeItemRef?.nativeId === "send-empty" &&
          event.turnItem.status === "completed"
            ? [event.turnItem]
            : [],
        );
        assert.deepEqual(
          sendEmptyUpdates.map((update) => sentMessageFromToolItem(update)),
          [statusUpdate, statusUpdate],
        );
        assert.strictEqual(sentMessageFromToolItem(tool("send-streaming")!), inProgressText);
        assert.strictEqual(sentMessageFromToolItem(tool("send-streaming-unpublished")!), undefined);
        const erroredUpdates = turn1Events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.nativeItemRef?.nativeId === "send-errored" &&
          event.turnItem.status === "completed"
            ? [event.turnItem]
            : [],
        );
        assert.strictEqual(erroredUpdates.length, 2);
        for (const update of erroredUpdates) {
          assert.strictEqual(compactDynamicToolOutput(update.output)?.isError, true);
          assert.include(JSON.stringify(update.output), "Denied by policy");
          assert.strictEqual(sentMessageFromToolItem(update), undefined);
        }
        assert.strictEqual(sentMessageFromToolItem(tool("send-late")!), lateText);
        assert.strictEqual(sentMessageFromToolItem(tool("send-late-unpublished")!), undefined);
        const lateErrorSibling = tool("send-late-error-sibling");
        assert.isDefined(lateErrorSibling);
        assert.strictEqual(lateErrorSibling.status, "completed");
        assert.strictEqual(lateErrorSibling.output, undefined);
        assert.strictEqual(sentMessageFromToolItem(tool("send-late-args")!), "Second args");
        assert.strictEqual(
          sentMessageFromToolItem(tool("send-bare-fail-sibling")!),
          "Shared ready",
        );
        assert.strictEqual(sentMessageFromToolItem(tool("send-unfinished")!), undefined);
        assert.strictEqual(
          sentMessageFromToolItem(toolIn(turn2Events, "turn2-leaked-check")!),
          undefined,
        );
        assert.strictEqual(
          previewRecordingIdFromToolItem(tool("recording-stop")!),
          `${threadId}-rec-1`,
        );
      }).pipe(Effect.provide(layerSession)),
  );
});

/**
 * A session whose prompt reports one running command and returns end_turn, as agy 1.5.11 does
 * for `run_command` once `WaitMsBeforeAsync` passes. The test sends every later frame.
 */
const openSessionWithRunningCommand = Effect.fn("openSessionWithRunningCommand")(function* (
  commandInput: Record<string, unknown>,
  /** The prompt launches one agy 1.5 subagent instead; its records live below this profile. */
  detachedChildProfile?: string,
  /** agy 1.5.11 answers a steered prompt once the next one arrives, which runs to `releaseSteer`. */
  steering?: { readonly agentVersion: string; readonly holdsFirstPrompt: boolean },
  options?: {
    readonly profileDirectory?: string;
    readonly initialToolCalls?: ReadonlyArray<EffectAcpSchema.SessionUpdate>;
    readonly runtimeMode?: "approval-required";
    readonly useRealPrompt?: boolean;
    readonly useRealCancel?: boolean;
    readonly cancelTimeout?: Duration.Input;
    readonly mockEnv?: (runtimeOrdinal: number) => Record<string, string>;
    readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
    readonly flavorOverrides?: Partial<Parameters<typeof makeAcpAdapterV2>[0]["flavor"]>;
    readonly prompt?: (
      runtimeOrdinal: number,
      promptOrdinal: number,
    ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
  },
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const crypto = yield* SecureRandom.SecureRandom;
  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
  let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
  let requestPermission: Parameters<RuntimeService["handleRequestPermission"]>[0] | undefined;
  let elicit: Parameters<RuntimeService["handleElicitation"]>[0] | undefined;
  let incomingRequest: AntigravityAdapterV2RuntimeInput["onIncomingRequest"];
  let acknowledgeResponse: AntigravityAdapterV2RuntimeInput["onOutgoingResponse"];
  let runtimes = 0;
  const runtimeClosedByOrdinal = new Map<number, Deferred.Deferred<void>>();
  const runtimeClosed = (ordinal: number) =>
    Effect.suspend(() => {
      const deferred = runtimeClosedByOrdinal.get(ordinal);
      return deferred === undefined
        ? Effect.die(`runtime ${ordinal} was not started`)
        : Deferred.await(deferred);
    });
  const send = (update: EffectAcpSchema.SessionUpdate) =>
    sessionUpdate === undefined
      ? Effect.die("the adapter must handle session updates")
      : sessionUpdate(normalizeAntigravitySessionUpdate({ sessionId: "mock-session-1", update }));
  const command = {
    toolCallId: "call_fetch",
    kind: "execute",
    title: "node fetch_throughput.mjs",
    rawInput: { CommandLine: "node fetch_throughput.mjs", ...commandInput },
  } as const;
  let cancels = 0;
  const prompts: Array<{
    readonly prompt: ReadonlyArray<EffectAcpSchema.ContentBlock>;
    readonly released: Deferred.Deferred<void> | undefined;
  }> = [];
  const steered = yield* Deferred.make<void>();
  const releaseSteer = yield* Deferred.make<void>();
  let terminate: AntigravityAdapterV2RuntimeInput["onTermination"];
  let stop: Effect.Effect<void>;
  const usage = { sessionUpdate: "usage_update", used: 9000, size: 1048576 } as const;
  const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
  const scheduledFinalizes = yield* Queue.unbounded<Duration.Input>();
  const instanceId = ProviderInstanceId.make("antigravity-wake-test");
  const threadId = ThreadId.make("thread-antigravity-wake");
  const selfInvocation = yield* resolveSelfInvocation();
  const profileDirectory = options?.profileDirectory ?? detachedChildProfile;
  const adapterOptions: AntigravityAdapterV2Options = {
    instanceId,
    selfInvocation,
    continuationRequests: { offer: (request) => Effect.sync(() => void offers.push(request)) },
    makeRuntime: (input) => {
      const runtimeOrdinal = ++runtimes;
      let promptOrdinal = 0;
      incomingRequest = input.onIncomingRequest;
      acknowledgeResponse = input.onOutgoingResponse;
      terminate = input.onTermination;
      return Effect.gen(function* () {
        const closed = yield* Deferred.make<void>();
        runtimeClosedByOrdinal.set(runtimeOrdinal, closed);
        const scope = yield* Scope.Scope;
        yield* Scope.addFinalizer(scope, Deferred.succeed(closed, undefined).pipe(Effect.asVoid));
        const runtime = yield* makeAntigravityAcpRuntime({
          ...input,
          ...(options?.cancelTimeout === undefined ? {} : { cancelTimeout: options.cancelTimeout }),
          childProcessSpawner,
          spawn: {
            command: process.execPath,
            args: [mockAgentPath],
            cwd: input.cwd,
            env: {
              T3_ACP_ANTIGRAVITY: "1",
              ...(steering === undefined ? {} : { T3_ACP_AGENT_VERSION: steering.agentVersion }),
              ...(options?.mockEnv?.(runtimeOrdinal) ?? {}),
            },
          },
        }).pipe(Effect.provideService(SecureRandom.SecureRandom, crypto));
        return {
          ...runtime,
          cancel:
            options?.useRealCancel === true
              ? Effect.sync(() => {
                  cancels += 1;
                }).pipe(Effect.andThen(runtime.cancel))
              : Effect.sync(() => {
                  cancels += 1;
                }),
          handleSessionUpdate: (handler) =>
            Effect.sync(() => {
              sessionUpdate = handler;
            }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
          handleRequestPermission: (handler) =>
            Effect.sync(() => {
              requestPermission = handler;
            }).pipe(Effect.andThen(runtime.handleRequestPermission(handler))),
          handleElicitation: (handler) =>
            Effect.sync(() => {
              elicit = handler;
            }).pipe(Effect.andThen(runtime.handleElicitation(handler))),
          prompt:
            options?.useRealPrompt === true
              ? (payload, promptOptions) =>
                  Effect.sync(() => {
                    prompts.push({ prompt: payload.prompt, released: promptOptions?.released });
                  }).pipe(Effect.andThen(runtime.prompt(payload, promptOptions)))
              : (payload, promptOptions) =>
                  Effect.gen(function* () {
                    prompts.push({ prompt: payload.prompt, released: promptOptions?.released });
                    if (promptOptions?.dispatched !== undefined) {
                      yield* Deferred.succeed(promptOptions.dispatched, undefined);
                    }
                    if (options?.prompt !== undefined) {
                      return yield* options.prompt(runtimeOrdinal, ++promptOrdinal);
                    }
                    if (prompts.length > 1) {
                      yield* Deferred.succeed(steered, undefined);
                      yield* Deferred.await(releaseSteer);
                      return { stopReason: "end_turn" as const };
                    }
                    if (options?.initialToolCalls !== undefined) {
                      for (const toolUpdate of options.initialToolCalls) {
                        yield* send(toolUpdate);
                      }
                    } else {
                      yield* send(
                        detachedChildProfile === undefined
                          ? { sessionUpdate: "tool_call", ...command, status: "in_progress" }
                          : {
                              sessionUpdate: "tool_call",
                              toolCallId: "call_research",
                              kind: "other",
                              title: "Run invoke_subagent",
                              status: "completed",
                              rawInput: {
                                TypeName: "research",
                                Role: "Researcher",
                                Prompt: "Read it",
                              },
                            },
                      );
                    }
                    yield* send({
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "I'll render once the fetch finishes." },
                    });
                    yield* send(usage);
                    if (steering?.holdsFirstPrompt === true) yield* Deferred.await(steered);
                    return { stopReason: "end_turn" as const };
                  }),
        } satisfies RuntimeService;
      });
    },
    withProcess: (close, task) =>
      Effect.sync(() => {
        stop = close;
      }).pipe(Effect.andThen(task)),
    defaultModel: Effect.undefined,
    ...(profileDirectory === undefined ? {} : { profileDirectory }),
  };
  const adapter =
    options === undefined
      ? yield* makeAntigravityAdapterV2(adapterOptions)
      : yield* makeAcpAdapterV2({
          instanceId,
          flavor: {
            ...makeAntigravityAcpAdapterFlavor({
              ...adapterOptions,
              random: crypto,
              fileSystem: yield* FileSystem.FileSystem,
              path,
              host: yield* ProviderHost.ProviderHost,
            }),
            ...(options.flavorOverrides ?? {}),
          },
          selfInvocation,
          ...(adapterOptions.continuationRequests === undefined
            ? {}
            : { continuationRequests: adapterOptions.continuationRequests }),
          testHooks: {
            onDeferredFinalizeScheduled: (debounce) => Queue.offer(scheduledFinalizes, debounce),
            ...(options.testHooks ?? {}),
          },
        });
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: options?.runtimeMode ?? "full-access",
    interactionMode: "default",
    cwd: process.cwd(),
  });
  const modelSelection = { instanceId, model: "gemini-test-low" } as const;
  const session = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-antigravity-wake"),
    modelSelection,
    runtimePolicy,
  });
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* session.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const until = (done: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      while (true) {
        const event = yield* Queue.take(events);
        seen.push(event);
        if (done(event)) return seen;
      }
    });
  const providerThread = yield* session.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy,
  });
  const now = yield* DateTime.now;
  const startTurn = (
    ordinal: number,
    continuation: boolean,
    appContext?: ProviderAdapter.ProviderAdapterV2TurnInput["appContext"],
  ) =>
    session.startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project-antigravity-wake"),
        title: "Antigravity wake",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: runtimePolicy.runtimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make(`run-antigravity-wake-${ordinal}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`attempt-antigravity-wake-${ordinal}`),
      rootNodeId: NodeId.make(`node-antigravity-wake-${ordinal}`),
      providerThread,
      message: {
        ...(continuation
          ? { createdBy: "agent" as const, creationSource: "provider" as const }
          : { createdBy: "user" as const, creationSource: "web" as const }),
        messageId: MessageId.make(`message-antigravity-wake-${ordinal}`),
        text: "chart the throughput",
        attachments: [],
      },
      ...(appContext === undefined ? {} : { appContext }),
      modelSelection,
      runtimePolicy,
    });

  return {
    session,
    providerThread,
    command,
    usage,
    offers,
    scheduledFinalizes,
    send,
    startTurn,
    until,
    throughTerminal: until((event) => event.type === "turn.terminal"),
    // The reply before end_turn closes when the prompt settles, held open or not.
    throughPromptSettled: until(
      (event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "assistant_message" &&
        event.turnItem.status === "completed",
    ),
    requestPermission: (...args: Parameters<NonNullable<typeof requestPermission>>) =>
      requestPermission === undefined
        ? Effect.die("the adapter must handle permission requests")
        : requestPermission(...args),
    elicit: (...args: Parameters<NonNullable<typeof elicit>>) =>
      elicit?.(...args) ?? Effect.die("the adapter must handle elicitation"),
    cancels: () => cancels,
    runtimes: () => runtimes,
    runtimeClosed,
    incomingRequest: (requestId: string, method: string) =>
      incomingRequest?.(requestId, method, {}) ?? Effect.die("missing incoming request callback"),
    acknowledgeResponse: (requestId: string) =>
      acknowledgeResponse?.(requestId) ?? Effect.die("missing response acknowledgement callback"),
    prompts,
    steerStarted: Deferred.await(steered),
    releaseSteer: Deferred.succeed(releaseSteer, undefined),
    runtimeDies: Effect.suspend(
      () =>
        terminate?.(
          new EffectAcpErrors.AcpTransportError({ detail: "agent exited", cause: "exit" }),
        ) ?? Effect.die("the adapter must watch its runtime"),
    ),
    closeRuntime: Effect.suspend(() => stop),
  };
});

const antigravityBlockedPromptError = () =>
  new EffectAcpErrors.AcpRequestError({
    code: -32603,
    errorMessage:
      "Can't add this prompt to session mock-session-1: the running prompt is waiting for a permission or question answer; answer it or send session/cancel, then send this prompt again",
  });

it.effect.each(["user_input", "approval"] as const)(
  "declines steering while a live %s request awaits an answer",
  (kind) =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const opened = yield* openSessionWithRunningCommand(
        {},
        undefined,
        { agentVersion: "1.5.13", holdsFirstPrompt: false },
        {
          runtimeMode: "approval-required",
          prompt: (_runtime, ordinal) =>
            ordinal === 1
              ? Deferred.await(release).pipe(Effect.as({ stopReason: "end_turn" as const }))
              : Deferred.isDone(release).pipe(
                  Effect.flatMap((answered) =>
                    answered
                      ? Effect.succeed({ stopReason: "end_turn" as const })
                      : Effect.fail(antigravityBlockedPromptError()),
                  ),
                ),
        },
      );
      yield* opened.startTurn(1, false);
      yield* opened.until(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const request = yield* (
        kind === "approval"
          ? opened
              .requestPermission(
                {
                  sessionId: "mock-session-1",
                  toolCall: { toolCallId: "cmd_1", kind: "execute", title: "Run a command?" },
                  options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
                },
                { requestId: "pending-request", method: "session/request_permission" },
              )
              .pipe(Effect.map((result) => result.outcome.outcome === "selected"))
          : opened
              .elicit(
                {
                  sessionId: "mock-session-1",
                  mode: "form",
                  message: "Need one answer",
                  requestedSchema: {
                    type: "object",
                    properties: { port: { type: "string", title: "Which port?" } },
                    required: ["port"],
                  },
                },
                { requestId: "pending-request", method: "elicitation/create" },
              )
              .pipe(Effect.map((result) => result.action === "accept"))
      ).pipe(Effect.forkScoped);
      const pending = (yield* opened.until(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      )).at(-1);
      assert(pending?.type === "runtime_request.updated");
      const { runtimeRequest } = pending;
      assert.equal(runtimeRequest.kind, kind === "approval" ? "command" : kind);
      assert(runtimeRequest.providerTurnId !== null);
      const steer = yield* opened.session
        .steerTurn({
          threadId: ThreadId.make("thread-antigravity-wake"),
          runId: RunId.make("run-antigravity-wake-1"),
          providerThread: opened.providerThread,
          providerTurnId: runtimeRequest.providerTurnId,
          message: {
            messageId: MessageId.make("message-antigravity-blocked-steer"),
            text: "Child finished",
            attachments: [],
            createdBy: "agent",
            creationSource: "mcp",
          },
        })
        .pipe(Effect.flip);
      assert.instanceOf(steer, ProviderAdapter.ProviderAdapterSteerDeclinedError);
      assert.lengthOf(opened.prompts, 1);
      assert.equal(opened.cancels(), 0);
      const response = yield* opened.session
        .respondToRuntimeRequest({
          requestId: runtimeRequest.id,
          ...(runtimeRequest.kind === "user_input"
            ? { answers: { port: "3000" } }
            : { decision: "accept" }),
        })
        .pipe(Effect.forkScoped);
      assert.isTrue(yield* Fiber.join(request));
      yield* opened.acknowledgeResponse("pending-request");
      yield* Fiber.join(response);
      yield* Deferred.succeed(release, undefined);
      const terminal = (yield* opened.throughTerminal).at(-1);
      assert(terminal?.type === "turn.terminal" && terminal.status === "completed");

      yield* opened.startTurn(2, false);
      const next = (yield* opened.throughTerminal).at(-1);
      assert(next?.type === "turn.terminal" && next.status === "completed");
      assert.equal(opened.runtimes(), 1);
    }).pipe(Effect.provide(layerSession)),
);

it.effect(
  "declines steering when a wire permission/elicitation arrives before pendingRuntimeRequests, without declining non-blocking requests",
  () =>
    Effect.gen(function* () {
      const releasePrompt1 = yield* Deferred.make<void>();
      const steerStarted = yield* Deferred.make<void>();
      const opened = yield* openSessionWithRunningCommand(
        {},
        undefined,
        { agentVersion: "1.5.13", holdsFirstPrompt: false },
        {
          prompt: (_runtime, ordinal) =>
            ordinal === 1
              ? Deferred.await(releasePrompt1).pipe(Effect.as({ stopReason: "end_turn" as const }))
              : Deferred.succeed(steerStarted, undefined).pipe(
                  Effect.as({ stopReason: "end_turn" as const }),
                ),
        },
      );
      yield* opened.startTurn(1, false);
      const started = (yield* opened.until(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      )).at(-1);
      assert(started?.type === "provider_turn.updated");

      // Incoming blocking request on the wire before any runtime_request.updated is projected.
      yield* opened.incomingRequest("wire-perm-1", "session/request_permission");
      const declined = yield* opened.session
        .steerTurn({
          threadId: ThreadId.make("thread-antigravity-wake"),
          runId: RunId.make("run-antigravity-wake-1"),
          providerThread: opened.providerThread,
          providerTurnId: started.providerTurn.id,
          message: {
            messageId: MessageId.make("message-antigravity-early-guard"),
            text: "Child finished",
            attachments: [],
            createdBy: "agent",
            creationSource: "mcp",
          },
        })
        .pipe(Effect.flip);
      assert.instanceOf(declined, ProviderAdapter.ProviderAdapterSteerDeclinedError);
      assert.lengthOf(opened.prompts, 1);
      yield* opened.acknowledgeResponse("wire-perm-1");

      // Non-blocking incoming requests (e.g. fs/read_text_file) must not decline steers.
      yield* opened.incomingRequest("wire-fs-1", "fs/read_text_file");
      yield* opened.session.steerTurn({
        threadId: ThreadId.make("thread-antigravity-wake"),
        runId: RunId.make("run-antigravity-wake-1"),
        providerThread: opened.providerThread,
        providerTurnId: started.providerTurn.id,
        message: {
          messageId: MessageId.make("message-antigravity-nonblocking-steer"),
          text: "Proceed after fs read",
          attachments: [],
          createdBy: "agent",
          creationSource: "mcp",
        },
      });
      yield* Deferred.await(steerStarted);
      yield* opened.acknowledgeResponse("wire-fs-1");
      yield* Deferred.succeed(releasePrompt1, undefined);
      const terminal = (yield* opened.throughTerminal).at(-1);
      assert(terminal?.type === "turn.terminal" && terminal.status === "completed");
      assert.equal(opened.runtimes(), 1);
    }).pipe(Effect.provide(layerSession)),
);

it.effect.each(["user_input", "approval"] as const)(
  "recovers from a raced blocked steer on real AcpSessionRuntime.prompt without failing the active %s turn",
  (kind) =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand(
        {},
        undefined,
        { agentVersion: "1.5.13", holdsFirstPrompt: false },
        {
          runtimeMode: "approval-required",
          useRealPrompt: true,
          mockEnv: () => ({
            T3_ACP_STEER_BEHAVIOR:
              kind === "user_input"
                ? "raced-blocked-steer-question"
                : "raced-blocked-steer-permission",
          }),
        },
      );
      yield* opened.startTurn(1, false);
      const started = (yield* opened.until(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      )).at(-1);
      assert(started?.type === "provider_turn.updated");
      yield* opened.until(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "assistant_message" &&
          event.turnItem.text.includes("Working on turn 1..."),
      );

      // Steer races BEFORE the agent sends the elicitation/permission over stdio.
      // Real AcpSessionRuntime.prompt hands off via `released` and receives the blocked error.
      const racedAppContext = [{ key: "raced_ctx", text: "must survive rollback" }] as const;
      const steer = yield* opened.session
        .steerTurn({
          threadId: ThreadId.make("thread-antigravity-wake"),
          runId: RunId.make("run-antigravity-wake-1"),
          providerThread: opened.providerThread,
          providerTurnId: started.providerTurn.id,
          appContext: racedAppContext,
          message: {
            messageId: MessageId.make("message-antigravity-raced-blocked-steer"),
            text: "Child finished",
            attachments: [],
            createdBy: "agent",
            creationSource: "mcp",
          },
        })
        .pipe(Effect.flip);
      assert.instanceOf(steer, ProviderAdapter.ProviderAdapterSteerDeclinedError);
      assert.equal(opened.runtimes(), 1);

      // Now the real permission/question from prompt #1 arrives and Turn 1 completes once answered.
      const pending = (yield* opened.until(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      )).at(-1);
      assert(pending?.type === "runtime_request.updated");
      const { runtimeRequest } = pending;
      assert.equal(runtimeRequest.kind, kind === "approval" ? "command" : kind);
      yield* opened.session.respondToRuntimeRequest({
        requestId: runtimeRequest.id,
        ...(runtimeRequest.kind === "user_input"
          ? { answers: { port: "3000" } }
          : { decision: "accept" }),
      });

      const terminal = (yield* opened.throughTerminal).at(-1);
      assert(terminal?.type === "turn.terminal" && terminal.status === "completed");
      assert.equal(opened.runtimes(), 1);

      // The next turn runs on the same healthy runtime and receives the rolled-back appContext.
      yield* opened.startTurn(2, false, racedAppContext);
      const next = (yield* opened.throughTerminal).at(-1);
      assert(next?.type === "turn.terminal" && next.status === "completed");
      assert.equal(opened.runtimes(), 1);
      const turn2Prompt = opened.prompts.at(-1)?.prompt ?? [];
      assert.isTrue(
        turn2Prompt.some(
          (block) => block.type === "text" && block.text.includes("must survive rollback"),
        ),
        "rolled-back appContext from the declined steer must be delivered on Turn 2",
      );
    }).pipe(Effect.provide(layerSession)),
);

it.effect.each(["steer", "start"] as const)(
  "quarantines and immediately tears down a wedged runtime after a rejected %s prompt on real AcpSessionRuntime.prompt",
  (source) =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand(
        {},
        undefined,
        { agentVersion: "1.5.13", holdsFirstPrompt: false },
        {
          useRealPrompt: true,
          mockEnv: (runtimeOrdinal) =>
            runtimeOrdinal === 1
              ? {
                  T3_ACP_STEER_BEHAVIOR:
                    source === "steer" ? "rejected-steer-orphaned" : "blocked-start-turn",
                }
              : {},
        },
      );
      yield* opened.startTurn(1, false);
      if (source === "steer") {
        const started = (yield* opened.until(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running",
        )).at(-1);
        assert(started?.type === "provider_turn.updated");
        yield* opened.until(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "running",
        );
        yield* opened.session
          .steerTurn({
            threadId: ThreadId.make("thread-antigravity-wake"),
            runId: RunId.make("run-antigravity-wake-1"),
            providerThread: opened.providerThread,
            providerTurnId: started.providerTurn.id,
            message: {
              messageId: MessageId.make("message-antigravity-rejected-steer"),
              text: "Child finished",
              attachments: [],
              createdBy: "agent",
              creationSource: "mcp",
            },
          })
          .pipe(Effect.flip);
      }
      const failed = (yield* opened.throughTerminal).at(-1);
      assert(failed?.type === "turn.terminal" && failed.status === "failed");

      // Wedged runtime must be torn down immediately — before Turn 2 even starts.
      yield* opened.runtimeClosed(1);
      assert.isFalse(
        yield* opened.session.hasPendingBackgroundWork ?? Effect.succeed(false),
        "quarantined wedged runtime must not pin sessionHasPendingBackgroundWork",
      );
      assert.lengthOf(opened.offers, 0);

      yield* opened.startTurn(2, false);
      const next = (yield* opened.throughTerminal).at(-1);
      assert(next?.type === "turn.terminal" && next.status === "completed");
      assert.equal(opened.runtimes(), 2);
      assert.lengthOf(opened.offers, 0);
    }).pipe(Effect.provide(layerSession)),
);

it.effect(
  "cancels pending approvals and user inputs and drops late orphaned updates on wedged failure quarantine",
  () =>
    Effect.gen(function* () {
      const failPrompt1 = yield* Deferred.make<void>();
      const opened = yield* openSessionWithRunningCommand(
        {},
        undefined,
        { agentVersion: "1.5.13", holdsFirstPrompt: false },
        {
          runtimeMode: "approval-required",
          prompt: (runtimeOrdinal) =>
            runtimeOrdinal === 1
              ? Deferred.await(failPrompt1).pipe(
                  Effect.andThen(Effect.fail(antigravityBlockedPromptError())),
                )
              : Effect.succeed({ stopReason: "end_turn" as const }),
        },
      );
      yield* opened.startTurn(1, false);
      yield* opened.until(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );

      // Open BOTH a pending approval AND a pending user_input request on Turn 1.
      yield* opened
        .requestPermission(
          {
            sessionId: "mock-session-1",
            toolCall: { toolCallId: "cmd_quarantine", kind: "execute", title: "Run command?" },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          },
          { requestId: "quarantine-approval", method: "session/request_permission" },
        )
        .pipe(Effect.forkScoped);
      const pendingApproval = (yield* opened.until(
        (event) =>
          event.type === "runtime_request.updated" &&
          event.runtimeRequest.status === "pending" &&
          event.runtimeRequest.kind === "command",
      )).at(-1);
      assert(pendingApproval?.type === "runtime_request.updated");

      yield* opened
        .elicit(
          {
            sessionId: "mock-session-1",
            mode: "form",
            message: "Need one answer",
            requestedSchema: {
              type: "object",
              properties: { port: { type: "string", title: "Which port?" } },
              required: ["port"],
            },
          },
          { requestId: "quarantine-question", method: "elicitation/create" },
        )
        .pipe(Effect.forkScoped);
      const pendingQuestion = (yield* opened.until(
        (event) =>
          event.type === "runtime_request.updated" &&
          event.runtimeRequest.status === "pending" &&
          event.runtimeRequest.kind === "user_input",
      )).at(-1);
      assert(pendingQuestion?.type === "runtime_request.updated");

      // Fail Turn 1 with a wedged blocked-session error.
      yield* Deferred.succeed(failPrompt1, undefined);
      const seenToTerminal = yield* opened.throughTerminal;
      const failed = seenToTerminal.at(-1);
      assert(failed?.type === "turn.terminal" && failed.status === "failed");

      const cancelledRequestIds = new Set(
        seenToTerminal
          .filter(
            (event): event is Extract<typeof event, { type: "runtime_request.updated" }> =>
              event.type === "runtime_request.updated" &&
              event.runtimeRequest.status === "cancelled",
          )
          .map((event) => event.runtimeRequest.id),
      );
      assert.isTrue(
        cancelledRequestIds.has(pendingApproval.runtimeRequest.id),
        "pending approval must be cancelled during wedged quarantine",
      );
      assert.isTrue(
        cancelledRequestIds.has(pendingQuestion.runtimeRequest.id),
        "pending user_input must be cancelled during wedged quarantine",
      );

      // Late session/update frames from the orphaned runtime must be ignored and never buffer.
      yield* opened.send({
        sessionUpdate: "tool_call_update",
        ...opened.command,
        status: "completed",
        rawOutput: { output: "stale orphan completion", exit_code: 0 },
      });
      yield* opened.send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "stale orphan assistant text" },
      });

      yield* opened.runtimeClosed(1);
      assert.lengthOf(opened.offers, 0);
      assert.isFalse(yield* opened.session.hasPendingBackgroundWork ?? Effect.succeed(false));

      yield* opened.startTurn(2, false);
      const turn2Events = yield* opened.throughTerminal;
      const next = turn2Events.at(-1);
      assert(next?.type === "turn.terminal" && next.status === "completed");
      assert.equal(opened.runtimes(), 2);
      assert.isFalse(
        turn2Events.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.text.includes("stale orphan"),
        ),
        "orphaned updates must never replay into the replacement runtime",
      );
    }).pipe(Effect.provide(layerSession)),
);

it.effect(
  "does not dispatch a delayed prompt #1 fiber when a steer supersedes it before dispatch",
  () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const opened = yield* openSessionWithRunningCommand(
        {},
        undefined,
        { agentVersion: "1.5.13", holdsFirstPrompt: false },
        {
          useRealPrompt: true,
          mockEnv: () => ({ T3_ACP_STEER_BEHAVIOR: "complete-with-text" }),
        },
      );
      const nativeThreadId = opened.providerThread.nativeThreadRef?.nativeId ?? "mock-session-1";
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: opened.providerThread.driver,
        nativeTurnId: `provider-instance:${opened.providerThread.providerInstanceId}:${nativeThreadId}:turn:1`,
      });
      yield* opened.startTurn(1, false);
      // Steer immediately before prompt #1's forked fiber runs sendPromptWhenIdle.
      yield* opened.session.steerTurn({
        threadId: ThreadId.make("thread-antigravity-wake"),
        runId: RunId.make("run-antigravity-wake-1"),
        providerThread: opened.providerThread,
        providerTurnId,
        message: {
          messageId: MessageId.make("message-antigravity-immediate-steer"),
          text: "Immediate steer before prompt 1 runs",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      const events = yield* opened.throughTerminal;
      const terminal = events.at(-1);
      assert(terminal?.type === "turn.terminal" && terminal.status === "completed");
      assert.equal(opened.runtimes(), 1);
      assert.lengthOf(
        opened.prompts,
        1,
        "superseded delayed prompt #1 fiber must not dispatch a second session/prompt",
      );
      assert.isTrue(
        opened.prompts[0]!.prompt.some(
          (block) =>
            block.type === "text" && block.text.includes("Immediate steer before prompt 1 runs"),
        ),
      );
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.text.includes("Immediate steer before prompt 1 runs"),
        ),
      );
    }).pipe(Effect.provide(layerSession)),
);

it.effect(
  "queues a declined steer during a pending ask_question end-to-end and runs it after Turn 1 completes",
  () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const cwd = yield* checkpointWorkspace("antigravity-declined-steer-e2e");
      const instanceId = ProviderInstanceId.make("antigravity-e2e-steer");
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation,
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: {
                T3_ACP_ANTIGRAVITY: "1",
                T3_ACP_AGENT_VERSION: "1.5.13",
                T3_ACP_STEER_BEHAVIOR: "ask-question-then-complete",
              },
            },
          }).pipe(Effect.provideService(SecureRandom.SecureRandom, crypto)),
        withProcess: (_close, task) => task,
        defaultModel: Effect.undefined,
      });
      const layer = ProviderReplayHarness.layerWithRegistry(
        { name: "antigravity-declined-steer-e2e" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { runEffectWorker: false },
      );

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:antigravity-declined-steer-e2e");
        const waitForDomainEvent = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runHead,
            Effect.forkScoped,
          );

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-e2e"),
          threadId,
          projectId: ProjectId.make("project:antigravity-declined-steer-e2e"),
          title: "Antigravity declined steer e2e",
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });

        const pendingQuestionEvent = yield* waitForDomainEvent(
          (event) =>
            event.type === "runtime-request.updated" &&
            event.payload.kind === "user_input" &&
            event.payload.status === "pending",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("turn-1"),
          threadId,
          messageId: MessageId.make("message:turn-1"),
          text: "Start turn 1",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const questionOption = yield* Fiber.join(pendingQuestionEvent);
        assert(
          questionOption._tag === "Some" && questionOption.value.type === "runtime-request.updated",
        );
        const questionRequestId = questionOption.value.payload.id;

        const beforeSteer = yield* orchestrator.getThreadProjection(threadId);
        const turn1Run = beforeSteer.runs[0]!;

        // Dispatch a steer while Turn 1 is waiting on ask_question.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer-1"),
          threadId,
          messageId: MessageId.make("message:steer-1"),
          text: "Queued follow-up after question",
          attachments: [],
          dispatchMode: { type: "steer_active", targetRunId: turn1Run.id },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        const midProjection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(midProjection.runs[0]?.status, "running");
        assert.isTrue(
          midProjection.runs.some(
            (run) =>
              run.status === "queued" && run.userMessageId === MessageId.make("message:steer-1"),
          ),
          "declined steer must be queued as a follow-up run without failing Turn 1",
        );

        // Answer the ask_question; Turn 1 completes and Turn 2 runs automatically.
        const turn1Completed = yield* waitForDomainEvent(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === turn1Run.id &&
            event.payload.status === "completed",
        );
        yield* orchestrator.dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make("answer-question"),
          threadId,
          requestId: questionRequestId,
          answers: { port: "3000" },
        });
        yield* worker.drain();
        yield* Fiber.join(turn1Completed);

        const queuedRun = midProjection.runs.find((run) => run.status === "queued")!;
        const turn2Completed = yield* waitForDomainEvent(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === queuedRun.id &&
            event.payload.status === "completed",
        );
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        yield* Fiber.join(turn2Completed);

        const finalProjection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(finalProjection.runs[0]?.status, "completed");
        assert.equal(
          finalProjection.runs.find((run) => run.id === queuedRun.id)?.status,
          "completed",
        );
        assert.isTrue(
          finalProjection.visibleTurnItems.some(
            ({ item }) =>
              item.type === "assistant_message" &&
              item.text.includes("Queued follow-up after question"),
          ),
          "queued follow-up run must deliver the declined steer message after Turn 1 completes",
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(layerSession)),
);

it.effect.each(["prompt1-callback-first", "steer2-rejection-first"] as const)(
  "settles Turn 1 cleanly and resolves promptWireSettled when Prompt #1 completes around a raced blocked steer (%s)",
  (ordering) =>
    Effect.gen(function* () {
      const prompt1Release = yield* Deferred.make<void>();
      const steer2Dispatched = yield* Deferred.make<void>();
      const steer2Release = yield* Deferred.make<void>();
      const prompt1CallbackDone = yield* Deferred.make<void>();
      const prompt1WireSettled = yield* Deferred.make<void>();
      const releasePrompt1Callback = yield* Deferred.make<void>();
      const heldForPendingReply = yield* Deferred.make<void>();
      let pendingReply = true;
      let wireSettleCount = 0;

      const opened = yield* openSessionWithRunningCommand(
        {},
        undefined,
        { agentVersion: "1.5.13", holdsFirstPrompt: false },
        {
          flavorOverrides: {
            promptInactivityTimeout: "80 millis",
            hasPendingReply: () => Effect.succeed(pendingReply),
          },
          testHooks: {
            afterPromptWireSettled: () =>
              Effect.gen(function* () {
                wireSettleCount += 1;
                if (wireSettleCount === 1) {
                  yield* Deferred.succeed(prompt1WireSettled, undefined);
                  if (ordering === "steer2-rejection-first") {
                    yield* Deferred.await(releasePrompt1Callback);
                  }
                }
              }),
            afterPromptCallback: () =>
              Deferred.succeed(prompt1CallbackDone, undefined).pipe(Effect.asVoid),
            afterPromptSettledWithBackgroundWork: () =>
              Deferred.succeed(heldForPendingReply, undefined).pipe(Effect.asVoid),
          },
          prompt: (_runtimeOrdinal, promptOrdinal) => {
            if (promptOrdinal === 1) {
              return Deferred.await(prompt1Release).pipe(
                Effect.as({ stopReason: "end_turn" as const }),
              );
            }
            if (promptOrdinal === 2) {
              return Deferred.succeed(steer2Dispatched, undefined).pipe(
                Effect.andThen(Deferred.await(steer2Release)),
                Effect.andThen(Effect.fail(antigravityBlockedPromptError())),
              );
            }
            return Effect.succeed({ stopReason: "end_turn" as const });
          },
        },
      );

      yield* opened.startTurn(1, false);
      const started = (yield* opened.until(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      )).at(-1);
      assert(started?.type === "provider_turn.updated");

      const racedAppContext = [{ key: "raced_ctx_issue1", text: "must survive race" }] as const;
      const steerFiber = yield* opened.session
        .steerTurn({
          threadId: ThreadId.make("thread-antigravity-wake"),
          runId: RunId.make("run-antigravity-wake-1"),
          providerThread: opened.providerThread,
          providerTurnId: started.providerTurn.id,
          appContext: racedAppContext,
          message: {
            messageId: MessageId.make("message-antigravity-race-issue1"),
            text: "Steer racing Prompt #1 wire completion",
            attachments: [],
            createdBy: "agent",
            creationSource: "mcp",
          },
        })
        .pipe(Effect.flip, Effect.forkScoped);

      // Steer #2 is now in flight (activePromptSequence === 2, inFlightPromptSequences === {1, 2}).
      yield* Deferred.await(steer2Dispatched);

      // Prompt #1 finishes on the wire while superseded by Steer #2.
      yield* Deferred.succeed(prompt1Release, undefined);
      if (ordering === "prompt1-callback-first") {
        // Wait for Prompt #1's callback to run and stash its completion BEFORE Steer #2 rejects.
        yield* Deferred.await(prompt1CallbackDone);
        yield* Deferred.succeed(steer2Release, undefined);
      } else {
        // Prompt #1 settled on wire (skipping Effect.tap promptWireSettled), paused before callback.
        yield* Deferred.await(prompt1WireSettled);
        yield* Deferred.succeed(steer2Release, undefined);
        const declined = yield* Fiber.join(steerFiber);
        assert.instanceOf(declined, ProviderAdapter.ProviderAdapterSteerDeclinedError);
        yield* Deferred.succeed(releasePrompt1Callback, undefined);
      }

      if (ordering === "prompt1-callback-first") {
        const declined = yield* Fiber.join(steerFiber);
        assert.instanceOf(declined, ProviderAdapter.ProviderAdapterSteerDeclinedError);
      }

      // Prompt #1 settled into pendingReply hold. Advance past promptInactivityTimeout (80ms):
      // if promptWireSettled was left unresolved on restored ownership, the watchdog would
      // fail Turn 1 and kill the runtime here.
      yield* Deferred.await(heldForPendingReply);
      yield* TestClock.adjust("150 millis");
      assert.equal(opened.runtimes(), 1);

      // Release pendingReply and let deferred finalize complete Turn 1 cleanly.
      pendingReply = false;
      yield* opened.send(opened.usage);
      const debounce = yield* Queue.take(opened.scheduledFinalizes);
      yield* TestClock.adjust(debounce);

      const terminal = (yield* opened.throughTerminal).at(-1);
      assert(terminal?.type === "turn.terminal" && terminal.status === "completed");
      assert.equal(opened.runtimes(), 1);

      // Follow-up turn succeeds on the SAME healthy runtime with the rolled-back appContext.
      yield* opened.startTurn(2, false, racedAppContext);
      const next = (yield* opened.throughTerminal).at(-1);
      assert(next?.type === "turn.terminal" && next.status === "completed");
      assert.equal(opened.runtimes(), 1);
      const turn2Prompt = opened.prompts.at(-1)?.prompt ?? [];
      assert.isTrue(
        turn2Prompt.some(
          (block) => block.type === "text" && block.text.includes("must survive race"),
        ),
        "rolled-back appContext from the declined steer must be delivered on Turn 2",
      );
    }).pipe(Effect.provide(layerSession)),
);

it.effect(
  "restores activePromptSequence and turn state without hanging Turn 1 when forkFollowPrompt fails during steer",
  () =>
    Effect.gen(function* () {
      const releasePrompt1 = yield* Deferred.make<void>();
      const opened = yield* openSessionWithRunningCommand(
        {},
        undefined,
        { agentVersion: "1.5.13", holdsFirstPrompt: false },
        {
          testHooks: {
            beforeForkFollowPrompt: (sequence) =>
              sequence === 2 ? Effect.die("simulated forkFollowPrompt failure") : Effect.void,
          },
          prompt: (_runtimeOrdinal, promptOrdinal) =>
            promptOrdinal === 1
              ? Deferred.await(releasePrompt1).pipe(Effect.as({ stopReason: "end_turn" as const }))
              : Effect.succeed({ stopReason: "end_turn" as const }),
        },
      );

      yield* opened.startTurn(1, false);
      const started = (yield* opened.until(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      )).at(-1);
      assert(started?.type === "provider_turn.updated");

      const steerExit = yield* opened.session
        .steerTurn({
          threadId: ThreadId.make("thread-antigravity-wake"),
          runId: RunId.make("run-antigravity-wake-1"),
          providerThread: opened.providerThread,
          providerTurnId: started.providerTurn.id,
          appContext: [{ key: "failed_fork_ctx", text: "must roll back" }],
          message: {
            messageId: MessageId.make("message-antigravity-failed-fork"),
            text: "Steer whose forkFollowPrompt fails",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(steerExit));
      assert.lengthOf(opened.prompts, 1);

      // Prompt #1 must NOT be permanently superseded: completing it finishes Turn 1 cleanly.
      yield* Deferred.succeed(releasePrompt1, undefined);
      const terminal = (yield* opened.throughTerminal).at(-1);
      assert(terminal?.type === "turn.terminal" && terminal.status === "completed");
      assert.equal(opened.runtimes(), 1);
    }).pipe(Effect.provide(layerSession)),
);

it.effect(
  "commits steer fork and foregroundIdle handoff atomically when steerTurn is interrupted mid-commit",
  () =>
    Effect.gen(function* () {
      const hookReached = yield* Deferred.make<void>();
      const interruptIssued = yield* Deferred.make<void>();
      const opened = yield* openSessionWithRunningCommand(
        {},
        undefined,
        { agentVersion: "1.5.13", holdsFirstPrompt: false },
        {
          runtimeMode: "approval-required",
          useRealPrompt: true,
          mockEnv: () => ({ T3_ACP_STEER_BEHAVIOR: "raced-blocked-steer-permission" }),
          testHooks: {
            afterSteerForkBeforeRelease: () =>
              Deferred.succeed(hookReached, undefined).pipe(
                Effect.andThen(Deferred.await(interruptIssued)),
              ),
          },
        },
      );

      yield* opened.startTurn(1, false);
      const started = (yield* opened.until(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      )).at(-1);
      assert(started?.type === "provider_turn.updated");
      yield* opened.until(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "assistant_message" &&
          event.turnItem.text.includes("Working on turn 1..."),
      );

      const steerFiber = yield* opened.session
        .steerTurn({
          threadId: ThreadId.make("thread-antigravity-wake"),
          runId: RunId.make("run-antigravity-wake-1"),
          providerThread: opened.providerThread,
          providerTurnId: started.providerTurn.id,
          message: {
            messageId: MessageId.make("message-antigravity-interrupted-commit"),
            text: "Steer interrupted between fork and release",
            attachments: [],
            createdBy: "agent",
            creationSource: "mcp",
          },
        })
        .pipe(Effect.forkScoped);

      // Trigger interruption while steerWithPrompt is right between forkFollowPrompt and
      // Deferred.succeed(previousForegroundIdle, undefined). Because the commit section is
      // uninterruptible, previousForegroundIdle MUST still be resolved so Prompt #2 reaches
      // the runtime, declines, restores Prompt #1, and Turn 1 finishes instead of hanging.
      yield* Deferred.await(hookReached);
      yield* Fiber.interrupt(steerFiber).pipe(Effect.forkScoped);
      yield* Deferred.succeed(interruptIssued, undefined);
      const steerExit = yield* Fiber.await(steerFiber);
      assert.isTrue(Exit.isFailure(steerExit));

      const pending = (yield* opened.until(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      )).at(-1);
      assert(pending?.type === "runtime_request.updated");
      yield* opened.session.respondToRuntimeRequest({
        requestId: pending.runtimeRequest.id,
        decision: "accept",
      });

      const terminal = (yield* opened.throughTerminal).at(-1);
      assert(terminal?.type === "turn.terminal" && terminal.status === "completed");
      assert.equal(opened.runtimes(), 1);
    }).pipe(Effect.provide(layerSession)),
);

it.live.each(["completes-on-cancel", "retires-on-cancel-timeout"] as const)(
  "preserves AcpSessionRuntime wait-for-prompt cancel behavior after a raced blocked steer declines (%s)",
  (mode) =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand(
        {},
        undefined,
        { agentVersion: "1.5.13", holdsFirstPrompt: false },
        {
          useRealPrompt: true,
          useRealCancel: true,
          cancelTimeout: "180 millis",
          mockEnv: (runtimeOrdinal) =>
            runtimeOrdinal === 1
              ? {
                  T3_ACP_STEER_BEHAVIOR:
                    mode === "completes-on-cancel"
                      ? "raced-blocked-steer-cancel-wait"
                      : "raced-blocked-steer-cancel-hang",
                }
              : {},
        },
      );

      yield* opened.startTurn(1, false);
      const started = (yield* opened.until(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      )).at(-1);
      assert(started?.type === "provider_turn.updated");
      yield* opened.until(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "assistant_message" &&
          event.turnItem.text.includes("Working on turn 1..."),
      );

      // Raced steer releases Prompt #1 from activePromptRef into releasedPromptsRef,
      // then fails with blockedOnRuntimeRequest (clearing activePromptRef to None).
      const declined = yield* opened.session
        .steerTurn({
          threadId: ThreadId.make("thread-antigravity-wake"),
          runId: RunId.make("run-antigravity-wake-1"),
          providerThread: opened.providerThread,
          providerTurnId: started.providerTurn.id,
          message: {
            messageId: MessageId.make("message-antigravity-cancel-after-declined-steer"),
            text: "Raced steer before stop",
            attachments: [],
            createdBy: "agent",
            creationSource: "mcp",
          },
        })
        .pipe(Effect.flip);
      assert.instanceOf(declined, ProviderAdapter.ProviderAdapterSteerDeclinedError);
      assert.equal(opened.runtimes(), 1);

      if (mode === "completes-on-cancel") {
        // Real runtime.cancel under wait-for-prompt MUST wait for Prompt #1's cancelled
        // response and drain its final assistant chunk instead of returning immediately.
        yield* opened.session.interruptTurn({
          providerThread: opened.providerThread,
          providerTurnId: started.providerTurn.id,
        });
        const events = yield* opened.throughTerminal;
        const terminal = events.at(-1);
        assert(terminal?.type === "turn.terminal" && terminal.status === "interrupted");
        assert.isTrue(
          events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "assistant_message" &&
              event.turnItem.text.includes("Cancelling turn 1..."),
          ),
          "wait-for-prompt cancel must await Prompt #1 and drain its cancellation updates",
        );
        assert.equal(opened.runtimes(), 1);

        // Runtime stays healthy for Turn 2.
        yield* opened.startTurn(2, false);
        const next = (yield* opened.throughTerminal).at(-1);
        assert(next?.type === "turn.terminal" && next.status === "completed");
        assert.equal(opened.runtimes(), 1);
      } else {
        // Prompt #1 ignores session/cancel; wait-for-prompt cancel MUST time out and
        // retire the hung runtime rather than returning early and leaking the process.
        const interruptExit = yield* opened.session
          .interruptTurn({
            providerThread: opened.providerThread,
            providerTurnId: started.providerTurn.id,
          })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(interruptExit));
        const terminal = (yield* opened.throughTerminal).at(-1);
        assert(terminal?.type === "turn.terminal" && terminal.status === "interrupted");

        // The retired hung runtime must be replaced on Turn 2.
        yield* opened.startTurn(2, false);
        const next = (yield* opened.throughTerminal).at(-1);
        assert(next?.type === "turn.terminal" && next.status === "completed");
        assert.equal(opened.runtimes(), 2);
      }
    }).pipe(Effect.provide(layerSession)),
);

describe("AntigravityAdapterV2 work after the prompt ends", () => {
  // agy sets `IsDaemon` on a command it does not wait for. When it exits, the agent replies
  // with no prompt open.
  it.effect("continues in one run when a finished daemon wakes the agent", () =>
    Effect.gen(function* () {
      const { command, usage, offers, send, startTurn, throughTerminal, requestPermission } =
        yield* openSessionWithRunningCommand({ IsDaemon: true, WaitMsBeforeAsync: 500 });
      yield* startTurn(1, false);
      const promptTerminal = (yield* throughTerminal).at(-1);
      assert.equal(promptTerminal?.type === "turn.terminal" && promptTerminal.status, "completed");

      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      assert.lengthOf(offers, 1, "the finished daemon must wake the thread");
      // The agent can ask before the app has started the continuation run.
      const followUp = { toolCallId: "call_analyze", kind: "execute", title: "node analyze.mjs" };
      const permission = yield* requestPermission(
        {
          sessionId: "mock-session-1",
          toolCall: { ...followUp, status: "pending" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
        { requestId: "permission-1", method: "session/request_permission" },
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* offers[0]!.dispatchIfCurrent!(Effect.void);
      yield* startTurn(2, true);
      assert.deepEqual(yield* Fiber.join(permission), {
        outcome: { outcome: "selected", optionId: "allow" },
      });

      // The model took 6.7 s to answer the finished command; the run must outlast that silence.
      yield* TestClock.adjust("10 seconds");
      yield* send({ sessionUpdate: "tool_call", ...followUp, status: "completed" });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Here is the chart." },
      });
      yield* TestClock.adjust("10 seconds");
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const continued = yield* throughTerminal;
      const continuedTerminal = continued.at(-1);
      assert.equal(
        continuedTerminal?.type === "turn.terminal" && continuedTerminal.status,
        "completed",
      );
      assert.isTrue(
        continued.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.runId === RunId.make("run-antigravity-wake-2"),
        ),
        "the reply belongs to the continuation run",
      );
      const finished = continued.findLast(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId,
      );
      assert.equal(finished?.type === "turn_item.updated" && finished.turnItem.status, "completed");
      assert.lengthOf(offers, 1, "one wake is one run");
    }).pipe(Effect.provide(layerSession)),
  );

  // Frames as agy 1.5.11 sent them for `run_command` with `WaitMsBeforeAsync`: the prompt returns
  // end_turn while the command runs, and the agent replies when the command finishes.
  it.effect("keeps the run open while a command the agent waits for still runs", () =>
    Effect.gen(function* () {
      const { command, usage, offers, send, startTurn, until, throughPromptSettled } =
        yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
      yield* startTurn(1, false);
      yield* throughPromptSettled;
      // Progress keeps a command past the post-settle hold bound, which counts silence only.
      for (const minute of [10, 20, 30]) {
        yield* TestClock.adjust("10 minutes");
        yield* send({
          sessionUpdate: "tool_call_update",
          ...command,
          status: "in_progress",
          rawOutput: { output: `fetched ${minute} pages` },
        });
      }
      yield* TestClock.adjust("10 minutes");
      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      yield* TestClock.adjust("10 seconds");
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Here is the chart." },
      });
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const run = yield* until((event) => event.type === "turn.terminal");
      const terminal = run.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      assert.include(JSON.stringify(run), "Here is the chart.", "the reply is part of the run");
      assert.lengthOf(offers, 0, "the open run needs no continuation");
    }).pipe(Effect.provide(layerSession)),
  );

  // A command whose terminal update never arrives would hold the run in Working forever with
  // an empty pending list and a finished reply above Stop.
  it.effect("settles a silent background command after the post-settle hold timeout", () =>
    Effect.gen(function* () {
      const { command, offers, startTurn, until, throughPromptSettled } =
        yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
      yield* startTurn(1, false);
      const prompt = yield* throughPromptSettled;

      // A running tool keeps the inactivity watchdog re-armed, so 20 silent minutes do not
      // settle this run on their own.
      yield* TestClock.adjust("20 minutes");
      yield* TestClock.adjust("11 minutes");
      const run = yield* until((event) => event.type === "turn.terminal");
      const terminal = run.at(-1);
      assert.equal(
        terminal?.type === "turn.terminal" && terminal.status,
        "completed",
        "the bounded hold finalizes the turn instead of leaving it running forever",
      );
      assert.equal(terminal?.type === "turn.terminal" && terminal.failure, null);
      assert.lengthOf(offers, 0, "a silent command produces no wake on its own");
      const commandItem = [...prompt, ...run].findLast(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId,
      );
      assert.isTrue(
        commandItem?.type === "turn_item.updated" && commandItem.turnItem.status === "completed",
        "the silent command is no longer left as live activity on a settled run",
      );
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect("keeps a silent scheduled wake in its run past the command hold bound", () =>
    Effect.gen(function* () {
      const { usage, offers, send, startTurn, until, throughPromptSettled } =
        yield* openSessionWithRunningCommand({}, undefined, undefined, {
          initialToolCalls: [
            {
              sessionUpdate: "tool_call",
              toolCallId: "call_schedule",
              kind: "other",
              title: "Run schedule",
              status: "in_progress",
              rawInput: { DurationSeconds: 3600, Prompt: "Continue the task" },
            },
          ],
        });
      yield* startTurn(1, false);
      yield* throughPromptSettled;
      yield* TestClock.adjust("61 minutes");
      yield* send({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_schedule",
        status: "completed",
      });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Picked the task back up." },
      });
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const run = yield* until((event) => event.type === "turn.terminal");
      assert.include(
        JSON.stringify(run),
        "Picked the task back up.",
        "the wake reply stays in the run",
      );
      assert.lengthOf(offers, 0);
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect("keeps an unanswered question open past the command hold bound", () =>
    Effect.gen(function* () {
      const { command, usage, send, startTurn, until, throughPromptSettled, requestPermission } =
        yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
      yield* startTurn(1, false);
      yield* throughPromptSettled;
      const question = yield* requestPermission(
        {
          sessionId: "mock-session-1",
          toolCall: { toolCallId: "interaction_1", kind: "other", title: "Which port?" },
          options: [
            { optionId: "3000", name: "3000", kind: "allow_once" },
            { optionId: "8080", name: "8080", kind: "allow_once" },
          ],
        },
        { requestId: "question-1", method: "session/request_permission" },
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* TestClock.adjust("31 minutes");
      yield* Fiber.interrupt(question);
      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Here is the chart." },
      });
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const run = yield* until((event) => event.type === "turn.terminal");
      assert.include(JSON.stringify(run), "Here is the chart.", "the question kept the run open");
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect("fails a turn held by background work when its runtime is closed", () =>
    Effect.gen(function* () {
      const { startTurn, throughPromptSettled, closeRuntime, throughTerminal } =
        yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
      yield* startTurn(1, false);
      yield* throughPromptSettled;
      yield* closeRuntime;
      const terminal = (yield* throughTerminal).at(-1);
      assert(terminal?.type === "turn.terminal" && terminal.status === "failed");
      assert.equal(terminal.failure.class, "transport_error");
      assert.equal(terminal.failure.retryable, true);
    }).pipe(Effect.provide(layerSession)),
  );

  // Command 2 finishes during reply 1; agy dequeues command 2 after reply 1's usage_update and
  // needs >3 s before streaming reply 2. Wait for reply 2 (bounded by the 2-minute quiet limit),
  // but still finalize at 3 s when both commands were batched into reply 1.
  it.effect.each([
    { case: "separate second wake", batched: false, stalls: false },
    { case: "batched into one wake reply", batched: true, stalls: false },
    { case: "stalled second wake hits quiet limit", batched: false, stalls: true },
  ])(
    "handles two parallel background commands finishing 500 ms apart ($case)",
    ({ batched, stalls }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profile = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agy-race-" });
        const generated = (kind: string) =>
          path.join(
            profile,
            "antigravity-acp",
            "brain",
            "mock-session-1",
            ".system_generated",
            kind,
          );
        const writeFile = (directory: string, name: string, body: string) =>
          fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(Effect.andThen(fileSystem.writeFileString(path.join(directory, name), body)));
        const cmd1 = {
          toolCallId: "call_gates",
          kind: "execute",
          title: "bin/gates back",
          rawInput: { CommandLine: "bin/gates back", WaitMsBeforeAsync: 10000 },
        } as const;
        const cmd2 = {
          toolCallId: "call_tests",
          kind: "execute",
          title: "bin/session test",
          rawInput: { CommandLine: "bin/session test", WaitMsBeforeAsync: 10000 },
        } as const;
        const { usage, offers, scheduledFinalizes, send, startTurn, until, throughPromptSettled } =
          yield* openSessionWithRunningCommand({}, undefined, undefined, {
            profileDirectory: profile,
            initialToolCalls: [
              { sessionUpdate: "tool_call", ...cmd1, status: "in_progress" },
              { sessionUpdate: "tool_call", ...cmd2, status: "in_progress" },
            ],
          });
        yield* startTurn(1, false);
        yield* throughPromptSettled;

        // Command 1 finishes and wakes the model.
        yield* writeFile(
          generated("messages"),
          "msg-1.json",
          JSON.stringify({
            id: "msg-1",
            priority: "MESSAGE_PRIORITY_HIGH",
            sender: "mock-session-1/task-1",
          }),
        );
        yield* writeFile(generated("messages"), "read.json", JSON.stringify({ "msg-1": true }));
        yield* writeFile(
          generated("logs"),
          "transcript.jsonl",
          `${JSON.stringify({ step_index: 1, type: "SYSTEM_MESSAGE", status: "DONE", content: "priority=MESSAGE_PRIORITY_HIGH task-1" })}\n`,
        );
        yield* send({
          sessionUpdate: "tool_call_update",
          ...cmd1,
          status: "completed",
          rawOutput: { output: "ok larastan", exit_code: 0 },
        });

        // 500 ms later, command 2 also finishes while reply 1 is still in flight.
        yield* TestClock.adjust("500 millis");
        yield* writeFile(
          generated("messages"),
          "msg-2.json",
          JSON.stringify({
            id: "msg-2",
            priority: "MESSAGE_PRIORITY_HIGH",
            sender: "mock-session-1/task-2",
          }),
        );
        yield* send({
          sessionUpdate: "tool_call_update",
          ...cmd2,
          status: "completed",
          rawOutput: { output: "34 passed", exit_code: 0 },
        });
        assert.equal((yield* Queue.takeAll(scheduledFinalizes)).at(-1), "2 minutes");

        // Reply 1 streams and ends with usage_update #1.
        yield* TestClock.adjust("8 seconds");
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: batched ? "gates and tests both passed." : "gates passed; waiting for tests.",
          },
        });
        assert.equal((yield* Queue.takeAll(scheduledFinalizes)).at(-1), "2 minutes");
        yield* writeFile(
          generated("messages"),
          "read.json",
          JSON.stringify({ "msg-1": true, "msg-2": true }),
        );
        yield* writeFile(
          generated("logs"),
          "transcript.jsonl",
          (batched
            ? [
                JSON.stringify({
                  step_index: 1,
                  type: "SYSTEM_MESSAGE",
                  status: "DONE",
                  content: "priority=MESSAGE_PRIORITY_HIGH task-1 + task-2",
                }),
                JSON.stringify({
                  step_index: 2,
                  type: "PLANNER_RESPONSE",
                  status: "DONE",
                  content: "gates and tests both passed.",
                }),
              ]
            : [
                JSON.stringify({
                  step_index: 1,
                  type: "SYSTEM_MESSAGE",
                  status: "DONE",
                  content: "priority=MESSAGE_PRIORITY_HIGH task-1",
                }),
                JSON.stringify({
                  step_index: 2,
                  type: "PLANNER_RESPONSE",
                  status: "DONE",
                  content: "gates passed; waiting for tests.",
                }),
                JSON.stringify({
                  step_index: 3,
                  type: "SYSTEM_MESSAGE",
                  status: "DONE",
                  content: "priority=MESSAGE_PRIORITY_HIGH task-2",
                }),
              ]
          ).join("\n") + "\n",
        );
        yield* send(usage);
        assert.equal(yield* Queue.take(scheduledFinalizes), "3000 millis");

        // Advance past the 3-second debounce.
        yield* TestClock.adjust("3 seconds");
        if (batched) {
          const run = yield* until((event) => event.type === "turn.terminal");
          const terminal = run.at(-1);
          assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
          assert.include(JSON.stringify(run), "gates and tests both passed.");
          assert.lengthOf(offers, 0);
          return;
        }

        // Pending wake for command 2 must extend into the 2-minute quiet window before finalizing.
        assert.equal(yield* Queue.take(scheduledFinalizes), "2 minutes");
        if (stalls) {
          yield* TestClock.adjust("2 minutes");
          const run = yield* until((event) => event.type === "turn.terminal");
          const terminal = run.at(-1);
          assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
          assert.lengthOf(offers, 0);
          return;
        }

        // Reply 2 arrives 6 seconds later (9 seconds after usage_update #1).
        yield* TestClock.adjust("6 seconds");
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "All 34 tests passed." },
        });
        assert.equal((yield* Queue.takeAll(scheduledFinalizes)).at(-1), "2 minutes");
        yield* writeFile(
          generated("logs"),
          "transcript.jsonl",
          [
            JSON.stringify({
              step_index: 1,
              type: "SYSTEM_MESSAGE",
              status: "DONE",
              content: "priority=MESSAGE_PRIORITY_HIGH task-1",
            }),
            JSON.stringify({
              step_index: 2,
              type: "PLANNER_RESPONSE",
              status: "DONE",
              content: "gates passed; waiting for tests.",
            }),
            JSON.stringify({
              step_index: 3,
              type: "SYSTEM_MESSAGE",
              status: "DONE",
              content: "priority=MESSAGE_PRIORITY_HIGH task-2",
            }),
            JSON.stringify({
              step_index: 4,
              type: "PLANNER_RESPONSE",
              status: "DONE",
              content: "All 34 tests passed.",
            }),
          ].join("\n") + "\n",
        );
        yield* send(usage);
        assert.equal(yield* Queue.take(scheduledFinalizes), "3000 millis");
        yield* TestClock.adjust("3 seconds");

        const run = yield* until((event) => event.type === "turn.terminal");
        const terminal = run.at(-1);
        assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
        assert.include(
          JSON.stringify(run),
          "All 34 tests passed.",
          "reply 2 must stay in the same run",
        );
        assert.lengthOf(offers, 0, "the open run needs no continuation");
      }).pipe(Effect.provide(layerSession)),
  );

  // A background command can finish while the initial prompt's final reply is still in flight,
  // so the tool is already `completed` when session/prompt returns end_turn while its wake sits
  // unread in the inbox.
  it.effect(
    "keeps the run open when a background command finishes before end_turn with an unread wake",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profile = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agy-pre-settle-" });
        const generated = (kind: string) =>
          path.join(
            profile,
            "antigravity-acp",
            "brain",
            "mock-session-1",
            ".system_generated",
            kind,
          );
        const writeFile = (directory: string, name: string, body: string) =>
          fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(Effect.andThen(fileSystem.writeFileString(path.join(directory, name), body)));
        const cmd = {
          toolCallId: "call_mix",
          kind: "execute",
          title: "python3 voice.py mix",
          rawInput: { CommandLine: "python3 voice.py mix", WaitMsBeforeAsync: 10000 },
        } as const;
        yield* writeFile(
          generated("messages"),
          "msg-1.json",
          JSON.stringify({
            id: "msg-1",
            priority: "MESSAGE_PRIORITY_HIGH",
            sender: "mock-session-1/task-1",
          }),
        );
        const { usage, offers, scheduledFinalizes, send, startTurn, until, throughPromptSettled } =
          yield* openSessionWithRunningCommand({}, undefined, undefined, {
            profileDirectory: profile,
            initialToolCalls: [
              { sessionUpdate: "tool_call", ...cmd, status: "in_progress" },
              {
                sessionUpdate: "tool_call_update",
                ...cmd,
                status: "completed",
                rawOutput: { output: "mixed.mp4", exit_code: 0 },
              },
            ],
          });
        yield* startTurn(1, false);
        yield* throughPromptSettled;
        assert.equal(yield* Queue.take(scheduledFinalizes), "2 minutes");

        yield* TestClock.adjust("9 seconds");
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Mix finished." },
        });
        assert.equal(yield* Queue.take(scheduledFinalizes), "2 minutes");
        yield* writeFile(generated("messages"), "read.json", JSON.stringify({ "msg-1": true }));
        yield* writeFile(
          generated("logs"),
          "transcript.jsonl",
          `${JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", content: "Mix finished." })}\n`,
        );
        yield* send(usage);
        assert.equal(yield* Queue.take(scheduledFinalizes), "3000 millis");
        yield* TestClock.adjust("3 seconds");

        const run = yield* until((event) => event.type === "turn.terminal");
        const terminal = run.at(-1);
        assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
        assert.include(JSON.stringify(run), "Mix finished.");
        assert.lengthOf(offers, 0);
      }).pipe(Effect.provide(layerSession)),
  );

  // agy names its background commands `<session>/task-<n>`; the agent passes that to
  // t3_background_wait, which must not fail since the adapter already holds the run open.
  it.effect("accepts t3_background_wait for a command it already tracks", () =>
    Effect.gen(function* () {
      const { session, providerThread, startTurn, throughPromptSettled } =
        yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
      yield* startTurn(1, false);
      yield* throughPromptSettled;
      const taskIds = ["mock-session-1/task-2"];
      assert.isDefined(session.awaitBackgroundTasks, "t3_background_wait must not be unsupported");
      const result = yield* session.awaitBackgroundTasks!({
        providerThread,
        taskIds,
        awaited: true,
      });
      assert.deepEqual(result.matched, taskIds);
    }).pipe(Effect.provide(layerSession)),
  );

  // agy 1.5.11 reads a prompt sent mid-turn as a steer: it answers the running prompt end_turn
  // and goes on under the new one. session/cancel would end its running commands and subagents.
  it.effect("steers a running prompt with the next one and leaves its work running", () =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand({}, undefined, {
        agentVersion: "1.5.11",
        holdsFirstPrompt: true,
      });
      const { session, providerThread, command, usage, send, startTurn, until } = opened;
      assert.isTrue(session.providerSession.capabilities.turns.supportsActiveSteering);
      yield* startTurn(1, false);
      const started = yield* until(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId,
      );
      const providerTurnId = started.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0]!;
      yield* send({
        sessionUpdate: "tool_call",
        toolCallId: "call_artist",
        kind: "other",
        title: "Run invoke_subagent",
        status: "completed",
        rawInput: { Role: "Artist", Prompt: "Paint the scooter" },
      });

      const steer = yield* session
        .steerTurn({
          threadId: ThreadId.make("thread-antigravity-wake"),
          runId: RunId.make("run-antigravity-wake-1"),
          providerThread,
          providerTurnId,
          message: {
            messageId: MessageId.make("message-antigravity-steer"),
            text: "Use opus subagents from now on",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        })
        .pipe(Effect.forkScoped);
      yield* opened.steerStarted;
      assert.equal(opened.cancels(), 0, "a steer must not cancel the agent's work");
      assert.lengthOf(opened.prompts, 2);
      assert.deepEqual(opened.prompts[1]!.prompt, [
        { type: "text", text: "Use opus subagents from now on" },
      ]);
      assert.isTrue(
        yield* Deferred.isDone(opened.prompts[0]!.released!),
        "the steered prompt frees the runtime for the steer",
      );
      // The steered prompt has answered end_turn; the turn must outlast the finalize debounce.
      yield* TestClock.adjust("10 seconds");

      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Switching to opus subagents." },
      });
      yield* send(usage);
      yield* opened.releaseSteer;
      yield* Fiber.join(steer);
      const run = [...started, ...(yield* until((event) => event.type === "turn.terminal"))];
      const terminal = run.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      assert.include(JSON.stringify(run), "Switching to opus subagents.");
      const finished = run.findLast(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId,
      );
      assert.equal(finished?.type === "turn_item.updated" && finished.turnItem.status, "completed");
      const subagentStatuses = run.flatMap((event) =>
        event.type === "subagent.updated" ? [event.subagent.status] : [],
      );
      assert.notInclude(subagentStatuses, "interrupted");
      assert.equal(subagentStatuses.at(-1), "idle");
    }).pipe(Effect.provide(layerSession)),
  );

  // A wake run has no prompt of its own, yet agy can keep working in it for minutes.
  it.effect("steers a continuation run that keeps working after its wake", () =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand(
        { IsDaemon: true, WaitMsBeforeAsync: 500 },
        undefined,
        { agentVersion: "1.5.11", holdsFirstPrompt: false },
      );
      const { session, providerThread, command, offers, send, startTurn, until, throughTerminal } =
        opened;
      yield* startTurn(1, false);
      yield* throughTerminal;
      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      assert.lengthOf(offers, 1, "the finished daemon must wake the thread");
      yield* offers[0]!.dispatchIfCurrent!(Effect.void);
      yield* startTurn(2, true);
      const followUp = { toolCallId: "call_build", kind: "execute", title: "vp run build" };
      yield* send({ sessionUpdate: "tool_call", ...followUp, status: "in_progress" });
      const continued = yield* until(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === followUp.toolCallId,
      );
      const providerTurnId = continued.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0]!;

      const steer = yield* session
        .steerTurn({
          threadId: ThreadId.make("thread-antigravity-wake"),
          runId: RunId.make("run-antigravity-wake-2"),
          providerThread,
          providerTurnId,
          message: {
            messageId: MessageId.make("message-antigravity-steer"),
            text: "Skip the build",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* opened.steerStarted;
      assert.equal(opened.cancels(), 0, "a steer must not cancel the agent's work");
      assert.lengthOf(opened.prompts, 2);
      assert.deepEqual(opened.prompts[1]!.prompt, [{ type: "text", text: "Skip the build" }]);

      yield* send({ sessionUpdate: "tool_call_update", ...followUp, status: "completed" });
      yield* TestClock.adjust("16 minutes");
      const silent = yield* until((event) => event.type === "turn.terminal");
      const terminal = silent.at(-1);
      assert.equal(
        terminal?.type === "turn.terminal" && terminal.status,
        "failed",
        "a silent steer prompt must still hit the inactivity timeout",
      );
      assert(Exit.isFailure(yield* Fiber.join(steer)));
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect("steers a run held open by a detached subagent without stopping it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profile = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-kids-" });
      const records = (conversationId: string, kind: string) =>
        path.join(profile, "antigravity-acp", "brain", conversationId, ".system_generated", kind);
      const write = (directory: string, name: string, value: unknown) =>
        fileSystem
          .makeDirectory(directory, { recursive: true })
          .pipe(
            Effect.andThen(
              fileSystem.writeFileString(path.join(directory, name), JSON.stringify(value)),
            ),
          );
      yield* write(records("mock-session-1", "subagents"), "child-1.json", {});
      yield* write(records("child-1", "messages"), "launch.json", {
        sender: "mock-session-1",
        sourceMetadata: { tool: { toolCall: { id: "call_research", name: "invoke_subagent" } } },
      });
      const opened = yield* openSessionWithRunningCommand({}, profile, {
        agentVersion: "1.5.11",
        holdsFirstPrompt: false,
      });
      const { session, providerThread, usage, send, startTurn, until, throughPromptSettled } =
        opened;
      yield* startTurn(1, false);
      const prompt = yield* throughPromptSettled;
      const providerTurnId = prompt.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0]!;
      yield* TestClock.adjust("10 minutes");

      const steer = yield* session
        .steerTurn({
          threadId: ThreadId.make("thread-antigravity-wake"),
          runId: RunId.make("run-antigravity-wake-1"),
          providerThread,
          providerTurnId,
          message: {
            messageId: MessageId.make("message-antigravity-steer"),
            text: "Also check the footnotes",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        })
        .pipe(Effect.forkScoped);
      yield* opened.steerStarted;
      assert.equal(opened.cancels(), 0, "a steer must not cancel the agent's subagents");
      assert.lengthOf(opened.prompts, 2);
      yield* write(records("mock-session-1", "messages"), "report.json", { sender: "child-1" });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "I'll have the footnotes checked too." },
      });
      yield* send(usage);
      yield* opened.releaseSteer;
      yield* Fiber.join(steer);
      const run = [...prompt, ...(yield* until((event) => event.type === "turn.terminal"))];
      const terminal = run.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      assert.include(JSON.stringify(run), "I'll have the footnotes checked too.");
      const subagentStatuses = run.flatMap((event) =>
        event.type === "subagent.updated" ? [event.subagent.status] : [],
      );
      assert.notInclude(subagentStatuses, "interrupted");
      assert.equal(subagentStatuses.at(-1), "idle");
    }).pipe(Effect.provide(layerSession)),
  );

  // Files as agy 1.5.12 wrote them: the launch sits in the child's inbox, and the child's report
  // lands in the parent's inbox with no session update. Only the agent's own reply follows.
  it.effect.each([
    { reports: "after the prompt ends", duringPrompt: false },
    { reports: "while the prompt runs", duringPrompt: true },
  ])("keeps a detached subagent running until it reports $reports", ({ duringPrompt }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profile = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-kids-" });
      const records = (conversationId: string, kind: string) =>
        path.join(profile, "antigravity-acp", "brain", conversationId, ".system_generated", kind);
      const write = (directory: string, name: string, value: unknown) =>
        fileSystem
          .makeDirectory(directory, { recursive: true })
          .pipe(
            Effect.andThen(
              fileSystem.writeFileString(path.join(directory, name), JSON.stringify(value)),
            ),
          );
      yield* write(records("mock-session-1", "subagents"), "child-1.json", {});
      yield* write(records("child-1", "messages"), "launch.json", {
        sender: "mock-session-1",
        sourceMetadata: { tool: { toolCall: { id: "call_research", name: "invoke_subagent" } } },
      });
      const report = write(records("mock-session-1", "messages"), "report.json", {
        sender: "child-1",
      });
      if (duringPrompt) yield* report;

      const { usage, offers, send, startTurn, until, throughPromptSettled } =
        yield* openSessionWithRunningCommand({}, profile);
      yield* startTurn(1, false);
      const statuses = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
        events.flatMap((event) =>
          event.type === "subagent.updated" ? [event.subagent.status] : [],
        );
      const prompt = yield* throughPromptSettled;
      assert.equal(statuses(prompt).at(-1), duringPrompt ? "idle" : "running");
      if (!duringPrompt) {
        yield* TestClock.adjust("10 minutes");
        yield* report;
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "The researcher found it." },
        });
        yield* send(usage);
        yield* TestClock.adjust("3 seconds");
      }
      const run = yield* until((event) => event.type === "turn.terminal");
      const terminal = run.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      assert.equal(statuses([...prompt, ...run]).at(-1), "idle");
      assert.equal(
        JSON.stringify(run).includes("The researcher found it."),
        !duringPrompt,
        "the reply about the report is part of the run",
      );
      assert.lengthOf(offers, 0, "the open run needs no continuation");
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect(
    "projects Antigravity subagent transcript thinking, typed tools, and assistant reply live and keeps them when Idle",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profile = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-antigravity-subagent-live-",
        });
        const records = (conversationId: string, kind: string) =>
          path.join(profile, "antigravity-acp", "brain", conversationId, ".system_generated", kind);
        const writeJson = (directory: string, name: string, value: unknown) =>
          fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(
              Effect.andThen(
                fileSystem.writeFileString(path.join(directory, name), JSON.stringify(value)),
              ),
            );
        const writeTranscript = (lines: ReadonlyArray<unknown>) => {
          const directory = records("child-1", "logs");
          return fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(
              Effect.andThen(
                fileSystem.writeFileString(
                  path.join(directory, "transcript.jsonl"),
                  `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
                ),
              ),
            );
        };

        yield* writeJson(records("mock-session-1", "subagents"), "child-1.json", {
          conversationId: "child-1",
          subagentDescriptor: { role: "Codebase Researcher" },
        });
        yield* writeJson(records("child-1", "messages"), "launch.json", {
          sender: "mock-session-1",
          content: "Read README.md",
          sourceMetadata: {
            tool: { toolCall: { id: "call_research", name: "invoke_subagent" } },
          },
        });
        // While running, the child has written thinking, a completed read_file, an edit_file, and a running command.
        yield* writeTranscript([
          { step_index: 0, type: "SYSTEM_MESSAGE", status: "DONE", content: "Read README.md" },
          {
            step_index: 1,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            thinking: "Checking README.md and applying the fix.",
            tool_calls: [
              { name: "read_file", args: { Path: '"/project/README.md"' } },
              {
                name: "edit_file",
                args: {
                  Path: '"/project/README.md"',
                  Target: '"old"',
                  Replacement: '"new"',
                },
              },
              {
                name: "run_command",
                args: { CommandLine: '"pnpm test"', toolSummary: '"Run tests"' },
              },
            ],
          },
          {
            step_index: 2,
            type: "GENERIC",
            status: "DONE",
            content: "Created At: 2026-11-26T02:00:00+01:00\n1: old line",
          },
          {
            step_index: 3,
            type: "GENERIC",
            status: "DONE",
            content: "Updated README.md",
          },
        ]);

        const { usage, send, startTurn, until, throughPromptSettled } =
          yield* openSessionWithRunningCommand({}, profile);
        yield* startTurn(1, false);
        const promptEvents = yield* throughPromptSettled;

        const childThread = promptEvents.find((event) => event.type === "app_thread.created");
        assert.isDefined(childThread);
        const childThreadId =
          childThread?.type === "app_thread.created" ? childThread.appThread.id : undefined;
        assert.isDefined(childThreadId);

        // Give the live transcript follower a poll tick while the subagent is still running.
        yield* TestClock.adjust("1 second");

        // Now the child completes its command, writes its final assistant reply, and reports back to parent.
        yield* writeTranscript([
          { step_index: 0, type: "SYSTEM_MESSAGE", status: "DONE", content: "Read README.md" },
          {
            step_index: 1,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            thinking: "Checking README.md and applying the fix.",
            tool_calls: [
              { name: "read_file", args: { Path: '"/project/README.md"' } },
              {
                name: "edit_file",
                args: {
                  Path: '"/project/README.md"',
                  Target: '"old"',
                  Replacement: '"new"',
                },
              },
              {
                name: "run_command",
                args: { CommandLine: '"pnpm test"', toolSummary: '"Run tests"' },
              },
            ],
          },
          {
            step_index: 2,
            type: "GENERIC",
            status: "DONE",
            content: "Created At: 2026-11-26T02:00:00+01:00\n1: old line",
          },
          {
            step_index: 3,
            type: "GENERIC",
            status: "DONE",
            content: "Updated README.md",
          },
          {
            step_index: 4,
            type: "GENERIC",
            status: "DONE",
            content: "All tests passed.",
          },
          {
            step_index: 5,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            content: "Updated README.md and verified all tests pass.",
          },
        ]);
        yield* writeJson(records("mock-session-1", "messages"), "report.json", {
          sender: "child-1",
        });
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "The researcher finished." },
        });
        yield* send(usage);
        yield* TestClock.adjust("3 seconds");
        const tailEvents = yield* until((event) => event.type === "turn.terminal");
        const allEvents = [...promptEvents, ...tailEvents];

        const childItemsById = new Map<
          string,
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>["turnItem"]
        >();
        for (const event of allEvents) {
          if (event.type === "turn_item.updated" && event.turnItem.threadId === childThreadId) {
            childItemsById.set(String(event.turnItem.id), event.turnItem);
          }
        }
        const childItems = [...childItemsById.values()].toSorted((a, b) => a.ordinal - b.ordinal);
        assert.deepEqual(
          childItems.map((item) => item.type),
          [
            "user_message",
            "reasoning",
            "dynamic_tool",
            "file_change",
            "command_execution",
            "assistant_message",
          ],
        );
        const reasoning = childItems[1];
        assert.equal(
          reasoning?.type === "reasoning" ? reasoning.text : null,
          "Checking README.md and applying the fix.",
        );
        const readItem = childItems[2];
        assert.equal(readItem?.type === "dynamic_tool" ? readItem.toolName : null, "Read");
        assert.equal(readItem?.type === "dynamic_tool" ? readItem.output : null, "1: old line");
        const fileChange = childItems[3];
        assert.equal(
          fileChange?.type === "file_change" ? fileChange.fileName : null,
          "/project/README.md",
        );
        assert.include(
          fileChange?.type === "file_change" ? (fileChange.diffStr ?? "") : "",
          "-old",
        );
        assert.include(
          fileChange?.type === "file_change" ? (fileChange.diffStr ?? "") : "",
          "+new",
        );
        const command = childItems[4];
        assert.equal(command?.type === "command_execution" ? command.input : null, "pnpm test");
        assert.equal(
          command?.type === "command_execution" ? command.output : null,
          "All tests passed.",
        );
        assert.equal(command?.status, "completed");
        const assistant = childItems[5];
        assert.equal(
          assistant?.type === "assistant_message" ? assistant.text : null,
          "Updated README.md and verified all tests pass.",
        );

        const lastSubagent = allEvents.findLast((event) => event.type === "subagent.updated");
        assert.equal(
          lastSubagent?.type === "subagent.updated" ? lastSubagent.subagent.status : null,
          "idle",
        );
        assert.equal(
          lastSubagent?.type === "subagent.updated" ? lastSubagent.subagent.result : null,
          "Updated README.md and verified all tests pass.",
        );
      }).pipe(Effect.provide(layerSession)),
  );

  it.effect(
    "captures a subagent's closing assistant reply written shortly after send_message marks it Idle",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profile = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-antigravity-subagent-trailing-",
        });
        const records = (conversationId: string, kind: string) =>
          path.join(profile, "antigravity-acp", "brain", conversationId, ".system_generated", kind);
        const writeJson = (directory: string, name: string, value: unknown) =>
          fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(
              Effect.andThen(
                fileSystem.writeFileString(path.join(directory, name), JSON.stringify(value)),
              ),
            );
        const writeTranscript = (lines: ReadonlyArray<unknown>) => {
          const directory = records("child-1", "logs");
          return fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(
              Effect.andThen(
                fileSystem.writeFileString(
                  path.join(directory, "transcript.jsonl"),
                  `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
                ),
              ),
            );
        };

        yield* writeJson(records("mock-session-1", "subagents"), "child-1.json", {
          conversationId: "child-1",
          subagentDescriptor: { role: "Rich Format Tester" },
        });
        yield* writeJson(records("child-1", "messages"), "launch.json", {
          sender: "mock-session-1",
          content: "Format a markdown summary",
          sourceMetadata: {
            tool: { toolCall: { id: "call_research", name: "invoke_subagent" } },
          },
        });
        const preReplySteps = [
          {
            step_index: 0,
            type: "SYSTEM_MESSAGE",
            status: "DONE",
            content: "Format a markdown summary",
          },
          {
            step_index: 1,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            tool_calls: [{ name: "send_message", args: { Message: '"Done!"' } }],
          },
          { step_index: 2, type: "GENERIC", status: "DONE", content: "Message sent." },
        ];
        yield* writeTranscript(preReplySteps);
        yield* writeJson(records("mock-session-1", "messages"), "report.json", {
          sender: "child-1",
        });

        const { startTurn, until, throughPromptSettled, session, providerThread } =
          yield* openSessionWithRunningCommand({}, profile);
        const runKeepsIngesting = session.hasPendingBackgroundWorkForThread!(providerThread);
        yield* startTurn(1, false);
        const promptEvents = yield* throughPromptSettled;
        const childThread = promptEvents.find((event) => event.type === "app_thread.created");
        const childThreadId =
          childThread?.type === "app_thread.created" ? childThread.appThread.id : undefined;
        assert.isDefined(childThreadId);

        // Child became Idle as soon as report.json landed, before its closing PLANNER_RESPONSE flushed.
        const idleSubagent = promptEvents.findLast((event) => event.type === "subagent.updated");
        assert.equal(
          idleSubagent?.type === "subagent.updated" ? idleSubagent.subagent.status : null,
          "idle",
        );
        // The run reads this probe once the root ends; it must already hold the drain at Idle.
        assert.isTrue(yield* runKeepsIngesting);

        // Closing reply lands in transcript.jsonl after Idle.
        yield* writeTranscript([
          ...preReplySteps,
          {
            step_index: 3,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            content: "## Summary\n\n| Check | Status |\n| --- | --- |\n| Diff | Passed |",
          },
        ]);
        yield* TestClock.adjust("2 seconds");
        const trailingEvents = yield* until(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.threadId === childThreadId &&
            event.turnItem.type === "assistant_message",
        );
        const assistantItem = trailingEvents.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.threadId === childThreadId &&
            event.turnItem.type === "assistant_message",
        );
        assert.equal(
          assistantItem?.type === "turn_item.updated" &&
            assistantItem.turnItem.type === "assistant_message"
            ? assistantItem.turnItem.text
            : null,
          "## Summary\n\n| Check | Status |\n| --- | --- |\n| Diff | Passed |",
        );
        // The drain ends with a subagent event, so the run re-checks and stops ingesting.
        let pending = true;
        for (let attempt = 0; attempt < 2 && pending; attempt += 1) {
          yield* until((event) => event.type === "subagent.updated");
          pending = yield* runKeepsIngesting;
        }
        assert.isFalse(pending);
      }).pipe(Effect.provide(layerSession)),
  );

  it.effect("ends a continuation run whose replayed reply launched a subagent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      // No records: nothing proves a child is at work, so none may hold a run open.
      const profile = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-kids-" });
      const { usage, offers, send, startTurn, throughTerminal } =
        yield* openSessionWithRunningCommand({}, profile);
      yield* startTurn(1, false);
      yield* throughTerminal;
      yield* send({
        sessionUpdate: "tool_call",
        toolCallId: "call_follow_up",
        kind: "other",
        title: "Run invoke_subagent",
        status: "completed",
        rawInput: { TypeName: "research", Role: "Checker", Prompt: "Check it" },
      });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Started a checker." },
      });
      yield* send(usage);
      assert.lengthOf(offers, 1, "the agent's own reply must wake the thread");
      yield* offers[0]!.dispatchIfCurrent!(Effect.void);
      yield* startTurn(2, true);
      yield* TestClock.adjust("3 seconds");
      const terminal = (yield* throughTerminal).at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect.each([
    // session/cancel ends the agent's commands, so only Stop may send it.
    { ending: "Stop", cancels: 1, status: "interrupted" },
    { ending: "a new message", cancels: 0, status: "interrupted" },
    { ending: "the agent exiting", cancels: 0, status: "failed" },
  ] as const)(
    "ends a run held open by a running command on $ending",
    ({ ending, cancels, status }) =>
      Effect.gen(function* () {
        const opened = yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
        yield* opened.startTurn(1, false);
        const started = yield* opened.throughPromptSettled;
        const turn = started.find((event) => event.type === "provider_turn.updated");
        if (turn?.type !== "provider_turn.updated") return assert.fail("the turn must start");
        if (ending === "the agent exiting") {
          yield* opened.runtimeDies;
        } else {
          yield* opened.session.interruptTurn({
            providerThread: opened.providerThread,
            providerTurnId: turn.providerTurn.id,
            ...(ending === "Stop" ? { requestRuntimeRestart: true } : {}),
          });
        }
        const terminal = (yield* opened.throughTerminal).at(-1);
        assert.equal(terminal?.type === "turn.terminal" && terminal.status, status);
        assert.equal(opened.cancels(), cancels);
      }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 subagent reads", () => {
  it.effect("completes a read T3 served when the agent later fails it with a step error", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-reads-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-reads-outside-",
      });
      const served = path.join(workspace, "served.ts");
      yield* fileSystem.writeFileString(served, "export {};");
      const denied = path.join(outside, "secret.txt");
      yield* fileSystem.writeFileString(denied, "secret");
      const unseen = path.join(workspace, "unseen.ts");
      const retried = path.join(workspace, "retried.ts");
      const stepError = 'Model produced invalid output. ("model output error")';
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-subagent-reads-test");
      const threadId = ThreadId.make("thread-antigravity-subagent-reads");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdate = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              handleReadTextFile: (handler) =>
                Effect.sync(() => {
                  readTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
              // agy_acp_server announces a subagent's client_view_file on the parent session,
              // never completes it, then fails every open call with the next step error.
              prompt: () =>
                Effect.gen(function* () {
                  if (sessionUpdate === undefined || readTextFile === undefined) {
                    return yield* Effect.die("the adapter must handle updates and reads");
                  }
                  const send = sessionUpdate;
                  const handleRead = readTextFile;
                  const update = (update: EffectAcpSchema.SessionUpdate) =>
                    send(
                      normalizeAntigravitySessionUpdate({ sessionId: "mock-session-1", update }),
                    );
                  // The agent's own view_file never reaches T3, so it must not take a served read.
                  const reads = [
                    ["call_native", served, "Running view_file"],
                    ["call_served", served, "Running client_view_file"],
                    ["call_missing", retried, "Running client_view_file"],
                    ["call_retried", retried, "Running client_view_file"],
                    ["call_denied", denied, "Running client_view_file"],
                    ["call_unseen", unseen, "Running client_view_file"],
                  ] as const;
                  for (const [toolCallId, target, title] of reads) {
                    yield* update({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title,
                      kind: "read",
                      status: "in_progress",
                      rawInput: { absolute_path: target },
                      locations: [{ path: target }],
                    });
                  }
                  const serve = (target: string) =>
                    handleRead(
                      { sessionId: "subagent-conversation", path: target },
                      { requestId: `read-${target}`, method: "fs/read_text_file" },
                    ).pipe(Effect.exit);
                  yield* serve(served);
                  yield* serve(retried);
                  yield* fileSystem.writeFileString(retried, "export {};").pipe(Effect.orDie);
                  yield* serve(retried);
                  yield* serve(denied);
                  for (const [toolCallId] of reads) {
                    yield* update({
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status: "failed",
                      rawOutput: stepError,
                    });
                  }
                  return { stopReason: "end_turn" as const };
                }),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-subagent-reads"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* session.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project-antigravity-subagent-reads"),
          title: "Antigravity subagent reads",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: workspace,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make("run-antigravity-subagent-reads"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-antigravity-subagent-reads"),
        rootNodeId: NodeId.make("node-antigravity-subagent-reads"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-antigravity-subagent-reads"),
          text: "review the codebase",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      const events = Array.from(
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const read = (nativeId: string) => {
        const event = events.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId,
        );
        return event?.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
          ? { status: event.turnItem.status, output: event.turnItem.output }
          : undefined;
      };

      const firstEvent = (nativeId: string, status: string) =>
        events.findIndex(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId &&
            event.turnItem.status === status,
        );
      // T3 completes a served read itself instead of leaving it running until the flush.
      assert.isAbove(firstEvent("call_served", "completed"), -1);
      assert.isBelow(firstEvent("call_served", "completed"), firstEvent("call_native", "failed"));
      const failed = { status: "failed" as const, output: stepError };
      assert.deepEqual(read("call_served"), { status: "completed", output: undefined });
      assert.deepEqual(read("call_retried"), { status: "completed", output: undefined });
      assert.deepEqual(read("call_native"), failed);
      assert.deepEqual(read("call_missing"), failed);
      assert.deepEqual(read("call_denied"), failed);
      assert.deepEqual(read("call_unseen"), failed);
    }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 runtime mode ceiling", () => {
  const modesSetFor = (
    pickedMode: string,
    modes: Pick<ProviderAdapter.ProviderAdapterV2RuntimePolicy, "runtimeMode" | "maxRuntimeMode">,
  ) =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const modesSet: Array<string> = [];
      const instanceId = ProviderInstanceId.make("antigravity-ceiling-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              setMode: (modeId) =>
                Effect.sync(() => {
                  modesSet.push(modeId);
                }).pipe(Effect.andThen(runtime.setMode(modeId))),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const threadId = ThreadId.make("thread-antigravity-ceiling");
      yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-ceiling"),
        modelSelection: {
          instanceId,
          model: "gemini-test-low",
          options: [{ id: "_t3/session-mode", value: pickedMode }],
        },
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          ...modes,
          interactionMode: "default",
          cwd: process.cwd(),
        }),
      });
      return modesSet;
    }).pipe(Effect.provide(layerSession), Effect.scoped);

  it.effect("does not apply a picked session mode above the thread's runtime mode", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* modesSetFor("yolo", { runtimeMode: "approval-required" }), [
        "default",
      ]);
      assert.deepEqual(
        yield* modesSetFor("auto_edit", {
          runtimeMode: "approval-required",
          maxRuntimeMode: "auto-accept-edits",
        }),
        ["default"],
      );
      // A narrower mode is still the user's to pick.
      assert.deepEqual(yield* modesSetFor("default", { runtimeMode: "auto-accept-edits" }), [
        "auto_edit",
        "default",
      ]);
    }),
  );

  it.effect("leaving Plan keeps the permission mode the thread has now", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      let runtime: AcpSessionRuntime.AcpSessionRuntime["Service"] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-plan-exit-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.tap((made) =>
              Effect.sync(() => {
                runtime = made;
              }),
            ),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const threadId = ThreadId.make("thread-antigravity-plan-exit");
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const planPolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "plan",
        cwd: process.cwd(),
      });
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-plan-exit"),
        modelSelection,
        runtimePolicy: planPolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* session.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: planPolicy,
      });
      const supervisedPolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      yield* session.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy: supervisedPolicy,
          modelSelection,
          now: yield* DateTime.now,
        }),
      );
      yield* Stream.fromQueue(events).pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.equal((yield* runtime!.getModeState)?.currentModeId, "default");
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.live.each([
    { closure: "reported exit", expected: "resume" },
    { closure: "reported exit", expected: "load" },
    { closure: "idle", expected: "resume" },
    { closure: "before snapshot", expected: "load" },
    { closure: "before prompt", expected: "resume" },
    { closure: "during prompt", expected: "resume" },
    { closure: "concurrent resume", expected: "resume" },
    { closure: "before steer is queued", expected: "resume" },
    { closure: "stop during a busy steer retry", expected: "resume" },
  ])("recovers with $expected ($closure)", ({ closure, expected }) =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const replacementStartup: Array<string> = [];
      let terminate: AntigravityAdapterV2RuntimeInput["onTermination"];
      let stop: Effect.Effect<void>;
      let runtimes = 0;
      const promptStarted = yield* Deferred.make<void>();
      const releasePromptCallback = yield* Deferred.make<void>();
      const steerBeforeQueue = yield* Deferred.make<void>();
      const releaseRetry = yield* Deferred.make<void>();
      const firstPromptSettled = yield* Deferred.make<void>();
      const cancelEntered = yield* Deferred.make<void>();
      const cancelSent = yield* Deferred.make<void>();
      const outgoing: string[] = [];
      const busySteer = closure === "stop during a busy steer retry";
      const concurrentResume = closure === "concurrent resume";
      const interruptedSteer = closure === "before steer is queued" || busySteer;
      let firstRuntimeService: RuntimeService | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-restart-resume-test");
      const options: AntigravityAdapterV2Options = {
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) => {
          const firstRuntime = ++runtimes === 1;
          let prompts = 0;
          if (firstRuntime) terminate = input.onTermination;
          return makeAntigravityAcpRuntime({
            ...input,
            ...(firstRuntime && concurrentResume ? { onTermination: () => Effect.void } : {}),
            requestLogger: (event) => {
              if (event.status !== "started") return Effect.void;
              if (!firstRuntime) {
                if (
                  ["initialize", "session/new", "session/load", "session/resume"].includes(
                    event.method,
                  )
                ) {
                  replacementStartup.push(event.method);
                }
                return Effect.void;
              }
              if (event.method !== "session/prompt") return Effect.void;
              if (++prompts === (busySteer ? 3 : 2) && interruptedSteer) {
                return Deferred.succeed(steerBeforeQueue, undefined).pipe(
                  Effect.andThen(busySteer ? Deferred.await(releaseRetry) : Effect.never),
                );
              }
              return Deferred.succeed(promptStarted, undefined).pipe(Effect.asVoid);
            },
            ...(busySteer
              ? {
                  protocolLogging: {
                    logOutgoing: true,
                    logger: (event) =>
                      Effect.gen(function* () {
                        if (
                          event.direction !== "outgoing" ||
                          event.stage !== "raw" ||
                          typeof event.payload !== "string"
                        )
                          return;
                        for (const method of ["session/prompt", "session/cancel"]) {
                          if (event.payload.includes(`"method":"${method}"`)) {
                            outgoing.push(method);
                            if (method === "session/cancel")
                              yield* Deferred.succeed(cancelSent, undefined);
                          }
                        }
                      }),
                  },
                }
              : {}),
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: {
                T3_ACP_ANTIGRAVITY: "1",
                ...(firstRuntime &&
                (closure === "during prompt" ||
                  concurrentResume ||
                  (interruptedSteer && !busySteer))
                  ? { T3_ACP_HANG_PROMPT_FOREVER: "1" }
                  : {}),
                ...(interruptedSteer ? { T3_ACP_AGENT_VERSION: "1.5.11" } : {}),
                ...(busySteer ? { T3_ACP_BUSY_SECOND_PROMPT: "1" } : {}),
              },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.tap((runtime) =>
              Effect.sync(() => {
                if (firstRuntime) firstRuntimeService = runtime;
              }),
            ),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              getEvents: () =>
                firstRuntime && concurrentResume
                  ? runtime
                      .getEvents()
                      .pipe(Stream.filter((event) => event._tag !== "RuntimeClosed"))
                  : runtime.getEvents(),
              cancel: busySteer
                ? Deferred.succeed(cancelEntered, undefined).pipe(Effect.andThen(runtime.cancel))
                : runtime.cancel,
              start: () =>
                runtime.start().pipe(
                  Effect.map((started) =>
                    expected === "load" && closure !== "before snapshot"
                      ? {
                          ...started,
                          initializeResult: {
                            ...started.initializeResult,
                            agentCapabilities: {
                              ...started.initializeResult.agentCapabilities,
                              sessionCapabilities: {},
                            },
                          },
                        }
                      : concurrentResume && !firstRuntime
                        ? {
                            ...started,
                            initializeResult: { ...started.initializeResult, protocolVersion: 1 },
                          }
                        : started,
                  ),
                ),
              prompt: (payload, options) => {
                const prompt = runtime.prompt(payload, options);
                if (!firstRuntime) return prompt;
                if (busySteer) {
                  return prompt.pipe(
                    Effect.tap(() => Deferred.succeed(firstPromptSettled, undefined)),
                  );
                }
                if (closure === "before prompt") return stop.pipe(Effect.andThen(prompt));
                return concurrentResume
                  ? prompt.pipe(
                      Effect.onExit(() =>
                        Effect.interruptible(Deferred.await(releasePromptCallback)),
                      ),
                    )
                  : prompt;
              },
            })),
          );
        },
        withProcess: (close, task) =>
          Effect.sync(() => {
            stop = close;
          }).pipe(Effect.andThen(task)),
        defaultModel: Effect.undefined,
      };
      const adapter = concurrentResume
        ? yield* makeAcpAdapterV2({
            instanceId,
            selfInvocation: options.selfInvocation,
            continuationRequests: { offer: () => Effect.void },
            flavor: {
              ...makeAntigravityAcpAdapterFlavor({
                ...options,
                random: crypto,
                fileSystem: yield* FileSystem.FileSystem,
                path,
                host: yield* ProviderHost.ProviderHost,
              }),
              followAgentWorkState: true,
              extractSubagentUpdate: (tool) =>
                tool.toolCallId === "call_research"
                  ? {
                      nativeTaskId: tool.toolCallId,
                      prompt: "Read it",
                      title: "Researcher",
                      model: null,
                      status: "running",
                      childSessionId: null,
                      result: null,
                    }
                  : undefined,
              extractSubagentSessionEvent: ({ sessionId, update }) =>
                sessionId === "mock-session-1" && update.sessionUpdate === "agent_message_chunk"
                  ? {
                      type: "delegation",
                      childSessionId: "child-1",
                      parentSessionId: sessionId,
                      delegationId: "call_research",
                      prompt: "Read it",
                    }
                  : undefined,
            },
          })
        : yield* makeAntigravityAdapterV2(options);
      const threadId = ThreadId.make("thread-antigravity-restart-resume");
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-restart-resume"),
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* session.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const startTurn = (ordinal: number) =>
        Effect.gen(function* () {
          yield* session.startTurn(
            makeTurnInput({
              threadId,
              providerThread,
              instanceId,
              runtimePolicy,
              modelSelection,
              now: yield* DateTime.now,
              ordinal,
            }),
          );
        });
      const isRootTerminal = (
        event: ProviderAdapter.ProviderAdapterV2Event,
      ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
        event.type === "turn.terminal" && event.providerThreadId === providerThread.id;
      const awaitTerminal = Effect.repeat(Queue.take(events), { until: isRootTerminal }).pipe(
        Effect.map((event) => {
          assert(isRootTerminal(event));
          return event;
        }),
      );
      yield* startTurn(1);
      if (closure === "during prompt" || concurrentResume || interruptedSteer) {
        yield* Deferred.await(promptStarted);
        if (interruptedSteer) {
          const started = yield* Stream.fromQueue(events).pipe(
            Stream.filter((event) => event.type === "provider_turn.updated"),
            Stream.runHead,
          );
          assert(started._tag === "Some");
          if (busySteer) {
            yield* Deferred.await(firstPromptSettled);
          }
          const steer = yield* session
            .steerTurn({
              threadId,
              runId: RunId.make("run-antigravity-restart-steer"),
              providerThread,
              providerTurnId: started.value.providerTurn.id,
              message: {
                messageId: MessageId.make("message-antigravity-restart-steer"),
                text: "Do this instead.",
                attachments: [],
                createdBy: "user",
                creationSource: "web",
              },
            })
            .pipe(Effect.exit, Effect.forkScoped);
          if (busySteer) {
            yield* Effect.raceFirst(
              Deferred.await(steerBeforeQueue),
              Fiber.join(steer).pipe(
                Effect.tap((result) =>
                  Effect.die(new Error(`Steer returned before the retry was queued: ${result}`)),
                ),
              ),
            );
          } else {
            yield* Deferred.await(steerBeforeQueue);
          }
          if (busySteer) {
            const stopping = yield* session
              .interruptTurn({ providerThread, providerTurnId: started.value.providerTurn.id })
              .pipe(Effect.forkScoped);
            yield* Deferred.await(cancelEntered);
            assert.deepEqual(outgoing, ["session/prompt", "session/prompt"]);
            yield* Deferred.succeed(releaseRetry, undefined);
            yield* Deferred.await(cancelSent);
            assert.deepEqual(outgoing.slice(0, 4), [
              "session/prompt",
              "session/prompt",
              "session/prompt",
              "session/cancel",
            ]);
            yield* Fiber.join(stopping);
            assert(Exit.isFailure(yield* Fiber.join(steer)));
            return;
          }
          yield* stop!;
          assert(Exit.isFailure(yield* Fiber.join(steer)));
        } else {
          if (concurrentResume) {
            const emit = (update: EffectAcpSchema.SessionUpdate) =>
              firstRuntimeService!.request("_test/emit-update", {
                sessionId: "mock-session-1",
                update,
              });
            yield* emit({
              sessionUpdate: "tool_call_update",
              toolCallId: "call_research",
              kind: "other",
              title: "Run invoke_subagent",
              status: "in_progress",
              rawInput: { TypeName: "research", Role: "Researcher", Prompt: "Read it" },
            });
            yield* emit({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Delegating" },
            });
            yield* Stream.fromQueue(events).pipe(
              Stream.filter(
                (event) =>
                  event.type === "provider_thread.updated" &&
                  event.providerThread.nativeThreadRef?.nativeId === "child-1",
              ),
              Stream.runHead,
            );
          }
          yield* stop!;
          if (concurrentResume) {
            yield* session
              .resumeThread({ providerThread, modelSelection, runtimePolicy })
              .pipe(Effect.ensuring(Deferred.succeed(releasePromptCallback, undefined)));
            yield* terminate!(
              new EffectAcpErrors.AcpTransportError({ detail: "agent exited", cause: "exit" }),
            );
            const firstRelevant = yield* Effect.repeat(Queue.take(events), {
              until: (event) =>
                isRootTerminal(event) ||
                (event.type === "subagent.updated" && event.subagent.status === "failed"),
            });
            assert.equal(firstRelevant.type, "subagent.updated");
          }
        }
      }
      // Starting before consuming the terminal event proves resume released the active turn.
      if (concurrentResume) yield* startTurn(2);
      const first = yield* awaitTerminal;
      if (
        closure === "before prompt" ||
        closure === "during prompt" ||
        concurrentResume ||
        interruptedSteer
      ) {
        assert(first.status === "failed");
        assert.include(first.failure?.message, "Retry the turn");
        assert.equal(first.failure?.class, "transport_error");
        assert.equal(first.failure?.retryable, true);
        if (concurrentResume) assert.notEqual(first.childTurnsContinue, true);
      } else {
        assert.equal(first.status, "completed");
        if (closure === "idle" || closure === "before snapshot") {
          yield* stop!;
        } else {
          yield* terminate!(
            new EffectAcpErrors.AcpTransportError({ detail: "agent exited", cause: "exit" }),
          );
        }
      }
      if (closure === "before snapshot") {
        yield* session.readThreadSnapshot({ providerThread });
      }
      if (!concurrentResume) yield* startTurn(2);
      const second = yield* awaitTerminal;
      assert.equal(second.status, "completed");
      assert.equal(runtimes, 2);
      assert.deepEqual(replacementStartup, ["initialize", `session/${expected}`]);
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 session system prompt", () => {
  it.effect.each(["1.5.1"])(
    "carries PR linking once per turn on %s, which does not advertise a system prompt append",
    (agentVersion) =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* SecureRandom.SecureRandom;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const logs = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-log-" });
        const requestLog = path.join(logs, "requests.ndjson");
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        const promptReceived = yield* Deferred.make<Parameters<RuntimeService["prompt"]>[0]>();
        const instanceId = ProviderInstanceId.make("antigravity-system-prompt-test");
        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: {
                  T3_ACP_ANTIGRAVITY: "1",
                  T3_ACP_AGENT_VERSION: agentVersion,
                  T3_ACP_REQUEST_LOG_PATH: requestLog,
                  T3_ACP_HANG_PROMPT_FOREVER: "1",
                },
              },
            }).pipe(
              Effect.provideService(SecureRandom.SecureRandom, crypto),
              Effect.map((runtime): RuntimeService => ({
                ...runtime,
                prompt: (request) =>
                  Deferred.succeed(promptReceived, request).pipe(
                    Effect.andThen(runtime.prompt(request)),
                  ),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
        });
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-sp-" });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const threadId = ThreadId.make("thread-antigravity-system-prompt");
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-system-prompt"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* session
          .startTurn({
            appThread: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId: ProjectId.make("project-antigravity-system-prompt"),
              title: "Antigravity system prompt",
              providerInstanceId: instanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: providerThread.id,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
            threadId,
            runId: RunId.make("run-antigravity-system-prompt"),
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: RunAttemptId.make("attempt-antigravity-system-prompt"),
            rootNodeId: NodeId.make("node-antigravity-system-prompt"),
            providerThread,
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: MessageId.make("message-antigravity-system-prompt"),
              text: "open a PR",
              attachments: [],
            },
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.forkScoped);
        const sent = JSON.stringify((yield* Deferred.await(promptReceived)).prompt);
        const sessionNew = (yield* fileSystem.readFileString(requestLog))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { method?: string; params?: { _meta?: unknown } })
          .find((request) => request.method === "session/new");
        const append = JSON.stringify(sessionNew?.params?._meta ?? null);
        // Identity stays per turn either way.
        assert.include(sent, "through the Antigravity harness, as gemini-test-low");
        assert.notInclude(append, "systemPrompt");
        assert.include(sent, "<pull_request_linking>");
      }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 update_steps checklist", () => {
  it.effect("shows agy's update_steps calls as the thread's task list, not tool rows", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-update-steps-test");
      const threadId = ThreadId.make("thread-antigravity-update-steps");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdate = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              // agy 1.5.15/1.5.16 report the checklist only as tool calls, never as ACP `plan`.
              prompt: () =>
                Effect.gen(function* () {
                  const send = (update: EffectAcpSchema.SessionUpdate) =>
                    sessionUpdate === undefined
                      ? Effect.die("the adapter must handle session updates")
                      : sessionUpdate(
                          normalizeAntigravitySessionUpdate({
                            sessionId: "mock-session-1",
                            update,
                          }),
                        );
                  const calls = [
                    [
                      { title: "Create a.txt", status: "in_progress" },
                      { title: "Create b.txt", status: "pending" },
                    ],
                    [
                      { title: "Create a.txt", status: "done" },
                      { title: "Create b.txt", status: "in_progress" },
                    ],
                  ];
                  for (const [index, steps] of calls.entries()) {
                    const toolCallId = `update-steps-${index + 1}`;
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title: "Run update_steps",
                      kind: "other",
                      status: "in_progress",
                      rawInput: { steps },
                    });
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status: "completed",
                    });
                  }
                  return { stopReason: "end_turn" as const };
                }),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-update-steps"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* session.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project-antigravity-update-steps"),
          title: "Antigravity update_steps",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make("run-antigravity-update-steps"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-antigravity-update-steps"),
        rootNodeId: NodeId.make("node-antigravity-update-steps"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-antigravity-update-steps"),
          text: "create a.txt and b.txt",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      const events = Array.from(
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );

      const toolRows = events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
          ? [event.turnItem.toolName]
          : [],
      );
      assert.deepEqual(toolRows, []);
      const plans = events.flatMap((event) =>
        event.type === "plan.updated" && event.plan.kind === "todo_list"
          ? [event.plan.steps.map((step) => [step.text, step.status])]
          : [],
      );
      assert.deepEqual(plans.at(-1), [
        ["Create a.txt", "completed"],
        ["Create b.txt", "running"],
      ]);
    }).pipe(Effect.provide(layerSession)),
  );
});
