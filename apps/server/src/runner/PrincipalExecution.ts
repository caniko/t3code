import { DEFAULT_PRINCIPAL_ID } from "@t3tools/contracts";
import type { AgentScopeShape } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { makeRunnerPtyAdapter, makeRunnerSpawner, type RunnerEndpoint } from "./RunnerClient.ts";

export class RunnerUnavailableError extends Schema.TaggedError<RunnerUnavailableError>()(
  "RunnerUnavailableError",
  { principal: Schema.String, socketPath: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `The runner for principal '${this.principal}' is unavailable at ${this.socketPath}: ${this.reason}. Work is not run as the server user.`;
  }
}

/** Where a thread's work runs. `undefined` means in this process, as the server user. */
export interface PrincipalExecutionShape {
  readonly spawnerFor: (
    threadId: string,
  ) => Effect.Effect<ChildProcessSpawner.ChildProcessSpawner["Service"] | undefined, RunnerUnavailableError>;
  readonly ptyFor: (
    threadId: string,
  ) => Effect.Effect<PtyAdapter.PtyAdapter["Service"] | undefined, RunnerUnavailableError>;
  readonly runnerFor: (threadId: string) => Effect.Effect<RunnerEndpoint | undefined, RunnerUnavailableError>;
}

/** Unwired code (and single-user installs) keep spawning in-process. */
export const PrincipalExecution = Context.Reference<PrincipalExecutionShape>(
  "t3/runner/PrincipalExecution",
  {
    defaultValue: () => ({
      spawnerFor: () => Effect.undefined,
      ptyFor: () => Effect.undefined,
      runnerFor: () => Effect.undefined,
    }),
  },
);

/** Principal ids are Linux user names, so anything else could not name a runner and must not reach a path. */
const USERNAME = /^[a-z_][a-z0-9_-]{0,31}$/;

export const runnerSocketPath = (template: string, principal: string) =>
  template.replaceAll("%u", principal);

export const passthroughAgentScope: AgentScopeShape = {
  wrap: ({ command, args }) => Effect.succeed({ command, args }),
  oomKilled: () => Effect.succeed(false),
  stop: () => Effect.void,
  kill: () => Effect.succeed(false),
  clear: () => Effect.void,
};

export const makePrincipalExecution = (input: {
  readonly ownerOf: (threadId: string) => Effect.Effect<string | undefined, ProjectionStore.ProjectionStoreV2Error>;
  readonly socketExists: (socketPath: string) => Effect.Effect<boolean>;
  readonly socketTemplate: string;
  readonly serverEnv: NodeJS.ProcessEnv;
}): PrincipalExecutionShape => {
  const runnerFor = Effect.fn("PrincipalExecution.runnerFor")(function* (threadId: string) {
    const owner = yield* input.ownerOf(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new RunnerUnavailableError({
            principal: "unknown",
            socketPath: input.socketTemplate,
            reason: `could not read the thread owner (${String(cause)})`,
          }),
      ),
    );
    const principal = owner ?? DEFAULT_PRINCIPAL_ID;
    if (principal === DEFAULT_PRINCIPAL_ID) return undefined;
    const socketPath = runnerSocketPath(input.socketTemplate, USERNAME.test(principal) ? principal : "invalid");
    if (!USERNAME.test(principal)) {
      return yield* new RunnerUnavailableError({ principal, socketPath, reason: "not a valid Linux user name" });
    }
    if (!(yield* input.socketExists(socketPath))) {
      return yield* new RunnerUnavailableError({ principal, socketPath, reason: "no runner socket" });
    }
    return { socketPath, serverEnv: input.serverEnv } satisfies RunnerEndpoint;
  });
  return {
    runnerFor,
    spawnerFor: (threadId) =>
      runnerFor(threadId).pipe(Effect.map((endpoint) => endpoint && makeRunnerSpawner(endpoint))),
    ptyFor: (threadId) =>
      runnerFor(threadId).pipe(Effect.map((endpoint) => endpoint && makeRunnerPtyAdapter(endpoint))),
  };
};

export const layer = Layer.effect(
  PrincipalExecution,
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const fs = yield* FileSystem.FileSystem;
    const serverEnv = yield* HostProcess.Environment;
    const socketTemplate = yield* Config.String("T3CODE_RUNNER_SOCKET_TEMPLATE").pipe(
      Config.withDefault("/run/t3code/runner-%u.sock"),
    );
    return makePrincipalExecution({
      ownerOf: (threadId) =>
        store.getThreadShell(threadId as never).pipe(
          Effect.map((shell) => shell?.ownerPrincipal),
        ),
      socketExists: (socketPath) =>
        fs.stat(socketPath).pipe(
          Effect.map((info) => info.type === "Socket"),
          Effect.orElseSucceed(() => false),
        ),
      socketTemplate,
      serverEnv,
    });
  }),
);
