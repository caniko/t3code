// @effect-diagnostics nodeBuiltinImport:off -- the client speaks raw unix sockets.
import * as NodeNet from "node:net";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import * as NodeSink from "@effect/platform-node-shared/NodeSink";
import * as NodeStream from "@effect/platform-node-shared/NodeStream";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

import {
  overlayEnv,
  readFrames,
  type RunnerFrame,
  sendFrame,
  type SpawnProcessFrame,
  type SpawnPtyFrame,
} from "./protocol.ts";

export interface RunnerExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface RunnerProcess {
  readonly pid: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exit: Promise<RunnerExit>;
  readonly kill: (signal: string) => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly dispose: () => void;
}

const LOST: RunnerExit = { code: null, signal: "SIGKILL" };

/** Connects, sends the spawn request and resolves once the runner reports the pid. */
const openRunnerConnection = (socketPath: string, request: SpawnProcessFrame | SpawnPtyFrame) =>
  new Promise<RunnerProcess>((resolve, reject) => {
    const socket = NodeNet.connect(socketPath);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let settled = false;
    let resolveExit!: (exit: RunnerExit) => void;
    const exit = new Promise<RunnerExit>((r) => (resolveExit = r));
    const finish = (result: RunnerExit) => {
      resolveExit(result);
      stdout.end();
      stderr.end();
    };
    const stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        sendFrame(socket, { t: "stdin", d: chunk.toString("base64") }, () => callback());
      },
      final: (callback) => {
        sendFrame(socket, { t: "stdin-end" }, () => callback());
      },
    });
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.once("connect", () => sendFrame(socket, request));
    socket.on("error", (error) => {
      fail(error);
      finish(LOST);
    });
    socket.on("close", () => {
      fail(new Error("The runner closed the connection before starting the process."));
      finish(LOST);
    });
    readFrames(
      socket,
      (raw) => {
        const frame = raw as RunnerFrame;
        switch (frame.t) {
          case "started":
            settled = true;
            resolve({
              pid: frame.pid,
              stdin,
              stdout,
              stderr,
              exit,
              kill: (signal) => void sendFrame(socket, { t: "signal", signal }),
              resize: (cols, rows) => void sendFrame(socket, { t: "resize", cols, rows }),
              dispose: () => socket.destroy(),
            });
            break;
          case "error":
            fail(new Error(frame.message));
            break;
          case "out":
            (frame.s === "stdout" ? stdout : stderr).write(Buffer.from(frame.d, "base64"));
            break;
          case "exit":
            finish({ code: frame.code, signal: frame.signal });
            break;
        }
      },
      (message) => fail(new Error(message)),
    );
  });

export interface RunnerEndpoint {
  readonly socketPath: string;
  readonly principal?: string;
  readonly serverEnv: Readonly<Record<string, string | undefined>>;
}

export const openRunnerProcess = (
  endpoint: RunnerEndpoint,
  input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd?: string | undefined;
    readonly env?: Readonly<Record<string, string | undefined>> | undefined;
    readonly stdin?: "pipe" | "ignore";
    readonly shell?: boolean | string | undefined;
  },
) =>
  openRunnerConnection(endpoint.socketPath, {
    t: "spawn",
    kind: "process",
    command: input.command,
    args: input.args,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    env: overlayEnv(input.env, endpoint.serverEnv),
    stdin: input.stdin ?? "pipe",
    ...(input.shell ? { shell: input.shell } : {}),
  });

const platformError = (method: string, command: string, cause: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "ChildProcess",
    method,
    pathOrDescriptor: command,
    description: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const unsupported = (command: string, what: string) =>
  Effect.fail(
    platformError("spawn", command, new Error(`${what} is not supported by the runner.`)),
  );

/** The runner wire carries plain strings, so a redacted word is unwrapped on its way out. */
const word = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const envWords = (
  env: Record<string, string | Redacted.Redacted<string> | undefined>,
): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value === undefined ? undefined : word(value)]),
  );

