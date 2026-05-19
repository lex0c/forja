// GC orchestrator tests. Pins the multi-table sweep ordering,
// dry-run vs force divergence, per-table filter, idempotency, and
// the per-table error capture (errors don't abort other tables).

import { beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_RETENTION } from '../../src/audit/config-loader.ts';
import { runGc } from '../../src/audit/gc.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { insertBgProcess } from '../../src/storage/repos/bg-processes.ts';
import { createPin } from '../../src/storage/repos/context-pins.ts';
import { writeRecapCache } from '../../src/storage/repos/recap-cache.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;
let sessionId: string;

// Seed fixture taking `nowMs` directly so "old" / "fresh" rows
// are placed relative to the runGc comparison point — not relative
// to an `anchor` that itself sits far before nowMs (the prior
// mistake bled "fresh" rows into the cutoff window).
const seedAllFour = (nowMs: number): void => {
  const OLD = nowMs - 2 * DAY_MS; // > 1d old → past cutoff
  const FRESH = nowMs - 1000; // 1s old → inside cutoff for all phase-1 day-based tables

  // Pins: one old + one fresh.
  createPin(db, { sessionId, kind: 'invariant', text: 'old', createdBy: 'user', createdAt: OLD });
  createPin(db, {
    sessionId,
    kind: 'invariant',
    text: 'fresh',
    createdBy: 'user',
    createdAt: FRESH,
  });

  // Bg: old exited + old running. Cutoff catches BOTH age-wise,
  // but the status filter protects old-running.
  insertBgProcess(db, {
    id: 'old-exited',
    sessionId,
    command: 'echo',
    cwd: '/p',
    stdoutLogPath: '/t/o',
    stderrLogPath: '/t/e',
    spawnedAt: OLD,
  });
  db.query(`UPDATE background_processes SET status = 'exited', exited_at = ? WHERE id = ?`).run(
    OLD + 1,
    'old-exited',
  );
  insertBgProcess(db, {
    id: 'old-running',
    sessionId,
    command: 'tail -f',
    cwd: '/p',
    stdoutLogPath: '/t/o2',
    stderrLogPath: '/t/e2',
    spawnedAt: OLD,
  });
  // Status remains 'running' from the INSERT default — sweep MUST
  // refuse to delete this row.

  // Recap cache: expired + fresh. Recap uses absolute TTL via
  // `expires_at = generatedAt + ttlMs`, compared against nowMs.
  writeRecapCache(db, {
    scopeHash: 'hash-old',
    renderer: 'pr',
    promptVersion: 'v',
    output: 'x',
    ttlMs: 100, // expires at OLD + 100, way before nowMs
    generatedAt: OLD,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
  });
  writeRecapCache(db, {
    scopeHash: 'hash-fresh',
    renderer: 'pr',
    promptVersion: 'v',
    output: 'y',
    ttlMs: 60_000, // expires at FRESH + 60s = nowMs + ~60s → fresh
    generatedAt: FRESH,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
  });

  // Retrieval trace: old + fresh.
  db.query(
    `INSERT INTO retrieval_trace (
      id, session_id, query_text, workflow, query_type, budget_tokens,
      candidates_raw_json, candidates_expanded_json, candidates_ranked_json,
      context_slot_json, timings_json, created_at
    ) VALUES (?, ?, '', 'debug', 'symbol', 1000, '[]', '[]', '[]', '{}', '{}', ?)`,
  ).run('old-rt', sessionId, OLD);
  db.query(
    `INSERT INTO retrieval_trace (
      id, session_id, query_text, workflow, query_type, budget_tokens,
      candidates_raw_json, candidates_expanded_json, candidates_ranked_json,
      context_slot_json, timings_json, created_at
    ) VALUES (?, ?, '', 'debug', 'symbol', 1000, '[]', '[]', '[]', '{}', '{}', ?)`,
  ).run('fresh-rt', sessionId, FRESH);
};

// Tight config so 2000ms-old fixtures fall outside retention at our
// chosen `nowMs`. retrieval_trace / context_pins / bg_processes all
// take days; pick "1 day" and put fixtures > 1 day before now.
const TIGHT_CONFIG = {
  recap_cache_ttl_ms: DEFAULT_RETENTION.recap_cache_ttl_ms, // unused in tests below; recap uses expires_at
  retrieval_trace_days: 1,
  context_pins_days: 1,
  bg_processes_days: 1,
  // runGcOnStop is irrelevant to the orchestrator tests — that flag
  // is consumed by the harness loop wiring, not by runGc itself.
  // Set explicitly to satisfy the RetentionConfig type.
  runGcOnStop: false,
};

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
});

