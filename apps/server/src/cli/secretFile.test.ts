// @effect-diagnostics nodeBuiltinImport:off - the helper guards real filesystem modes.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { readSecretFile, writeSecretFile } from "./secretFile.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

const withTempDir = <A, E, R>(run: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-secret-file-"))),
    run,
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  ).pipe(Effect.provide(layerCliRuntime));

it.effect("writes a token only its owner can read", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const file = NodePath.join(dir, "token");
      yield* writeSecretFile(file, "token-value");

      expect(NodeFS.readFileSync(file, "utf8")).toBe("token-value");
      expect(NodeFS.statSync(file).mode & 0o777).toBe(0o600);
      expect(yield* readSecretFile(file)).toBe("token-value");
    }),
  ),
);

it.effect("replaces an existing token without leaving a temporary file", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const file = NodePath.join(dir, "token");
      yield* writeSecretFile(file, "first");
      yield* writeSecretFile(file, "second");

      expect(NodeFS.readdirSync(dir)).toEqual(["token"]);
      expect(yield* readSecretFile(file)).toBe("second");
    }),
  ),
);

it.effect("reads a token written with one trailing newline", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const file = NodePath.join(dir, "token");
      NodeFS.writeFileSync(file, "token-value\n", { mode: 0o600 });

      expect(yield* readSecretFile(file)).toBe("token-value");
    }),
  ),
);

it.effect("reads a group-readable token file provisioned by ACL", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const file = NodePath.join(dir, "token");
      NodeFS.writeFileSync(file, "token-value", { mode: 0o640 });
      NodeFS.chmodSync(file, 0o640);

      expect(yield* readSecretFile(file)).toBe("token-value");
    }),
  ),
);

it.effect("refuses a token file other users can read", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const file = NodePath.join(dir, "token");
      NodeFS.writeFileSync(file, "token-value", { mode: 0o644 });
      NodeFS.chmodSync(file, 0o644);

      const error = yield* readSecretFile(file).pipe(Effect.flip);

      expect(error.message).toContain(file);
      expect(error.message).not.toContain("token-value");
    }),
  ),
);

it.effect("refuses a token file its group can change or any user can execute", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      for (const mode of [0o660, 0o610, 0o700]) {
        const file = NodePath.join(dir, `token-${mode.toString(8)}`);
        NodeFS.writeFileSync(file, "token-value", { mode });
        NodeFS.chmodSync(file, mode);

        const error = yield* readSecretFile(file).pipe(Effect.flip);

        expect(error.message).toContain(file);
        expect(error.message).not.toContain("token-value");
      }
    }),
  ),
);

it.effect("refuses an oversized token file before reading it", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const file = NodePath.join(dir, "token");
      NodeFS.writeFileSync(file, "x".repeat(9 * 1024), { mode: 0o600 });

      const error = yield* readSecretFile(file).pipe(Effect.flip);

      expect(error.message).toContain("too large");
      expect(error.message).toContain(file);
    }),
  ),
);

it.effect("names the missing token file without guessing at its contents", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const file = NodePath.join(dir, "missing");

      const error = yield* readSecretFile(file).pipe(Effect.flip);

      expect(error.message).toContain(file);
    }),
  ),
);

it.effect("rejects token files with whitespace", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const file = NodePath.join(dir, "token");
      NodeFS.writeFileSync(file, "two words", { mode: 0o600 });

      const error = yield* readSecretFile(file).pipe(Effect.flip);

      expect(error.message).not.toContain("two words");
    }),
  ),
);

it.effect("refuses a relative token path", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const relative = NodePath.relative(process.cwd(), NodePath.join(dir, "token"));

      const writeError = yield* writeSecretFile(relative, "token-value").pipe(Effect.flip);
      const readError = yield* readSecretFile(relative).pipe(Effect.flip);

      expect(writeError.message).toContain("absolute");
      expect(readError.message).toContain("absolute");
    }),
  ),
);
