// @effect-diagnostics nodeBuiltinImport:off -- the fixtures are real files and a FIFO the driver reads.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { driver } from "./driver.ts";

// The driver itself needs no service; this satisfies the driver contract's union.
const testLayer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

const withRoot = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-file-secret-"));
    return use(root).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  });

const writeSecret = (root: string, name: string, contents: string, mode = 0o600) => {
  const filePath = NodePath.join(root, name);
  NodeFS.writeFileSync(filePath, contents);
  NodeFS.chmodSync(filePath, mode);
  return filePath;
};

const read = (root: string, references: ReadonlyArray<string>) =>
  driver.read({ root }, references).pipe(Effect.provide(testLayer));

// The driver fails closed on Windows, which has no POSIX permission bits.
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("file driver", () => {
  it.effect("reads a 0600 file and strips one trailing newline", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        writeSecret(root, "api-key", "sk-live\n");
        writeSecret(root, "crlf-key", "sk-live\r\n");

        assert.deepStrictEqual(yield* read(root, ["api-key", "crlf-key"]), ["sk-live", "sk-live"]);
      }),
    ),
  );

  it.effect("keeps a newline inside the secret", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        writeSecret(root, "pem-key", "line-one\nline-two\n");

        assert.deepStrictEqual(yield* read(root, ["pem-key"]), ["line-one\nline-two"]);
      }),
    ),
  );

  it.effect("reads an empty or whitespace-only file as undefined", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        writeSecret(root, "empty", "");
        writeSecret(root, "blank", " \n\t\n");

        assert.deepStrictEqual(yield* read(root, ["empty", "blank"]), [undefined, undefined]);
      }),
    ),
  );

  it.effect("rejects a file that group or other can read", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        writeSecret(root, "shared", "sk-live\n", 0o644);

        assert.deepStrictEqual(yield* read(root, ["shared"]), [undefined]);
      }),
    ),
  );

  it.effect("rejects a symlink in place of the secret", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const target = writeSecret(root, "target", "sk-live\n");
        NodeFS.symlinkSync(target, NodePath.join(root, "link"));

        assert.deepStrictEqual(yield* read(root, ["link"]), [undefined]);
      }),
    ),
  );

  it.effect("rejects a FIFO without waiting for a writer", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const fifo = NodePath.join(root, "fifo");
        NodeChildProcess.execFileSync("mkfifo", [fifo]);
        NodeFS.chmodSync(fifo, 0o600);

        assert.deepStrictEqual(yield* read(root, ["fifo"]), [undefined]);
      }),
    ),
  );

  it.effect("accepts exactly 16 KiB and rejects one byte more", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        writeSecret(root, "max", "x".repeat(16 * 1024));
        writeSecret(root, "over", "x".repeat(16 * 1024 + 1));

        assert.deepStrictEqual(yield* read(root, ["max", "over"]), [
          "x".repeat(16 * 1024),
          undefined,
        ]);
      }),
    ),
  );

  it.effect("reads a missing file as undefined", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* read(root, ["missing"]), [undefined]);
      }),
    ),
  );

  it.effect("follows a symlinked root directory", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const real = NodePath.join(root, "real");
        NodeFS.mkdirSync(real);
        writeSecret(real, "api-key", "sk-live\n");
        const linked = NodePath.join(root, "linked");
        NodeFS.symlinkSync(real, linked);

        assert.deepStrictEqual(yield* read(linked, ["api-key"]), ["sk-live"]);
      }),
    ),
  );

  it.effect("answers references in input order with holes", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        writeSecret(root, "a-key", "a\n");
        writeSecret(root, "c-key", "c\n");

        assert.deepStrictEqual(yield* read(root, ["a-key", "b-key", "c-key"]), [
          "a",
          undefined,
          "c",
        ]);
      }),
    ),
  );
});
