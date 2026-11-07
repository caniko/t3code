import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Command } from "effect/cli";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { environmentCommand, readPairingCode } from "./environment.ts";

it.effect("reads a pairing code from stdin without changing literal-code behavior", () =>
  Effect.gen(function* () {
    const input = Stdio.layerTest({
      stdin: Stream.make(new TextEncoder().encode("  pairing-code\n")),
    });
    assert.strictEqual(yield* readPairingCode("-").pipe(Effect.provide(input)), "pairing-code");
    assert.strictEqual(
      yield* readPairingCode("literal-code").pipe(
        Effect.provide(Stdio.layerTest({ stdin: Stream.die("stdin must not be read") })),
      ),
      "literal-code",
    );
    const error = yield* readPairingCode("-").pipe(
      Effect.provide(Stdio.layerTest({ stdin: Stream.empty })),
      Effect.flip,
    );
    assert.strictEqual(error.reason, "pairing_rejected");
    assert.strictEqual(error.message, "The pairing code read from standard input is empty.");
  }),
);

const layerCliRuntime = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  NetService.layer,
  TestConsole.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
);

it.effect("describes this environment's native identity without starting a server", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-environment-describe-test-",
    });
    const runDescribe = (args: ReadonlyArray<string>) =>
      Command.runWith(environmentCommand, { version: "0.0.0" })([
        "describe",
        "--base-dir",
        baseDir,
        ...args,
      ]);
    const lastLog = Effect.map(TestConsole.logLines, (lines) => String(lines.at(-1) ?? ""));

    const { human, json, repeatedJson } = yield* Effect.gen(function* () {
      yield* runDescribe([]);
      const human = yield* lastLog;
      yield* runDescribe(["--json"]);
      const json = yield* lastLog;
      yield* runDescribe(["--json"]);
      const repeatedJson = yield* lastLog;
      return { human, json, repeatedJson };
    }).pipe(Effect.provide(layerCliRuntime));

    const descriptor = JSON.parse(json) as { environmentId: string; label: string };
    const repeated = JSON.parse(repeatedJson) as { environmentId: string };
    assert.equal(descriptor.environmentId, repeated.environmentId);
    assert.equal(human, `${descriptor.label} (${descriptor.environmentId})\n`);

    const nativeDescriptor = yield* Effect.gen(function* () {
      const environment = yield* ServerEnvironment.ServerEnvironment;
      return yield* environment.getDescriptor;
    }).pipe(
      Effect.provide(
        ServerEnvironment.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    );
    assert.equal(descriptor.environmentId, nativeDescriptor.environmentId);
    assert.deepEqual(descriptor, nativeDescriptor);

    const stateDir = path.join(baseDir, "userdata");
    assert.isFalse(yield* fileSystem.exists(path.join(stateDir, "statev2.sqlite")));
    assert.isFalse(yield* fileSystem.exists(path.join(stateDir, "server-runtime.json")));
    assert.deepEqual(yield* fileSystem.readDirectory(path.join(stateDir, "secrets")), []);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
