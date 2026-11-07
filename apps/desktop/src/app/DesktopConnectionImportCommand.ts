// @effect-diagnostics nodeBuiltinImport:off -- Imported catalog ownership, mode, and bounded reads need one file descriptor at the Node adapter boundary.
import * as NodeFSP from "node:fs/promises";

import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  mergeConnectionCatalogDocument,
  persistedTargetIdentity,
} from "@t3tools/client-runtime/platform";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";
import * as DesktopUserData from "./DesktopUserData.ts";

const IMPORT_CONNECTIONS_FLAG = "--import-connections";
export const MAX_IMPORT_BYTES = 1024 * 1024;

const ConnectionCatalogDocumentJson = Schema.fromJsonString(ConnectionCatalogDocument);
const decodeConnectionCatalogDocumentJson = Schema.decodeEffect(ConnectionCatalogDocumentJson);
const encodeConnectionCatalogDocumentJson = Schema.encodeEffect(ConnectionCatalogDocumentJson);

export type ImportConnectionsArgument =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Invalid"; readonly message: string }
  | { readonly _tag: "Present"; readonly path: string };

export function readImportConnectionsArgument(args: readonly string[]): ImportConnectionsArgument {
  if (args.some((arg) => arg.startsWith(`${IMPORT_CONNECTIONS_FLAG}=`))) {
    return {
      _tag: "Invalid",
      message: `Pass the file separately: ${IMPORT_CONNECTIONS_FLAG} FILE.`,
    };
  }
  const indexes = args.flatMap((arg, index) => (arg === IMPORT_CONNECTIONS_FLAG ? [index] : []));
  if (indexes.length === 0) return { _tag: "Absent" };
  if (indexes.length > 1) {
    return { _tag: "Invalid", message: `Pass ${IMPORT_CONNECTIONS_FLAG} once.` };
  }
  const filePath = args[(indexes[0] ?? 0) + 1];
  if (filePath === undefined || filePath.startsWith("--")) {
    return { _tag: "Invalid", message: `${IMPORT_CONNECTIONS_FLAG} needs a file path.` };
  }
  return { _tag: "Present", path: filePath };
}

const DesktopConnectionImportReason = Schema.Literals([
  "invalid-argument",
  "app-running",
  "unreadable-file",
  "not-a-regular-file",
  "insecure-file-owner",
  "insecure-file-permissions",
  "oversized-file",
  "invalid-document",
  "duplicate-identity",
  "inconsistent-document",
  "unreadable-catalog",
  "secure-storage-unavailable",
  "write-failed",
]);

export class DesktopConnectionImportError extends Schema.TaggedError<DesktopConnectionImportError>()(
  "DesktopConnectionImportError",
  {
    reason: DesktopConnectionImportReason,
    path: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid-argument":
        return `Use ${IMPORT_CONNECTIONS_FLAG} FILE with one connection catalog file.`;
      case "app-running":
        return "T3 Code is already running. Quit it before importing saved connections.";
      case "unreadable-file":
        return `Could not read ${this.path ?? "the connection catalog file"}.`;
      case "not-a-regular-file":
        return `${this.path ?? "The connection catalog file"} is not a regular file.`;
      case "insecure-file-owner":
        return `${this.path ?? "The connection catalog file"} is owned by another user.`;
      case "insecure-file-permissions":
        return `${this.path ?? "The connection catalog file"} is readable or writable by another user.`;
      case "oversized-file":
        return `${this.path ?? "The connection catalog file"} is larger than 1 MiB.`;
      case "invalid-document":
        return `${this.path ?? "The connection catalog file"} is not a valid T3 Code connection catalog.`;
      case "duplicate-identity":
        return `${this.path ?? "The connection catalog file"} contains duplicate connection entries.`;
      case "inconsistent-document":
        return `${this.path ?? "The connection catalog file"} contains inconsistent connection entries.`;
      case "unreadable-catalog":
        return "Could not read the existing desktop connection catalog.";
      case "secure-storage-unavailable":
        return "T3 Code secure storage is unavailable, so no connections were imported.";
      case "write-failed":
        return "Could not save the imported connections.";
    }
  }
}

export const prepare = Effect.gen(function* () {
  // Pre-ready switches must be in place before Electron selects a keyring backend.
  yield* DesktopPreReadyPlatform.DesktopPreReadyElectronOptions;
  const electronApp = yield* ElectronApp.ElectronApp;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const userDataPath = yield* DesktopUserData.resolveUserDataPath(environment).pipe(
    Effect.provide(DesktopPreReadyFileSystem.layer),
  );
  yield* electronApp.setPath("userData", userDataPath);
  // The running app's renderer keeps the catalog in memory, so refuse while it owns the lock.
  if (!(yield* electronApp.requestSingleInstanceLock)) {
    return yield* new DesktopConnectionImportError({ reason: "app-running" });
  }
  const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
  yield* identity.configure;
  yield* electronApp.whenReady;
}).pipe(Effect.withSpan("desktop.connectionImport.prepare"));

