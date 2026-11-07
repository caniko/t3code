// @effect-diagnostics nodeBuiltinImport:off -- the fixture runner binds a real unix socket.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
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
const credentialToken = "synthetic-claude-oauth-token";
const credentialUnavailable = "The native Claude credential is unavailable.";

const credentialPath = (home: string) => NodePath.join(home, "claude-oauth-token");

const writeCredential = (home: string, contents = credentialToken) => {
  const path = credentialPath(home);
  NodeFS.writeFileSync(path, contents, { mode: 0o400 });
  NodeFS.chmodSync(path, 0o400);
  return path;
};

const writeScript = (home: string, name: string, body: string) => {
  const path = NodePath.join(home, name);
  NodeFS.writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  return path;
};

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
  options: { readonly env?: (home: string) => Readonly<Record<string, string>> } = {},
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const home = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3r-")));
      const socketPath = NodePath.join(home, "dejana.sock");
      const server = await serveRunner({
        socketPath,
        home,
        allowedRoots: [],
        env: { PATH: process.env["PATH"] ?? "", HOME: home, ...options.env?.(home) },
        spawnPty: fakePty,
      });
      return { server, socketPath, home };
    }),
    ({ socketPath, home }) => use({ socketPath, home }),
    ({ server, home }) =>
      Effect.sync(() => {
        server.close();
        NodeFS.rmSync(home, { recursive: true, force: true });
      }),
  );

const runCommand = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: string,
  args: ReadonlyArray<string>,
  options: object,
) =>
  Effect.scoped(
    spawner
      .spawn(ChildProcess.make(command, [...args], options))
      .pipe(
        Effect.flatMap((handle) =>
          Stream.mkString(Stream.decodeText(handle.stdout)).pipe(Effect.zip(handle.exitCode)),
        ),
      ),
  );

