import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
// @effect-diagnostics nodeBuiltinImport:off - CLI integration uses temporary Node paths.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProviderInstanceId,
  ThreadId,
  type ApplicationProjectEvent,
  type OrchestrationV2AppThread,
  type ProjectId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import { ProjectImportFailedError, ProjectImportInputError } from "./project.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);
const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(Effect.provide(layerCliRuntime));

const runCliCaptured = (args: ReadonlyArray<string>, options?: { readonly stdin?: string }) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(Command.runWith(cli, { version: "0.0.0" })(args));
    const logs = yield* TestConsole.logLines;
    return {
      result,
      logs: logs.filter((line): line is string => typeof line === "string"),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        layerCliRuntime,
        TestConsole.layer,
        options?.stdin === undefined
          ? Layer.empty
          : Stdio.layerTest({
              stdin: Stream.make(new TextEncoder().encode(options.stdin)),
            }),
      ),
    ),
  );

const makeProjectImportFile = (directory: string, records: unknown) => {
  const file = NodePath.join(directory, "projects.json");
  NodeFS.writeFileSync(file, JSON.stringify(records));
  return file;
};

const readProjectImportSummary = (logs: ReadonlyArray<string>) => {
  const line = logs.findLast((entry) => entry.startsWith("{"));
  assert.isDefined(line);
  return JSON.parse(line!) as {
    created: number;
    existing: number;
    moved: number;
    skipped: number;
    failed: number;
    results: ReadonlyArray<{
      workspaceRoot: string;
      status: "created" | "existing" | "moved" | "skipped" | "failed";
      error?: string;
    }>;
  };
};

const makeConfig = (baseDir: string) =>
  Effect.gen(function* () {
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
    return {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otelEnvironment: OtelEnvironment.none,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
      otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
      otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
      otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl: undefined,
      devAllowedOrigins: [],
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    } satisfies ServerConfig.ServerConfig["Service"];
  });

const withProjectService = <A, E>(
  baseDir: string,
  use: (projects: ProjectService.ProjectService["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const config = yield* makeConfig(baseDir);
    const layer = RuntimeLayer.layerProjectService.pipe(
      Layer.provideMerge(ProjectEnrichmentService.layer),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(ProjectFaviconResolver.layer),
      Layer.provideMerge(T3ProjectFileLoader.layer),
      Layer.provideMerge(WorkspacePaths.layer),
      Layer.provideMerge(
        ServerSettings.layer.pipe(
          Layer.provide(Layer.merge(ServerSecretStore.layer, ManagedPolicy.layerTest())),
        ),
      ),
      Layer.provideMerge(SqlitePersistence.layerConfig),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
    );
    return yield* ProjectService.ProjectService.pipe(Effect.flatMap(use), Effect.provide(layer));
  });

const readProjects = (baseDir: string) =>
  withProjectService(baseDir, (projects) => projects.snapshot);

const readProjectEvents = (baseDir: string) =>
  Effect.gen(function* () {
    const config = yield* makeConfig(baseDir);
    const layer = OrchestrationEventStore.layer.pipe(
      Layer.provideMerge(SqlitePersistence.layerConfig),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
    );
    const events = yield* Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const latest = yield* store.latestApplicationSequence;
      return yield* store
        .readApplicationEvents({ afterSequence: 0, throughSequence: latest })
        .pipe(Stream.runCollect);
    }).pipe(Effect.provide(layer));
    return Array.from(events).filter(
      (event): event is ApplicationProjectEvent => "aggregateKind" in event,
    );
  });

