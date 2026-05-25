import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
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
  // Slice 163 (review — Batch A audit hardening): skip the
  // SessionStart `PRAGMA integrity_check`. Per spec §15 + SEC §1.2
  // the integrity check is the load-bearing defense against torn-
  // page corruption / hostile FS write — production paths MUST run
  // it. The option exists only as a test seam for fixtures that
  // construct + mutate the DB schema mid-test (e.g., migration
  // tests intentionally leaving the DB in an inconsistent state).
  // Production callers MUST NOT pass this.
  skipIntegrityCheck?: boolean;
}

// Slice 163 (review — Batch A audit hardening). Run `PRAGMA
// integrity_check` against the just-opened DB. SQLite's full
// btree + schema walk; ~ms for empty DBs, ~hundreds of ms for
// large ones. Returns the list of rows (always one row per
// problem; a clean DB returns `[{ integrity_check: 'ok' }]`).
//
// Why at SessionStart: per spec §15 + SEC §1.2, FS-level corruption
// of `sessions.db` (cosmic ray, torn-page after kernel crash,
// hostile FS write) is part of the threat model. `verifyChain`
// runs ON the rows present and would happily report ok:true on a
// chain whose middle was silently dropped by a torn-page event.
// integrity_check catches that BEFORE the engine starts emitting.
const runIntegrityCheck = (db: DB, path: string): void => {
  const rows = db.query('PRAGMA integrity_check;').all() as Array<{ integrity_check: string }>;
  const allOk = rows.length === 1 && rows[0]?.integrity_check === 'ok';
  if (allOk) return;
  // Format problems for the error message: integrity_check can
  // return multiple rows when several issues are found. Cap to
  // first 5 so the error doesn't explode on a thoroughly corrupted
  // DB; operator gets enough signal to act.
  const issues = rows.slice(0, 5).map((r) => r.integrity_check);
  if (rows.length > 5) issues.push(`... and ${rows.length - 5} more`);
  // Close the connection before throwing — leaving it open holds
  // the file handle + WAL writer slot.
  db.close();
  throw new Error(
    `storage: PRAGMA integrity_check failed for '${path}': ${issues.join('; ')}. DB is corrupted — restore from backup or rotate (agent permission rotate-chain). See SEC §1.2 / spec §15.`,
  );
};

// Slice 163 (review — Batch A): lock down permissions on the
// sessions.db file + its parent dir per SEC §8.3. Multi-user host
// scenario: user A runs Forja; user B on the same machine can
// otherwise read /home/userA/.local/share/forja/sessions.db
// (default umask 0644) — the file contains tool_calls.output rows
// (file content the agent read, possibly secrets) and
// approvals_log rows (capabilities, args). Tight perms (0600 file,
// 0700 dir) close that vector.
//
// Best-effort: chmodSync can fail on exotic FS (FAT/exFAT have
// no Unix perms, some mounts are noexec/nosuid w/o chmod support).
// Swallow on failure — operator sees the lax perms at their own
// host's normal `ls -l`; not breaking the agent on a niche FS.
const lockdownDbPerms = (path: string): void => {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort. FS without Unix perms support (FAT/exFAT) ignores.
  }
  try {
    chmodSync(dirname(path), 0o700);
  } catch {
    // Best-effort.
  }
};

export const openDb = (path: string, options: OpenDbOptions = {}): DB => {
  if (options.readonly === true) {
    // Don't mkdir parent; don't pass create:true. If the file is
    // missing the open throws — caller decides how to surface.
    const db = new Database(path, { readonly: true });
    db.exec('PRAGMA foreign_keys = ON;');
    // Slice 163: integrity_check applies to read-only opens too
    // — a doctor inspection of a corrupted DB should refuse
    // instead of silently reporting "all chains ok".
    if (options.skipIntegrityCheck !== true && path !== MEMORY_DB) {
      runIntegrityCheck(db, path);
    }
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
    // Slice 163: integrity check + permission lockdown.
    // Order: integrity first (cheapest opportunity to refuse on
    // corruption), then chmod (the new file just got created by
    // Bun.Database; chmod runs against the live inode).
    if (options.skipIntegrityCheck !== true) {
      runIntegrityCheck(db, path);
    }
    lockdownDbPerms(path);
  }
  return db;
};

export const openMemoryDb = (): DB => openDb(MEMORY_DB);

