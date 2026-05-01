// Per-DB serialization for scan operations.
//
// Concurrent scan paths on the same DB connection are unsafe:
//   - The full-scan pipeline (scanProject) uses a connection-
//     scoped temp table `_scan_seen`. Two parallel scans would
//     drop/create it underneath each other.
//   - Incremental scans (scanFiles) share the connection's
//     prepared-statement cache and run resolver passes that
//     scanProject also runs at the end of its own work.
//   - SQLite serializes individual writes via the WAL, but
//     interleaved transactions across the two paths produce
//     observable intermediate states (resolver binding while
//     prune is mid-flight, for example) that callers shouldn't
//     have to reason about.
//
// The mutex queues calls so they run end-to-end one at a time,
// even when multiple callers `await` overlapping operations.
// Walker-only work (FS reads in walkProject) inside a single
// scan still runs in parallel within that scan.
//
// WeakMap-keyed by DB so closing the DB releases the entry.
// The stored promise is `.catch`-swallowed so a rejection in
// scan N doesn't poison scan N+1 — the rejection still
// propagates to N's caller via `ours`.

import type { DB } from '../../storage/db.ts';

const scanMutexes = new WeakMap<DB, Promise<unknown>>();

export const withScanLock = async <T>(db: DB, fn: () => Promise<T>): Promise<T> => {
  const prior = scanMutexes.get(db) ?? Promise.resolve();
  const ours = (async () => {
    await prior.catch(() => {
      // Swallow prior's failure — independent scans don't
      // share fate. The rejection already propagated to its
      // own caller; we just need to know prior is done.
    });
    return fn();
  })();
  // Park the catch-swallowed handle so the next caller's
  // `await prior` resolves regardless of our outcome. The real
  // outcome is returned to OUR caller via `ours`.
  scanMutexes.set(
    db,
    ours.catch(() => {}),
  );
  return ours;
};
