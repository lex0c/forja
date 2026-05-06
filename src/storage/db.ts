import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database;

export const MEMORY_DB = ':memory:';

export const openDb = (path: string): DB => {
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
