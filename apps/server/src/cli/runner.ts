// @effect-diagnostics nodeBuiltinImport:off -- the runner serves its own home directory.
import * as NodeOs from "node:os";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/cli";

import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { serveRunner } from "../runner/RunnerServer.ts";

export const runnerCommand = Command.make("runner", {
  socket: Flag.String("socket").pipe(
    Flag.withDescription("Unix socket to listen on. Omit under a systemd socket unit."),
    Flag.optional,
  ),
  allowRoot: Flag.String("allow-root").pipe(
    Flag.withDescription("Directory outside the home that work may run in. Repeatable."),
    Flag.between(0, 64),
  ),
}).pipe(
  Command.withDescription(
    "Run spawn requests from the T3 server as this user. Started by t3-runner@<user>.service.",
  ),
  Command.withHandler(({ socket, allowRoot }) =>
    Effect.gen(function* () {
      const pty = yield* PtyAdapter.PtyAdapter;
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      yield* Effect.promise(() =>
        serveRunner({
          ...(Option.isSome(socket) ? { socketPath: socket.value } : {}),
          home: NodeOs.homedir(),
          allowedRoots: allowRoot,
          env: process.env,
          spawnPty: (input) => runPromise(pty.spawn(input)),
        }),
      );
      return yield* Effect.never;
    }).pipe(Effect.provide(NodePtyAdapter.layer)),
  ),
);