// Slice 174 (hardening A3): durable-best-effort close. `PRAGMA
// synchronous = NORMAL` (set in openDb) keeps the hot path fast —
// main-DB pages fsync, but WAL frames can sit in the kernel page
// cache after COMMIT. The window is small in normal operation but
// real: a host crash (kernel panic, power loss) between the last
// commit and the next checkpoint loses every audit row written
// since the last checkpoint, and the chain-verifier can't tell
// the missing rows from rows that were never written.
//
// CHECKPOINT MODE CHOICE — PASSIVE, not TRUNCATE.
//
// The v0 fix used `wal_checkpoint(TRUNCATE)` which:
//   - waits for ALL readers to finish snapshotting (busy-handler
//     invoked, controlled by `busy_timeout=5000` set in openDb),
//   - waits until every reader is reading from the main DB only,
//   - then checkpoints + truncates the WAL file to zero.
// Result: every closeDb call could block up to 5 SECONDS waiting
// for concurrent readers (parent + subagent + readonly inspector
// overlap is the canonical case the project's parallelism
// architecture creates). Since closeDb runs in finally blocks
// across 16 cli/* entry points, this introduced user-visible
// exit latency under normal operation.
//
// PASSIVE:
//   - checkpoints as many frames as possible without waiting,
//   - busy-handler is NEVER invoked,
//   - syncs the main DB file when all frames were checkpointed,
//   - frames with active readers stay in the WAL — they're
//     recovered automatically on next open (the WAL file is the
//     recovery mechanism, not a transient buffer).
// Trade-off: a host crash AFTER closeDb but BEFORE next open
// loses any frames that PASSIVE couldn't checkpoint because a
// reader held them. Mitigation: those frames are committed —
// the WAL file persists on disk between processes, and the
// next `openDb` automatically checkpoints during the first
// write. The window where data is genuinely at risk is
// "graceful shutdown + host crash + WAL file lost (e.g. tmpfs)
// before next open" — much narrower than the v0 promise but
// the right balance against the 5s-blocking-per-close cost.
//
// Best-effort: a failed checkpoint must NOT block close — the
// close itself frees the file handle and any blocked connection
// waiting for the writer lock. Throws are logged to stderr and
// swallowed so the original error in a finally block isn't
// masked. Common no-op cases (readonly DBs, :memory:, DBs opened
// before journal_mode=WAL ran) succeed silently because
// wal_checkpoint is itself a no-op there.
export const closeDb = (db: DB): void => {
  try {
    db.exec('PRAGMA wal_checkpoint(PASSIVE);');
  } catch (e) {
    process.stderr.write(
      `forja: WAL checkpoint failed on close: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
  // db.close() can also throw — rare in practice (Bun returns
  // void on a clean close, throws on already-closed or on FS
  // error releasing the WAL fd), but a throw here would
  // propagate out of finally blocks (`try { migrate(db); }
  // catch (e) { closeDb(db); throw e; }`) and replace the
  // original error the caller meant to surface. Mirror the
  // checkpoint posture: log and swallow so the finally-block
  // chain stays honest about which error was the root cause.
  try {
    db.close();
  } catch (e) {
    process.stderr.write(
      `forja: db.close() failed on close: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
};

// Bun's Database.transaction wraps `fn` in a function that opens a SAVEPOINT,
// runs the body, and commits or rolls back. This helper exposes that as a
// single call so callers don't need to know about the curried form.
//
// Default `db.transaction(fn)()` opens DEFERRED — no lock held until the
// first write. That's fine for write-only sequences (multiple INSERTs in
// a row) but UNSAFE for read-modify-write under concurrency: another
// process can commit between our SELECT and our INSERT, invalidating our
// snapshot with SQLITE_BUSY_SNAPSHOT (which busy_timeout does NOT retry).
export const withTransaction = <T>(db: DB, fn: () => T): T => db.transaction(fn)();

// Slice 127 (R3 P0-A): IMMEDIATE transaction variant for
// read-modify-write paths. Acquires the writer lock at BEGIN so the
// SELECT inside the transaction sees a snapshot that's guaranteed
// stable through to COMMIT. Multiple concurrent BEGIN IMMEDIATEs
// serialize via busy_timeout=5000 (set in openDb) — the second
// caller waits up to 5s for the first to commit, then proceeds.
//
// Use for: audit chain append (read prev_hash, compute new hash,
// insert). Any sequence where the write payload depends on data
// read inside the same transaction.
//
// Do NOT use for: pure SELECTs (overhead with no benefit), pure
// INSERTs (deferred works fine), or long-running operations
// (serializing the writer lock for >100ms starves the rest).
export const withImmediateTransaction = <T>(db: DB, fn: () => T): T =>
  db.transaction(fn).immediate();
