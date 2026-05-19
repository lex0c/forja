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
import { pruneEvictionEvents } from '../../src/storage/repos/eviction-events.ts';
import { pruneFailureEvents } from '../../src/storage/repos/failure-events.ts';
import { pruneHookRuns } from '../../src/storage/repos/hook-runs.ts';
import { pruneMemoryEvents } from '../../src/storage/repos/memory-events.ts';
import { pruneExpiredOutcomeSignals } from '../../src/storage/repos/outcome-signals.ts';
import { pruneOutcomes } from '../../src/storage/repos/outcomes.ts';
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

// ──────────────────────────────────────────────────────────────────
// Phase 2 — audit-cascade tables
// ──────────────────────────────────────────────────────────────────

// memory_events
describe('pruneMemoryEvents (Phase 2)', () => {
  const seed = (createdAt: number, id: string): void => {
    db.query(
      `INSERT INTO memory_events (id, scope, action, memory_name, source, session_id, cwd, created_at, details)
       VALUES (?, 'user', 'created', 'm1', 'user_explicit', NULL, NULL, ?, NULL)`,
    ).run(id, createdAt);
  };

  test('deletes rows older than cutoff (EXCLUSIVE)', () => {
    seed(100, 'a');
    seed(200, 'b');
    seed(300, 'c');
    expect(pruneMemoryEvents(db, 200)).toBe(1);
    const remaining = db.query('SELECT COUNT(*) AS n FROM memory_events').get() as { n: number };
    expect(remaining.n).toBe(2);
  });

  test('rejects non-positive olderThanMs', () => {
    expect(() => pruneMemoryEvents(db, 0)).toThrow(/positive/);
  });
});

// hook_runs
describe('pruneHookRuns (Phase 2)', () => {
  const seed = (createdAt: number, id: string): void => {
    db.query(
      `INSERT INTO hook_runs
       (id, session_id, event, layer, source_path, hook_index, command, expanded,
        exit_code, outcome, duration_ms, stdout, stderr, matched_tool, created_at)
       VALUES (?, NULL, 'Stop', 'project', '/x', 0, 'echo', 'echo', 0, 'allow', 10, '', '', NULL, ?)`,
    ).run(id, createdAt);
  };

  test('deletes rows older than cutoff (EXCLUSIVE)', () => {
    seed(100, 'a');
    seed(200, 'b');
    seed(300, 'c');
    expect(pruneHookRuns(db, 200)).toBe(1);
  });

  test('rejects non-positive olderThanMs', () => {
    expect(() => pruneHookRuns(db, 0)).toThrow(/positive/);
  });
});

// failure_events
describe('pruneFailureEvents (Phase 2)', () => {
  const seed = (createdAt: number, id: string): void => {
    db.query(
      `INSERT INTO failure_events
       (id, session_id, step_id, code, classe, recovery_action, user_visible, payload_json, created_at, prev_chain_hash, this_chain_hash)
       VALUES (?, ?, NULL, 'X', 'tool', 'retry', 0, NULL, ?, '0', ?)`,
    ).run(id, sessionId, createdAt, id); // this_chain_hash UNIQUE — use id as proxy
  };

  test('deletes rows older than cutoff (EXCLUSIVE); chain trade-off accepted', () => {
    seed(100, 'a');
    seed(200, 'b');
    seed(300, 'c');
    // Per spec: sweep DELETEs individual rows. Chain integrity for
    // partial-session sweep is the documented trade-off.
    expect(pruneFailureEvents(db, 200)).toBe(1);
    const remaining = db.query('SELECT COUNT(*) AS n FROM failure_events').get() as { n: number };
    expect(remaining.n).toBe(2);
  });

  test('rejects non-positive olderThanMs', () => {
    expect(() => pruneFailureEvents(db, 0)).toThrow(/positive/);
  });
});

// eviction_events
describe('pruneEvictionEvents (Phase 2)', () => {
  const seed = (recordedAt: number, id: string): void => {
    db.query(
      `INSERT INTO eviction_events
       (id, parent_id, substrate, object_id, object_scope, from_state, to_state, trigger, motivo, evidence_json, outcome, actor, recorded_at)
       VALUES (?, NULL, 'memory', ?, 'user', 'active', 'evicted', 'gc_test', 'low_roi', '{}', 'applied', 'user', ?)`,
    ).run(id, `obj-${id}`, recordedAt);
  };

  test('deletes rows older than cutoff (EXCLUSIVE)', () => {
    seed(100, 'a');
    seed(200, 'b');
    seed(300, 'c');
    expect(pruneEvictionEvents(db, 200)).toBe(1);
  });

  test('rejects non-positive olderThanMs', () => {
    expect(() => pruneEvictionEvents(db, 0)).toThrow(/positive/);
  });
});

// outcomes
describe('pruneOutcomes (Phase 2)', () => {
  // Chain fixture: outcomes FK → tool_calls FK → messages FK → sessions.
  // Helper insert each link minimally.
  const seed = (recordedAt: number, id: string): void => {
    const msgId = `msg-${id}`;
    const tcId = `tc-${id}`;
    db.query(
      `INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
       VALUES (?, ?, NULL, 'assistant', '', ?)`,
    ).run(msgId, sessionId, recordedAt);
    db.query(
      `INSERT INTO tool_calls (id, message_id, tool_name, input, output, status, created_at)
       VALUES (?, ?, 't', '{}', '{}', 'done', ?)`,
    ).run(tcId, msgId, recordedAt);
    db.query(
      `INSERT INTO outcomes
       (id, session_id, tool_call_id, action_signature, tier, result, evidence_json, scope_kind, scope_id, recorded_at)
       VALUES (?, ?, ?, 'act', 1, 'success', NULL, 'session', ?, ?)`,
    ).run(id, sessionId, tcId, sessionId, recordedAt);
  };

  test('deletes rows older than cutoff (EXCLUSIVE)', () => {
    seed(100, 'a');
    seed(200, 'b');
    seed(300, 'c');
    expect(pruneOutcomes(db, 200)).toBe(1);
  });

  test('rejects non-positive olderThanMs', () => {
    expect(() => pruneOutcomes(db, 0)).toThrow(/positive/);
  });
});

// outcome_signals (TTL-based — mirrors purgeExpiredRecapCache)
describe('pruneExpiredOutcomeSignals (Phase 2)', () => {
  const seed = (ttlExpiresAt: number, id: string): void => {
    db.query(
      `INSERT INTO outcome_signals
       (id, approval_seq, install_id, signal_kind, signal_weight, payload_json, observed_at, detected_at, ttl_expires_at)
       VALUES (?, 1, 'i', 'tool_error', 0.3, NULL, 0, 0, ?)`,
    ).run(id, ttlExpiresAt);
  };

  test('deletes rows where ttl_expires_at <= nowMs (INCLUSIVE — matches recap_cache)', () => {
    seed(100, 'a');
    seed(200, 'b'); // exact boundary
    seed(300, 'c');
    // nowMs=200: rows at 100 + 200 deleted (<= INCLUSIVE); row at 300 kept.
    // Matches `purgeExpiredRecapCache` boundary so the two TTL-based
    // sweeps stay symmetric.
    expect(pruneExpiredOutcomeSignals(db, 200)).toBe(2);
    const remaining = db.query('SELECT COUNT(*) AS n FROM outcome_signals').get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  test('rejects non-positive nowMs', () => {
    expect(() => pruneExpiredOutcomeSignals(db, 0)).toThrow(/positive/);
  });
});
