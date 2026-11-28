// @effect-diagnostics nodeBuiltinImport:off -- POSIX ownership checks, private atomic writes, and detached Unix desktop launch.
import {
  CommandId,
  DEFAULT_PRINCIPAL_ID,
  isOperatorRequestDue,
  isOperatorRequestTerminalStatus,
  MessageId,
  OperatorRequestCreateInput,
  OperatorRequestError,
  OperatorRequestRecord,
  PrincipalId,
  type OperatorRequestAnswerInput,
  type OperatorRequestCancelInput,
  type OperatorRequestFailureReason,
  type OperatorRequestLaunchDesktopInput,
  type OperatorRequestLaunchDesktopResult,
  type OperatorRequestListPendingInput,
  type OperatorRequestListPendingResult,
  OperatorRequestReceipt,
  type OperatorRequestReceiptMetadata,
  type OperatorRequestResolveInput,
  type OperatorRequestStatusInput,
  type OrchestrationV2AppThread,
  type OrchestrationV2InternalCommand,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import { ServerConfig } from "../config.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import {
  ProjectionStoreV2,
  type ProjectionStoreV2Error,
} from "../orchestration-v2/ProjectionStore.ts";
import { PrincipalExecution } from "../runner/PrincipalExecution.ts";

type RecordCommand = Extract<OrchestrationV2InternalCommand, { type: "operator_request.record" }>;
type RequestEffect<A> = Effect.Effect<A, OperatorRequestError>;
type RequestScope = {
  /** Null disables standalone access; omitted preserves legacy local ownership. */
  readonly ownerPrincipal?: PrincipalId | null;
  readonly allowThread?: (threadId: ThreadId) => Effect.Effect<boolean, { readonly _tag: string }>;
};
type OperatorRequestService = {
  readonly create: (
    input: OperatorRequestCreateInput,
    scope?: RequestScope,
  ) => RequestEffect<OperatorRequestRecord>;
  readonly resolve: (
    input: OperatorRequestResolveInput,
    scope?: RequestScope,
  ) => RequestEffect<OperatorRequestRecord>;
  readonly answer: (
    input: OperatorRequestAnswerInput,
    scope?: RequestScope,
  ) => RequestEffect<OperatorRequestRecord>;
  readonly cancel: (
    input: OperatorRequestCancelInput,
    scope?: RequestScope,
  ) => RequestEffect<OperatorRequestRecord>;
  readonly status: (
    input: OperatorRequestStatusInput,
    scope?: RequestScope,
  ) => RequestEffect<OperatorRequestRecord>;
  readonly readPrivateReceipt: (
    record: OperatorRequestRecord,
  ) => RequestEffect<OperatorRequestReceipt | undefined>;
  readonly getPreviewUrl: (
    input: OperatorRequestStatusInput,
    scope: RequestScope,
  ) => RequestEffect<string | null>;
  readonly listPending: (
    input?: OperatorRequestListPendingInput,
    scope?: RequestScope,
  ) => RequestEffect<OperatorRequestListPendingResult>;
  readonly launchDesktop: (
    input: OperatorRequestLaunchDesktopInput,
    scope?: RequestScope,
  ) => RequestEffect<OperatorRequestLaunchDesktopResult>;
};

export class OperatorRequests extends Context.Service<OperatorRequests, OperatorRequestService>()(
  "t3/operatorRequests/OperatorRequests",
) {}

export interface OperatorRequestDesktopRuntime {
  readonly getUid?: () => number | undefined;
  readonly runtimeDir?: () => string | undefined;
  readonly focusSocket?: (path: string, requestId: string, uid: number) => Promise<void>;
  readonly spawnVagrant?: (requestId: string) => Promise<void>;
}

const failure = (reason: OperatorRequestFailureReason, message: string) =>
  new OperatorRequestError({ reason, message });
const storeFailure = () =>
  failure("storage_failed", "Could not read or write the operator request.");
