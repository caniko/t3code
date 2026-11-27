// @effect-diagnostics nodeBuiltinImport:off -- This fixture binds a Unix socket and verifies file modes on disk.
import {
  isOperatorRequestTerminalStatus,
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

function fixture(desktop: OperatorRequestDesktopRuntime = {}) {
  return Effect.gen(function* () {
    const created = yield* Deferred.make<void>();
    const commands: Command[] = [];
    const cards = new Map<string, Card>();
    const service = yield* make({
      stateDir,
      desktop: { getUid: () => 1000, ...desktop },
      projection: {
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
      yield* TestClock.setTime(Date.parse(expiresAt) + 1);
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
      const answer = yield* service.answer({
        requestId: record.requestId,
        status: "submitted",
        decidedVia: "inline",
        answers: { secret: "private-answer", large: "blob".repeat(32_000) },
        note: "private-note",
        wakeThread: false,
      });
      const receiptPath = NodePath.join(
        stateDir,
        "operator-requests",
        "receipts",
        `${record.requestId}.json`,
      );
      expect(answer.receipt?.receiptPath).toBe(receiptPath);
      expect(JSON.stringify(commands)).not.toMatch(/private-answer|private-note|blobblob/);
      expect(commands.every((command) => command.wake === undefined)).toBe(true);
      expect((yield* Effect.promise(() => NodeFSP.stat(receiptPath))).mode & 0o777).toBe(0o600);
      expect(
        JSON.parse(yield* Effect.promise(() => NodeFSP.readFile(receiptPath, "utf8"))),
      ).toMatchObject({
        answers: { secret: "private-answer", large: "blob".repeat(32_000) },
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
