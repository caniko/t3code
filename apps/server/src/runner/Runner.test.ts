// @effect-diagnostics nodeBuiltinImport:off -- the fixture runner binds a real unix socket.
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/process";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  makeOpenCodeThreadProcesses,
  makePrincipalExecution,
  ProviderRunnerUnsupportedError,
  requireRunnerSupport,
} from "./PrincipalExecution.ts";
import { readFrames, sendFrame, type RunnerFrame } from "./protocol.ts";
import { makeRunnerPtyAdapter, makeRunnerSpawner } from "./RunnerClient.ts";
import { serveRunner } from "./RunnerServer.ts";

const serverEnv = { HOME: "/var/lib/t3code", SERVER_SECRET: "s3cret" };

const fakePty: Parameters<typeof serveRunner>[0]["spawnPty"] = async (input) => {
  const child = NodeChildProcess.spawn(input.shell, input.args ?? [], {
    cwd: input.cwd,
    env: input.env,
  });
  child.stdout.setEncoding("utf8");
  return {
    pid: child.pid!,
    write: (data) => void child.stdin.write(data),
    resize: () => {},
    kill: (signal) => void child.kill(signal as NodeJS.Signals),
    onData: (callback) => {
      child.stdout.on("data", callback);
      return () => {};
    },
    onExit: (callback) => {
      child.on("exit", (code) => callback({ exitCode: code ?? -1, signal: null }));
      return () => {};
    },
  };
};

const withRunner = <A, E, R>(
  use: (input: { socketPath: string; home: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const home = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3r-")));
      const socketPath = NodePath.join(home, "dejana.sock");
      const server = await serveRunner({
        socketPath,
        home,
        allowedRoots: [],
        env: { PATH: process.env["PATH"] ?? "", HOME: home },
        spawnPty: fakePty,
      });
      return { server, socketPath, home };
    }),
    ({ socketPath, home }) => use({ socketPath, home }),
    ({ server, home }) =>
      Effect.sync(() => {
        server.close();
        NodeFs.rmSync(home, { recursive: true, force: true });
      }),
  );

const runShell = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  script: string,
  options: object,
) =>
  Effect.scoped(
    spawner
      .spawn(ChildProcess.make("/bin/sh", ["-c", script], options))
      .pipe(
        Effect.flatMap((handle) =>
          Stream.mkString(Stream.decodeText(handle.stdout)).pipe(Effect.zip(handle.exitCode)),
        ),
      ),
  );

const rawRequest = (socketPath: string, frame: Parameters<typeof sendFrame>[1]) =>
  Effect.promise(
    () =>
      new Promise<RunnerFrame>((resolve) => {
        const socket = NodeNet.connect(socketPath, () => sendFrame(socket, frame));
        readFrames(
          socket,
          (raw) => {
            resolve(raw as RunnerFrame);
            socket.destroy();
          },
          () => {},
        );
      }),
  );

