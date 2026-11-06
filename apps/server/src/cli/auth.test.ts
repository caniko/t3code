// @effect-diagnostics nodeBuiltinImport:off - the helper writes real protected files.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { writeIssuedSessionToken } from "./auth.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

const withTempDir = <A, E, R>(run: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-auth-issue-"))),
    run,
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  ).pipe(Effect.provide(layerCliRuntime));

const issued = {
  sessionId: AuthSessionId.make("session-1"),
  token: "secret-token",
};

const revokingAuth = (revoked: Ref.Ref<ReadonlyArray<string>>) => ({
  revokeSession: (sessionId: AuthSessionId) =>
    Ref.update(revoked, (ids) => [...ids, sessionId]).pipe(Effect.as(true)),
});

it.effect("revokes the issued session when its token file cannot be written", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const revoked = yield* Ref.make<ReadonlyArray<string>>([]);

      // The directory itself is not a writable file destination.
      const error = yield* writeIssuedSessionToken(revokingAuth(revoked), issued, dir).pipe(
        Effect.flip,
      );

      expect(yield* Ref.get(revoked)).toEqual(["session-1"]);
      expect(error.message).toContain(dir);
      expect(error.message).not.toContain("secret-token");
    }),
  ),
);

it.effect("keeps the session when the token file was written", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const revoked = yield* Ref.make<ReadonlyArray<string>>([]);
      const file = NodePath.join(dir, "token");

      yield* writeIssuedSessionToken(revokingAuth(revoked), issued, file);

      expect(yield* Ref.get(revoked)).toEqual([]);
      expect(NodeFS.readFileSync(file, "utf8")).toBe("secret-token");
      expect(NodeFS.statSync(file).mode & 0o777).toBe(0o600);
    }),
  ),
);