export interface DesktopConnectionImportSummary {
  readonly targets: number;
  readonly profiles: number;
  readonly credentials: number;
}

export class DesktopConnectionImportCommand extends Context.Service<
  DesktopConnectionImportCommand,
  {
    readonly importConnections: (
      filePath: string,
    ) => Effect.Effect<DesktopConnectionImportSummary, DesktopConnectionImportError>;
  }
>()("@t3tools/desktop/app/DesktopConnectionImportCommand") {}

type ImportedDocumentProblem = "duplicate-identity" | "inconsistent-document";

function targetProfileMatches(
  target: ConnectionCatalogDocument["targets"][number],
  profile: ConnectionCatalogDocument["profiles"][number],
): boolean {
  if (target._tag === "RelayConnectionTarget") return false;
  if (target.environmentId !== profile.environmentId) return false;
  return target._tag === "BearerConnectionTarget"
    ? profile._tag === "BearerConnectionProfile"
    : profile._tag === "SshConnectionProfile";
}

function importedDocumentProblem(
  document: ConnectionCatalogDocument,
): ImportedDocumentProblem | null {
  const targetIdentities = new Set<string>();
  const targetsByConnectionId = new Map<string, ConnectionCatalogDocument["targets"][number]>();
  for (const target of document.targets) {
    const identity = persistedTargetIdentity(target);
    if (targetIdentities.has(identity)) return "duplicate-identity";
    targetIdentities.add(identity);
    if (target._tag === "RelayConnectionTarget") continue;
    if (target.connectionId.startsWith("learned:")) return "inconsistent-document";
    if (targetsByConnectionId.has(target.connectionId)) return "duplicate-identity";
    targetsByConnectionId.set(target.connectionId, target);
  }

  const profileConnectionIds = new Set<string>();
  for (const profile of document.profiles) {
    if (profileConnectionIds.has(profile.connectionId)) return "duplicate-identity";
    profileConnectionIds.add(profile.connectionId);
    const target = targetsByConnectionId.get(profile.connectionId);
    if (target === undefined || !targetProfileMatches(target, profile)) {
      return "inconsistent-document";
    }
    if (
      profile._tag === "BearerConnectionProfile" &&
      (profile.learned !== undefined ||
        profile.network !== undefined ||
        profile.authorization !== undefined)
    ) {
      return "inconsistent-document";
    }
  }

  const credentialConnectionIds = new Set<string>();
  for (const credential of document.credentials) {
    if (credentialConnectionIds.has(credential.connectionId)) return "duplicate-identity";
    credentialConnectionIds.add(credential.connectionId);
    if (!targetsByConnectionId.has(credential.connectionId)) return "inconsistent-document";
  }
  // Imported endpoints cannot borrow credentials or profiles from the local keyring.
  for (const connectionId of targetsByConnectionId.keys()) {
    if (!profileConnectionIds.has(connectionId) || !credentialConnectionIds.has(connectionId)) {
      return "inconsistent-document";
    }
  }
  return null;
}

function mergedImportConflict(
  imported: ConnectionCatalogDocument,
  merged: ConnectionCatalogDocument,
): boolean {
  for (const importedTarget of imported.targets) {
    if (importedTarget._tag === "RelayConnectionTarget") continue;
    const connectionId = importedTarget.connectionId;
    const targets: Array<ConnectionCatalogDocument["targets"][number]> = [];
    for (const target of merged.targets) {
      if (target._tag !== "RelayConnectionTarget" && target.connectionId === connectionId) {
        targets.push(target);
      }
    }
    if (targets.length !== 1) return true;
    const target = targets[0]!;
    const profiles = merged.profiles.filter((profile) => profile.connectionId === connectionId);
    if (profiles.length > 1) return true;
    const profile = profiles[0];
    if (profile !== undefined && !targetProfileMatches(target, profile)) return true;
  }
  return false;
}

const openReadFlags =
  NodeFSP.constants.O_RDONLY |
  (NodeFSP.constants.O_NOFOLLOW ?? 0) |
  (NodeFSP.constants.O_NONBLOCK ?? 0);

const isSymlinkOpenError = (cause: unknown): boolean =>
  (cause as NodeJS.ErrnoException | undefined)?.code === "ELOOP";

