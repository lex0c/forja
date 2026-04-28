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
  }
  return db;
};

export const openMemoryDb = (): DB => openDb(MEMORY_DB);

// Bun's Database.transaction wraps `fn` in a function that opens a SAVEPOINT,
// runs the body, and commits or rolls back. This helper exposes that as a
// single call so callers don't need to know about the curried form.
export const withTransaction = <T>(db: DB, fn: () => T): T => db.transaction(fn)();
