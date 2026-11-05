import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Migrator from "effect/sql/Migrator";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import SessionAccess from "./Migrations/080_SessionAccess.ts";
import PeerLinkOwner from "./Migrations/081_PeerLinkOwner.ts";

const v2Migrations = migrationManifest.filter(([id]) => id >= 55);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

const ledgerRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly migration_id: number;
    readonly name: string;
    readonly created_at: string;
  }>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
});

const sharingRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    groups: yield* sql`SELECT * FROM session_groups ORDER BY id`,
    members: yield* sql`SELECT * FROM session_group_members ORDER BY group_id, principal`,
    threads: yield* sql`SELECT * FROM session_group_threads ORDER BY group_id, thread_id`,
    shares: yield* sql`SELECT * FROM session_shares ORDER BY thread_id, principal`,
  };
});

const peerLinks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`
    SELECT owner_principal, environment_id, secret_name, label, urls_json, access,
           linked_at, expires_at, last_reached_at, last_error, fenced
    FROM peer_environment_links
    ORDER BY owner_principal, environment_id
  `;
});

const seedSharingRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO session_groups (id, name, owner_principal, created_at)
    VALUES ('group-1', 'Platform', 'alice', '2026-10-03 00:00:00')
  `;
  yield* sql`
    INSERT INTO session_group_members (group_id, principal, role)
    VALUES ('group-1', 'bob', 'participant')
  `;
  yield* sql`
    INSERT INTO session_group_threads (group_id, thread_id) VALUES ('group-1', 'thread-1')
  `;
  yield* sql`
    INSERT INTO session_shares (thread_id, principal, role) VALUES ('thread-1', 'carol', 'viewer')
  `;
});

const seedLegacySharingHistory = (withPeerLinkOwner: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 77 });
    // The abandoned sharing build recorded 080/081 at 78/79.
    yield* Migrator.make({})({
      loader: Migrator.fromRecord({
        "78_SessionAccess": SessionAccess,
        ...(withPeerLinkOwner ? { "79_PeerLinkOwner": PeerLinkOwner } : {}),
      }),
    });
    yield* sql`
      UPDATE effect_sql_migrations SET created_at = '2026-10-01 00:00:00' WHERE migration_id = 78
    `;
    if (withPeerLinkOwner) {
      yield* sql`
        UPDATE effect_sql_migrations SET created_at = '2026-10-02 00:00:00' WHERE migration_id = 79
      `;
    }
  });

const assertSharingSchemaUpgraded = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  assert.deepStrictEqual(yield* history, migrationManifest);
  assert.deepStrictEqual(yield* runMigrations(), []);
  assert.deepStrictEqual(
    yield* sql`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_orch_events_correlation_id'
    `,
    [],
  );
  for (const index of [
    "orchestration_v2_projection_threads_subagent_result_idx",
    "orchestration_v2_projection_runs_delegated_delivery_idx",
  ]) {
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ${index}`,
      [{ name: index }],
    );
  }
});