const alreadyTerminal = () => failure("already_terminal", "Operator request is already terminal.");
const errno = (cause: unknown) => (cause as NodeJS.ErrnoException | undefined)?.code;
const safeId = (id: string) => /^[A-Za-z0-9._:-]{1,128}$/.test(id) && id !== "." && id !== "..";
const standaloneJson = Schema.fromJsonString(
  Schema.Struct({ ...OperatorRequestRecord.fields, ownerPrincipal: Schema.optional(PrincipalId) }),
);
const decodeStandalone = Schema.decodeUnknownSync(standaloneJson);
const encodeStandalone = Schema.encodeSync(standaloneJson);
const standaloneOwner = (scope?: RequestScope) =>
  scope?.ownerPrincipal === undefined ? DEFAULT_PRINCIPAL_ID : scope.ownerPrincipal;
const decodeCreate = Schema.decodeUnknownSync(OperatorRequestCreateInput);
const receiptJson = Schema.fromJsonString(OperatorRequestReceipt);
const decodeReceipt = Schema.decodeUnknownSync(receiptJson);
const encodeReceipt = Schema.encodeSync(receiptJson);
const MAX_PRIVATE_RECEIPT_BYTES = 64 * 1024;

function validPreviewUrl(value: string): boolean {
  if (!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\//.test(value) || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.hostname === "127.0.0.1" &&
      !url.username &&
      !url.password &&
      url.port !== "0" &&
      Boolean(url.searchParams.get("token")?.trim())
    );
  } catch {
    return false;
  }
}