const runShell = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  script: string,
  options: object,
) => runCommand(spawner, "/bin/sh", ["-c", script], options);

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

  it.live(
    "passes a managed Claude credential as fd 3 without exposing it in the environment or argv",
    () =>
      withRunner(
        ({ socketPath, home }) =>
          Effect.gen(function* () {
            const claude = writeScript(
              home,
              "claude",
              [
                "token=$(cat <&3)",
                'printf "fd=%s\\n" "$token"',
                'printf "descriptor=%s\\n" "${CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR-<unset>}"',
                'case "$(env)" in *"$token"*) echo token-in-env ;; *) echo token-not-in-env ;; esac',
                'case "$*" in *"$token"*) echo token-in-argv ;; *) echo token-not-in-argv ;; esac',
                'printf "oauth-env=%s\\n" "${CLAUDE_CODE_OAUTH_TOKEN-<unset>}"',
                'printf "api-key=%s\\n" "${ANTHROPIC_API_KEY-<unset>}"',
                'printf "auth-token=%s\\n" "${ANTHROPIC_AUTH_TOKEN-<unset>}"',
                'printf "args=%s\\n" "$*"',
              ].join("\n"),
            );
            const spawner = makeRunnerSpawner({ socketPath, serverEnv });
            const [out, code] = yield* runCommand(spawner, claude, ["--print", "hi"], {
              cwd: home,
              env: {},
            });
            expect(code).toBe(0);
            expect(out).toBe(
              [
                `fd=${credentialToken}`,
                "descriptor=3",
                "token-not-in-env",
                "token-not-in-argv",
                "oauth-env=<unset>",
                "api-key=<unset>",
                "auth-token=<unset>",
                "args=--print hi",
                "",
              ].join("\n"),
            );
          }),
        {
          env: (home) => ({
            T3CODE_CLAUDE_OAUTH_TOKEN_FILE: writeCredential(home),
            CLAUDE_CODE_OAUTH_TOKEN: "ambient-oauth-token",
            CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "9",
            ANTHROPIC_API_KEY: "ambient-api-key",
            ANTHROPIC_AUTH_TOKEN: "ambient-auth-token",
          }),
        },
      ),
  );

  it.live("does not give the Claude credential fd to other commands", () =>
    withRunner(
      ({ socketPath, home }) =>
        Effect.gen(function* () {
          const spawner = makeRunnerSpawner({ socketPath, serverEnv });
          const [out, code] = yield* runShell(
            spawner,
            [
              "if cat <&3 >/dev/null 2>&1; then echo fd-open; else echo fd-closed; fi",
              'printf "descriptor=%s\\n" "${CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR-<unset>}"',
            ].join("\n"),
            { cwd: home, env: {} },
          );
          expect(code).toBe(0);
          expect(out).toBe("fd-closed\ndescriptor=<unset>\n");
        }),
      { env: (home) => ({ T3CODE_CLAUDE_OAUTH_TOKEN_FILE: writeCredential(home) }) },
    ),
  );

  it.live("fails closed when the managed Claude credential file is missing or unsafe", () =>
    withRunner(
      ({ socketPath, home }) =>
        Effect.gen(function* () {
          const claude = writeScript(home, "claude", "echo ran");
          const tokenPath = credentialPath(home);
          const request = {
            t: "spawn",
            kind: "process",
            command: claude,
            args: [],
            stdin: "ignore",
            env: {},
          } as const;
          expect(yield* rawRequest(socketPath, request)).toMatchObject({
            t: "error",
            message: credentialUnavailable,
          });

          NodeFS.writeFileSync(tokenPath, credentialToken);
          NodeFS.chmodSync(tokenPath, 0o640);
          expect(yield* rawRequest(socketPath, request)).toMatchObject({
            t: "error",
            message: credentialUnavailable,
          });

          const target = NodePath.join(home, "credential-target");
          NodeFS.writeFileSync(target, credentialToken, { mode: 0o400 });
          NodeFS.rmSync(tokenPath);
          NodeFS.symlinkSync(target, tokenPath);
          expect(yield* rawRequest(socketPath, request)).toMatchObject({
            t: "error",
            message: credentialUnavailable,
          });

          for (const contents of [
            "",
            " \t\n\r ",
            Buffer.from("token\0value"),
            Buffer.from("token\x01value"),
            Buffer.from("token\nvalue"),
            Buffer.from("token\tvalue"),
          ]) {
            NodeFS.rmSync(tokenPath, { force: true });
            NodeFS.writeFileSync(tokenPath, contents, { mode: 0o400 });
            expect(yield* rawRequest(socketPath, request)).toMatchObject({
              t: "error",
              message: credentialUnavailable,
            });
          }

          NodeFS.rmSync(tokenPath);
          NodeFS.writeFileSync(tokenPath, Buffer.alloc(16 * 1024 + 1, "a"), { mode: 0o400 });
          const oversized = yield* rawRequest(socketPath, request);
          expect(oversized).toMatchObject({ t: "error", message: credentialUnavailable });
          expect(JSON.stringify(oversized)).not.toContain(credentialToken);
          expect(JSON.stringify(oversized)).not.toContain(tokenPath);
        }),
      { env: (home) => ({ T3CODE_CLAUDE_OAUTH_TOKEN_FILE: credentialPath(home) }) },
    ),
  );

  it.live("keeps credential homes, files and tokens out of the server environment overlay", () =>
    withRunner(
      ({ socketPath, home }) =>
        Effect.gen(function* () {
          const trustedHome = NodePath.join(home, "trusted-claude-config");
          const trustedCredential = writeCredential(home);
          const spawner = makeRunnerSpawner({ socketPath, serverEnv });
          const [out, code] = yield* runShell(
            spawner,
            [
              'printf "home=%s\\n" "$CLAUDE_CONFIG_DIR"',
              'printf "file=%s\\n" "$T3CODE_CLAUDE_OAUTH_TOKEN_FILE"',
              'printf "oauth=%s\\n" "${CLAUDE_CODE_OAUTH_TOKEN-<unset>}"',
              'printf "api=%s\\n" "${ANTHROPIC_API_KEY-<unset>}"',
              'printf "bedrock=%s\\n" "$CLAUDE_CODE_USE_BEDROCK"',
              'printf "entrypoint=%s\\n" "$CLAUDE_CODE_ENTRYPOINT"',
            ].join("\n"),
            {
              cwd: home,
              env: {
                CLAUDE_CONFIG_DIR: "/evil/claude",
                CLAUDE_CODE_OAUTH_TOKEN: "overlay-oauth-token",
                ANTHROPIC_API_KEY: "overlay-api-key",
                T3CODE_CLAUDE_OAUTH_TOKEN_FILE: "/evil/credential",
                CLAUDE_CODE_USE_BEDROCK: "1",
                CLAUDE_CODE_ENTRYPOINT: "instance-entrypoint",
              },
            },
          );
          expect(code).toBe(0);
          expect(out).toBe(
            [
              `home=${trustedHome}`,
              `file=${trustedCredential}`,
              "oauth=<unset>",
              "api=<unset>",
              "bedrock=1",
              "entrypoint=instance-entrypoint",
              "",
            ].join("\n"),
          );

          const request = {
            t: "spawn",
            kind: "process",
            command: "/bin/sh",
            args: ["-c", "true"],
            stdin: "ignore",
          } as const;
          for (const key of [
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
            "CREDENTIALS_DIRECTORY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN_FILE",
            "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
            "CLAUDE_CODE_OAUTH_SCOPES",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "OPENAI_API_KEY",
            "T3CODE_CLAUDE_OAUTH_TOKEN_FILE",
            "T3CODE_OPENAI_OAUTH_COMMAND",
            "T3CODE_OPENAI_OAUTH_CONFIG_FILE",
            "T3CODE_OPENAI_CREDENTIAL_COMMAND",
          ]) {
            expect(
              yield* rawRequest(socketPath, { ...request, env: { [key]: "/evil" } }),
            ).toMatchObject({
              t: "error",
              message: `Environment override of ${key} is not allowed.`,
            });
          }
        }),
      {
        env: (home) => ({
          CLAUDE_CONFIG_DIR: NodePath.join(home, "trusted-claude-config"),
          T3CODE_CLAUDE_OAUTH_TOKEN_FILE: credentialPath(home),
          CLAUDE_CODE_USE_BEDROCK: "0",
        }),
      },
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