describe("runner", () => {
  it.live(
    "runs a process in the requested cwd with the overlaid env and the runner's own HOME",
    () =>
      withRunner(({ socketPath, home }) =>
        Effect.gen(function* () {
          const spawner = makeRunnerSpawner({ socketPath, serverEnv });
          const [out, code] = yield* runShell(spawner, 'pwd; echo "$FOO|$HOME|$SERVER_SECRET"', {
            cwd: home,
            env: { ...serverEnv, FOO: "bar", HOME: "/evil" },
          });
          expect(code).toBe(0);
          expect(out).toBe(`${home}\nbar|${home}|\n`);
        }),
      ),
  );

  it.live("rejects a cwd outside the allowed roots and protected env keys", () =>
    withRunner(({ socketPath }) =>
      Effect.gen(function* () {
        const spawner = makeRunnerSpawner({ socketPath, serverEnv });
        const escaped = yield* Effect.exit(runShell(spawner, "true", { cwd: "/" }));
        expect(Exit.isFailure(escaped)).toBe(true);
        const base = {
          t: "spawn",
          kind: "process",
          command: "true",
          args: [],
          stdin: "ignore",
        } as const;
        expect(yield* rawRequest(socketPath, { ...base, env: { PATH: "/evil" } })).toMatchObject({
          t: "error",
          message: "Environment override of PATH is not allowed.",
        });
        expect(yield* rawRequest(socketPath, { ...base, env: {}, cwd: "relative" })).toMatchObject({
          t: "error",
        });
      }),
    ),
  );

  it.live("sends non-default principals to their runner and the default one in-process", () =>
    withRunner(({ socketPath, home }) =>
      Effect.gen(function* () {
        const execution = makePrincipalExecution({
          ownerOf: (threadId) => Effect.succeed(threadId === "mine" ? undefined : "dejana"),
          ownersOfPath: (cwd) => Effect.succeed(cwd.startsWith(home) ? ["dejana"] : []),
          socketExists: (path) => Effect.succeed(path === socketPath),
          socketTemplate: NodePath.join(home, "%u.sock"),
          serverEnv,
        });
        expect(yield* execution.spawnerFor("mine")).toBeUndefined();
        const spawner = yield* execution.spawnerFor("theirs");
        const [out] = yield* runShell(spawner!, "echo $HOME", { cwd: home });
        expect(out).toBe(`${home}\n`);
        expect(yield* execution.spawnerForPath("/srv/elsewhere")).toBeUndefined();
        expect(yield* execution.spawnerForPath(home)).toBeDefined();
      }),
    ),
  );

  it.live("runs a terminal in the runner and streams data, input and exit", () =>
    withRunner(({ socketPath, home }) =>
      Effect.gen(function* () {
        const pty = makeRunnerPtyAdapter({ socketPath, serverEnv });
        const process = yield* pty.spawn({
          shell: "/bin/sh",
          args: ["-c", "exec cat"],
          cwd: home,
          cols: 80,
          rows: 24,
          env: {},
        });
        const echoed = new Promise<string>((resolve) => {
          let seen = "";
          process.onData((data) => {
            seen += data;
            if (seen.includes("hi\n")) resolve(seen);
          });
        });
        const exited = new Promise<number>((resolve) =>
          process.onExit((event) => resolve(event.exitCode)),
        );
        process.write("hi\n");
        expect(yield* Effect.promise(() => echoed)).toContain("hi");
        process.kill("SIGTERM");
        expect(yield* Effect.promise(() => exited)).toBeDefined();
      }),
    ),
  );

  it.live(
    "fails closed when the runner socket is missing or the principal is not a user name",
    () =>
      Effect.gen(function* () {
        const execution = makePrincipalExecution({
          ownerOf: (threadId) => Effect.succeed(threadId),
          ownersOfPath: () => Effect.succeed([]),
          socketExists: () => Effect.succeed(false),
          socketTemplate: "/run/t3code/runner-%u.sock",
          serverEnv,
        });
        const missing = yield* Effect.flip(execution.spawnerFor("dejana"));
        expect(missing.message).toContain("/run/t3code/runner-dejana.sock");
        const traversal = yield* Effect.flip(execution.runnerFor("../../etc/x"));
        expect(traversal.socketPath).not.toContain("..");
      }),
  );

  it.live("runs an OpenCode server in the thread owner's runner", () =>
    withRunner(({ socketPath, home }) =>
      Effect.gen(function* () {
        const execution = makePrincipalExecution({
          ownerOf: (threadId) => Effect.succeed(threadId === "mine" ? undefined : "dejana"),
          ownersOfPath: () => Effect.succeed([]),
          socketExists: (path) => Effect.succeed(path === socketPath),
          socketTemplate: socketPath,
          serverEnv,
        });
        const processes = makeOpenCodeThreadProcesses(execution);
        expect(yield* processes.forThread("mine")).toBeUndefined();
        const theirs = yield* processes.forThread("theirs");
        expect(theirs?.owner).toBe("dejana");
        expect(yield* processes.forThread("theirs-2")).toMatchObject({ owner: "dejana" });
        const [out, code] = yield* runShell(
          theirs!.spawner,
          'pwd; echo "$HOME|$OPENCODE_LOG|$SERVER_SECRET"',
          { cwd: home, env: { ...serverEnv, OPENCODE_LOG: "debug", HOME: "/evil" } },
        );
        expect(code).toBe(0);
        expect(out).toBe(`${home}\n${home}|debug|\n`);

        const offline = makePrincipalExecution({
          ownerOf: () => Effect.succeed("dejana"),
          ownersOfPath: () => Effect.succeed([]),
          socketExists: () => Effect.succeed(false),
          socketTemplate: "/run/t3code/runner-%u.sock",
          serverEnv,
        });
        const missing = yield* Effect.flip(
          makeOpenCodeThreadProcesses(offline).forThread("theirs"),
        );
        expect(missing.detail).toContain("/run/t3code/runner-dejana.sock");
      }),
    ),
  );

  it.live(
    "fails closed for providers that spawn in-process when a runner principal owns the thread",
    () =>
      Effect.gen(function* () {
        const execution = makePrincipalExecution({
          ownerOf: (threadId) => Effect.succeed(threadId === "mine" ? undefined : "dejana"),
          ownersOfPath: () => Effect.succeed([]),
          socketExists: () => Effect.succeed(true),
          socketTemplate: "/run/t3code/runner-%u.sock",
          serverEnv,
        });
        yield* requireRunnerSupport(execution, "mine", "cursor");
        yield* requireRunnerSupport(execution, "theirs", "codex");
        const refused = yield* Effect.flip(requireRunnerSupport(execution, "theirs", "cursor"));
        expect(refused).toBeInstanceOf(ProviderRunnerUnsupportedError);
        expect(refused.message).toContain("not supported for signed-in users yet");
      }),
  );
});