/** A `ChildProcessSpawner` whose processes run in the runner behind `endpoint`. */
export const makeRunnerSpawner = (endpoint: RunnerEndpoint) =>
  ChildProcessSpawner.make(
    Effect.fn("RunnerSpawner.spawn")(function* (command) {
      if (!ChildProcess.isStandardCommand(command)) {
        return yield* unsupported("pipeline", "Piped commands");
      }
      const { options } = command;
      if (options.additionalFds !== undefined && Object.keys(options.additionalFds).length > 0) {
        return yield* unsupported(command.command, "Additional file descriptors");
      }
      const stdinOption = options.stdin;
      const stdinConfig =
        typeof stdinOption === "object" && stdinOption !== null && "stream" in stdinOption
          ? stdinOption.stream
          : stdinOption;
      const isStream = typeof stdinConfig === "object" && stdinConfig !== null;
      for (const output of [options.stdout, options.stderr]) {
        const stream =
          typeof output === "object" && output !== null && "stream" in output
            ? output.stream
            : output;
        if (typeof stream === "object" && stream !== null) {
          return yield* unsupported(command.command, "Custom output sinks");
        }
      }
      const proc = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            openRunnerProcess(endpoint, {
              command: command.command,
              args: command.args.map(word),
              cwd: options.cwd,
              env: options.env === undefined ? undefined : envWords(options.env),
              stdin: stdinConfig === "ignore" || stdinConfig === "inherit" ? "ignore" : "pipe",
              shell: options.shell,
            }),
          catch: (cause) => platformError("spawn", command.command, cause),
        }),
        (spawned) => Effect.sync(() => spawned.dispose()),
      );
      const onError = (cause: unknown) => platformError("stream", command.command, cause);
      if (isStream) {
        yield* Stream.run(
          stdinConfig as Stream.Stream<Uint8Array, PlatformError.PlatformError>,
          NodeSink.fromWritable({ evaluate: () => proc.stdin, onError, endOnDone: true }),
        ).pipe(Effect.ignore, Effect.forkScoped);
      }
      const stdout = NodeStream.fromReadable<Uint8Array, PlatformError.PlatformError>({
        evaluate: () => proc.stdout,
        onError,
      });
      const stderr = NodeStream.fromReadable<Uint8Array, PlatformError.PlatformError>({
        evaluate: () => proc.stderr,
        onError,
      });
      const exited = Effect.promise(() => proc.exit);
      let running = true;
      void proc.exit.then(() => (running = false));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(proc.pid),
        exitCode: exited.pipe(
          Effect.flatMap((exit) =>
            exit.code === null
              ? Effect.fail(
                  platformError(
                    "exitCode",
                    command.command,
                    new Error(`Process ended by signal ${exit.signal}.`),
                  ),
                )
              : Effect.succeed(ChildProcessSpawner.ExitCode(exit.code)),
          ),
        ),
        isRunning: Effect.sync(() => running),
        kill: Effect.fn("RunnerSpawner.kill")(function* (killOptions) {
          proc.kill(killOptions?.killSignal ?? "SIGTERM");
          if (killOptions?.forceKillAfter === undefined) return yield* exited;
          const graceful = yield* exited.pipe(Effect.timeoutOption(killOptions.forceKillAfter));
          if (Option.isNone(graceful)) {
            proc.kill("SIGKILL");
            yield* exited;
          }
        }),
        stdin:
          isStream || stdinConfig === "ignore" || stdinConfig === "inherit"
            ? Sink.drain
            : NodeSink.fromWritable({ evaluate: () => proc.stdin, onError, endOnDone: true }),
        stdout,
        stderr,
        all: Stream.merge(stdout, stderr),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );

class RunnerPtyProcess implements PtyAdapter.PtyProcess {
  private readonly decoder = new StringDecoder("utf8");
  private readonly dataListeners = new Set<(data: string) => void>();
  private exitEvent: PtyAdapter.PtyExitEvent | undefined;
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();