const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const userId = yield* HostProcess.UserId;
  const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;

  const readPrivateImportFile = Effect.fn("desktop.connectionImport.readPrivateImportFile")(
    function* (resolvedPath: string) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () => NodeFSP.open(resolvedPath, openReadFlags),
              catch: (cause) =>
                new DesktopConnectionImportError({
                  reason: isSymlinkOpenError(cause) ? "not-a-regular-file" : "unreadable-file",
                  path: resolvedPath,
                  cause,
                }),
            }),
            (handle) => Effect.promise(() => handle.close()),
          );
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: (cause) =>
              new DesktopConnectionImportError({
                reason: "unreadable-file",
                path: resolvedPath,
                cause,
              }),
          });
          if (!stat.isFile()) {
            return yield* new DesktopConnectionImportError({
              reason: "not-a-regular-file",
              path: resolvedPath,
            });
          }
          if (stat.size > MAX_IMPORT_BYTES) {
            return yield* new DesktopConnectionImportError({
              reason: "oversized-file",
              path: resolvedPath,
            });
          }
          if (platform !== "win32") {
            if (userId !== undefined && stat.uid !== userId) {
              return yield* new DesktopConnectionImportError({
                reason: "insecure-file-owner",
                path: resolvedPath,
              });
            }
            if ((stat.mode & 0o077) !== 0) {
              return yield* new DesktopConnectionImportError({
                reason: "insecure-file-permissions",
                path: resolvedPath,
              });
            }
          }
          // Windows lacks O_NOFOLLOW and POSIX owner/mode bits; the same-fd
          // regular-file check and the user's ACL remain authoritative there.
          const buffer = Buffer.alloc(MAX_IMPORT_BYTES + 1);
          let offset = 0;
          while (offset < buffer.length) {
            const read = yield* Effect.tryPromise({
              try: () => handle.read(buffer, offset, buffer.length - offset, offset),
              catch: (cause) =>
                new DesktopConnectionImportError({
                  reason: "unreadable-file",
                  path: resolvedPath,
                  cause,
                }),
            });
            if (read.bytesRead === 0) break;
            offset += read.bytesRead;
          }
          if (offset > MAX_IMPORT_BYTES) {
            return yield* new DesktopConnectionImportError({
              reason: "oversized-file",
              path: resolvedPath,
            });
          }
          return buffer.subarray(0, offset).toString("utf8");
        }),
      );
    },
  );

  const importConnections = Effect.fn("desktop.connectionImport.importConnections")(function* (
    filePath: string,
  ) {
    const resolvedPath = path.resolve(filePath);
    const raw = yield* readPrivateImportFile(resolvedPath);
    const imported = yield* decodeConnectionCatalogDocumentJson(raw).pipe(
      Effect.mapError(
        () =>
          new DesktopConnectionImportError({
            reason: "invalid-document",
            path: resolvedPath,
          }),
      ),
    );
    const problem = importedDocumentProblem(imported);
    if (problem !== null) {
      return yield* new DesktopConnectionImportError({
        reason: problem,
        path: resolvedPath,
      });
    }

    const existing = yield* store.read.pipe(
      Effect.mapError(
        () =>
          new DesktopConnectionImportError({
            reason: "unreadable-catalog",
          }),
      ),
    );
    if (existing._tag === "unavailable") {
      return yield* new DesktopConnectionImportError({
        reason: "secure-storage-unavailable",
      });
    }
    const current =
      existing._tag === "missing"
        ? EMPTY_CONNECTION_CATALOG_DOCUMENT
        : yield* decodeConnectionCatalogDocumentJson(existing.catalog).pipe(
            Effect.mapError(
              () =>
                new DesktopConnectionImportError({
                  reason: "unreadable-catalog",
                }),
            ),
          );
    const merged = mergeConnectionCatalogDocument(current, imported);
    if (mergedImportConflict(imported, merged)) {
      return yield* new DesktopConnectionImportError({
        reason: "inconsistent-document",
        path: resolvedPath,
      });
    }
    const encoded = yield* encodeConnectionCatalogDocumentJson(merged).pipe(
      Effect.mapError(
        () =>
          new DesktopConnectionImportError({
            reason: "write-failed",
          }),
      ),
    );
    const written = yield* store.set(encoded).pipe(
      Effect.mapError(
        () =>
          new DesktopConnectionImportError({
            reason: "write-failed",
          }),
      ),
    );
    if (!written) {
      return yield* new DesktopConnectionImportError({
        reason: "secure-storage-unavailable",
      });
    }
    return {
      targets: imported.targets.length,
      profiles: imported.profiles.length,
      credentials: imported.credentials.length,
    };
  });

  return DesktopConnectionImportCommand.of({ importConnections });
});

export const layer = Layer.effect(DesktopConnectionImportCommand, make);
