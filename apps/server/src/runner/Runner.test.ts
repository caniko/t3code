// @effect-diagnostics nodeBuiltinImport:off -- the fixture runner binds a real unix socket.
import * as NodeFs from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/process";

import { makePrincipalExecution } from "./PrincipalExecution.ts";
import { readFrames, sendFrame, type RunnerFrame } from "./protocol.ts";
import { makeRunnerSpawner } from "./RunnerClient.ts";
import { serveRunner } from "./RunnerServer.ts";

const serverEnv = { HOME: "/var/lib/t3code", SERVER_SECRET: "s3cret" };

const withRunner = <A, E, R>(use: (input: { socketPath: string; home: string }) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const home = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3r-")));
      const socketPath = NodePath.join(home, "dejana.sock");
      const server = await serveRunner({
        socketPath,
        home,
        allowedRoots: [],
        env: { PATH: process.env["PATH"] ?? "", HOME: home },
        spawnPty: () => Promise.reject(new Error("no pty in tests")),
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

const runShell = (spawner: ReturnType<typeof makeRunnerSpawner>, script: string, options: object) =>
  Effect.scoped(
    spawner.spawn(ChildProcess.make("/bin/sh", ["-c", script], options)).pipe(
      Effect.flatMap((handle) =>
        Stream.mkString(Stream.decodeText(handle.stdout)).pipe(
          Effect.zip(handle.exitCode),
        ),
      ),
    ),
  );

const rawRequest = (socketPath: string, frame: Parameters<typeof sendFrame>[1]) =>
  Effect.promise(
    () =>
      new Promise<RunnerFrame>((resolve) => {
        const socket = NodeNet.connect(socketPath, () => sendFrame(socket, frame));
        readFrames(socket, (raw) => { resolve(raw as RunnerFrame); socket.destroy(); }, () => {});
      }),
  );

describe("runner", () => {
  it.live("runs a process in the requested cwd with the overlaid env and the runner's own HOME", () =>
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
        const base = { t: "spawn", kind: "process", command: "true", args: [], stdin: "ignore" } as const;
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
          socketExists: (path) => Effect.succeed(path === socketPath),
          socketTemplate: NodePath.join(home, "%u.sock"),
          serverEnv,
        });
        expect(yield* execution.spawnerFor("mine")).toBeUndefined();
        const spawner = yield* execution.spawnerFor("theirs");
        const [out] = yield* runShell(spawner!, "echo $HOME", { cwd: home });
        expect(out).toBe(`${home}\n`);
      }),
    ),
  );

  it.live("fails closed when the runner socket is missing or the principal is not a user name", () =>
    Effect.gen(function* () {
      const execution = makePrincipalExecution({
        ownerOf: (threadId) => Effect.succeed(threadId),
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
});