async function writePrivateFile(path: string, data: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodePath.dirname(path), ".write-"));
  const temporary = NodePath.join(directory, "record.json");
  try {
    await NodeFSP.writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    await NodeFSP.rename(temporary, path);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

async function focusSocket(path: string, requestId: string, uid: number): Promise<void> {
  const directory = NodePath.dirname(path);
  const parent = await NodeFSP.lstat(directory);
  if (
    !parent.isDirectory() ||
    parent.uid !== uid ||
    (parent.mode & 0o022) !== 0 ||
    (await NodeFSP.realpath(directory)) !== directory
  ) {
    throw new Error("Untrusted Vagrant socket directory.");
  }
  const info = await NodeFSP.lstat(path);
  if (!info.isSocket() || info.uid !== uid || (info.mode & 0o777) !== 0o600) {
    throw new Error("Untrusted Vagrant socket.");
  }
  await new Promise<void>((done, fail) => {
    const socket = NodeNet.createConnection(path);
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5_000);
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ op: "focus_request", request_id: requestId })}\n`),
    );
    socket.once("error", fail);
    socket.once("end", () => fail(new Error("Vagrant closed the socket.")));
    socket.once("timeout", () => socket.destroy(new Error("Vagrant socket timed out.")));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response.length > 4_096) {
        socket.destroy(new Error("Vagrant response exceeded its limit."));
        return;
      }
      const end = response.indexOf("\n");
      if (end < 0) return;
      try {
        const result: unknown = JSON.parse(response.slice(0, end));
        if (
          typeof result !== "object" ||
          result === null ||
          !("ok" in result) ||
          result.ok !== true ||
          !("request_id" in result) ||
          result.request_id !== requestId
        ) {
          throw new Error("Vagrant refused the request.");
        }
        done();
      } catch (error) {
        fail(error);
      } finally {
        socket.destroy();
      }
    });
  });
}

function spawnVagrant(requestId: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = NodeChildProcess.spawn("vagrant", ["--request", requestId], {
      detached: true,
      shell: false,
      stdio: "ignore",
    });
    child.once("error", fail);
    child.once("spawn", () => {
      child.unref();
      done();
    });
  });
}

export const make = Effect.fn("OperatorRequests.make")(function* (options: {
  readonly stateDir: string;
  readonly projection: Pick<ProjectionStoreV2["Service"], "listOperatorRequests"> & {
    readonly getThread: (
      threadId: ThreadId,
    ) => Effect.Effect<Pick<OrchestrationV2AppThread, "ownerPrincipal">, ProjectionStoreV2Error>;
  };
  readonly orchestrator: Pick<OrchestratorV2["Service"], "dispatch"> &
    Partial<Pick<OrchestratorV2["Service"], "streamStoredEventsFrom">>;
  readonly desktop?: OperatorRequestDesktopRuntime;
}) {
  const { projection, orchestrator, desktop } = options;
  const random = yield* SecureRandom.SecureRandom;
  const execution = yield* PrincipalExecution;
  const getUid = desktop?.getUid ?? (() => process.getuid?.());
  const storage = NodePath.join(options.stateDir, "operator-requests");
  const recordsDir = NodePath.join(storage, "records");
  const standalone = new Map<
    string,
    { record: OperatorRequestRecord; ownerPrincipal: PrincipalId }
  >();
  const waiters = new Map<
    string,
    {
      result: Deferred.Deferred<OperatorRequestRecord>;
      fallback?: Effect.Effect<unknown, OperatorRequestError>;
    }
  >();
  const locks = yield* KeyedLock.make<string>();
  const creationLock = yield* Semaphore.make(1);
  const io = <A>(action: () => Promise<A>) =>
    Effect.tryPromise({ try: action, catch: storeFailure });
  // Standalone records are local to this server instance, just like its projection DB.
  for (const record of yield* io(async () => {
    const files = await NodeFSP.readdir(recordsDir).catch((cause: unknown) => {
      if (errno(cause) === "ENOENT") return [];
      throw cause;
    });
    return Promise.all(
      files
        .filter((name) => name.endsWith(".json"))
        .map(async (name) =>
          decodeStandalone(await NodeFSP.readFile(NodePath.join(recordsDir, name), "utf8")),
        ),
    );
  })) {
    const { ownerPrincipal = DEFAULT_PRINCIPAL_ID, ...request } = record;
    if (request.threadId === undefined && safeId(request.requestId))
      standalone.set(request.requestId, { record: request, ownerPrincipal });
  }

  type Lookup = OperatorRequestStatusInput & { readonly includeTerminal?: boolean | undefined };
  const matchingStandalone = (input: Lookup, owner: PrincipalId | null) =>
    input.threadId !== undefined || owner === null
      ? []
      : [...standalone.values()]
          .filter(
            ({ record, ownerPrincipal }) =>
              ownerPrincipal === owner &&
              (input.includeTerminal === true || !isOperatorRequestTerminalStatus(record.status)) &&
              (input.requestId === undefined || record.requestId === input.requestId) &&
              (input.turnItemId === undefined || record.turnItemId === input.turnItemId) &&
              (input.externalId === undefined || record.externalId === input.externalId),
          )
          .map(({ record }) => record);

  const matching = Effect.fnUntraced(function* (input: Lookup, scope?: RequestScope) {
    const items = yield* projection.listOperatorRequests(input);
    const allowThread = scope?.allowThread;
    const allowed =
      allowThread === undefined
        ? undefined
        : new Set(
            yield* Effect.filter([...new Set(items.map((item) => item.threadId))], allowThread),
          );
    return [
      ...items
        .filter((item) => allowed === undefined || allowed.has(item.threadId))
        .map((item) => ({ ...item.request, threadId: item.threadId, turnItemId: item.id })),
      ...matchingStandalone(input, standaloneOwner(scope)),
    ];
  }, Effect.mapError(storeFailure));

  const find = Effect.fn("OperatorRequests.find")(function* (
    input: OperatorRequestStatusInput,
    scope?: RequestScope,
  ) {
    if (
      input.requestId === undefined &&
      input.turnItemId === undefined &&
      input.externalId === undefined
    ) {
      return yield* failure("invalid_request", "Supply a requestId, turnItemId, or externalId.");
    }
    const [record, duplicate] = yield* matching({ ...input, includeTerminal: true }, scope);
    if (duplicate !== undefined)
      return yield* failure("invalid_request", "Operator request identifier is ambiguous.");
    if (record === undefined) return yield* failure("not_found", "Operator request was not found.");
    return record;
  });

  const persist = Effect.fn("OperatorRequests.persist")(function* (
    record: OperatorRequestRecord,
    wake?: RecordCommand["wake"],
    owner?: PrincipalId,
    wakeOnly?: true,
    cleanupRejectedReceipt: Effect.Effect<void> = Effect.void,
  ) {
    if (record.threadId !== undefined && record.turnItemId !== undefined) {
      const { sequence } = yield* orchestrator
        .dispatch({
          type: "operator_request.record",
          commandId: CommandId.make(
            `operator-request:${record.requestId}:${yield* random.uuidV4()}`,
          ),
          threadId: record.threadId,
          turnItemId: record.turnItemId,
          request: record,
          ...(wake === undefined ? {} : { wake }),
          ...(wakeOnly === undefined ? {} : { wakeOnly }),
        })
        .pipe(
          Effect.onError(() => cleanupRejectedReceipt),
          Effect.mapError(storeFailure),
        );
      return {
        record: yield* find({ threadId: record.threadId, turnItemId: record.turnItemId }),
        sequence,
      };
    }
    const ownerPrincipal =
      standalone.get(record.requestId)?.ownerPrincipal ?? owner ?? DEFAULT_PRINCIPAL_ID;
    yield* io(() =>
      writePrivateFile(
        NodePath.join(recordsDir, `${record.requestId}.json`),
        encodeStandalone({ ...record, ownerPrincipal }),
      ),
    ).pipe(Effect.onError(() => cleanupRejectedReceipt));
    standalone.set(record.requestId, { record, ownerPrincipal });
    return { record, sequence: undefined };
  });

  const expire = Effect.fnUntraced(function* (record: OperatorRequestRecord) {
    const now = yield* DateTime.now;
    if (!isOperatorRequestDue(record, DateTime.toEpochMillis(now))) return record;
    const decidedAt = DateTime.formatIso(now);
    const { record: saved } = yield* persist({
      ...record,
      status: "expired",
      updatedAt: decidedAt,
      receipt: { status: "expired", decidedAt, decidedVia: "external" },
    });
    const waiter = waiters.get(record.requestId);
    if (waiter !== undefined) yield* Deferred.succeed(waiter.result, saved);
    return saved;
  });

  const refresh = Effect.fnUntraced(function* (
    record: OperatorRequestRecord,
    scope?: RequestScope,
  ) {
    const now = yield* DateTime.now;
    if (!isOperatorRequestDue(record, DateTime.toEpochMillis(now))) return record;
    return yield* locks.withLock(
      record.requestId,
      find({ requestId: record.requestId, threadId: record.threadId }, scope).pipe(
        Effect.flatMap(expire),
        Effect.uninterruptible,
      ),
    );
  });

  const status: OperatorRequestService["status"] = Effect.fn("OperatorRequests.status")(
    (input, scope) => find(input, scope).pipe(Effect.flatMap((record) => refresh(record, scope))),
  );

  const getPreviewUrl: OperatorRequestService["getPreviewUrl"] = Effect.fn(
    "OperatorRequests.getPreviewUrl",
  )(function* (input, scope) {
    const record = yield* status(input, scope);
    if (isOperatorRequestTerminalStatus(record.status)) return yield* alreadyTerminal();
    const url = record.surfaces?.previewUrl;
    return url !== undefined && validPreviewUrl(url) ? url : null;
  });

  const privateReceiptPath = (requestId: string) =>
    NodePath.join(storage, "receipts", `${requestId}.json`);

  const readPrivateReceipt: OperatorRequestService["readPrivateReceipt"] = Effect.fn(
    "OperatorRequests.readPrivateReceipt",
  )(function* (record) {
    const metadata = record.receipt;
    if (!safeId(record.requestId) || metadata === undefined) return undefined;
    const path = privateReceiptPath(record.requestId);
    return yield* io(async () => {
      const file = await NodeFSP.open(path, "r").catch((cause: unknown) => {
        if (errno(cause) !== "ENOENT") throw cause;
      });
      if (file === undefined) return undefined;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_PRIVATE_RECEIPT_BYTES) return undefined;
        const receipt = decodeReceipt(await file.readFile("utf8"));
        return receipt.decidedAt === metadata.decidedAt &&
          receipt.receiptPath === metadata.receiptPath &&
          receipt.status === metadata.status
          ? receipt
          : undefined;
      } finally {
        await file.close();
      }
    });
  });

  const decide = Effect.fn("OperatorRequests.decide")(function* (
    record: OperatorRequestRecord,
    input: OperatorRequestResolveInput,
  ) {
    if (record.privilege === "user" && getUid() === 0) {
      return yield* failure("root_forbidden", "User operator requests cannot run as root.");
    }
    const decidedAt = DateTime.formatIso(yield* DateTime.now);
    const localReceiptPath = privateReceiptPath(record.requestId);
    const receiptPath = input.receiptPath ?? localReceiptPath;
    // Only bounded, explicitly named metadata enters the journal or RPC results.
    const receipt: OperatorRequestReceiptMetadata = {
      status: input.status,
      decidedAt,
      decidedVia: input.decidedVia ?? "external",
      receiptPath: receiptPath.slice(0, 4096),
      ...(input.summary === undefined ? {} : { summary: input.summary.slice(0, 512) }),
      ...(input.actionId === undefined ? {} : { actionId: input.actionId.slice(0, 128) }),
      ...(input.artifacts === undefined
        ? {}
        : {
            artifacts: input.artifacts.slice(0, 16).map((artifact) => ({
              label: artifact.label.slice(0, 128),
              path: artifact.path.slice(0, 4096),
              ...(artifact.sha256 === undefined ? {} : { sha256: artifact.sha256.slice(0, 64) }),
            })),
          }),
    };
    const writeLocalReceipt =
      input.receiptPath === undefined ||
      input.answers !== undefined ||
      input.note !== undefined ||
      input.artifacts !== undefined;
    if (writeLocalReceipt) {
      const full: OperatorRequestReceipt = {
        ...receipt,
        ...(input.answers === undefined ? {} : { answers: input.answers }),
        ...(input.note === undefined ? {} : { note: input.note }),
      };
      const data = yield* Effect.try({
        try: () => encodeReceipt(full),
        catch: () => failure("invalid_request", "Private operator receipt must be JSON."),
      });
      if (Buffer.byteLength(data) > MAX_PRIVATE_RECEIPT_BYTES)
        return yield* failure("invalid_request", "Private operator receipt exceeds 64 KiB.");
      yield* io(() => writePrivateFile(localReceiptPath, data));
    }
    const summary = `Operator request ${record.requestId} was ${input.status}.`;
    const waiter = waiters.get(record.requestId);
    const wake: RecordCommand["wake"] =
      input.status === "expired" || input.wakeThread === false || record.threadId === undefined
        ? undefined
        : {
            messageId: MessageId.make(`message:operator-request:${record.requestId}`),
            text: summary,
            notification: {
              source: { kind: "background_task" },
              outcome: input.status === "submitted" ? "completed" : "cancelled",
              summary,
            },
          };
    const { record: saved } = yield* persist(
      { ...record, status: input.status, updatedAt: decidedAt, receipt },
      waiter === undefined ? wake : undefined,
      undefined,
      undefined,
      writeLocalReceipt
        ? io(() => NodeFSP.rm(localReceiptPath, { force: true })).pipe(Effect.ignore)
        : Effect.void,
    );
    if (
      saved.receipt?.receiptPath !== receipt.receiptPath ||
      saved.receipt?.decidedAt !== decidedAt
    ) {
      if (writeLocalReceipt)
        yield* io(() => NodeFSP.rm(localReceiptPath, { force: true })).pipe(Effect.ignore);
      return yield* alreadyTerminal();
    }
    if (waiter !== undefined) {
      if (wake !== undefined) {
        const limit = yield* DispatchModeLimit;
        waiter.fallback = persist(saved, wake, undefined, true).pipe(
          Effect.provideService(DispatchModeLimit, limit),
        );
      }
      yield* Deferred.succeed(waiter.result, saved);
    }
    return saved;
  });

  const resolve: OperatorRequestService["resolve"] = Effect.fn("OperatorRequests.resolve")(
    function* (input, scope) {
      const record = yield* find(input, scope);
      return yield* locks.withLock(
        record.requestId,
        Effect.uninterruptible(
          Effect.gen(function* () {
            const current = yield* find(
              {
                requestId: record.requestId,
                threadId: record.threadId,
              },
              scope,
            ).pipe(Effect.flatMap(expire));
            if (isOperatorRequestTerminalStatus(current.status)) return yield* alreadyTerminal();
            return yield* decide(current, input);
          }),
        ),
      );
    },
  );

  const create: OperatorRequestService["create"] = Effect.fn("OperatorRequests.create")(
    function* (input, scope) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const validated = yield* Effect.try({
            try: () => decodeCreate(input),
            catch: () => failure("invalid_request", "Invalid operator request."),
          });
          const owner = standaloneOwner(scope);
          if (validated.threadId === undefined && owner === null) {
            return yield* failure(
              "invalid_request",
              "Standalone operator requests are not allowed.",
            );
          }
          if (validated.privilege === "user" && getUid() === 0) {
            return yield* failure("root_forbidden", "User operator requests cannot run as root.");
          }
          const previewUrl = validated.surfaces?.previewUrl;
          if (previewUrl !== undefined && !validPreviewUrl(previewUrl)) {
            return yield* failure(
              "invalid_request",
              "Preview URL must use http://127.0.0.1:<port>/ with a request token.",
            );
          }
          const requestId = validated.requestId ?? (yield* random.uuidV4());
          if (!safeId(requestId))
            return yield* failure("invalid_request", "Invalid operator request ID.");
          if (
            validated.threadId === undefined &&
            (validated.runId !== undefined || validated.nodeId !== undefined)
          ) {
            return yield* failure("invalid_request", "Run and node require a thread.");
          }
          const { record, waiter, sequence } = yield* creationLock.withPermit(
            Effect.gen(function* () {
              const lookup = {
                ...(validated.externalId === undefined
                  ? { requestId }
                  : { externalId: validated.externalId }),
                includeTerminal: true,
              };
              if (validated.externalId !== undefined) {
                const threadOwner = (threadId: ThreadId) =>
                  projection.getThread(threadId).pipe(
                    Effect.map((thread) => thread.ownerPrincipal ?? DEFAULT_PRINCIPAL_ID),
                    Effect.mapError(storeFailure),
                  );
                const conflict =
                  validated.threadId === undefined
                    ? owner !== null &&
                      Option.isSome(
                        yield* Effect.findFirst(
                          yield* projection
                            .listOperatorRequests(lookup)
                            .pipe(Effect.mapError(storeFailure)),
                          (item) =>
                            threadOwner(item.threadId).pipe(
                              Effect.map((principal) => principal === owner),
                            ),
                        ),
                      )
                    : matchingStandalone(lookup, yield* threadOwner(validated.threadId)).length !==
                      0;
                if (conflict)
                  return yield* failure(
                    "invalid_request",
                    "Operator request identifier is in use.",
                  );
              }
              const [existing] =
                validated.threadId === undefined
                  ? matchingStandalone(lookup, owner)
                  : yield* matching(lookup, { ownerPrincipal: null });
              if (existing !== undefined) {
                if (existing.threadId !== validated.threadId) {
                  return yield* failure(
                    "invalid_request",
                    "Operator request identifier is in use.",
                  );
                }
                return { record: existing, waiter: undefined, sequence: undefined };
              }
              const turnItemId =
                validated.turnItemId ??
                (validated.threadId === undefined
                  ? undefined
                  : TurnItemId.make(`operator-request:${requestId}`));
              if (
                turnItemId !== undefined &&
                (yield* matching({ turnItemId, includeTerminal: true }, { ownerPrincipal: null }))
                  .length > 0
              ) {
                return yield* failure(
                  "invalid_request",
                  "Operator request turn item ID is in use.",
                );
              }
              const conflicts = yield* matching(
                { requestId, includeTerminal: true },
                { ownerPrincipal: null },
              );
              if (standalone.has(requestId) || conflicts.length !== 0)
                return yield* failure("invalid_request", "Operator request ID is in use.");
              const now = DateTime.formatIso(yield* DateTime.now);
              const waitPolicy = validated.waitPolicy ?? { mode: "async" };
              const waiter =
                waitPolicy.mode === "sync"
                  ? { result: yield* Deferred.make<OperatorRequestRecord>() }
                  : undefined;
              if (waiter !== undefined) waiters.set(requestId, waiter);
              const saved = yield* persist(
                {
                  ...validated,
                  requestId,
                  ...(turnItemId === undefined ? {} : { turnItemId }),
                  waitPolicy,
                  status: "pending",
                  createdAt: now,
                  updatedAt: now,
                },
                undefined,
                owner ?? undefined,
              ).pipe(Effect.onError(() => Effect.sync(() => waiters.delete(requestId))));
              return { ...saved, waiter };
            }),
          );
          if (waiter === undefined) return record;
          if (isOperatorRequestTerminalStatus(record.status)) {
            waiters.delete(requestId);
            return record;
          }
          const result = Deferred.await(waiter.result);
          // A stop/archive closes the card without calling this service; replay from the create receipt.
          const events =
            sequence === undefined || record.threadId === undefined
              ? undefined
              : orchestrator.streamStoredEventsFrom?.({
                  afterSequence: sequence,
                  threadId: record.threadId,
                  eventType: "turn-item.updated",
                });
          const wait =
            events === undefined
              ? result
              : Effect.raceFirst(
                  result,
                  events.pipe(
                    Stream.filterMap((stored) => {
                      const event = stored.event;
                      return event.type === "turn-item.updated" &&
                        event.payload.type === "operator_request" &&
                        event.payload.request.requestId === requestId &&
                        isOperatorRequestTerminalStatus(event.payload.request.status)
                        ? Result.succeed(event.payload.request)
                        : Result.fail(undefined);
                    }),
                    Stream.runHead,
                    Effect.option,
                    Effect.map(Option.flatten),
                    Effect.flatMap(
                      Option.match({ onSome: Effect.succeed, onNone: () => Effect.never }),
                    ),
                  ),
                );
          const syncTimeoutMs = record.waitPolicy.syncTimeoutMs ?? 180_000;
          const timeoutMs =
            record.expiresAt === undefined
              ? syncTimeoutMs
              : Math.min(
                  syncTimeoutMs,
                  Math.max(
                    0,
                    Date.parse(record.expiresAt) - DateTime.toEpochMillis(yield* DateTime.now),
                  ),
                );
          return yield* restore(wait.pipe(Effect.timeoutOption(timeoutMs))).pipe(
            Effect.flatMap(
              Option.match({
                onSome: (resolved) => {
                  waiters.delete(requestId);
                  return Effect.succeed(resolved);
                },
                onNone: () =>
                  locks.withLock(
                    requestId,
                    Effect.uninterruptible(
                      Effect.gen(function* () {
                        const current = yield* find(
                          { requestId, threadId: record.threadId },
                          scope,
                        ).pipe(Effect.flatMap(expire));
                        if (isOperatorRequestTerminalStatus(current.status)) {
                          waiters.delete(requestId);
                          return current;
                        }
                        if (record.waitPolicy.onTimeout === "cancel") {
                          return yield* decide(current, { status: "cancelled", wakeThread: false });
                        }
                        const { record: updated } = yield* persist({
                          ...current,
                          status: "pending",
                          demotedToAsync: true,
                          updatedAt: DateTime.formatIso(yield* DateTime.now),
                        });
                        waiters.delete(requestId);
                        return updated;
                      }),
                    ),
                  ),
              }),
            ),
            Effect.ensuring(
              locks.withLock(
                requestId,
                Effect.suspend(() => {
                  const abandoned = waiters.get(requestId);
                  waiters.delete(requestId);
                  return (
                    abandoned?.fallback?.pipe(
                      Effect.catch((error) =>
                        Effect.logWarning("Could not wake abandoned operator request", {
                          requestId,
                          error,
                        }),
                      ),
                      Effect.asVoid,
                    ) ?? Effect.void
                  );
                }),
              ),
            ),
          );
        }),
      );
    },
  );

  const launchDesktop: OperatorRequestService["launchDesktop"] = Effect.fn(
    "OperatorRequests.launchDesktop",
  )(function* (input, scope) {
    const principalMismatch = failure(
      "desktop_unavailable",
      "The request's execution principal does not match the local desktop user.",
    );
    if (standaloneOwner(scope) !== DEFAULT_PRINCIPAL_ID) return yield* principalMismatch;
    const uid = getUid();
    if (uid === undefined || uid === 0) {
      return yield* failure("root_forbidden", "Desktop actions require a non-root Unix user.");
    }
    const record = yield* status(input, scope);
    if (isOperatorRequestTerminalStatus(record.status)) return yield* alreadyTerminal();
    if (record.threadId !== undefined) {
      const runner = yield* execution
        .runnerFor(record.threadId)
        .pipe(Effect.mapError(() => principalMismatch));
      if (runner !== undefined) return yield* principalMismatch;
    } else if (standalone.get(record.requestId)?.ownerPrincipal !== DEFAULT_PRINCIPAL_ID) {
      return yield* principalMismatch;
    }
    const action = record.surfaces?.desktopAction;
    if (action?.kind !== "vagrant" || !safeId(action.requestId)) {
      return yield* failure("invalid_request", "A valid Vagrant desktop action is required.");
    }
    const runtimeDir = (desktop?.runtimeDir ?? (() => process.env.XDG_RUNTIME_DIR))();
    const directory =
      runtimeDir !== undefined && NodePath.isAbsolute(runtimeDir)
        ? NodePath.resolve(runtimeDir, "vagrant")
        : undefined;
    const path =
      action.socketPath ??
      (directory === undefined ? undefined : NodePath.join(directory, "desk.sock"));
    if (
      path === undefined ||
      !NodePath.isAbsolute(path) ||
      NodePath.resolve(path) !== path ||
      NodePath.dirname(path) !== directory
    ) {
      return yield* failure(
        "invalid_request",
        "Vagrant socket must be under XDG_RUNTIME_DIR/vagrant.",
      );
    }
    return yield* Effect.tryPromise({
      try: async (): Promise<OperatorRequestLaunchDesktopResult> => {
        try {
          await (desktop?.focusSocket ?? focusSocket)(path, action.requestId, uid);
          return { ok: true, method: "socket", requestId: action.requestId };
        } catch (cause) {
          if (errno(cause) !== "ENOENT" && errno(cause) !== "ECONNREFUSED") throw cause;
          await (desktop?.spawnVagrant ?? spawnVagrant)(action.requestId);
          return { ok: true, method: "spawn", requestId: action.requestId };
        }
      },
      catch: () => failure("desktop_unavailable", "Could not focus or launch the Vagrant request."),
    });
  });

  const cancel: OperatorRequestService["cancel"] = Effect.fn("OperatorRequests.cancel")(
    (input, scope) =>
      resolve(
        {
          ...input,
          status: "cancelled",
          ...(input.reason === undefined ? {} : { summary: input.reason }),
        },
        scope,
      ),
  );
  const listPending: OperatorRequestService["listPending"] = Effect.fn(
    "OperatorRequests.listPending",
  )((input = {}, scope) =>
    matching(input, scope).pipe(
      Effect.flatMap((records) => Effect.forEach(records, (record) => refresh(record, scope))),
      Effect.map((records) => ({
        requests: records
          .filter(
            (record) =>
              input.includeTerminal === true || !isOperatorRequestTerminalStatus(record.status),
          )
          .filter((record) => input.kind === undefined || record.kind === input.kind)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      })),
    ),
  );
  return OperatorRequests.of({
    create,
    status,
    readPrivateReceipt,
    getPreviewUrl,
    resolve,
    answer: resolve,
    cancel,
    listPending,
    launchDesktop,
  });
});

export const layer = Layer.effect(
  OperatorRequests,
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    const projection = yield* ProjectionStoreV2;
    const orchestrator = yield* OrchestratorV2;
    return yield* make({ stateDir, projection, orchestrator });
  }).pipe(Effect.orDie),
);