it.effect(
  "adds, renames, and removes projects, and tracks folders on add, through the V2 project CLI domain",
  () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-project-cli-"));
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-v2-project-workspace-"),
      );

      yield* runCli(["project", "add", workspaceRoot, "--title", "Alpha", "--base-dir", baseDir]);
      const added = (yield* readProjects(baseDir)).projects[0];
      assert.equal(added?.title, "Alpha");
      assert.equal(added?.workspaceRoot, workspaceRoot);

      yield* runCli(["project", "rename", workspaceRoot, "Beta", "--base-dir", baseDir]);
      assert.equal((yield* readProjects(baseDir)).projects[0]?.title, "Beta");

      yield* runCli(["project", "remove", added?.id ?? "", "--base-dir", baseDir]);
      assert.deepEqual((yield* readProjects(baseDir)).projects, []);

      // Repositories inside the folder are found; `--track` adds one from outside it.
      const shared = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-project-shared-"));
      const homeShared = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-project-home-"));
      NodeFS.mkdirSync(NodePath.join(workspaceRoot, "api", ".git"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(workspaceRoot, "notes"));
      // Names are cut to 128 UTF-16 units, never between the halves of an emoji.
      const named = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-project-names-"));
      const straddling = NodePath.join(named, `${"a".repeat(127)}🚀`);
      const fitting = NodePath.join(named, `${"b".repeat(126)}🚀`);
      const padded = NodePath.join(named, `${" ".repeat(127)}🚀`);
      for (const folder of [straddling, fitting, padded]) NodeFS.mkdirSync(folder);
      yield* runCli([
        "project",
        "add",
        workspaceRoot,
        "--track",
        `${shared}${NodePath.sep}`,
        "--track",
        `~/${NodePath.basename(homeShared)}`,
        "--track",
        straddling,
        "--track",
        fitting,
        "--track",
        padded,
        "--base-dir",
        baseDir,
      ]).pipe(Effect.provideService(HostProcess.HomeDirectory, NodeOS.tmpdir()));
      assert.deepEqual((yield* readProjects(baseDir)).projects[0]?.trackedFolders, [
        { path: NodePath.join(workspaceRoot, "api"), name: "api", discovered: true },
        { path: shared, name: NodePath.basename(shared) },
        { path: homeShared, name: NodePath.basename(homeShared) },
        { path: straddling, name: "a".repeat(127) },
        { path: fitting, name: `${"b".repeat(126)}🚀` },
        { path: padded, name: "🚀" },
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("imports a project batch, reruns idempotently, and preserves existing project rows", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-project-import-"));
    const workspaceA = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-v2-project-import-a-"),
    );
    const workspaceB = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-v2-project-import-b-"),
    );
    const file = makeProjectImportFile(baseDir, [
      { title: "Alpha", workspaceRoot: workspaceA },
      { title: "Beta", workspaceRoot: workspaceB },
      { title: "Duplicate Alpha", workspaceRoot: workspaceA },
    ]);

    const first = yield* runCliCaptured([
      "project",
      "import",
      "--file",
      file,
      "--base-dir",
      baseDir,
    ]);
    assert.equal(first.result._tag, "Success");
    assert.lengthOf(first.logs, 1);
    const firstSummary = readProjectImportSummary(first.logs);
    assert.deepEqual(
      {
        created: firstSummary.created,
        existing: firstSummary.existing,
        skipped: firstSummary.skipped,
        failed: firstSummary.failed,
      },
      { created: 2, existing: 1, skipped: 0, failed: 0 },
    );
    assert.deepEqual(
      firstSummary.results.map((result) => result.status),
      ["created", "created", "existing"],
    );

    const before = (yield* readProjects(baseDir)).projects
      .map(({ id, title, workspaceRoot }) => ({ id, title, workspaceRoot }))
      .sort((left, right) => left.id.localeCompare(right.id));
    assert.lengthOf(before, 2);

    const rerunFile = makeProjectImportFile(baseDir, [
      { title: "Renamed Alpha", workspaceRoot: workspaceA },
      { title: "Renamed Beta", workspaceRoot: workspaceB },
    ]);
    const second = yield* runCliCaptured([
      "project",
      "import",
      "--file",
      rerunFile,
      "--base-dir",
      baseDir,
    ]);
    assert.equal(second.result._tag, "Success");
    assert.deepEqual(
      {
        created: readProjectImportSummary(second.logs).created,
        existing: readProjectImportSummary(second.logs).existing,
      },
      { created: 0, existing: 2 },
    );
    const after = (yield* readProjects(baseDir)).projects
      .map(({ id, title, workspaceRoot }) => ({ id, title, workspaceRoot }))
      .sort((left, right) => left.id.localeCompare(right.id));
    assert.deepEqual(after, before);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("re-imports a workspace after its project was removed", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-project-import-"));
    const workspaceRoot = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-v2-project-import-"),
    );
    yield* runCli(["project", "add", workspaceRoot, "--title", "Original", "--base-dir", baseDir]);
    const original = (yield* readProjects(baseDir)).projects[0];
    assert.isDefined(original);
    yield* runCli(["project", "remove", original!.id, "--base-dir", baseDir]);

    const file = makeProjectImportFile(baseDir, [{ title: "Reimported", workspaceRoot }]);
    const { result, logs } = yield* runCliCaptured([
      "project",
      "import",
      "--file",
      file,
      "--base-dir",
      baseDir,
    ]);
    assert.equal(result._tag, "Success");
    assert.equal(readProjectImportSummary(logs).created, 1);
    const reimported = (yield* readProjects(baseDir)).projects[0];
    assert.notEqual(reimported!.id, original!.id);
    assert.equal(reimported!.title, "Reimported");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("rebinds a project whose workspace root moved behind a symlink", () =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-project-moved-"));
    const owned = NodePath.join(root, "owned");
    const canonicalRoot = NodePath.join(owned, "demo");
    NodeFS.mkdirSync(canonicalRoot, { recursive: true });
    const legacyParent = NodePath.join(root, "repos", "owned");
    NodeFS.mkdirSync(NodePath.dirname(legacyParent), { recursive: true });
    NodeFS.symlinkSync(owned, legacyParent);
    const legacyRoot = NodePath.join(legacyParent, "demo");
    const baseDir = NodePath.join(root, "state");

    yield* runCli(["project", "add", legacyRoot, "--title", "Demo", "--base-dir", baseDir]);
    const original = (yield* readProjects(baseDir)).projects[0];
    assert.isDefined(original);
    assert.equal(original?.workspaceRoot, legacyRoot);

    const file = makeProjectImportFile(root, [{ title: "Demo", workspaceRoot: canonicalRoot }]);
    const first = yield* runCliCaptured([
      "project",
      "import",
      "--file",
      file,
      "--base-dir",
      baseDir,
    ]);
    assert.equal(first.result._tag, "Success");
    const firstSummary = readProjectImportSummary(first.logs);
    assert.deepEqual(
      {
        created: firstSummary.created,
        existing: firstSummary.existing,
        moved: firstSummary.moved,
        skipped: firstSummary.skipped,
        failed: firstSummary.failed,
      },
      { created: 0, existing: 0, moved: 1, skipped: 0, failed: 0 },
    );
    assert.deepEqual(
      firstSummary.results.map((result) => result.status),
      ["moved"],
    );

    const afterMove = (yield* readProjects(baseDir)).projects;
    assert.lengthOf(afterMove, 1);
    assert.equal(afterMove[0]?.id, original?.id);
    assert.equal(afterMove[0]?.workspaceRoot, canonicalRoot);
    assert.equal(afterMove[0]?.title, "Demo");

    const projectEvents = yield* readProjectEvents(baseDir);
    assert.lengthOf(
      projectEvents.filter((event) => event.type === "project.created"),
      1,
    );
    const updates = projectEvents.filter((event) => event.type === "project.meta-updated");
    assert.lengthOf(updates, 1);
    assert.equal(updates[0]?.aggregateId, original?.id);
    assert.equal(updates[0]?.payload.workspaceRoot, canonicalRoot);

    const second = yield* runCliCaptured([
      "project",
      "import",
      "--file",
      file,
      "--base-dir",
      baseDir,
    ]);
    assert.equal(second.result._tag, "Success");
    const secondSummary = readProjectImportSummary(second.logs);
    assert.deepEqual(
      {
        created: secondSummary.created,
        existing: secondSummary.existing,
        moved: secondSummary.moved,
      },
      { created: 0, existing: 1, moved: 0 },
    );
    assert.lengthOf((yield* readProjects(baseDir)).projects, 1);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("skips missing and non-directory workspace roots without creating them", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-project-import-"));
    const missing = NodePath.join(baseDir, "missing");
    const regularFile = NodePath.join(baseDir, "regular-file");
    NodeFS.writeFileSync(regularFile, "not a directory");
    const file = makeProjectImportFile(baseDir, [
      { title: "Missing", workspaceRoot: missing },
      { title: "File", workspaceRoot: regularFile },
    ]);
    const { result, logs } = yield* runCliCaptured([
      "project",
      "import",
      "--file",
      file,
      "--base-dir",
      baseDir,
    ]);
    assert.equal(result._tag, "Success");
    const summary = readProjectImportSummary(logs);
    assert.deepEqual(
      { created: summary.created, skipped: summary.skipped, failed: summary.failed },
      { created: 0, skipped: 2, failed: 0 },
    );
    assert.isFalse(NodeFS.existsSync(missing));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("reads the import list from stdin when --file is -", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-project-import-"));
    const workspaceRoot = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-v2-project-import-"),
    );
    const { result, logs } = yield* runCliCaptured(
      ["project", "import", "--file", "-", "--base-dir", baseDir],
      { stdin: JSON.stringify([{ title: "Stdin", workspaceRoot }]) },
    );
    assert.equal(result._tag, "Success");
    assert.equal(readProjectImportSummary(logs).created, 1);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("validates the whole import list before creating anything", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-project-import-"));
    const workspaceRoot = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-v2-project-import-"),
    );
    const invalidRecord = makeProjectImportFile(baseDir, [
      { title: "Valid", workspaceRoot },
      { title: "", workspaceRoot },
    ]);
    const invalid = yield* runCliCaptured([
      "project",
      "import",
      "--file",
      invalidRecord,
      "--base-dir",
      baseDir,
    ]);
    assert.equal(invalid.result._tag, "Failure");
    assert.instanceOf(
      invalid.result._tag === "Failure" ? invalid.result.failure : undefined,
      ProjectImportInputError,
    );
    const invalidJsonFile = NodePath.join(baseDir, "invalid.json");
    NodeFS.writeFileSync(invalidJsonFile, "{");
    const malformed = yield* runCliCaptured([
      "project",
      "import",
      "--file",
      invalidJsonFile,
      "--base-dir",
      baseDir,
    ]);
    assert.instanceOf(
      malformed.result._tag === "Failure" ? malformed.result.failure : undefined,
      ProjectImportInputError,
    );
    assert.deepEqual((yield* readProjects(baseDir)).projects, []);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("keeps successful records when a later record fails", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-project-import-"));
    const workspaceRoot = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-v2-project-import-"),
    );
    const loopingPath = NodePath.join(baseDir, "looping-link");
    NodeFS.symlinkSync(loopingPath, loopingPath);
    const file = makeProjectImportFile(baseDir, [
      { title: "Good", workspaceRoot },
      { title: "Bad", workspaceRoot: loopingPath },
    ]);
    const { result, logs } = yield* runCliCaptured([
      "project",
      "import",
      "--file",
      file,
      "--base-dir",
      baseDir,
    ]);
    assert.equal(result._tag, "Failure");
    assert.instanceOf(
      result._tag === "Failure" ? result.failure : undefined,
      ProjectImportFailedError,
    );
    assert.lengthOf(logs, 1);
    assert.deepEqual(
      {
        created: readProjectImportSummary(logs).created,
        failed: readProjectImportSummary(logs).failed,
      },
      { created: 1, failed: 1 },
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["snapshot", "mutation"] as const)(
  "waits for a busy live server's %s response",
  (slowRequest) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-live-project-cli-" });
      const baseDir = NodePath.join(root, "state");
      const workspaceRoot = NodePath.join(root, "workspace");
      yield* fs.makeDirectory(workspaceRoot);
      yield* persistServerRuntimeState({
        path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
        state: yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: 3_773,
        }),
      });
      const now = "2026-01-01T00:00:00.000Z";
      const requestReceived = Promise.withResolvers<void>();
      const releaseResponse = Promise.withResolvers<void>();
      let snapshotRequests = 0;
      let mutations = 0;
      const fetch: typeof globalThis.fetch = async (_input, init) => {
        const isMutation = init?.method === "POST";
        if (isMutation) mutations++;
        else snapshotRequests++;
        if (slowRequest === "mutation" ? isMutation : !isMutation) {
          requestReceived.resolve();
          await releaseResponse.promise;
        }
        return Response.json(
          isMutation
            ? {
                id: "live-project",
                title: NodePath.basename(workspaceRoot),
                workspaceRoot,
                defaultModelSelection: null,
                scripts: [],
                createdAt: now,
                updatedAt: now,
                deletedAt: null,
              }
            : { projects: [], updatedAt: now },
        );
      };

      const add = yield* runCli(["project", "add", workspaceRoot, "--base-dir", baseDir]).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.forkChild,
      );
      yield* Effect.promise(() => requestReceived.promise);
      yield* TestClock.adjust("2 seconds");
      releaseResponse.resolve();
      yield* Fiber.join(add);

      assert.equal(snapshotRequests, 1);
      assert.equal(mutations, 1);
      assert.deepEqual((yield* readProjects(baseDir)).projects, []);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does not send a token to whatever took over a dead server's port", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dead-project-cli-" });
    const baseDir = NodePath.join(root, "state");
    const workspaceRoot = NodePath.join(root, "workspace");
    yield* fs.makeDirectory(workspaceRoot);
    const state = yield* makePersistedServerRuntimeState({
      config: { host: "127.0.0.1", devUrl: undefined },
      port: 3_773,
    });
    yield* persistServerRuntimeState({
      path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
      // Above Linux's PID ceiling, as in pair.test.ts: no process can hold it.
      state: { ...state, pid: 4_194_305 },
    });
    let requests = 0;
    const fetch: typeof globalThis.fetch = async () => {
      requests++;
      return Response.json({ projects: [], updatedAt: "2026-01-01T00:00:00.000Z" });
    };

    yield* runCli(["project", "add", workspaceRoot, "--base-dir", baseDir]).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );

    assert.equal(requests, 0);
    assert.equal((yield* readProjects(baseDir)).projects[0]?.workspaceRoot, workspaceRoot);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const makeProjectLookupFixture = Effect.fn("ProjectCliTest.makeProjectLookupFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-project-lookup-" });
  const baseDir = NodePath.join(root, "state");
  const workspaceRoot = NodePath.join(root, "workspace");
  yield* fs.makeDirectory(workspaceRoot);
  yield* runCli(["project", "add", workspaceRoot, "--base-dir", baseDir]);
  const project = (yield* readProjects(baseDir)).projects[0];
  assert.isDefined(project);
  return { baseDir, workspaceRoot, project: project! };
});

