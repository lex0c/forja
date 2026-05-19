import { createHash } from 'node:crypto';
import type { DB } from './db.ts';
import type { Migration } from './migrations/index.ts';
import { MIGRATIONS } from './migrations/index.ts';

interface MigrationRow {
  id: number;
  name: string;
  hash: string;
  applied_at: number;
}

// Hash the *normalized* SQL so reformatting (indentation, line breaks, extra
// blank lines) does not invalidate an already-applied migration. Semantic
// changes (renamed column, different type, etc.) still produce a different
// hash and are caught.
const normalizeSql = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const sha256 = (s: string): string => createHash('sha256').update(normalizeSql(s)).digest('hex');

const ensureMigrationsTable = (db: DB): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      hash        TEXT NOT NULL,
      applied_at  INTEGER NOT NULL
    );
  `);
};

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

// Read-only check: how many registered migrations have NOT been
// applied to this DB? Used by code paths that want to know about
// pending migrations WITHOUT applying them (e.g., `agent gc`
// dry-run, which must not mutate schema).
//
// Returns the count of migrations whose `id` is missing from
// `_migrations`. Does NOT detect hash mismatches on already-applied
// migrations — that's the integrity check that lives inside
// `migrate` itself and only runs when the operator opts in. For
// dry-run we accept the trade-off: hash drift surfaces on the next
// real `migrate` call (or any other command that calls migrate
// during bootstrap).
export const countPendingMigrations = (
  db: DB,
  migrations: readonly Migration[] = MIGRATIONS,
): number => {
  const tblExists = db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '_migrations'",
    )
    .get() as { n: number } | null;
  if (tblExists === null || tblExists.n === 0) return migrations.length;
  const appliedIds = (db.query('SELECT id FROM _migrations').all() as Array<{ id: number }>).map(
    (r) => r.id,
  );
  const appliedSet = new Set(appliedIds);
  return migrations.filter((m) => !appliedSet.has(m.id)).length;
};

export const migrate = (db: DB, migrations: readonly Migration[] = MIGRATIONS): MigrateResult => {
  ensureMigrationsTable(db);
  const appliedRows = db
    .query('SELECT id, name, hash, applied_at FROM _migrations ORDER BY id ASC')
    .all() as MigrationRow[];
  const appliedById = new Map(appliedRows.map((r) => [r.id, r]));

  // Slice 134 P0-6: forward-compat check. If `_migrations` carries a
  // row whose id isn't in the current registry, this DB was last
  // touched by a NEWER Forja binary — the older binary can't
  // assume its schema knowledge covers the row shape that was
  // created. Refuse loud rather than silently proceed and risk
  // writing rows the future binary will mis-read. Forensic audit
  // DBs are expected to outlive Forja versions; opening with the
  // wrong binary should be impossible to do quietly.
  const registeredIds = new Set(migrations.map((m) => m.id));
  for (const row of appliedRows) {
    if (!registeredIds.has(row.id)) {
      throw new Error(
        `migrate: DB has migration id=${row.id} (name=${row.name}) that this Forja binary does not know about. This DB was last written by a NEWER Forja; update the binary or open with a fresh DB.`,
      );
    }
  }

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const m of migrations) {
    const hash = sha256(m.sql);
    const existing = appliedById.get(m.id);
    if (existing !== undefined) {
      if (existing.hash !== hash) {
        throw new Error(
          `migration ${m.name} (id=${m.id}) was already applied with a different hash; refusing to proceed.\n` +
            `  applied hash: ${existing.hash}\n` +
            `  current hash: ${hash}`,
        );
      }
      skipped.push(m.name);
      continue;
    }
    const apply = db.transaction(() => {
      db.exec(m.sql);
      db.query('INSERT INTO _migrations (id, name, hash, applied_at) VALUES (?, ?, ?, ?)').run(
        m.id,
        m.name,
        hash,
        Date.now(),
      );
    });
    apply();
    applied.push(m.name);
  }

  return { applied, skipped };
};