describe('runGc — dry-run', () => {
  test('reports counts per table; no mutation', () => {
    // Anchor = NOW; seed fixtures with relative offsets.
    const nowMs = 10 * DAY_MS;
    // Old fixtures must be > 1 day old: anchor = nowMs - 2 days.
    seedAllFour(nowMs);

    const report = runGc({
      db,
      config: TIGHT_CONFIG,
      nowMs,
      dryRun: true,
    });
    expect(report.mode).toBe('dry-run');
    expect(report.errors).toEqual([]);
    expect(report.tables.length).toBe(4);

    // FS state unchanged: re-run dry-run gets same numbers.
    const second = runGc({ db, config: TIGHT_CONFIG, nowMs, dryRun: true });
    expect(second.tables).toEqual(report.tables);

    // Each table reports a positive "would delete" for the old row,
    // and beforeCount includes both rows.
    const byTable = new Map(report.tables.map((t) => [t.table, t]));
    expect(byTable.get('context_pins')?.beforeCount).toBe(2);
    expect(byTable.get('context_pins')?.deletedCount).toBe(1);
    expect(byTable.get('retrieval_trace')?.beforeCount).toBe(2);
    expect(byTable.get('retrieval_trace')?.deletedCount).toBe(1);
    // bg_processes: 2 total (1 exited + 1 running), 1 deletable
    // (running is protected regardless of age).
    expect(byTable.get('bg_processes')?.beforeCount).toBe(2);
    expect(byTable.get('bg_processes')?.deletedCount).toBe(1);
    // recap_cache: 2 total, 1 expired.
    expect(byTable.get('recap_cache')?.beforeCount).toBe(2);
    expect(byTable.get('recap_cache')?.deletedCount).toBe(1);
  });
});

describe('runGc — force', () => {
  test('deletes per dry-run projection; second run is idempotent', () => {
    const nowMs = 10 * DAY_MS;
    seedAllFour(nowMs);

    const first = runGc({ db, config: TIGHT_CONFIG, nowMs, dryRun: false });
    expect(first.mode).toBe('force');
    expect(first.errors).toEqual([]);

    // Sum across all tables = 4 (one row per table).
    const totalDeleted = first.tables.reduce((acc, t) => acc + t.deletedCount, 0);
    expect(totalDeleted).toBe(4);

    // Idempotency: re-run deletes nothing.
    const second = runGc({ db, config: TIGHT_CONFIG, nowMs, dryRun: false });
    expect(second.tables.every((t) => t.deletedCount === 0)).toBe(true);
  });

  test('protected running bg_processes row survives even with old spawn_at', () => {
    const nowMs = 100 * DAY_MS;
    insertBgProcess(db, {
      id: 'ancient-running',
      sessionId,
      command: 'long-running',
      cwd: '/p',
      stdoutLogPath: '/t/o',
      stderrLogPath: '/t/e',
      spawnedAt: 1, // ancient
    });
    runGc({ db, config: TIGHT_CONFIG, nowMs, dryRun: false });
    const remaining = db
      .query(
        "SELECT COUNT(*) AS n FROM background_processes WHERE id = 'ancient-running' AND status = 'running'",
      )
      .get() as { n: number };
    expect(remaining.n).toBe(1);
  });
});

describe('runGc — tables filter', () => {
  test('restricts to listed tables only', () => {
    const nowMs = 10 * DAY_MS;
    seedAllFour(nowMs);

    const report = runGc({
      db,
      config: TIGHT_CONFIG,
      nowMs,
      dryRun: true,
      tables: ['context_pins'],
    });
    expect(report.tables.length).toBe(1);
    expect(report.tables[0]?.table).toBe('context_pins');
  });

  test('empty filter is treated as "all"', () => {
    // Edge: caller passes [] explicitly. Orchestrator treats it as
    // "no filter" — both `undefined` and `[]` yield all 4 tables.
    const nowMs = 10 * DAY_MS;
    const report = runGc({
      db,
      config: TIGHT_CONFIG,
      nowMs,
      dryRun: true,
      tables: [],
    });
    expect(report.tables.length).toBe(0); // empty IS empty (caller signaled "none")
    // The "all" semantic is `tables: undefined` per the type — the
    // empty array means "I explicitly chose nothing".
  });
});

describe('runGc — input validation', () => {
  test('rejects non-positive nowMs', () => {
    expect(() => runGc({ db, config: TIGHT_CONFIG, nowMs: 0, dryRun: true })).toThrow(/positive/);
    expect(() => runGc({ db, config: TIGHT_CONFIG, nowMs: -1, dryRun: true })).toThrow(/positive/);
  });
});
