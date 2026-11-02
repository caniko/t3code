// @effect-diagnostics nodeBuiltinImport:off -- the runner speaks raw unix sockets.
import type { Socket } from "node:net";

/**
 * One connection is one process. The client opens with a `spawn` frame; both sides then exchange
 * newline-delimited JSON frames until `exit`. Closing the connection kills the process, so a
 * client's scope exit is the cleanup path. Bytes travel as base64.
 */
export type SpawnProcessFrame = {
  readonly t: "spawn";
  readonly kind: "process";
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: "pipe" | "ignore";
  readonly shell?: boolean | string;
};

export type SpawnPtyFrame = {
  readonly t: "spawn";
  readonly kind: "pty";
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
};

export type ClientFrame =
  | SpawnProcessFrame
  | SpawnPtyFrame
  | { readonly t: "stdin"; readonly d: string }
  | { readonly t: "stdin-end" }
  | { readonly t: "signal"; readonly signal: string }
  | { readonly t: "resize"; readonly cols: number; readonly rows: number };

export type RunnerFrame =
  | { readonly t: "started"; readonly pid: number }
  | { readonly t: "error"; readonly message: string }
  | { readonly t: "out"; readonly s: "stdout" | "stderr"; readonly d: string }
  | { readonly t: "exit"; readonly code: number | null; readonly signal: string | null };

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Server-side variables the user's own login environment must keep control of. */
const PROTECTED_ENV_KEYS = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "IFS",
]);

export const isProtectedEnvKey = (key: string) =>
  PROTECTED_ENV_KEYS.has(key) || key.startsWith("LD_") || key.startsWith("DYLD_");

/**
 * What the client may overlay on the runner's environment: values the caller changed relative to the
 * server's own environment, minus protected keys. The server's inherited environment (service
 * credentials, its HOME and PATH) never reaches a user's process.
 */
export const overlayEnv = (
  env: Readonly<Record<string, string | undefined>> | undefined,
  serverEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const overlay: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined || isProtectedEnvKey(key) || serverEnv[key] === value) continue;
    overlay[key] = value;
  }
  return overlay;
};

export const sendFrame = (socket: Socket, frame: ClientFrame | RunnerFrame, cb?: () => void) => {
  if (socket.destroyed || !socket.writable) return false;
  return socket.write(`${JSON.stringify(frame)}\n`, cb);
};

/** Splits a socket into JSON frames; a malformed or oversized line is reported once and stops reading. */
export const readFrames = (
  socket: Socket,
  onFrame: (frame: unknown) => void,
  onProtocolError: (message: string) => void,
) => {
  let buffer = "";
  let failed = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    if (failed) return;
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        onFrame(JSON.parse(line));
      } catch (cause) {
        failed = true;
        onProtocolError(`Malformed runner frame: ${String(cause)}`);
        return;
      }
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_FRAME_BYTES) {
      failed = true;
      onProtocolError("Runner frame exceeds the size limit.");
    }
  });
};