describe("runMigrations", () => {
  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 54 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "55_OrchestrationV2 (recorded: FutureMainMigration)");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 54", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("drops the unused correlation index and keeps correlation values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          'event-1', 'thread', 'thread-1', 0, 'thread.created', '2026-01-01T00:00:00.000Z',
          'command-1', NULL, 'correlation-1', 'client', '{}', '{}'
        )
      `;

      yield* runMigrations();

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'orchestration_events' AND sql IS NOT NULL
      `;
      const indexNames = indexes.map((row) => row.name);
      assert.notInclude(indexNames, "idx_orch_events_correlation_id");
      for (const kept of [
        "idx_orch_events_stream_version",
        "idx_orch_events_stream_sequence",
        "idx_orch_events_command_id",
        "idx_orchestration_events_agent_stream_sequence",
      ]) {
        assert.include(indexNames, kept);
      }
      const events = yield* sql<{ readonly correlation_id: string | null }>`
        SELECT correlation_id FROM orchestration_events WHERE event_id = 'event-1'
      `;
      assert.deepStrictEqual(events, [{ correlation_id: "correlation-1" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 54])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (56, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 56 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "56_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)",
      );
      assert.notInclude(String(exit), "57_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

describe("legacy sharing migration history", () => {
  it.effect.each([false, true])(
    "upgrades a database that recorded the sharing migrations at 78/79 (peer link owner: %s)",
    (withPeerLinkOwner) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedLegacySharingHistory(withPeerLinkOwner);
        yield* seedSharingRows;
        const sharingBefore = yield* sharingRows;

        if (withPeerLinkOwner) {
          yield* sql`
            INSERT INTO peer_environment_links (
              owner_principal, environment_id, secret_name, label, urls_json, access,
              linked_at, expires_at, last_reached_at, last_error, fenced
            )
            VALUES
              ('alice', 'env-shared', 'secret-alice', 'Alice', '["https://alice.example"]',
               'full', '2026-10-04 00:00:00', '2027-01-01 00:00:00', NULL, NULL, 0),
              ('bob', 'env-shared', 'secret-bob', 'Bob', '["https://bob.example"]',
               'read', '2026-10-05 00:00:00', '2027-02-01 00:00:00',
               '2026-10-06 00:00:00', 'offline', 1)
          `;
          const linksBefore = yield* peerLinks;

          assert.deepStrictEqual(yield* runMigrations(), [
            [78, "DropOrchestrationEventCorrelationIndex"],
            [79, "DelegatedRecoveryIndexes"],
          ]);

          assert.deepStrictEqual(yield* peerLinks, linksBefore);
          assert.deepStrictEqual(
            (yield* ledgerRows).filter((row) => row.migration_id >= 80),
            [
              { migration_id: 80, name: "SessionAccess", created_at: "2026-10-01 00:00:00" },
              { migration_id: 81, name: "PeerLinkOwner", created_at: "2026-10-02 00:00:00" },
            ],
          );
        } else {
          yield* sql`
            INSERT INTO peer_environment_links (
              environment_id, secret_name, label, urls_json, access, linked_at, expires_at,
              last_reached_at, last_error, fenced
            )
            VALUES (
              'env-legacy', 'secret-legacy', 'Legacy', '["https://legacy.example"]', 'full',
              '2026-10-04 00:00:00', '2027-01-01 00:00:00', NULL, NULL, 0
            )
          `;

          assert.deepStrictEqual(yield* runMigrations(), [
            [78, "DropOrchestrationEventCorrelationIndex"],
            [79, "DelegatedRecoveryIndexes"],
            [81, "PeerLinkOwner"],
          ]);

          assert.deepStrictEqual(yield* peerLinks, [
            {
              owner_principal: "owner",
              environment_id: "env-legacy",
              secret_name: "secret-legacy",
              label: "Legacy",
              urls_json: '["https://legacy.example"]',
              access: "full",
              linked_at: "2026-10-04 00:00:00",
              expires_at: "2027-01-01 00:00:00",
              last_reached_at: null,
              last_error: null,
              fenced: 0,
            },
          ]);
          assert.deepStrictEqual(
            (yield* ledgerRows).filter((row) => row.migration_id === 80),
            [{ migration_id: 80, name: "SessionAccess", created_at: "2026-10-01 00:00:00" }],
          );
        }

        yield* assertSharingSchemaUpgraded;
        assert.deepStrictEqual(yield* sharingRows, sharingBefore);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([
    "mixed",
    "later",
    "unknown",
    "missing prerequisite",
    "missing index",
    "missing owner",
  ] as const)("fails closed on a %s sharing history without changing the database", (kind) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacySharingHistory(true);
      yield* seedSharingRows;
      if (kind === "mixed") {
        yield* sql`
            UPDATE effect_sql_migrations SET name = 'DelegatedRecoveryIndexes' WHERE migration_id = 79
          `;
      } else if (kind === "later") {
        yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name) VALUES (80, 'FutureSharing')
          `;
      } else if (kind === "unknown") {
        yield* sql`UPDATE effect_sql_migrations SET name = 'UnknownFork' WHERE migration_id = 79`;
      } else if (kind === "missing prerequisite") {
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 77`;
      } else if (kind === "missing index") {
        yield* sql`DROP INDEX idx_session_shares_principal`;
      } else {
        yield* sql`ALTER TABLE peer_environment_links RENAME COLUMN owner_principal TO invalid_owner`;
      }
      const ledgerBefore = yield* ledgerRows;
      const sharingBefore = yield* sharingRows;

      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));

      assert.deepStrictEqual(yield* ledgerRows, ledgerBefore);
      assert.deepStrictEqual(yield* sharingRows, sharingBefore);
      assert.deepStrictEqual(
        yield* sql`
            SELECT name FROM sqlite_master
            WHERE type = 'index' AND name = 'idx_orch_events_correlation_id'
          `,
        [{ name: "idx_orch_events_correlation_id" }],
      );
      assert.deepStrictEqual(
        yield* sql`
            SELECT name FROM sqlite_master
            WHERE type = 'index'
              AND name = 'orchestration_v2_projection_runs_delegated_delivery_idx'
          `,
        [],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([77, 78, 79, 80])("does not reconcile legacy sharing past limit %s", (limit) =>
    Effect.gen(function* () {
      yield* seedLegacySharingHistory(true);
      yield* seedSharingRows;
      const ledgerBefore = yield* ledgerRows;
      const sharingBefore = yield* sharingRows;

      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: limit }));
      assert.strictEqual(Exit.isFailure(exit), limit >= 78);

      assert.deepStrictEqual(yield* ledgerRows, ledgerBefore);
      assert.deepStrictEqual(yield* sharingRows, sharingBefore);
      assert.isFalse((yield* ledgerRows).some((row) => row.migration_id > 79));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("can stop a SessionAccess-only upgrade at 80 before adding peer owners", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacySharingHistory(false);
      yield* seedSharingRows;
      const sharingBefore = yield* sharingRows;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 80 }), [
        [78, "DropOrchestrationEventCorrelationIndex"],
        [79, "DelegatedRecoveryIndexes"],
      ]);
      assert.deepStrictEqual(
        yield* history,
        migrationManifest.filter(([id]) => id <= 80),
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM pragma_table_info('peer_environment_links') WHERE name = 'owner_principal'`,
        [],
      );
      assert.deepStrictEqual(yield* runMigrations(), [[81, "PeerLinkOwner"]]);
      yield* assertSharingSchemaUpgraded;
      assert.deepStrictEqual(yield* sharingRows, sharingBefore);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back sharing DDL and ledger together when the ledger write fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacySharingHistory(true);
      yield* seedSharingRows;
      yield* sql`
        INSERT INTO peer_environment_links (
          owner_principal, environment_id, secret_name, label, urls_json, access,
          linked_at, expires_at, last_reached_at, last_error, fenced
        )
        VALUES
          ('alice', 'env-shared', 'secret-alice', 'Alice', '["https://alice.example"]',
           'full', '2026-10-04 00:00:00', '2027-01-01 00:00:00', NULL, NULL, 0),
          ('bob', 'env-shared', 'secret-bob', 'Bob', '["https://bob.example"]',
           'read', '2026-10-05 00:00:00', '2027-02-01 00:00:00',
           '2026-10-06 00:00:00', 'offline', 1)
      `;
      const ledgerBefore = yield* ledgerRows;
      const sharingBefore = yield* sharingRows;
      const linksBefore = yield* peerLinks;

      yield* sql`
        CREATE TRIGGER abort_sharing_ledger_insert BEFORE INSERT ON effect_sql_migrations
        WHEN NEW.migration_id >= 78
        BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END
      `;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));

      assert.deepStrictEqual(yield* ledgerRows, ledgerBefore);
      assert.deepStrictEqual(yield* sharingRows, sharingBefore);
      assert.deepStrictEqual(yield* peerLinks, linksBefore);
      assert.deepStrictEqual(
        yield* sql`
          SELECT name FROM sqlite_master
          WHERE type = 'index' AND name = 'idx_orch_events_correlation_id'
        `,
        [{ name: "idx_orch_events_correlation_id" }],
      );
      assert.deepStrictEqual(
        yield* sql`
          SELECT name FROM sqlite_master
          WHERE type = 'index'
            AND name = 'orchestration_v2_projection_runs_delegated_delivery_idx'
        `,
        [],
      );

      yield* sql`DROP TRIGGER abort_sharing_ledger_insert`;
      yield* runMigrations();
      yield* assertSharingSchemaUpgraded;
      assert.deepStrictEqual(yield* sharingRows, sharingBefore);
      assert.deepStrictEqual(yield* peerLinks, linksBefore);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

// The npm launcher reads the highest migration id from these file names.
it.effect("registers every migration file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(import.meta.dirname, "Migrations");
    const files = (yield* fs.readDirectory(dir)).flatMap((name) => {
      const match = /^(\d+)_(\w+)\.ts$/.exec(name);
      return match ? [[Number(match[1]), match[2]] as const] : [];
    });
    assert.deepStrictEqual(
      files.toSorted(([a], [b]) => a - b),
      migrationManifest,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
