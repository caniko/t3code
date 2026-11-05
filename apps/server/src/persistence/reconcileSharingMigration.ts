import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0078 from "./Migrations/078_DropOrchestrationEventCorrelationIndex.ts";
import Migration0079 from "./Migrations/079_DelegatedRecoveryIndexes.ts";
import Migration0081 from "./Migrations/081_PeerLinkOwner.ts";

const LEGACY_SESSION_ACCESS_ID = 78;
const LEGACY_PEER_LINK_OWNER_ID = 79;
const SESSION_ACCESS_ID = 80;
const PEER_LINK_OWNER_ID = 81;

const SESSION_TABLES = [
  ["session_groups", ["id", "name", "owner_principal", "created_at"], ["id"]],
  ["session_group_members", ["group_id", "principal", "role"], ["group_id", "principal"]],
  ["session_group_threads", ["group_id", "thread_id"], ["thread_id"]],
  ["session_shares", ["thread_id", "principal", "role"], ["thread_id", "principal"]],
] as const;
const SESSION_INDEXES = [
  "idx_session_group_members_principal",
  "idx_session_group_threads_group",
  "idx_session_shares_principal",
] as const;
const PEER_LINK_COLUMNS = [
  "environment_id",
  "secret_name",
  "label",
  "urls_json",
  "access",
  "linked_at",
  "expires_at",
  "last_reached_at",
  "last_error",
  "fenced",
] as const;
const PEER_LINK_OWNER_COLUMNS = ["owner_principal", ...PEER_LINK_COLUMNS] as const;

interface MigrationRow {
  readonly migration_id: number;
  readonly name: string;
}

interface TableColumn {
  readonly name: string;
  readonly pk: number;
}

const fail = (message: string) => new Migrator.MigrationError({ kind: "BadState", message });

// A fork recorded SessionAccess at 78 and optionally PeerLinkOwner at 79. Keep its data,
// apply the upstream migrations those ids collided with, then move the equivalent ledger
// rows so the normal migrator does not replay PeerLinkOwner over owned links.
interface ReconcileSharingMigrationOptions {
  /** Reject histories that skipped the canonical V2 migrations before the fork's ids. */
  readonly validatePrerequisites: () => Effect.Effect<
    void,
    Migrator.MigrationError | SqlError,
    SqlClient.SqlClient
  >;
  readonly toMigrationInclusive?: number | undefined;
}

