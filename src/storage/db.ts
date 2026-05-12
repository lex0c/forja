import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database;

export const MEMORY_DB = ':memory:';

export interface OpenDbOptions {
  // Slice 125 (R2 P0-8): readonly handle for inspection / health
  // checks that MUST NOT mutate schema or rows. Sets the bun:sqlite
  // `readonly` flag (SQLite-level enforcement: any write fails
  // with SQLITE_READONLY). Skips the WAL pragmas (which need write
  // perms) and skips the parent-dir mkdir. `create` is forced off
  // — readonly mode on a non-existent file would otherwise create
  // an empty DB by accident. Doctor's chainCheck is the canonical
  // consumer; future read-only inspection tools (export, replay
  // against archived DB) can adopt the same shape.
  readonly?: boolean;
}

export const openDb = (path: string, options: OpenDbOptions = {}): DB => {
  if (options.readonly === true) {
    // Don't mkdir parent; don't pass create:true. If the file is
    // missing the open throws — caller decides how to surface.
    const db = new Database(path, { readonly: true });
    db.exec('PRAGMA foreign_keys = ON;');
    return db;
  }
  if (path !== MEMORY_DB) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== MEMORY_DB) {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    // 5s busy_timeout absorbs transient contention without
    // surfacing SQLITE_BUSY at the caller. Critical for the
    // parallelism architecture: a parent + up to 8 child
    // subagents (each its own subprocess with its own DB
    // connection) compete for the WAL writer lock. With
    // default `busy_timeout = 0`, any collision throws
    // immediately. Several writes are fail-soft (audit
    // streams: cost_progress_events, gate_decisions, hook_runs)
    // so a throw degrades audit completeness silently; others
    // are load-bearing (messages, sessions.complete,
    // subagent_handles.settle) and propagate up. Both
    // categories benefit from internal retry: 5s is well
    // above any single-row write latency on commodity disk
    // (typical: <5ms) but well below any operator-perceptible
    // hang threshold.
    //
    // In-memory DBs are skipped — they're single-connection
    // by construction and some tests simulate SQLITE_BUSY via
    // mock; applying a real busy_timeout there would slow
    // those tests without buying anything.
    db.exec('PRAGMA busy_timeout = 5000;');
  }
  return db;
};

export const openMemoryDb = (): DB => openDb(MEMORY_DB);

// Bun's Database.transaction wraps `fn` in a function that opens a SAVEPOINT,
// runs the body, and commits or rolls back. This helper exposes that as a
// single call so callers don't need to know about the curried form.
export const withTransaction = <T>(db: DB, fn: () => T): T => db.transaction(fn)();
