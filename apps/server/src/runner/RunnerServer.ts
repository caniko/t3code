// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- the runner owns raw sockets, child processes and their exit flush.
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";

import {
  type ClientFrame,
  isProtectedEnvKey,
  readFrames,
  type RunnerFrame,
  sendFrame,
  type SpawnProcessFrame,
  type SpawnPtyFrame,
} from "./protocol.ts";

export interface RunnerServerOptions {
  /** Listen here; absent means inherit the socket-activated descriptor 3. */
  readonly socketPath?: string;
  readonly home: string;
  /** Directories outside `home` that work may run in. */
  readonly allowedRoots: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly spawnPty: (input: PtyAdapter.PtySpawnInput) => Promise<PtyAdapter.PtyProcess>;
}

const SIGNALS = new Set(Object.keys(NodeOs.constants.signals));
// Grandchildren that inherit the pipes keep `close` from firing; report the exit regardless.
const EXIT_FLUSH_GRACE_MS = 2_000;

const within = (root: string, target: string) => {
  const relative = NodePath.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

const realpathOrNull = (value: string) => {
  try {
    return NodeFs.realpathSync(value);
  } catch {
    return null;
  }
};

/** Resolves symlinks before comparing, so a link inside the home cannot lead out of it. */
export const resolveAllowedCwd = (
  cwd: string | undefined,
  home: string,
  allowedRoots: ReadonlyArray<string>,
): string => {
  const requested = cwd ?? home;
  if (!NodePath.isAbsolute(requested)) throw new Error(`Working directory must be absolute: ${requested}`);
  const real = realpathOrNull(requested);
  if (real === null) throw new Error(`Working directory does not exist: ${requested}`);
  const roots = [home, ...allowedRoots].flatMap((root) => realpathOrNull(root) ?? []);
  if (!roots.some((root) => within(root, real))) {
    throw new Error(`Working directory is outside the allowed roots: ${requested}`);
  }
  return real;
};

export const assertAllowedEnv = (env: Readonly<Record<string, unknown>>) => {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") throw new Error(`Environment value for ${key} must be a string.`);
    if (isProtectedEnvKey(key)) throw new Error(`Environment override of ${key} is not allowed.`);
  }
};

const decode = (data: string) => Buffer.from(data, "base64");
const encode = (data: Uint8Array | string) => Buffer.from(data).toString("base64");

const killGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
};

