import { assert, it } from "@effect/vitest";
import { ThreadId, type SessionAccessMutation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SessionAccess from "./SessionAccess.ts";

const layerTest = SessionAccess.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const groupId = (id: string) => id as never;
const thread = (id: string) => ThreadId.make(id);

const insertThread = (id: string, owner: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = JSON.stringify(owner === null ? {} : { ownerPrincipal: owner });
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
         created_at, updated_at, payload_json)
      VALUES (${id}, 'p', 't', 'codex', 'full-access', 'default', 'x', 'x', ${payload})
    `;
  });

const reasonOf = <A, E extends { readonly reason?: string }>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

const create = (id: string): SessionAccessMutation => ({
  type: "group.create",
  groupId: groupId(id),
  name: id as never,
});

it.layer(layerTest)("SessionAccess", (it) => {
  it.effect("only the thread owner shares a thread, and a grant opens it for the grantee", () =>
    Effect.gen(function* () {
      const access = yield* SessionAccess.SessionAccess;
      yield* insertThread("t-share", "alice");
      const share = (principal: string): SessionAccessMutation => ({
        type: "thread.share",
        threadId: thread("t-share"),
        principal: "carol",
        role: "participant",
      });
      assert.strictEqual(yield* reasonOf(access.mutate("bob", share("bob"))), "not_found");
      yield* access.mutate("alice", share("alice"));
      assert.strictEqual((yield* access.grantsFor("carol")).get("t-share"), "participant");
      // A grantee sees the thread but still cannot share it on.
      assert.strictEqual(yield* reasonOf(access.mutate("carol", share("carol"))), "forbidden");
      assert.strictEqual(
        yield* reasonOf(
          access.mutate("alice", {
            ...share("alice"),
            principal: "alice",
          } as SessionAccessMutation),
        ),
        "invalid",
      );
      yield* access.mutate("alice", {
        type: "thread.unshare",
        threadId: thread("t-share"),
        principal: "carol",
      });
      assert.isFalse((yield* access.grantsFor("carol")).has("t-share"));
    }),
  );

  it.effect("group membership grants its threads; only the group owner manages it", () =>
    Effect.gen(function* () {
      const access = yield* SessionAccess.SessionAccess;
      yield* insertThread("t-group", "alice");
      yield* insertThread("t-bobs", "bob");
      yield* access.mutate("alice", create("g1"));
      yield* access.mutate("alice", {
        type: "group.thread.add",
        groupId: groupId("g1"),
        threadId: thread("t-group"),
      });
      yield* access.mutate("alice", {
        type: "group.member.invite",
        groupId: groupId("g1"),
        principal: "bob",
        role: "viewer",
      });
      assert.strictEqual((yield* access.grantsFor("bob")).get("t-group"), "viewer");
      // The cached grants refresh after a role change.
      yield* access.mutate("alice", {
        type: "group.member.invite",
        groupId: groupId("g1"),
        principal: "bob",
        role: "participant",
      });
      assert.strictEqual((yield* access.grantsFor("bob")).get("t-group"), "participant");

      const invite: SessionAccessMutation = {
        type: "group.member.invite",
        groupId: groupId("g1"),
        principal: "dave",
        role: "viewer",
      };
      assert.strictEqual(yield* reasonOf(access.mutate("bob", invite)), "forbidden");
      assert.strictEqual(yield* reasonOf(access.mutate("eve", invite)), "not_found");
      // A group holds only its owner's threads, and a thread joins one group.
      assert.strictEqual(
        yield* reasonOf(
          access.mutate("alice", {
            type: "group.thread.add",
            groupId: groupId("g1"),
            threadId: thread("t-bobs"),
          }),
        ),
        "forbidden",
      );
      yield* access.mutate("alice", create("g2"));
      assert.strictEqual(
        yield* reasonOf(
          access.mutate("alice", {
            type: "group.thread.add",
            groupId: groupId("g2"),
            threadId: thread("t-group"),
          }),
        ),
        "conflict",
      );

      const snapshot = yield* access.snapshot("bob");
      assert.deepStrictEqual(
        snapshot.groups.map((group) => ({
          id: group.id,
          role: group.callerRole,
          threads: group.threadIds,
        })),
        [{ id: groupId("g1"), role: "participant", threads: [thread("t-group")] }],
      );

      yield* access.mutate("alice", { type: "group.delete", groupId: groupId("g1") });
      assert.isFalse((yield* access.grantsFor("bob")).has("t-group"));
    }),
  );
});