  private readonly proc: RunnerProcess;

  constructor(proc: RunnerProcess) {
    this.proc = proc;
    proc.stdout.on("data", (chunk: Buffer) => {
      const text = this.decoder.write(chunk);
      if (text !== "") for (const listener of this.dataListeners) listener(text);
    });
    void proc.exit.then(({ code, signal }) => {
      this.exitEvent = {
        exitCode: code ?? -1,
        signal: signal === null ? null : Number(signal) || 1,
      };
      for (const listener of this.exitListeners) listener(this.exitEvent);
      this.exitListeners.clear();
      proc.dispose();
    });
  }

  get pid() {
    return this.proc.pid;
  }
  write(data: string) {
    this.proc.stdin.write(data);
  }
  resize(cols: number, rows: number) {
    this.proc.resize(cols, rows);
  }
  kill(signal?: string) {
    this.proc.kill(signal ?? "SIGHUP");
  }
  onData(callback: (data: string) => void) {
    this.dataListeners.add(callback);
    return () => void this.dataListeners.delete(callback);
  }
  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void) {
    if (this.exitEvent) {
      callback(this.exitEvent);
      return () => {};
    }
    this.exitListeners.add(callback);
    return () => void this.exitListeners.delete(callback);
  }
}

/** A `PtyAdapter` whose terminals are owned by the runner behind `endpoint`. */
export const makeRunnerPtyAdapter = (endpoint: RunnerEndpoint) =>
  PtyAdapter.PtyAdapter.of({
    spawn: Effect.fn("RunnerPtyAdapter.spawn")(function* (input) {
      const proc = yield* Effect.tryPromise({
        try: () =>
          openRunnerConnection(endpoint.socketPath, {
            t: "spawn",
            kind: "pty",
            command: input.shell,
            args: input.args ?? [],
            cwd: input.cwd,
            env: overlayEnv(input.env, endpoint.serverEnv),
            cols: input.cols,
            rows: input.rows,
          }),
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({ adapter: "runner", shell: input.shell, cause }),
      });
      return new RunnerPtyProcess(proc);
    }),
  });

interface ClaudeSpawnOptionsLike {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env: Record<string, string | undefined>;
  readonly signal: AbortSignal;
}

/** The synchronous process handle the Claude SDK's `spawnClaudeCodeProcess` hook expects; the runner connection opens behind it. */
export const spawnClaudeViaRunner = (
  endpoint: RunnerEndpoint,
  options: ClaudeSpawnOptionsLike,
  onStderr?: (chunk: string) => void,
) => {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let proc: RunnerProcess | undefined;
  let killRequested: string | undefined;
  const handle = Object.assign(emitter, {
    stdin,
    stdout,
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill(signal: NodeJS.Signals) {
      handle.killed = true;
      if (proc) proc.kill(signal);
      else killRequested = signal;
      return true;
    },
  });
  const onAbort = () => handle.kill("SIGTERM");
  if (options.signal.aborted) onAbort();
  else options.signal.addEventListener("abort", onAbort, { once: true });
  openRunnerProcess(endpoint, {
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
  }).then(
    (opened) => {
      proc = opened;
      if (killRequested !== undefined) opened.kill(killRequested);
      stdin.pipe(opened.stdin);
      opened.stdout.pipe(stdout);
      opened.stderr.setEncoding("utf8").on("data", (chunk: string) => onStderr?.(chunk));
      void opened.exit.then(({ code, signal }) => {
        handle.exitCode = code;
        handle.signalCode = signal as NodeJS.Signals | null;
        emitter.emit("exit", code, signal);
        opened.dispose();
      });
    },
    (cause) => {
      stdout.end();
      emitter.emit("error", cause instanceof Error ? cause : new Error(String(cause)));
    },
  );
  return handle;
};
