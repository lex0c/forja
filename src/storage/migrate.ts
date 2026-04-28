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

export const migrate = (db: DB, migrations: readonly Migration[] = MIGRATIONS): MigrateResult => {
  ensureMigrationsTable(db);
  const appliedRows = db
    .query('SELECT id, name, hash, applied_at FROM _migrations ORDER BY id ASC')
    .all() as MigrationRow[];
  const appliedById = new Map(appliedRows.map((r) => [r.id, r]));

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
