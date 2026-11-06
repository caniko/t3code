import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";

const MAX_TOKEN_BYTES = 8 * 1024;
// Owner execute, group write/execute, and every world bit are refused; `0640` stays readable.
const FORBIDDEN_TOKEN_FILE_MODE = 0o137;

/** A token file failure names the file, never its contents. */
export class SecretFileError extends Schema.TaggedError<SecretFileError>()("SecretFileError", {
  path: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `${this.reason}: ${this.path}`;
  }
}

const isToken = (value: string) => value.length > 0 && !/\s/.test(value);

const failure = (path: string, reason: string) => new SecretFileError({ path, reason });

/** Writes `token` atomically, readable only by its owner. */
export const writeSecretFile = Effect.fn("cli.secretFile.write")(function* (
  filePath: string,
  token: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  if (!path.isAbsolute(filePath)) {
    return yield* failure(filePath, "the token file path must be absolute");
  }
  if (!isToken(token)) {
    return yield* failure(filePath, "the token to write is not a single non-empty value");
  }
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${yield* random.uuidV4()}.tmp`,
  );
  yield* Effect.gen(function* () {
    yield* fs.writeFileString(tempPath, token, { flag: "wx", mode: 0o600 });
    yield* fs.chmod(tempPath, 0o600);
    yield* fs.rename(tempPath, filePath);
    yield* fs.chmod(filePath, 0o600);
  }).pipe(
    Effect.mapError((cause) =>
      failure(
        filePath,
        `could not write the token file (${cause instanceof Error ? cause.message : String(cause)})`,
      ),
    ),
    Effect.ensuring(fs.remove(tempPath).pipe(Effect.ignore)),
  );
});

/** Reads a token only when its owner or group can read it, and no one can write, traverse or execute it. */
export const readSecretFile = Effect.fn("cli.secretFile.read")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(filePath)) {
    return yield* failure(filePath, "the token file path must be absolute");
  }
  const readFailure = (reason: string) => failure(filePath, reason);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      // One open handle: the mode and size checked are the bytes that are read.
      const file = yield* fs
        .open(filePath, { flag: "r" })
        .pipe(Effect.mapError(() => readFailure("could not open the token file")));
      const info = yield* file.stat.pipe(
        Effect.mapError(() => readFailure("could not stat the token file")),
      );
      if (info.type !== "File") {
        return yield* readFailure("the token file is not a regular file");
      }
      // A group may read a provisioned token (`0640`, as an ACL mask shows); writes stay `0600`.
      if ((info.mode & FORBIDDEN_TOKEN_FILE_MODE) !== 0) {
        return yield* readFailure(
          "the token file must not be executable, writable by its group, or accessible to other users",
        );
      }
      if (info.size > ByteSize.bytes(MAX_TOKEN_BYTES)) {
        return yield* readFailure("the token file is too large");
      }
      const bytes = yield* file
        .readAlloc(MAX_TOKEN_BYTES + 1)
        .pipe(Effect.mapError(() => readFailure("could not read the token file")));
      if (Option.isNone(bytes)) return yield* readFailure("the token file is empty");
      if (bytes.value.length > MAX_TOKEN_BYTES) {
        return yield* readFailure("the token file is too large");
      }
      const raw = new TextDecoder().decode(bytes.value);
      const token = raw.endsWith("\r\n")
        ? raw.slice(0, -2)
        : raw.endsWith("\n")
          ? raw.slice(0, -1)
          : raw;
      if (!isToken(token)) {
        return yield* readFailure("the token file does not contain a single token");
      }
      return token;
    }),
  );
});
