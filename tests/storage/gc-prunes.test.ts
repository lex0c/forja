// GC prune helper tests. Each Phase 1 sweep is age/TTL-based; this
// file pins the cutoff semantics + return-count + safety
// invariants (e.g., bg_processes never deletes running rows).
//
// recap_cache prune (purgeExpiredRecapCache) predates this slice
// and has its own coverage in tests/storage/recap-cache.test.ts;
// we only re-validate that gc reuses the same boundary.

import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { insertBgProcess, pruneBgProcesses } from '../../src/storage/repos/bg-processes.ts';
import { createPin, pruneContextPins } from '../../src/storage/repos/context-pins.ts';
import { purgeExpiredRecapCache, writeRecapCache } from '../../src/storage/repos/recap-cache.ts';
import { pruneRetrievalTrace } from '../../src/storage/repos/retrieval-trace.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;
let sessionId: string;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'test/m', cwd: '/p' }).id;
});

// ──────────────────────────────────────────────────────────────────
// purgeExpiredRecapCache (reused as gc sweep)
// ──────────────────────────────────────────────────────────────────
describe('purgeExpiredRecapCache — gc sweep behavior', () => {
  test('deletes rows where expires_at <= now', () => {
    // Three rows with distinct expires_at; sweep at now=1500 keeps
    // only the one with expires_at=2000. Boundary at 1500 is
    // INCLUSIVE (<=), so a row with expires_at=1500 is deleted.
    writeRecapCache(db, {
      scopeHash: 'hash-a',
      renderer: 'pr',
      promptVersion: 'v1',
      output: 'x',
      ttlMs: 1000,
      generatedAt: 0, // expires_at = 1000
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    });
    writeRecapCache(db, {
      scopeHash: 'hash-b',
      renderer: 'pr',
      promptVersion: 'v1',
      output: 'x',
      ttlMs: 1500,
      generatedAt: 0, // expires_at = 1500
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    });
    writeRecapCache(db, {
      scopeHash: 'hash-c',
      renderer: 'pr',
      promptVersion: 'v1',
      output: 'x',
      ttlMs: 2000,
      generatedAt: 0, // expires_at = 2000
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    });

    const deleted = purgeExpiredRecapCache(db, 1500);
    expect(deleted).toBe(2); // rows 1000 + 1500 dropped
    const remaining = db.query('SELECT COUNT(*) AS n FROM recap_cache').get() as { n: number };
    expect(remaining.n).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// pruneRetrievalTrace
// ──────────────────────────────────────────────────────────────────
describe('pruneRetrievalTrace', () => {
  // Direct INSERT bypasses the createRetrievalTrace API (which
  // scrubs text + requires the full RETRIEVAL §10.1 payload). The
  // sweep only cares about `created_at`, so a minimal row suffices.
  const seed = (createdAt: number, id: string): void => {
    db.query(
      `INSERT INTO retrieval_trace (
        id, session_id, query_text, workflow, query_type, budget_tokens,
        candidates_raw_json, candidates_expanded_json, candidates_ranked_json,
        context_slot_json, timings_json, created_at
      ) VALUES (?, ?, '', 'debug', 'symbol', 1000, '[]', '[]', '[]', '{}', '{}', ?)`,
    ).run(id, sessionId, createdAt);
  };

  test('deletes rows older than cutoff (EXCLUSIVE)', () => {
    seed(100, 'a');
    seed(200, 'b');
    seed(300, 'c');
    const deleted = pruneRetrievalTrace(db, 200);
    // 100 < 200 → deleted; 200 == 200 → kept; 300 → kept.
    expect(deleted).toBe(1);
    const remaining = db.query('SELECT COUNT(*) AS n FROM retrieval_trace').get() as { n: number };
    expect(remaining.n).toBe(2);
  });

  test('zero deletions when nothing past cutoff', () => {
    seed(500, 'a');
    expect(pruneRetrievalTrace(db, 100)).toBe(0);
  });

  test('rejects non-positive olderThanMs', () => {
    expect(() => pruneRetrievalTrace(db, 0)).toThrow(/positive/);
    expect(() => pruneRetrievalTrace(db, -1)).toThrow(/positive/);
    expect(() => pruneRetrievalTrace(db, Number.NaN)).toThrow(/positive/);
  });
});

// ──────────────────────────────────────────────────────────────────
// pruneContextPins
// ──────────────────────────────────────────────────────────────────
describe('pruneContextPins', () => {
  const seed = (createdAt: number, text: string): void => {
    createPin(db, {
      sessionId,
      kind: 'invariant',
      text,
      createdBy: 'user',
      createdAt,
    });
  };

  test('deletes rows older than cutoff (EXCLUSIVE)', () => {
    seed(100, 'old');
    seed(200, 'edge');
    seed(300, 'fresh');
    const deleted = pruneContextPins(db, 200);
    expect(deleted).toBe(1);
    const remaining = db.query('SELECT COUNT(*) AS n FROM context_pins').get() as { n: number };
    expect(remaining.n).toBe(2);
  });

  test('per-pin expires_at does NOT interact with table sweep', () => {
    // Pin with expires_at far in the past, but created_at recent →
    // sweep at cutoff=50 must NOT delete (created_at > cutoff).
    createPin(db, {
      sessionId,
      kind: 'invariant',
      text: 'short-lived but new',
      createdBy: 'user',
      createdAt: 100,
      expiresAt: 10, // already expired by per-pin TTL but irrelevant here
    });
    expect(pruneContextPins(db, 50)).toBe(0);
  });

  test('rejects non-positive olderThanMs', () => {
    expect(() => pruneContextPins(db, 0)).toThrow(/positive/);
  });
});

// ──────────────────────────────────────────────────────────────────
// pruneBgProcesses
// ──────────────────────────────────────────────────────────────────
describe('pruneBgProcesses', () => {
  const seedExited = (spawnedAt: number, id: string): void => {
    insertBgProcess(db, {
      id,
      sessionId,
      command: 'echo',
      cwd: '/p',
      stdoutLogPath: '/tmp/out',
      stderrLogPath: '/tmp/err',
      spawnedAt,
    });
    // Flip to non-running so prune is eligible.
    db.query(`UPDATE background_processes SET status = 'exited', exited_at = ? WHERE id = ?`).run(
      spawnedAt + 1,
      id,
    );
  };

  const seedRunning = (spawnedAt: number, id: string): void => {
    insertBgProcess(db, {
      id,
      sessionId,
      command: 'long-running',
      cwd: '/p',
      stdoutLogPath: '/tmp/out',
      stderrLogPath: '/tmp/err',
      spawnedAt,
    });
    // Default status from insert is 'running'.
  };

  test('deletes exited rows older than cutoff', () => {
    seedExited(100, 'a');
    seedExited(200, 'b');
    seedExited(300, 'c');
    expect(pruneBgProcesses(db, 250)).toBe(2); // 100 + 200 deleted; 300 kept
  });

  test('NEVER deletes running rows regardless of age', () => {
    // Very old running row — must survive.
    seedRunning(1, 'old-running');
    seedExited(2, 'old-exited');
    // Cutoff way in the future; both rows are "older" age-wise.
    expect(pruneBgProcesses(db, 1_000_000)).toBe(1); // only exited row gone
    const remaining = db
      .query("SELECT COUNT(*) AS n FROM background_processes WHERE status = 'running'")
      .get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  test('cutoff is EXCLUSIVE for spawned_at', () => {
    seedExited(100, 'edge');
    expect(pruneBgProcesses(db, 100)).toBe(0); // spawned_at == cutoff → kept
    expect(pruneBgProcesses(db, 101)).toBe(1); // spawned_at < cutoff → deleted
  });

  test('rejects non-positive olderThanMs', () => {
    expect(() => pruneBgProcesses(db, 0)).toThrow(/positive/);
  });
});