it.effect.each([
  { label: "keeps its title", args: [], expectedTitle: undefined, named: false },
  {
    label: "applies --title",
    args: ["--title", " Back again "],
    expectedTitle: "Back again",
    named: false,
  },
  { label: "adds the --track folders to the ones it had", args: [], named: true },
])(
  "adding an archived project's folder again unarchives it and $label",
  ({ args, expectedTitle, named }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      const kept = { path: NodePath.join(baseDir, "..", "cli-kept"), name: "Kept" };
      const added = { path: NodePath.join(baseDir, "..", "cli-named"), name: "cli-named" };
      yield* fs.makeDirectory(kept.path);
      yield* fs.makeDirectory(added.path);
      yield* withProjectService(baseDir, (projects) =>
        projects.update({
          commandId: CommandId.make("project-cli-archive"),
          projectId: project.id,
          archived: true,
          trackedFolders: [kept],
        }),
      );

      yield* runCli([
        "project",
        "add",
        workspaceRoot,
        ...args,
        ...(named ? ["--track", kept.path, "--track", added.path] : []),
        "--base-dir",
        baseDir,
      ]);

      const projects = (yield* readProjects(baseDir)).projects;
      assert.deepEqual(
        projects.map((entry) => ({
          id: entry.id,
          title: entry.title,
          archivedAt: entry.archivedAt,
          trackedFolders: entry.trackedFolders,
        })),
        [
          {
            id: project.id,
            title: expectedTitle ?? project.title,
            archivedAt: null,
            trackedFolders: named ? [kept, added] : [kept],
          },
        ],
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

const makeThreadPersistenceLayer = Effect.fn("ProjectCliTest.makeThreadPersistenceLayer")(
  function* (baseDir: string) {
    const config = yield* makeConfig(baseDir);
    return Layer.mergeAll(
      RuntimeLayer.layerEventSink,
      ProjectionStore.layer,
      EventStore.layer,
    ).pipe(
      Layer.provideMerge(SqlitePersistence.layerConfig),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
    );
  },
);

const seedNativeThreads = Effect.fn("ProjectCliTest.seedNativeThreads")(function* (
  baseDir: string,
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly archived: boolean;
  }>,
) {
  const layer = yield* makeThreadPersistenceLayer(baseDir);
  const createdAt = DateTime.makeUnsafe("2026-09-04T12:00:00.000Z");
  const providerInstanceId = ProviderInstanceId.make("codex");
  yield* Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    yield* eventSink.write({
      commandId: CommandId.make("project-cli-seed-threads"),
      events: threads.map(({ id, projectId, archived }) => {
        const payload: OrchestrationV2AppThread = {
          createdBy: "user",
          creationSource: "web",
          id,
          projectId,
          title: id,
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
          forkedFrom: null,
          createdAt,
          updatedAt: createdAt,
          archivedAt: archived ? createdAt : null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        };
        return {
          id: EventId.make(`project-cli-create-${id}`),
          type: "thread.created" as const,
          threadId: id,
          providerInstanceId,
          occurredAt: createdAt,
          payload,
        };
      }),
    });
  }).pipe(Effect.provide(layer));
});

