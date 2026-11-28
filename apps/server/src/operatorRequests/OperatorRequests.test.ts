// @effect-diagnostics nodeBuiltinImport:off -- This fixture binds a Unix socket and verifies file modes on disk.
import {
  isOperatorRequestTerminalStatus,
  PrincipalId,
  ThreadId,
  type OperatorRequestCreateInput,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import { make, type OperatorRequestDesktopRuntime } from "./OperatorRequests.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import { makePrincipalExecution, PrincipalExecution } from "../runner/PrincipalExecution.ts";

const threadId = ThreadId.make("thread:test-operator-request");
const input = { title: "Approve a test operation", kind: "custom", privilege: "user" } as const;
type Card = Extract<OrchestrationV2TurnItem, { type: "operator_request" }>;
type Command = Extract<OrchestrationV2InternalCommand, { type: "operator_request.record" }>;
let stateDir: string;

beforeEach(async () => {
  stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-operator-request-"));
});
afterEach(async () => {
  await NodeFSP.rm(stateDir, { recursive: true, force: true });
});

function fixture(
  desktop: OperatorRequestDesktopRuntime = {},
  beforeCommit: (command: Command) => Effect.Effect<void, OrchestratorDispatchError> = () =>
    Effect.void,
) {
  return Effect.gen(function* () {
    const created = yield* Deferred.make<void>();
    const commands: Command[] = [];
    const cards = new Map<string, Card>();
    const service = yield* make({
      stateDir,
      desktop: { getUid: () => 1000, ...desktop },
      projection: {
        getThread: () => Effect.succeed({}),
        listOperatorRequests: (lookup) =>
          Effect.sync(() =>
            [...cards.values()].filter(
              ({ request }) =>
                (lookup.threadId === undefined || lookup.threadId === request.threadId) &&
                (lookup.requestId === undefined || lookup.requestId === request.requestId) &&
                (lookup.turnItemId === undefined || lookup.turnItemId === request.turnItemId) &&
                (lookup.externalId === undefined || lookup.externalId === request.externalId) &&
                (lookup.includeTerminal || !isOperatorRequestTerminalStatus(request.status)),
            ),
          ),
      },
      orchestrator: {
        dispatch: (command) =>
          Effect.gen(function* () {
            if (command.type !== "operator_request.record")
              throw new Error(`unexpected: ${command.type}`);
            commands.push(command);
            yield* beforeCommit(command);
            const { request } = command;
            const now = DateTime.makeUnsafe(request.updatedAt);
            const terminal = isOperatorRequestTerminalStatus(request.status);
            cards.set(command.turnItemId, {
              type: "operator_request",
              id: command.turnItemId,
              threadId: command.threadId,
              request,
              title: request.title,
              status: terminal ? "completed" : "waiting",
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
            yield* Deferred.succeed(created, undefined);
            return { sequence: commands.length, storedEvents: [] };
          }),
      },
    }).pipe(Effect.provide(NodeCrypto.layer));
    return { service, commands, created };
  });
}

const desktopInput = (requestId = "vagrant-42"): OperatorRequestCreateInput => ({
  ...input,
  kind: "vagrant",
  surfaces: { desktopAction: { kind: "vagrant", requestId } },
});

describe("OperatorRequests", () => {
  it.effect("expires overdue requests on read, list, or decision without waking the thread", () =>
    Effect.gen(function* () {
      const { service, commands } = yield* fixture();
      const expiresAt = "2000-01-01T00:00:00Z";
      yield* TestClock.setTime(Date.parse(expiresAt));
      const metadata = { labels: ["review"], detail: { attempt: 1 } };
      const create = () => service.create({ ...input, threadId, expiresAt, metadata });
      const read = yield* create();
      const decide = yield* create();
      const list = yield* create();
      const lookup = { requestId: read.requestId };
      expect(yield* service.status(lookup)).toMatchObject({
        status: "expired",
        expiresAt,
        metadata,
        receipt: { status: "expired" },
      });
      for (const method of [service.answer, service.resolve]) {
        expect(
          yield* Effect.flip(method({ requestId: decide.requestId, status: "submitted" })),
        ).toMatchObject({ _tag: "OperatorRequestError", reason: "already_terminal" });
      }
      expect((yield* service.listPending({ threadId })).requests).toEqual([]);
      expect(yield* service.status({ requestId: list.requestId })).toMatchObject({
        status: "expired",
      });
      expect(commands).toHaveLength(6);
      expect(commands.every((command) => command.wake === undefined)).toBe(true);
    }),
  );

  it.effect("persists standalone expiry, metadata and ownership across restarts", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture();
      const alice = { ownerPrincipal: "alice" };
      const bob = { ownerPrincipal: "bob" };
      const expiresAt = "2000-01-01T00:00:00Z";
      yield* TestClock.setTime(Date.parse(expiresAt) + 1);
      const metadata = { source: "fixture" };
      const { requestId } = yield* service.create(
        { ...input, expiresAt, metadata, externalId: "shared" },
        alice,
      );
      const reopened = (yield* fixture()).service;
      const lookup = { requestId };
      expect(yield* Effect.flip(reopened.status(lookup, bob))).toMatchObject({
        reason: "not_found",
      });
      expect(yield* Effect.flip(reopened.cancel(lookup, bob))).toMatchObject({
        reason: "not_found",
      });
      expect((yield* reopened.listPending({ includeTerminal: true }, bob)).requests).toEqual([]);
      expect(yield* reopened.status(lookup, alice)).toMatchObject({
        status: "expired",
        expiresAt,
        metadata,
      });
      const other = yield* reopened.create({ ...input, externalId: "shared" }, bob);
      expect(other.requestId).not.toBe(requestId);
      expect(yield* reopened.cancel({ requestId: other.requestId }, bob)).toMatchObject({
        status: "cancelled",
      });
      expect(yield* (yield* fixture()).service.status(lookup, alice)).toMatchObject({
        status: "expired",
      });
    }),
  );

  it.effect("returns a synchronous answer without a second wake", () =>
    Effect.gen(function* () {
      const { service, commands, created } = yield* fixture();
      const waiting = yield* service
        .create({
          ...input,
          threadId,
          externalId: "sync",
          waitPolicy: { mode: "sync", syncTimeoutMs: 5_000 },
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(created);
      const answered = yield* service.resolve({ externalId: "sync", status: "submitted" });
      expect(yield* Fiber.join(waiting)).toEqual(answered);
      expect(answered.receipt?.status).toBe("submitted");
      expect(commands).toHaveLength(2);
      expect(commands.every((command) => command.wake === undefined)).toBe(true);
    }),
  );

  it.effect("wakes exactly once when a sync caller disconnects during decision persistence", () =>
    Effect.gen(function* () {
      const committing = yield* Deferred.make<void>();
      const commit = yield* Deferred.make<void>();
      const { service, commands, created } = yield* fixture({}, (command) =>
        command.request.status === "submitted" && command.wakeOnly !== true
          ? Deferred.succeed(committing, undefined).pipe(Effect.andThen(Deferred.await(commit)))
          : Effect.void,
      );
      const waiting = yield* service
        .create({
          ...input,
          threadId,
          externalId: "abandoned",
          waitPolicy: { mode: "sync" },
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(created);
      const decision = yield* service
        .resolve({ externalId: "abandoned", status: "submitted" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(committing);
      waiting.interruptUnsafe();
      yield* Deferred.succeed(commit, undefined);
      expect((yield* Fiber.join(decision)).status).toBe("submitted");
      yield* Fiber.await(waiting);
      expect(commands.map(({ wake, wakeOnly }) => [wake !== undefined, wakeOnly])).toEqual([
        [false, undefined],
        [false, undefined],
        [true, true],
      ]);
    }),
  );

  it.effect("persists and returns sync expiry before the wait timeout", () =>
    Effect.gen(function* () {
      const { service, commands, created } = yield* fixture();
      const start = Date.parse("2026-11-28T00:00:00Z");
      yield* TestClock.setTime(start);
      const waiting = yield* service
        .create({
          ...input,
          threadId,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(start + 1_000)),
          waitPolicy: { mode: "sync", syncTimeoutMs: 60_000 },
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(created);
      yield* TestClock.adjust(1_000);
      const record = yield* Fiber.join(waiting);
      expect(record).toMatchObject({ status: "expired", receipt: { status: "expired" } });
      expect(commands.map((command) => command.request.status)).toEqual(["pending", "expired"]);
      expect(commands.every((command) => command.wake === undefined)).toBe(true);
    }),
  );

  it.effect("demotes a timed-out sync request and wakes only when answered", () =>
    Effect.gen(function* () {
      const { service, commands, created } = yield* fixture();
      const waiting = yield* service
        .create({
          ...input,
          threadId,
          waitPolicy: { mode: "sync", syncTimeoutMs: 5 },
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(created);
      yield* TestClock.adjust(5);
      const record = yield* Fiber.join(waiting);
      expect(record).toMatchObject({ status: "pending", demotedToAsync: true });
      expect(commands.every((command) => command.wake === undefined)).toBe(true);
      yield* service.answer({ requestId: record.requestId, status: "declined" });
      expect(commands.filter((command) => command.wake !== undefined)).toHaveLength(1);
    }),
  );

  it.effect("cancels on timeout without waking and preserves the terminal state", () =>
    Effect.gen(function* () {
      const { service, commands, created } = yield* fixture();
      const waiting = yield* service
        .create({
          ...input,
          threadId,
          waitPolicy: { mode: "sync", syncTimeoutMs: 5, onTimeout: "cancel" },
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(created);
      yield* TestClock.adjust(5);
      const record = yield* Fiber.join(waiting);
      expect(record.status).toBe("cancelled");
      const error = yield* Effect.flip(service.cancel({ requestId: record.requestId }));
      expect(error.reason).toBe("already_terminal");
      expect(commands).toHaveLength(2);
      expect(commands.every((command) => command.wake === undefined)).toBe(true);
    }),
  );

  it.effect("correlates IDs, serializes concurrent answers, and wakes at most once", () =>
    Effect.gen(function* () {
      const { service, commands } = yield* fixture();
      const record = yield* service.create({ ...input, threadId, externalId: "ticket-1" });
      expect(record.status).toBe("pending");
      expect(yield* service.create({ ...input, threadId, externalId: "ticket-1" })).toEqual(record);
      expect(yield* service.status({ turnItemId: record.turnItemId })).toEqual(record);
      const results = yield* Effect.all(
        [
          service.answer({ externalId: "ticket-1", status: "submitted" }).pipe(Effect.result),
          service.answer({ requestId: record.requestId, status: "declined" }).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect(results.find((result) => result._tag === "Failure")).toMatchObject({
        failure: { reason: "already_terminal" },
      });
      expect(commands.filter((command) => command.wake !== undefined)).toHaveLength(1);
      expect((yield* service.listPending()).requests).toEqual([]);
      expect((yield* service.listPending({ includeTerminal: true })).requests).toHaveLength(1);
    }),
  );

  it.effect("keeps raw receipt data in mode-0600 files and honors wakeThread:false", () =>
    Effect.gen(function* () {
      const { service, commands } = yield* fixture();
      const record = yield* service.create({ ...input, threadId });
      expect(
        yield* Effect.flip(
          service.answer({
            requestId: record.requestId,
            status: "submitted",
            answers: { large: "x".repeat(65_536) },
          }),
        ),
      ).toMatchObject({ reason: "invalid_request" });
      const answer = yield* service.answer({
        requestId: record.requestId,
        status: "submitted",
        decidedVia: "inline",
        answers: { secret: "private-answer" },
        note: "private-note",
        artifacts: [{ label: "Report", path: "/private/report.txt" }],
        wakeThread: false,
      });
      const receiptPath = NodePath.join(
        stateDir,
        "operator-requests",
        "receipts",
        `${record.requestId}.json`,
      );
      expect(answer.receipt?.receiptPath).toBe(receiptPath);
      expect(JSON.stringify(commands)).not.toMatch(/private-answer|private-note/);
      expect(commands.every((command) => command.wake === undefined)).toBe(true);
      expect((yield* Effect.promise(() => NodeFSP.stat(receiptPath))).mode & 0o777).toBe(0o600);
      expect(yield* service.readPrivateReceipt(answer)).toMatchObject({
        answers: { secret: "private-answer" },
        note: "private-note",
        artifacts: [{ label: "Report", path: "/private/report.txt" }],
      });
      expect(
        yield* service.readPrivateReceipt({
          ...answer,
          receipt: { ...answer.receipt!, receiptPath: "/other/receipt.json" },
        }),
      ).toBeUndefined();
      const external = yield* service.create({ ...input, threadId });
      const externalAnswer = yield* service.answer({
        requestId: external.requestId,
        status: "submitted",
        receiptPath: "/other/receipt.json",
        note: "private-note",
        wakeThread: false,
      });
      expect(yield* service.readPrivateReceipt(externalAnswer)).toMatchObject({
        receiptPath: "/other/receipt.json",
        note: "private-note",
      });
    }),
  );

  it.effect("reloads standalone records and terminal metadata", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture();
      const pending = yield* service.create({ ...input, externalId: "standalone" });
      const fresh = (yield* fixture()).service;
      expect((yield* fresh.listPending()).requests).toEqual([pending]);
      const resolved = yield* fresh.cancel({ externalId: "standalone" });
      const again = (yield* fixture()).service;
      expect(yield* again.status({ requestId: pending.requestId })).toEqual(resolved);
      const path = NodePath.join(
        stateDir,
        "operator-requests",
        "records",
        `${pending.requestId}.json`,
      );
      expect((yield* Effect.promise(() => NodeFSP.stat(path))).mode & 0o777).toBe(0o600);
    }),
  );

  it.effect("marks an externally expired request terminal without accepting another answer", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture();
      const record = yield* service.create(input);
      const expired = yield* service.resolve({ requestId: record.requestId, status: "expired" });
      expect(expired.receipt?.status).toBe("expired");
      expect(
        (yield* Effect.flip(service.answer({ requestId: record.requestId, status: "submitted" })))
          .reason,
      ).toBe("already_terminal");
    }),
  );

  it.effect("rejects invalid preview targets and accepts an explicit loopback URL", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture();
      for (const previewUrl of [
        "javascript:alert(1)",
        "file:///tmp/preview",
        "http://localhost:8080/?token=x",
        "http://127.0.0.1:8080@evil.example/",
        "http://user@127.0.0.1:8080/",
        "http://127.0.0.1/",
        "http://127.0.0.1:0/",
        "http://127.0.0.1:8123/request",
      ]) {
        expect(
          (yield* Effect.flip(service.create({ ...input, surfaces: { previewUrl } }))).reason,
        ).toBe("invalid_request");
      }
      const previewUrl = "http://127.0.0.1:8123/request?token=test";
      expect(
        (yield* service.create({ ...input, surfaces: { previewUrl } })).surfaces?.previewUrl,
      ).toBe(previewUrl);
    }),
  );

  it.effect("resolves previews only for source-thread writers or standalone owners", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture();
      const previewUrl = "http://127.0.0.1:8123/request?token=test";
      const owner = PrincipalId.make("preview-owner");
      const writer = {
        ownerPrincipal: owner,
        allowThread: (id: ThreadId) => Effect.succeed(id === threadId),
      };
      const reader = {
        ownerPrincipal: PrincipalId.make("preview-reader"),
        allowThread: () => Effect.succeed(false),
      };
      const request = { ...input, surfaces: { previewUrl } };
      const linked = yield* service.create({ ...request, threadId }, writer);
      const standalone = yield* service.create(request, writer);
      for (const { requestId } of [linked, standalone]) {
        expect((yield* Effect.flip(service.getPreviewUrl({ requestId }, reader))).reason).toBe(
          "not_found",
        );
        expect(yield* service.getPreviewUrl({ requestId }, writer)).toBe(previewUrl);
      }
      yield* service.cancel({ requestId: linked.requestId }, writer);
      expect(
        (yield* Effect.flip(service.getPreviewUrl({ requestId: linked.requestId }, writer))).reason,
      ).toBe("already_terminal");
    }),
  );

  it.effect("rejects user privilege and desktop execution as UID zero", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture({ getUid: () => 0 });
      expect((yield* Effect.flip(service.create(input))).reason).toBe("root_forbidden");
      const record = yield* service.create({ ...desktopInput(), privilege: "elevated-external" });
      expect(
        (yield* Effect.flip(service.launchDesktop({ requestId: record.requestId }))).reason,
      ).toBe("root_forbidden");
    }),
  );

  it.effect("falls back to an allowlisted spawn only for a missing/refused socket", () =>
    Effect.gen(function* () {
      const focusSocket = vi.fn(async () => {
        throw Object.assign(new Error(), { code: "ECONNREFUSED" });
      });
      const spawnVagrant = vi.fn(async (_id: string) => {});
      const { service } = yield* fixture({
        runtimeDir: () => stateDir,
        focusSocket,
        spawnVagrant,
      });
      const record = yield* service.create(desktopInput());
      expect(yield* service.launchDesktop({ requestId: record.requestId })).toEqual({
        ok: true,
        method: "spawn",
        requestId: "vagrant-42",
      });
      expect(focusSocket).toHaveBeenCalledExactlyOnceWith(
        NodePath.join(stateDir, "vagrant", "desk.sock"),
        "vagrant-42",
        1000,
      );
      expect(spawnVagrant).toHaveBeenCalledExactlyOnceWith("vagrant-42");
      focusSocket.mockRejectedValueOnce(Object.assign(new Error(), { code: "EACCES" }));
      expect(
        (yield* Effect.flip(service.launchDesktop({ requestId: record.requestId }))).reason,
      ).toBe("desktop_unavailable");
      expect(spawnVagrant).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("does not contact the desktop for a guest participant on a locally owned thread", () =>
    Effect.gen(function* () {
      const focusSocket = vi.fn(async () => {});
      const spawnVagrant = vi.fn(async () => {});
      const { service } = yield* fixture({ runtimeDir: () => stateDir, focusSocket, spawnVagrant });
      const { requestId } = yield* service.create({ ...desktopInput(), threadId });
      const participant = {
        ownerPrincipal: PrincipalId.make("alice"),
        allowThread: () => Effect.succeed(true),
      };
      expect(yield* service.status({ requestId }, participant)).toMatchObject({
        status: "pending",
      });
      expect(yield* Effect.flip(service.launchDesktop({ requestId }, participant))).toMatchObject({
        reason: "desktop_unavailable",
      });
      expect(focusSocket).not.toHaveBeenCalled();
      expect(spawnVagrant).not.toHaveBeenCalled();
    }),
  );

  it.effect.each([true, false])(
    "rejects a same-owner cross-scope external ID (thread first: %s)",
    (threadFirst) =>
      Effect.gen(function* () {
        const { service } = yield* fixture();
        const bare = { ...input, externalId: "cross-scope" };
        const bound = { ...bare, threadId };
        yield* service.create(threadFirst ? bound : bare);
        expect(yield* Effect.flip(service.create(threadFirst ? bare : bound))).toMatchObject({
          reason: "invalid_request",
        });
        expect(
          yield* service.create(bare, { ownerPrincipal: PrincipalId.make("alice") }),
        ).toMatchObject({
          externalId: bare.externalId,
        });
      }),
  );

  it.effect("removes the staged private receipt when dispatch rejects a narrowed caller", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture({}, (command) =>
        DispatchModeLimit.pipe(
          Effect.flatMap((limit) =>
            command.wake && limit
              ? Effect.fail(
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause: "Dispatch above caller limit",
                  }),
                )
              : Effect.void,
          ),
        ),
      );
      const request = yield* service.create({ ...input, threadId });
      const resolve = service.resolve({
        requestId: request.requestId,
        threadId,
        status: "submitted",
        answers: { approved: true },
        note: "private",
      });
      yield* Effect.flip(
        resolve.pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: "approval-required",
            interactionMode: "plan",
          }),
        ),
      );
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readdir(NodePath.join(stateDir, "operator-requests", "receipts")),
        ),
      ).toEqual([]);
      expect(yield* service.status({ requestId: request.requestId })).toMatchObject({
        status: "pending",
      });
    }),
  );

  it.effect("does not contact the server desktop for a runner-owned request", () =>
    Effect.gen(function* () {
      const focusSocket = vi.fn(async () => {});
      const spawnVagrant = vi.fn(async () => {});
      const { service } = yield* fixture({
        runtimeDir: () => stateDir,
        focusSocket,
        spawnVagrant,
      }).pipe(
        Effect.provideService(
          PrincipalExecution,
          makePrincipalExecution({
            ownerOf: () => Effect.succeed("alice"),
            ownersOfPath: () => Effect.succeed([]),
            socketExists: () => Effect.succeed(true),
            socketTemplate: "/run/t3code/runner-%u.sock",
            serverEnv: {},
          }),
        ),
      );
      const { requestId } = yield* service.create({ ...desktopInput(), threadId });
      expect(yield* Effect.flip(service.launchDesktop({ requestId }))).toMatchObject({
        reason: "desktop_unavailable",
        message: expect.stringContaining("execution principal"),
      });
      expect(focusSocket).not.toHaveBeenCalled();
      expect(spawnVagrant).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    "rejects missing actions, non-Vagrant actions, unsafe IDs, and escaped socket paths",
    () =>
      Effect.gen(function* () {
        const focusSocket = vi.fn(async () => {});
        const { service } = yield* fixture({ runtimeDir: () => stateDir, focusSocket });
        for (const invalid of [
          input,
          desktopInput("../outside"),
          desktopInput("a".repeat(129)),
          {
            ...input,
            surfaces: {
              desktopAction: {
                kind: "vagrant",
                requestId: "valid",
                socketPath: `${stateDir}/vagrant/../other.sock`,
              },
            },
          } as const,
        ]) {
          const record = yield* service.create(invalid);
          expect(
            (yield* Effect.flip(service.launchDesktop({ requestId: record.requestId }))).reason,
          ).toBe("invalid_request");
        }
        const malformed = {
          ...desktopInput(),
          surfaces: { desktopAction: { kind: "other", requestId: "ok" } },
        } as unknown as OperatorRequestCreateInput;
        expect((yield* Effect.flip(service.create(malformed))).reason).toBe("invalid_request");
        expect(focusSocket).not.toHaveBeenCalled();
      }),
  );

  const uid = process.getuid?.();
  it.live.skipIf(uid === undefined || uid === 0)(
    "focuses a real private Unix socket with newline-delimited JSON",
    () =>
      Effect.gen(function* () {
        if (uid === undefined) throw new Error("Unix UID required");
        const directory = NodePath.join(stateDir, "vagrant");
        yield* Effect.promise(() => NodeFSP.mkdir(directory, { mode: 0o700 }));
        const path = NodePath.join(directory, "desk.sock");
        let request = "";
        const server = NodeNet.createServer((socket) => {
          socket.setEncoding("utf8");
          socket.on("data", (chunk: string) => {
            request += chunk;
            if (request.includes("\n")) socket.end('{"ok":true,"request_id":"vagrant-42"}\n');
          });
        });
        try {
          yield* Effect.promise(
            () => new Promise<void>((done, fail) => server.once("error", fail).listen(path, done)),
          );
          yield* Effect.promise(() => NodeFSP.chmod(path, 0o600));
          const { service } = yield* fixture({ getUid: () => uid, runtimeDir: () => stateDir });
          const record = yield* service.create(desktopInput());
          expect(yield* service.launchDesktop({ requestId: record.requestId })).toMatchObject({
            ok: true,
            method: "socket",
          });
          expect(request).toBe('{"op":"focus_request","request_id":"vagrant-42"}\n');
        } finally {
          yield* Effect.promise(() => new Promise<void>((done) => server.close(() => done())));
        }
      }),
  );
});
