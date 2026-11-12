// @effect-diagnostics nodeBuiltinImport:off - FileSystem exposes neither no-follow/non-blocking
// open flags nor a descriptor that stays the same across the validation and the read.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { defineSecretProviderDriver } from "@t3tools/secret-provider-core/server/driver";
import * as Effect from "effect/Effect";

import { definition } from "../shared/definition.ts";

const MAX_SECRET_BYTES = 16 * 1024;

// Node opens every descriptor close-on-exec itself; fs.constants has no O_CLOEXEC to add.
const openFlags =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0) |
  (NodeFS.constants.O_NONBLOCK ?? 0);

type SecretRead =
  | { readonly _tag: "read"; readonly value: string | undefined }
  | { readonly _tag: "rejected"; readonly reason: string };

const rejected = (reason: string): SecretRead => ({ _tag: "rejected", reason });

// An errno message can name the path, so only the code reaches the log.
const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "unreadable";

const stripOneTrailingNewline = (value: string) =>
  value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;

// One descriptor carries the whole check, so a symlink or FIFO swapped in after the stat cannot be
// read through. The root directory itself may be a symlink: agenix links /run/user/<uid>/agenix.
async function readSecretFile(filePath: string): Promise<SecretRead> {
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(filePath, openFlags);
    const stats = await handle.stat();
    if (!stats.isFile()) return rejected("not a regular file");
    const uid = process.getuid?.();
    if (uid !== undefined && stats.uid !== uid) return rejected("not owned by the server's user");
    // Windows has no POSIX permission bits and reports 0o666, so a file provider fails shut there.
    if ((stats.mode & 0o077) !== 0) return rejected("readable by group or other");

    const buffer = new Uint8Array(MAX_SECRET_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_SECRET_BYTES) return rejected(`larger than ${MAX_SECRET_BYTES} bytes`);

    const value = stripOneTrailingNewline(new TextDecoder().decode(buffer.subarray(0, total)));
    return { _tag: "read", value: value.trim().length === 0 ? undefined : value };
  } catch (error) {
    return rejected(errorCode(error));
  } finally {
    await handle?.close().catch(() => {});
  }
}

const readOne = Effect.fn("FileDriver.readOne")(function* (root: string, reference: string) {
  const result = yield* Effect.promise(() => readSecretFile(NodePath.join(root, reference)));
  if (result._tag === "read") return result.value;
  yield* Effect.logWarning("Could not read secret from file", {
    reference,
    reason: result.reason,
  });
  return undefined;
});

export const driver = defineSecretProviderDriver({
  kind: definition.kind,
  definition,
  read: Effect.fn("FileDriver.read")(function* ({ root }, references) {
    return yield* Effect.forEach(references, (reference) => readOne(root, reference));
  }),
});