const readNativeThreadState = Effect.fn("ProjectCliTest.readNativeThreadState")(function* (
  baseDir: string,
  threadId: ThreadId,
) {
  const layer = yield* makeThreadPersistenceLayer(baseDir);
  return yield* Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    return {
      thread: yield* projections.getThread(threadId),
      events: yield* events.read({ threadId }).pipe(Stream.runCollect),
    };
  }).pipe(Effect.provide(layer));
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "project deletion with native V2 threads",
  (it) => {
    it.effect.each([
      { label: "an active thread", archived: false, missing: false },
      {
        label: "an archived thread after its workspace disappears",
        archived: true,
        missing: true,
      },
    ])("rejects unforced removal of a project with $label", ({ archived, missing }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
        const threadId = ThreadId.make("project-cli-preserved-thread");
        yield* seedNativeThreads(baseDir, [{ id: threadId, projectId: project.id, archived }]);
        const before = yield* readNativeThreadState(baseDir, threadId);
        if (missing) yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);

        const error = yield* runCli([
          "project",
          "remove",
          missing ? workspaceRoot : project.id,
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => assert.fail("Removing a nonempty project must require --force."),
          }),
        );

        assert.include(error.message, "not empty");
        assert.deepEqual(
          (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
          [project.id],
        );
        assert.deepEqual(yield* readNativeThreadState(baseDir, threadId), before);
        assert.equal(yield* fs.exists(workspaceRoot), !missing);
      }),
    );

    it.effect.each(["present", "missing"] as const)(
      "force-removes active and archived V2 threads with the workspace %s, preserving unrelated projects",
      (workspace) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
          const otherWorkspace = `${workspaceRoot}-other`;
          yield* fs.makeDirectory(otherWorkspace);
          yield* runCli(["project", "add", otherWorkspace, "--base-dir", baseDir]);
          const otherProject = (yield* readProjects(baseDir)).projects.find(
            (entry) => entry.workspaceRoot === otherWorkspace,
          );
          assert.isDefined(otherProject);
          const activeId = ThreadId.make("project-cli-deleted-active");
          const archivedId = ThreadId.make("project-cli-deleted-archived");
          const unrelatedId = ThreadId.make("project-cli-unrelated-thread");
          yield* seedNativeThreads(baseDir, [
            { id: activeId, projectId: project.id, archived: false },
            { id: archivedId, projectId: project.id, archived: true },
            { id: unrelatedId, projectId: otherProject!.id, archived: false },
          ]);
          const unrelatedBefore = yield* readNativeThreadState(baseDir, unrelatedId);
          if (workspace === "missing") {
            yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
          }

          yield* runCli([
            "project",
            "remove",
            workspace === "missing" ? workspaceRoot : project.id,
            "--force",
            "--base-dir",
            baseDir,
          ]);

          assert.deepEqual(
            (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
            [otherProject!.id],
          );
          for (const threadId of [activeId, archivedId]) {
            const state = yield* readNativeThreadState(baseDir, threadId);
            assert.isNotNull(state.thread.deletedAt);
            assert.lengthOf(
              state.events.filter((record) => record.event.type === "thread.deleted"),
              1,
            );
          }
          assert.deepEqual(yield* readNativeThreadState(baseDir, unrelatedId), unrelatedBefore);
          assert.equal(yield* fs.exists(workspaceRoot), workspace === "present");
          assert.isTrue(yield* fs.exists(otherWorkspace));
        }),
    );
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "project lookup with unavailable workspaces",
  (it) => {
    it.effect.each([
      "id",
      "stored path",
      "relative path",
      "path with a trailing separator",
    ] as const)("removes an empty project by %s after its directory is gone", (identifier) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
        yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
        const target = {
          id: project.id,
          "stored path": workspaceRoot,
          "relative path": NodePath.relative(process.cwd(), workspaceRoot),
          "path with a trailing separator": `${workspaceRoot}${NodePath.sep}`,
        }[identifier];
        yield* runCli(["project", "remove", target, "--base-dir", baseDir]);
        assert.deepEqual((yield* readProjects(baseDir)).projects, []);
        assert.isFalse(yield* fs.exists(workspaceRoot));
      }),
    );

    it.effect("does not resolve another environment's project ID in an empty database", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
        yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
        const replacementDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-v2-project-empty-",
        });
        const error = yield* runCli([
          "project",
          "remove",
          project.id,
          "--force",
          "--base-dir",
          replacementDir,
        ]).pipe(Effect.flip);
        assert.include(error.message, "No active project found");
        assert.deepEqual(
          (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
          [project.id],
        );
        assert.deepEqual((yield* readProjects(replacementDir)).projects, []);
      }),
    );

    it.effect("normalizes existing paths without conflating separately registered symlinks", () =>
      Effect.gen(function* () {
        const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
        yield* runCli([
          "project",
          "rename",
          `${workspaceRoot}${NodePath.sep}.`,
          "Normalized",
          "--base-dir",
          baseDir,
        ]);
        assert.equal((yield* readProjects(baseDir)).projects[0]?.title, "Normalized");
        const aliasPath = `${workspaceRoot}-alias`;
        NodeFS.symlinkSync(workspaceRoot, aliasPath, "junction");
        const unknownAlias = yield* runCli([
          "project",
          "remove",
          aliasPath,
          "--base-dir",
          baseDir,
        ]).pipe(Effect.flip);
        assert.include(unknownAlias.message, "No active project found");
        yield* runCli(["project", "add", aliasPath, "--base-dir", baseDir]);
        const added = (yield* readProjects(baseDir)).projects;
        assert.equal(added.length, 2);
        const aliasProject = added.find((entry) => entry.workspaceRoot === aliasPath);
        assert.isDefined(aliasProject);
        assert.notEqual(aliasProject?.id, project.id);
        yield* runCli(["project", "remove", `${aliasPath}${NodePath.sep}.`, "--base-dir", baseDir]);
        assert.deepEqual(
          (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
          [project.id],
        );
        assert.isTrue(NodeFS.existsSync(workspaceRoot));
      }),
    );
  },
);
