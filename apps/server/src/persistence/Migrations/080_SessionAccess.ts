import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Who besides a thread's owner may see or steer it. Plain tables rather than thread events:
// groups span threads, and access must never be replayed or rewound with a thread's history.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS session_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_principal TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS session_group_members (
      group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
      principal TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('viewer', 'participant')),
      PRIMARY KEY (group_id, principal)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_session_group_members_principal ON session_group_members(principal)`;
  // A thread belongs to at most one group.
  yield* sql`
    CREATE TABLE IF NOT EXISTS session_group_threads (
      group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL PRIMARY KEY
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_session_group_threads_group ON session_group_threads(group_id)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS session_shares (
      thread_id TEXT NOT NULL,
      principal TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('viewer', 'participant')),
      PRIMARY KEY (thread_id, principal)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_session_shares_principal ON session_shares(principal)`;
});
