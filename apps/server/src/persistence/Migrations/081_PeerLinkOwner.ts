import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Links belong to the principal whose agents use them. The primary key moves
  // from the environment to (owner, environment), so two principals can each
  // link one machine; existing rows stay with the default principal.
  yield* sql`
    CREATE TABLE peer_environment_links_v2 (
      owner_principal TEXT NOT NULL DEFAULT 'owner',
      environment_id TEXT NOT NULL,
      secret_name TEXT NOT NULL,
      label TEXT NOT NULL,
      urls_json TEXT NOT NULL,
      access TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_reached_at TEXT,
      last_error TEXT,
      fenced INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (owner_principal, environment_id)
    )
  `;
  yield* sql`
    INSERT INTO peer_environment_links_v2 (
      environment_id, secret_name, label, urls_json, access, linked_at, expires_at,
      last_reached_at, last_error, fenced
    )
    SELECT
      environment_id, secret_name, label, urls_json, access, linked_at, expires_at,
      last_reached_at, last_error, fenced
    FROM peer_environment_links
  `;
  yield* sql`DROP TABLE peer_environment_links`;
  yield* sql`ALTER TABLE peer_environment_links_v2 RENAME TO peer_environment_links`;
});
