import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopConnectionImportCommand from "./DesktopConnectionImportCommand.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const decodeConnectionCatalog = Schema.decodeUnknownSync(
  Schema.fromJsonString(ConnectionCatalogDocument),
);

function layerSafeStorage(available: boolean) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(available),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`encrypted:${value}`)),
    decryptString: (value) => {
      const decoded = textDecoder.decode(value);
      return decoded.startsWith("encrypted:")
        ? Effect.succeed(decoded.slice("encrypted:".length))
        : Effect.fail(
            new ElectronSafeStorage.ElectronSafeStorageDecryptError({
              cause: new Error("invalid encrypted catalog"),
            }),
          );
    },
    selectedStorageBackend: Effect.succeedNone,
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
}

function layerFor(baseDir: string, encryptionAvailable = true) {
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
  const layerDependencies = Layer.mergeAll(
    layerEnvironment,
    layerSafeStorage(encryptionAvailable),
    NodeServices.layer,
    NodeCrypto.layer,
  );
  const layerSavedEnvironments = DesktopSavedEnvironments.layer.pipe(
    Layer.provideMerge(layerDependencies),
  );
  const layerStore = DesktopConnectionCatalogStore.layer.pipe(
    Layer.provideMerge(layerSavedEnvironments),
    Layer.provideMerge(layerDependencies),
  );
  return DesktopConnectionImportCommand.layer.pipe(
    Layer.provideMerge(layerStore),
    Layer.provideMerge(layerDependencies),
  );
}