const handleConnection = (socket: NodeNet.Socket, options: RunnerServerOptions) => {
  let teardown: () => void = () => {};
  let dispatch: ((frame: ClientFrame) => void) | undefined;
  const send = (frame: RunnerFrame) => sendFrame(socket, frame);
  const fail = (message: string) => {
    send({ t: "error", message });
    socket.end();
  };

  const startProcess = (request: SpawnProcessFrame) => {
    const cwd = resolveAllowedCwd(request.cwd, options.home, options.allowedRoots);
    assertAllowedEnv(request.env);
    if (typeof request.command !== "string" || request.command === "") {
      throw new Error("Command must be a non-empty string.");
    }
    const child = NodeChildProcess.spawn(request.command, [...request.args], {
      cwd,
      env: { ...options.env, ...request.env },
      detached: true,
      shell: request.shell ?? false,
      stdio: [request.stdin === "ignore" ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let exited = false;
    let exitReported = false;
    const reportExit = (code: number | null, signal: string | null) => {
      if (exitReported) return;
      exitReported = true;
      send({ t: "exit", code, signal });
      socket.end();
    };
    child.once("error", (error) => {
      if (child.pid === undefined) fail(error.message);
    });
    child.once("spawn", () => send({ t: "started", pid: child.pid! }));
    child.stdout!.on("data", (chunk: Buffer) => send({ t: "out", s: "stdout", d: encode(chunk) }));
    child.stderr!.on("data", (chunk: Buffer) => send({ t: "out", s: "stderr", d: encode(chunk) }));
    child.stdin?.on("error", () => {});
    child.once("exit", (code, signal) => {
      exited = true;
      setTimeout(() => reportExit(code, signal), EXIT_FLUSH_GRACE_MS).unref();
    });
    child.once("close", (code, signal) => reportExit(code, signal));
    dispatch = (frame) => {
      switch (frame.t) {
        case "stdin":
          child.stdin?.write(decode(frame.d));
          break;
        case "stdin-end":
          child.stdin?.end();
          break;
        case "signal":
          if (SIGNALS.has(frame.signal) && child.pid !== undefined) {
            killGroup(child.pid, frame.signal as NodeJS.Signals);
          }
          break;
      }
    };
    teardown = () => {
      if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
      if (!exited) child.kill("SIGKILL");
    };
  };

  const startPty = (request: SpawnPtyFrame) => {
    const cwd = resolveAllowedCwd(request.cwd, options.home, options.allowedRoots);
    assertAllowedEnv(request.env);
    const cols = Number.isInteger(request.cols) && request.cols > 0 ? request.cols : 80;
    const rows = Number.isInteger(request.rows) && request.rows > 0 ? request.rows : 24;
    const queued: ClientFrame[] = [];
    let pty: PtyAdapter.PtyProcess | undefined;
    let closed = false;
    dispatch = (frame) => {
      if (pty === undefined) queued.push(frame);
      else applyPty(pty, frame);
    };
    const applyPty = (target: PtyAdapter.PtyProcess, frame: ClientFrame) => {
      switch (frame.t) {
        case "stdin":
          target.write(decode(frame.d).toString("utf8"));
          break;
        case "resize":
          if (Number.isInteger(frame.cols) && Number.isInteger(frame.rows)) {
            target.resize(frame.cols, frame.rows);
          }
          break;
        case "signal":
          if (SIGNALS.has(frame.signal)) target.kill(frame.signal);
          break;
      }
    };
    teardown = () => {
      closed = true;
      pty?.kill("SIGHUP");
    };
    options
      .spawnPty({
        shell: request.command,
        args: [...request.args],
        cwd,
        cols,
        rows,
        env: { ...options.env, ...request.env },
      })
      .then(
        (spawned) => {
          if (closed) return spawned.kill("SIGHUP");
          pty = spawned;
          spawned.onData((data) => send({ t: "out", s: "stdout", d: encode(data) }));
          spawned.onExit(({ exitCode, signal }) => {
            send({ t: "exit", code: exitCode, signal: signal === null ? null : String(signal) });
            socket.end();
          });
          send({ t: "started", pid: spawned.pid });
          for (const frame of queued.splice(0)) applyPty(spawned, frame);
        },
        (cause) => fail(cause instanceof Error ? cause.message : String(cause)),
      );
  };

  readFrames(
    socket,
    (raw) => {
      const frame = raw as ClientFrame;
      if (dispatch !== undefined) return dispatch(frame);
      try {
        if (frame?.t !== "spawn") throw new Error("The first frame must be a spawn request.");
        if (frame.kind === "process") startProcess(frame);
        else if (frame.kind === "pty") startPty(frame);
        else throw new Error("Unknown spawn kind.");
      } catch (cause) {
        fail(cause instanceof Error ? cause.message : String(cause));
      }
    },
    fail,
  );
  socket.on("error", () => {});
  socket.on("close", () => teardown());
};

const isStale = (socketPath: string) =>
  new Promise<boolean>((resolve) => {
    const probe = NodeNet.connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(false);
    });
    probe.once("error", () => resolve(true));
  });

/**
 * Serves spawn requests for the user this process runs as. The socket's filesystem permissions are
 * the only authentication: whoever can connect can run commands as this user, so the socket must be
 * reachable by the T3 server and nobody else (0660, or a systemd socket unit with `SocketGroup`).
 */
export const serveRunner = async (options: RunnerServerOptions) => {
  if (process.getuid?.() === 0) throw new Error("The runner must not run as root.");
  const server = NodeNet.createServer((socket) => handleConnection(socket, options));
  if (options.socketPath === undefined) {
    if (process.env["LISTEN_FDS"] !== "1") {
      throw new Error("Pass --socket, or start the runner from a systemd socket unit.");
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ fd: 3 }, resolve);
    });
    return server;
  }
  const { socketPath } = options;
  if (NodeFs.existsSync(socketPath)) {
    if (!(await isStale(socketPath))) throw new Error(`A runner is already listening on ${socketPath}.`);
    NodeFs.unlinkSync(socketPath);
  }
  const previousUmask = process.umask(0o117);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } finally {
    process.umask(previousUmask);
  }
  NodeFs.chmodSync(socketPath, 0o660);
  return server;
};