export const reconcileSharingMigration = Effect.fn("reconcileSharingMigration")(function* ({
  validatePrerequisites,
  toMigrationInclusive,
}: ReconcileSharingMigrationOptions) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (
        (yield* sql`
              SELECT name FROM sqlite_master
              WHERE type = 'table' AND name = 'effect_sql_migrations'
            `).length === 0
      ) {
        return [];
      }
      const history = yield* sql<MigrationRow>`
          SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
        `;
      const legacySessionAccess = history.find(
        (row) => row.migration_id === LEGACY_SESSION_ACCESS_ID && row.name === "SessionAccess",
      );
      const legacyPeerLinkOwner = history.find(
        (row) => row.migration_id === LEGACY_PEER_LINK_OWNER_ID && row.name === "PeerLinkOwner",
      );
      if (legacySessionAccess === undefined) {
        if (legacyPeerLinkOwner !== undefined) {
          return yield* fail(
            "This database records PeerLinkOwner without the fork's SessionAccess migration, so its sharing history is mixed and cannot be reconciled.",
          );
        }
        return [];
      }

      const limit = toMigrationInclusive ?? Number.POSITIVE_INFINITY;
      // The legacy row already holds the SessionAccess schema, but its id cannot be split
      // without writing canonical ids. Leave smaller partial targets untouched.
      if (limit < SESSION_ACCESS_ID) return [];
      if (legacyPeerLinkOwner !== undefined && limit < PEER_LINK_OWNER_ID) {
        return yield* fail(
          `The fork's PeerLinkOwner migration at ${LEGACY_PEER_LINK_OWNER_ID} cannot be canonicalized within migration limit ${limit}.`,
        );
      }
      const unexpected = history.filter(
        (row) =>
          row.migration_id >= LEGACY_SESSION_ACCESS_ID &&
          row !== legacySessionAccess &&
          row !== legacyPeerLinkOwner,
      );
      if (unexpected.length > 0) {
        return yield* fail(
          `This database's sharing migration history is mixed or newer than this build: ${unexpected
            .map((row) => `${row.migration_id}_${row.name}`)
            .join(", ")}.`,
        );
      }
      yield* validatePrerequisites();

      const sessionColumns = new Map<string, ReadonlyArray<TableColumn>>([
        ["session_groups", yield* sql<TableColumn>`PRAGMA table_info(session_groups)`],
        [
          "session_group_members",
          yield* sql<TableColumn>`PRAGMA table_info(session_group_members)`,
        ],
        [
          "session_group_threads",
          yield* sql<TableColumn>`PRAGMA table_info(session_group_threads)`,
        ],
        ["session_shares", yield* sql<TableColumn>`PRAGMA table_info(session_shares)`],
      ]);
      const sessionIndexes = new Set(
        (yield* sql<{ readonly name: string }>`
              SELECT name FROM sqlite_master
              WHERE type = 'index' AND name IN ${sql.in(SESSION_INDEXES)}
            `).map((index) => index.name),
      );
      const sessionProblems = [
        ...SESSION_TABLES.flatMap(([table, expected, expectedPrimaryKey]) => {
          const columns = sessionColumns.get(table) ?? [];
          const primaryKey = columns
            .filter((column) => column.pk > 0)
            .toSorted((a, b) => a.pk - b.pk)
            .map((column) => column.name);
          return [
            ...expected
              .filter((name) => !columns.some((column) => column.name === name))
              .map((name) => `${table}.${name}`),
            ...(primaryKey.length === expectedPrimaryKey.length &&
            primaryKey.every((name, index) => name === expectedPrimaryKey[index])
              ? []
              : [`${table} primary key`]),
          ];
        }),
        ...SESSION_INDEXES.filter((name) => !sessionIndexes.has(name)).map(
          (name) => `index ${name}`,
        ),
      ];
      if (sessionProblems.length > 0) {
        return yield* fail(
          `The fork's SessionAccess schema is not compatible with migration 80_SessionAccess: missing ${sessionProblems.join(", ")}.`,
        );
      }

      const peerColumns = yield* sql<TableColumn>`
          PRAGMA table_info(peer_environment_links)
        `;
      const missingPeerColumns = (expected: ReadonlyArray<string>) =>
        expected.filter((name) => !peerColumns.some((column) => column.name === name));
      if (
        (yield* sql`
              SELECT name FROM sqlite_master
              WHERE type = 'table' AND name = 'peer_environment_links_v2'
            `).length > 0
      ) {
        return yield* fail(
          "This database has an unfinished PeerLinkOwner migration, so its per-principal peer links cannot be reconciled automatically.",
        );
      }
      if (legacyPeerLinkOwner !== undefined) {
        const ownerPk = peerColumns.find((column) => column.name === "owner_principal");
        const environmentPk = peerColumns.find((column) => column.name === "environment_id");
        const missing = missingPeerColumns(PEER_LINK_OWNER_COLUMNS);
        if (missing.length > 0 || ownerPk?.pk !== 1 || environmentPk?.pk !== 2) {
          return yield* fail(
            `The fork's PeerLinkOwner schema is not compatible with migration 81_PeerLinkOwner${
              missing.length > 0 ? `: missing ${missing.join(", ")}` : ""
            }.`,
          );
        }
      } else {
        if (peerColumns.some((column) => column.name === "owner_principal")) {
          return yield* fail(
            "This database has per-principal peer links but no PeerLinkOwner migration, so its history is mixed and cannot be reconciled.",
          );
        }
        const missing = missingPeerColumns(PEER_LINK_COLUMNS);
        if (missing.length > 0) {
          return yield* fail(
            `Peer links cannot be upgraded to migration 81_PeerLinkOwner: missing ${missing.join(", ")}.`,
          );
        }
      }

      yield* Migration0078;
      yield* Migration0079;
      const runsPeerLinkOwner = legacyPeerLinkOwner === undefined && limit >= PEER_LINK_OWNER_ID;
      if (runsPeerLinkOwner) yield* Migration0081;

      if (legacyPeerLinkOwner !== undefined) {
        yield* sql`
            UPDATE effect_sql_migrations
            SET migration_id = ${PEER_LINK_OWNER_ID}, name = 'PeerLinkOwner'
            WHERE migration_id = ${LEGACY_PEER_LINK_OWNER_ID} AND name = 'PeerLinkOwner'
          `;
      }
      yield* sql`
          UPDATE effect_sql_migrations
          SET migration_id = ${SESSION_ACCESS_ID}, name = 'SessionAccess'
          WHERE migration_id = ${LEGACY_SESSION_ACCESS_ID} AND name = 'SessionAccess'
        `;
      yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name) VALUES
            (78, 'DropOrchestrationEventCorrelationIndex'),
            (79, 'DelegatedRecoveryIndexes')
        `;
      if (runsPeerLinkOwner) {
        yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name)
            VALUES (${PEER_LINK_OWNER_ID}, 'PeerLinkOwner')
          `;
      }

      const executed: Array<readonly [number, string]> = [
        [78, "DropOrchestrationEventCorrelationIndex"],
        [79, "DelegatedRecoveryIndexes"],
      ];
      if (runsPeerLinkOwner) executed.push([81, "PeerLinkOwner"]);
      return executed;
    }),
  );
});