const withCommand = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | DesktopConnectionImportCommand.DesktopConnectionImportCommand
    | DesktopConnectionCatalogStore.DesktopConnectionCatalogStore
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
    | Path.Path
  >,
  encryptionAvailable = true,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-connection-import-test-",
    });
    return yield* effect.pipe(Effect.provide(layerFor(baseDir, encryptionAvailable)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const writePrivateFile = (fileSystem: FileSystem.FileSystem, filePath: string, contents: string) =>
  fileSystem
    .writeFileString(filePath, contents)
    .pipe(Effect.andThen(fileSystem.chmod(filePath, 0o600)));

const existingDocument = {
  schemaVersion: 1,
  targets: [
    { _tag: "RelayConnectionTarget", environmentId: "manual-env", label: "Manual relay" },
    {
      _tag: "BearerConnectionTarget",
      environmentId: "env-1",
      label: "Old LAN",
      connectionId: "bearer:env-1",
    },
  ],
  profiles: [
    {
      _tag: "BearerConnectionProfile",
      connectionId: "bearer:env-1",
      environmentId: "env-1",
      label: "Old LAN",
      httpBaseUrl: "http://old.example.test:3773",
      wsBaseUrl: "ws://old.example.test:3773",
    },
  ],
  credentials: [
    {
      connectionId: "bearer:env-1",
      credential: { _tag: "BearerConnectionCredential", token: "old-token" },
    },
  ],
  remoteDpopTokens: [],
  disabledEnvironmentIds: ["manual-env"],
};

const importedDocument = {
  schemaVersion: 1,
  targets: [
    {
      _tag: "BearerConnectionTarget",
      environmentId: "env-1",
      label: "LAN",
      connectionId: "bearer:env-1",
    },
    {
      _tag: "SshConnectionTarget",
      environmentId: "env-1",
      label: "VPN",
      connectionId: "ssh:env-1",
    },
  ],
  profiles: [
    {
      _tag: "BearerConnectionProfile",
      connectionId: "bearer:env-1",
      environmentId: "env-1",
      label: "LAN",
      httpBaseUrl: "http://192.168.1.10:3773",
      wsBaseUrl: "ws://192.168.1.10:3773",
    },
    {
      _tag: "SshConnectionProfile",
      connectionId: "ssh:env-1",
      environmentId: "env-1",
      label: "VPN",
      target: { alias: "peer", hostname: "10.0.0.2", username: null, port: 22 },
    },
  ],
  credentials: [
    {
      connectionId: "bearer:env-1",
      credential: { _tag: "BearerConnectionCredential", token: "secret-token" },
    },
    {
      connectionId: "ssh:env-1",
      credential: { _tag: "BearerConnectionCredential", token: "ssh-token" },
    },
  ],
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
};

describe("DesktopConnectionImportCommand", () => {
  it.effect("upserts native records, keeps manual entries, routes, and credential privacy", () =>
    withCommand(
      Effect.gen(function* () {
        const command = yield* DesktopConnectionImportCommand.DesktopConnectionImportCommand;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const importPath = path.join(environment.stateDir, "import.json");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* writePrivateFile(fileSystem, importPath, JSON.stringify(importedDocument, null, 2));
        assert.isTrue(yield* store.set(JSON.stringify(existingDocument)));

        const summary = yield* command.importConnections(importPath);
        assert.deepEqual(summary, { targets: 2, profiles: 2, credentials: 2 });
        assert.notInclude(JSON.stringify(summary), "secret-token");

        const stored = yield* store.get;
        assert.isTrue(stored._tag === "Some");
        if (stored._tag === "None") return;
        const catalog = decodeConnectionCatalog(stored.value);
        assert.deepEqual(
          catalog.targets.map((target) => target.label),
          ["Manual relay", "LAN", "VPN"],
        );
        assert.deepEqual(
          catalog.profiles.map((profile) => profile.label),
          ["LAN", "VPN"],
        );
        assert.equal(catalog.credentials[0]?.connectionId, "bearer:env-1");
        assert.equal(catalog.disabledEnvironmentIds.length, 1);
        assert.equal(catalog.disabledEnvironmentIds[0], "manual-env");

        yield* command.importConnections(importPath);
        const reimported = yield* store.get;
        assert.isTrue(reimported._tag === "Some");
        if (reimported._tag === "None") return;
        assert.equal(reimported.value, stored.value);
      }),
    ),
  );

  it.effect("imports into an empty catalog", () =>
    withCommand(
      Effect.gen(function* () {
        const command = yield* DesktopConnectionImportCommand.DesktopConnectionImportCommand;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const importPath = path.join(environment.stateDir, "import.json");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* writePrivateFile(fileSystem, importPath, JSON.stringify(importedDocument));

        assert.deepEqual(yield* command.importConnections(importPath), {
          targets: 2,
          profiles: 2,
          credentials: 2,
        });
        const stored = yield* store.get;
        assert.isTrue(stored._tag === "Some");
        if (stored._tag === "None") return;
        const catalog = decodeConnectionCatalog(stored.value);
        assert.deepEqual(
          catalog.targets.map((target) => target.label),
          ["LAN", "VPN"],
        );
      }),
    ),
  );

  it.effect("leaves the existing catalog untouched when the import document is malformed", () =>
    withCommand(
      Effect.gen(function* () {
        const command = yield* DesktopConnectionImportCommand.DesktopConnectionImportCommand;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const importPath = path.join(environment.stateDir, "malformed.json");
        const original = JSON.stringify(existingDocument);
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        assert.isTrue(yield* store.set(original));
        yield* writePrivateFile(
          fileSystem,
          importPath,
          JSON.stringify({
            ...importedDocument,
            schemaVersion: 2,
            credentials: [
              {
                connectionId: "bearer:env-1",
                credential: { _tag: "BearerConnectionCredential", token: "super-secret" },
              },
            ],
          }),
        );

        const error = yield* command.importConnections(importPath).pipe(Effect.flip);
        assert.equal(error.reason, "invalid-document");
        assert.notInclude(error.message, "super-secret");

        const duplicatePath = path.join(environment.stateDir, "duplicate.json");
        yield* writePrivateFile(
          fileSystem,
          duplicatePath,
          JSON.stringify({
            ...importedDocument,
            targets: [importedDocument.targets[0], importedDocument.targets[0]],
          }),
        );
        const duplicateError = yield* command.importConnections(duplicatePath).pipe(Effect.flip);
        assert.equal(duplicateError.reason, "duplicate-identity");

        const stored = yield* store.get;
        assert.isTrue(stored._tag === "Some");
        if (stored._tag === "None") return;
        assert.equal(stored.value, original);
      }),
    ),
  );

  it.effect("rejects an oversized import without touching the catalog", () =>
    withCommand(
      Effect.gen(function* () {
        const command = yield* DesktopConnectionImportCommand.DesktopConnectionImportCommand;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const importPath = path.join(environment.stateDir, "oversized.json");
        const original = JSON.stringify(existingDocument);
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        assert.isTrue(yield* store.set(original));
        yield* writePrivateFile(
          fileSystem,
          importPath,
          "x".repeat(DesktopConnectionImportCommand.MAX_IMPORT_BYTES + 1),
        );

        const error = yield* command.importConnections(importPath).pipe(Effect.flip);
        assert.equal(error.reason, "oversized-file");
        const stored = yield* store.get;
        assert.isTrue(stored._tag === "Some");
        if (stored._tag === "None") return;
        assert.equal(stored.value, original);
      }),
    ),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "rejects non-private import files without touching the catalog",
    () =>
      withCommand(
        Effect.gen(function* () {
          const command = yield* DesktopConnectionImportCommand.DesktopConnectionImportCommand;
          const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const importPath = path.join(environment.stateDir, "public.json");
          const original = JSON.stringify(existingDocument);
          yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
          assert.isTrue(yield* store.set(original));
          yield* writePrivateFile(fileSystem, importPath, JSON.stringify(importedDocument));
          yield* fileSystem.chmod(importPath, 0o644);

          const error = yield* command.importConnections(importPath).pipe(Effect.flip);
          assert.equal(error.reason, "insecure-file-permissions");
          const stored = yield* store.get;
          assert.isTrue(stored._tag === "Some");
          if (stored._tag === "None") return;
          assert.equal(stored.value, original);
        }),
      ),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "rejects a symlinked import file without touching the catalog",
    () =>
      withCommand(
        Effect.gen(function* () {
          const command = yield* DesktopConnectionImportCommand.DesktopConnectionImportCommand;
          const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const targetPath = path.join(environment.stateDir, "real.json");
          const linkPath = path.join(environment.stateDir, "link.json");
          const original = JSON.stringify(existingDocument);
          yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
          assert.isTrue(yield* store.set(original));
          yield* writePrivateFile(fileSystem, targetPath, JSON.stringify(importedDocument));
          yield* fileSystem.symlink(targetPath, linkPath);

          const error = yield* command.importConnections(linkPath).pipe(Effect.flip);
          assert.equal(error.reason, "not-a-regular-file");
          const stored = yield* store.get;
          assert.isTrue(stored._tag === "Some");
          if (stored._tag === "None") return;
          assert.equal(stored.value, original);
        }),
      ),
  );

  it.effect("rejects inconsistent target, profile, and credential references before writing", () =>
    withCommand(
      Effect.gen(function* () {
        const command = yield* DesktopConnectionImportCommand.DesktopConnectionImportCommand;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const original = JSON.stringify(existingDocument);
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        assert.isTrue(yield* store.set(original));
        const cases: ReadonlyArray<readonly [string, object, string]> = [
          [
            "redirect-existing-token",
            {
              ...importedDocument,
              profiles: [
                {
                  ...importedDocument.profiles[0],
                  httpBaseUrl: "https://attacker.example",
                  wsBaseUrl: "wss://attacker.example",
                },
                importedDocument.profiles[1],
              ],
              credentials: [],
            },
            "inconsistent-document",
          ],
          [
            "missing-ssh-credential",
            { ...importedDocument, credentials: [importedDocument.credentials[0]] },
            "inconsistent-document",
          ],
          ["missing-profile", { ...importedDocument, profiles: [] }, "inconsistent-document"],
          ...[
            "learned:env-1:https://attacker.example@bearer:env-1",
            "learned:env-1:https://attacker.example",
          ].map(
            (connectionId) =>
              [
                "synthetic-learned-identity",
                {
                  ...importedDocument,
                  targets: [{ ...importedDocument.targets[0], connectionId }],
                  profiles: [{ ...importedDocument.profiles[0], connectionId }],
                  credentials: [{ ...importedDocument.credentials[0], connectionId }],
                },
                "inconsistent-document",
              ] as const,
          ),
          ...[{ learned: true }, { network: "tailscale" }, { authorization: "t3-connect" }].map(
            (flags) =>
              [
                "transport-relaxing-profile",
                {
                  ...importedDocument,
                  profiles: [
                    { ...importedDocument.profiles[0], ...flags },
                    importedDocument.profiles[1],
                  ],
                },
                "inconsistent-document",
              ] as const,
          ),
          [
            "shared-connection-id",
            {
              ...importedDocument,
              targets: [
                { ...importedDocument.targets[0], connectionId: "shared" },
                { ...importedDocument.targets[1], connectionId: "shared" },
              ],
              profiles: [],
              credentials: [],
            },
            "duplicate-identity",
          ],
          [
            "profile-environment-mismatch",
            {
              ...importedDocument,
              profiles: [
                { ...importedDocument.profiles[0], environmentId: "other-env" },
                importedDocument.profiles[1],
              ],
            },
            "inconsistent-document",
          ],
          [
            "profile-type-mismatch",
            {
              ...importedDocument,
              profiles: [
                { ...importedDocument.profiles[1], connectionId: "bearer:env-1" },
                importedDocument.profiles[1],
              ],
            },
            "inconsistent-document",
          ],
          [
            "orphan-profile",
            {
              ...importedDocument,
              profiles: [
                { ...importedDocument.profiles[0], connectionId: "bearer:manual" },
                importedDocument.profiles[1],
              ],
            },
            "inconsistent-document",
          ],
          [
            "orphan-credential",
            {
              ...importedDocument,
              credentials: [
                {
                  connectionId: "bearer:manual",
                  credential: importedDocument.credentials[0]!.credential,
                },
              ],
            },
            "inconsistent-document",
          ],
          [
            "existing-cross-kind",
            {
              ...importedDocument,
              targets: [
                {
                  ...importedDocument.targets[1],
                  connectionId: "bearer:env-1",
                },
              ],
              profiles: [
                {
                  ...importedDocument.profiles[1],
                  connectionId: "bearer:env-1",
                },
              ],
              credentials: [],
            },
            "inconsistent-document",
          ],
          [
            "existing-profile-mismatch",
            {
              ...importedDocument,
              targets: [
                { ...importedDocument.targets[0], environmentId: "env-2" },
                importedDocument.targets[1],
              ],
              profiles: [importedDocument.profiles[1]],
              credentials: [],
            },
            "inconsistent-document",
          ],
        ];

        for (const [name, document, reason] of cases) {
          const filePath = path.join(environment.stateDir, `${name}.json`);
          yield* writePrivateFile(fileSystem, filePath, JSON.stringify(document));
          const error = yield* command.importConnections(filePath).pipe(Effect.flip);
          assert.equal(error.reason, reason, name);
        }

        const stored = yield* store.get;
        assert.isTrue(stored._tag === "Some");
        if (stored._tag === "None") return;
        assert.equal(stored.value, original);
      }),
    ),
  );

  it.effect("fails closed and leaves an encrypted catalog untouched without a keyring", () =>
    withCommand(
      Effect.gen(function* () {
        const command = yield* DesktopConnectionImportCommand.DesktopConnectionImportCommand;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const importPath = path.join(environment.stateDir, "import.json");
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        const original = JSON.stringify(existingDocument);
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          catalogPath,
          JSON.stringify({
            version: 1,
            encryptedCatalog: Base64.encode(textEncoder.encode(`encrypted:${original}`)),
          }),
        );
        yield* writePrivateFile(fileSystem, importPath, JSON.stringify(importedDocument));
        const before = yield* fileSystem.readFileString(catalogPath);

        const error = yield* command.importConnections(importPath).pipe(Effect.flip);
        assert.equal(error.reason, "secure-storage-unavailable");
        assert.equal(yield* fileSystem.readFileString(catalogPath), before);
        assert.include(before, "encryptedCatalog");
        assert.notInclude(before, "secret-token");
      }),
      false,
    ),
  );
});

describe("DesktopConnectionImportCommand.prepare", () => {
  const withPrepare = <A, E, R>(
    lockAvailable: boolean,
    run: (events: ReadonlyArray<string>) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-import-prepare-test-",
      });
      const events: Array<string> = [];
      const preReady: DesktopPreReadyPlatform.DesktopPreReadyElectronOptions["Service"] = {
        linux: {
          isDevelopment: false,
          linuxDesktopEntryName: "com.t3tools.T3Code.desktop",
          passwordStore: "gnome-libsecret",
        },
        linuxPasswordStoreCommandLine: null,
      };
      const layerPreReady = Layer.effect(
        DesktopPreReadyPlatform.DesktopPreReadyElectronOptions,
        Effect.sync(() => {
          events.push("pre-ready");
          return preReady;
        }),
      );
      const electronApp = {
        setPath: (name: string) =>
          Effect.sync(() => {
            events.push(`set-path:${name}`);
          }),
        requestSingleInstanceLock: Effect.sync(() => {
          events.push("lock");
          return lockAvailable;
        }),
        whenReady: Effect.sync(() => {
          events.push("ready");
        }),
      } as unknown as ElectronApp.ElectronApp["Service"];
      const environment = {
        appDataDirectory: baseDir,
        isDevelopment: false,
        platform: "linux",
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"];

      return yield* run(events).pipe(
        Effect.provide(layerPreReady),
        Effect.provideService(ElectronApp.ElectronApp, electronApp),
        Effect.provideService(DesktopAppIdentity.DesktopAppIdentity, {
          resolveUserDataPath: Effect.die("profile setup must use the pre-ready filesystem"),
          configure: Effect.sync(() => {
            events.push("identity");
          }),
        }),
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

  it.effect("applies pre-ready setup before profile setup, lock, and readiness", () =>
    withPrepare(true, (events) =>
      DesktopConnectionImportCommand.prepare.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            assert.deepEqual(events, [
              "pre-ready",
              "set-path:userData",
              "lock",
              "identity",
              "ready",
            ]);
          }),
        ),
      ),
    ),
  );

  it.effect("uses the pre-ready filesystem for profile setup", () =>
    withPrepare(true, () =>
      DesktopConnectionImportCommand.prepare.pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            exists: () => Effect.die("async filesystem used during pre-ready profile setup"),
          }),
        ),
      ),
    ),
  );

  it.effect("refuses while another instance owns the lock", () =>
    withPrepare(false, (events) =>
      DesktopConnectionImportCommand.prepare.pipe(
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => {
            assert.equal(error._tag, "DesktopConnectionImportError");
            if (error._tag !== "DesktopConnectionImportError") return;
            assert.equal(error.reason, "app-running");
            assert.deepEqual(events, ["pre-ready", "set-path:userData", "lock"]);
          }),
        ),
      ),
    ),
  );
});

describe("readImportConnectionsArgument", () => {
  it("accepts one file path and rejects missing or duplicated values", () => {
    assert.deepEqual(
      DesktopConnectionImportCommand.readImportConnectionsArgument([
        "t3",
        "--import-connections",
        "/tmp/connections.json",
      ]),
      { _tag: "Present", path: "/tmp/connections.json" },
    );
    assert.equal(
      DesktopConnectionImportCommand.readImportConnectionsArgument(["t3", "--import-connections"])
        ._tag,
      "Invalid",
    );
    assert.equal(
      DesktopConnectionImportCommand.readImportConnectionsArgument([
        "t3",
        "--import-connections=/tmp/connections.json",
      ])._tag,
      "Invalid",
    );
    assert.equal(
      DesktopConnectionImportCommand.readImportConnectionsArgument(["t3"])._tag,
      "Absent",
    );
  });
});
