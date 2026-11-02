import {
  DEFAULT_PRINCIPAL_ID,
  type SessionAccessMutation,
  SessionAccessError,
  type SessionAccessSnapshot,
  type SessionGroup,
  type SessionGroupId,
  type SessionRole,
  type SessionThreadShare,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { ThreadGrants } from "./ThreadOwnership.ts";

export class SessionAccess extends Context.Service<
  SessionAccess,
  {
    /** The threads of other principals this principal may open, with the role it holds on each. */
    readonly grantsFor: (principal: string) => Effect.Effect<ThreadGrants>;
    readonly snapshot: (
      principal: string,
    ) => Effect.Effect<SessionAccessSnapshot, SessionAccessError>;
    /** Owner-only: who a thread is shared with directly. */
    readonly threadShares: (
      principal: string,
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<SessionThreadShare>, SessionAccessError>;
    readonly mutate: (
      principal: string,
      mutation: SessionAccessMutation,
    ) => Effect.Effect<void, SessionAccessError>;
  }
>()("t3/orchestration-v2/SessionAccess") {}

const fail = (reason: SessionAccessError["reason"], message: string) =>
  new SessionAccessError({ reason, message });

const strongest = (a: SessionRole | undefined, b: SessionRole): SessionRole =>
  a === "participant" || b === "participant" ? "participant" : "viewer";

export const layer = Layer.effect(
  SessionAccess,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const storage = Effect.mapError((cause: unknown) =>
      fail("storage", cause instanceof Error ? cause.message : "Session access storage failed."),
    );

    const grantsFor: SessionAccess["Service"]["grantsFor"] = Effect.fn("SessionAccess.grantsFor")(
      function* (principal) {
        // ponytail: one indexed read per call, so the CLI writing the database directly is seen at once; cache by `PRAGMA data_version` if shell streams get hot.
        const rows = yield* sql<{ readonly thread_id: string; readonly role: SessionRole }>`
          SELECT thread_id, role FROM session_shares WHERE principal = ${principal}
          UNION ALL
          SELECT gt.thread_id, m.role
          FROM session_group_members m
          JOIN session_group_threads gt ON gt.group_id = m.group_id
          WHERE m.principal = ${principal}
        `.pipe(Effect.orDie);
        const grants = new Map<string, SessionRole>();
        for (const row of rows)
          grants.set(row.thread_id, strongest(grants.get(row.thread_id), row.role));
        return grants;
      },
    );

    const threadOwner = Effect.fn("SessionAccess.threadOwner")(function* (threadId: ThreadId) {
      const rows = yield* sql<{ readonly owner: string | null }>`
        SELECT json_extract(payload_json, '$.ownerPrincipal') AS owner
        FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId} AND deleted_at IS NULL
      `;
      return rows[0] === undefined ? null : (rows[0].owner ?? DEFAULT_PRINCIPAL_ID);
    });

    /** Owner or the default principal; anyone else who cannot see the thread learns nothing of it. */
    const requireThreadOwner = Effect.fn("SessionAccess.requireThreadOwner")(function* (
      principal: string,
      threadId: ThreadId,
    ) {
      const owner = yield* threadOwner(threadId);
      if (owner === null) return yield* fail("not_found", "Thread not found");
      if (principal === DEFAULT_PRINCIPAL_ID || principal === owner) return owner;
      const grants = yield* grantsFor(principal);
      return yield* grants.has(threadId)
        ? fail("forbidden", "Only the thread owner can change who it is shared with")
        : fail("not_found", "Thread not found");
    });

    const requireGroupOwner = Effect.fn("SessionAccess.requireGroupOwner")(function* (
      principal: string,
      groupId: SessionGroupId,
    ) {
      const rows = yield* sql<{ readonly owner_principal: string }>`
        SELECT owner_principal FROM session_groups WHERE id = ${groupId}
      `;
      const owner = rows[0]?.owner_principal;
      if (owner === undefined) return yield* fail("not_found", "Group not found");
      if (principal === DEFAULT_PRINCIPAL_ID || principal === owner) return owner;
      const member = yield* sql`
        SELECT 1 FROM session_group_members WHERE group_id = ${groupId} AND principal = ${principal}
      `;
      return yield* member.length > 0
        ? fail("forbidden", "Only the group owner can change the group")
        : fail("not_found", "Group not found");
    });

    const apply = Effect.fn("SessionAccess.apply")(function* (
      principal: string,
      mutation: SessionAccessMutation,
    ) {
      switch (mutation.type) {
        case "group.create": {
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          const exists = yield* sql`SELECT 1 FROM session_groups WHERE id = ${mutation.groupId}`;
          if (exists.length > 0) return yield* fail("conflict", "Group already exists");
          yield* sql`
            INSERT INTO session_groups (id, name, owner_principal, created_at)
            VALUES (${mutation.groupId}, ${mutation.name}, ${principal}, ${createdAt})
          `;
          return;
        }
        case "group.rename":
          yield* requireGroupOwner(principal, mutation.groupId);
          yield* sql`UPDATE session_groups SET name = ${mutation.name} WHERE id = ${mutation.groupId}`;
          return;
        case "group.delete":
          yield* requireGroupOwner(principal, mutation.groupId);
          yield* sql`DELETE FROM session_groups WHERE id = ${mutation.groupId}`;
          return;
        case "group.thread.add": {
          const groupOwner = yield* requireGroupOwner(principal, mutation.groupId);
          const threadOwnerPrincipal = yield* threadOwner(mutation.threadId);
          if (threadOwnerPrincipal === null) return yield* fail("not_found", "Thread not found");
          if (threadOwnerPrincipal !== groupOwner) {
            return yield* fail("forbidden", "A group holds only its owner's threads");
          }
          const current = yield* sql<{ readonly group_id: string }>`
            SELECT group_id FROM session_group_threads WHERE thread_id = ${mutation.threadId}
          `;
          if (current[0] !== undefined && current[0].group_id !== mutation.groupId) {
            return yield* fail("conflict", "The thread already belongs to another group");
          }
          yield* sql`
            INSERT OR IGNORE INTO session_group_threads (group_id, thread_id)
            VALUES (${mutation.groupId}, ${mutation.threadId})
          `;
          return;
        }
        case "group.thread.remove":
          yield* requireGroupOwner(principal, mutation.groupId);
          yield* sql`
            DELETE FROM session_group_threads
            WHERE group_id = ${mutation.groupId} AND thread_id = ${mutation.threadId}
          `;
          return;
        case "group.member.invite": {
          const groupOwner = yield* requireGroupOwner(principal, mutation.groupId);
          if (mutation.principal === groupOwner) {
            return yield* fail("invalid", "The group owner is already a member");
          }
          yield* sql`
            INSERT INTO session_group_members (group_id, principal, role)
            VALUES (${mutation.groupId}, ${mutation.principal}, ${mutation.role})
            ON CONFLICT (group_id, principal) DO UPDATE SET role = excluded.role
          `;
          return;
        }
        case "group.member.remove":
          yield* requireGroupOwner(principal, mutation.groupId);
          yield* sql`
            DELETE FROM session_group_members
            WHERE group_id = ${mutation.groupId} AND principal = ${mutation.principal}
          `;
          return;
        case "thread.share": {
          const owner = yield* requireThreadOwner(principal, mutation.threadId);
          if (mutation.principal === owner) {
            return yield* fail("invalid", "The owner already has the thread");
          }
          yield* sql`
            INSERT INTO session_shares (thread_id, principal, role)
            VALUES (${mutation.threadId}, ${mutation.principal}, ${mutation.role})
            ON CONFLICT (thread_id, principal) DO UPDATE SET role = excluded.role
          `;
          return;
        }
        case "thread.unshare":
          yield* requireThreadOwner(principal, mutation.threadId);
          yield* sql`
            DELETE FROM session_shares
            WHERE thread_id = ${mutation.threadId} AND principal = ${mutation.principal}
          `;
          return;
      }
    });

    return SessionAccess.of({
      grantsFor,
      mutate: Effect.fn("SessionAccess.mutate")(function* (principal, mutation) {
        yield* sql
          .withTransaction(apply(principal, mutation))
          .pipe(
            Effect.mapError((cause) =>
              Schema.is(SessionAccessError)(cause) ? cause : fail("storage", String(cause)),
            ),
          );
      }),
      threadShares: Effect.fn("SessionAccess.threadShares")(function* (principal, threadId) {
        yield* requireThreadOwner(principal, threadId).pipe(storage);
        return yield* sql<SessionThreadShare>`
          SELECT principal, role FROM session_shares WHERE thread_id = ${threadId} ORDER BY principal
        `.pipe(storage);
      }),
      snapshot: Effect.fn("SessionAccess.snapshot")(function* (principal) {
        const groupRows = yield* sql<{
          readonly id: SessionGroupId;
          readonly name: string;
          readonly owner_principal: string;
          readonly created_at: string;
        }>`
          SELECT id, name, owner_principal, created_at FROM session_groups
          WHERE owner_principal = ${principal}
            OR id IN (SELECT group_id FROM session_group_members WHERE principal = ${principal})
          ORDER BY created_at, id
        `.pipe(storage);
        const ids = groupRows.map((group) => group.id);
        const members =
          ids.length === 0
            ? []
            : yield* sql<{
                readonly group_id: string;
                readonly principal: string;
                readonly role: SessionRole;
              }>`
                SELECT group_id, principal, role FROM session_group_members
                WHERE group_id IN ${sql.in(ids)} ORDER BY principal
              `.pipe(storage);
        const threads =
          ids.length === 0
            ? []
            : yield* sql<{ readonly group_id: string; readonly thread_id: ThreadId }>`
                SELECT group_id, thread_id FROM session_group_threads
                WHERE group_id IN ${sql.in(ids)} ORDER BY thread_id
              `.pipe(storage);
        const shared = yield* sql<{ readonly thread_id: ThreadId; readonly role: SessionRole }>`
          SELECT thread_id, role FROM session_shares WHERE principal = ${principal} ORDER BY thread_id
        `.pipe(storage);
        const groups = groupRows.map((group): SessionGroup => {
          const mine = members.filter((member) => member.group_id === group.id);
          return {
            id: group.id,
            name: group.name,
            ownerPrincipal: group.owner_principal,
            createdAt: DateTime.makeUnsafe(group.created_at),
            members: mine.map(({ principal: memberPrincipal, role }) => ({
              principal: memberPrincipal,
              role,
            })),
            threadIds: threads
              .filter((row) => row.group_id === group.id)
              .map((row) => row.thread_id),
            callerRole:
              group.owner_principal === principal
                ? "owner"
                : (mine.find((member) => member.principal === principal)?.role ?? "viewer"),
          };
        });
        return {
          groups,
          sharedThreads: shared.map((row) => ({ threadId: row.thread_id, role: row.role })),
        };
      }),
    });
  }),
);
