import { beforeEach, describe, expect, test } from 'bun:test';
import { TERSE_DETERMINISTIC_VERSION, buildAutoTerse } from '../../src/recap/auto-display.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { appendMessage } from '../../src/storage/repos/messages.ts';
import { readRecapCache, writeRecapCache } from '../../src/storage/repos/recap-cache.ts';
import { listRecentRecapRuns } from '../../src/storage/repos/recap-runs.ts';
import { type Session, completeSession, createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

const seed = (): Session => {
  const s = createSession(db, { model: 'sonnet', cwd: '/proj', startedAt: 1_000 });
  appendMessage(db, { sessionId: s.id, role: 'user', content: 'fix the bug', createdAt: 1_100 });
  appendMessage(db, {
    sessionId: s.id,
    role: 'assistant',
    parentId: null,
    content: [{ type: 'text', text: 'fixed it' }],
    tokensIn: 100,
    tokensOut: 50,
    cachedTokens: null,
    cacheCreationTokens: null,
    costUsd: 0.001,
    createdAt: 1_200,
  });
  completeSession(db, s.id, 'done', 0.001, true, 1_300);
  return s;
};

describe('buildAutoTerse', () => {
  test('happy path: projects + renders + writes cache + records audit row', () => {
    const s = seed();
    const result = buildAutoTerse({ db, sessionId: s.id, now: 5_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cacheHit).toBe(false);
    // Terse format: one line, ≤ 200 chars, single sentence ending in '.'
    expect(result.markdown.length).toBeLessThanOrEqual(201);
    expect(result.markdown.trim().endsWith('.')).toBe(true);
    // Auto-display passes `omitMetrics: true` to the renderer
    // (RECAP §3.3) so the trailing `<duration>, <cost>.` suffix
    // is dropped — the TUI surface lives below "Cogitated for X"
    // which already shows duration + cost. Pin the absence so a
    // future refactor that drops the flag fails this assertion.
    // `, $X.XX.` is the canonical cost suffix shape from formatUsd;
    // a duration token like `1m23s,` ends in a comma directly
    // before the cost, so checking for the cost suffix is enough.
    expect(result.markdown).not.toMatch(/, \$/);

    // Cache row landed for this scope. Helper's exact scope hash
    // is opaque from outside (depends on the projected
    // intermediate); a SELECT on the table is the simplest way
    // to confirm the write happened without re-implementing the
    // hash math.
    const cacheRows = db
      .query<{ output: string; renderer: string; prompt_version: string }, []>(
        'SELECT output, renderer, prompt_version FROM recap_cache',
      )
      .all();
    expect(cacheRows).toHaveLength(1);
    expect(cacheRows[0]?.renderer).toBe('terse');
    expect(cacheRows[0]?.prompt_version).toBe(TERSE_DETERMINISTIC_VERSION);
    expect(cacheRows[0]?.output).toBe(result.markdown);

    // Audit row: one row, terse, used_llm 0, cache_hit 0.
    const runs = listRecentRecapRuns(db, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.renderer).toBe('terse');
    expect(runs[0]?.usedLlm).toBe(false);
    expect(runs[0]?.cacheHit).toBe(false);
    expect(runs[0]?.promptVersion).toBeNull();
  });

  test('cache hit returns cached output and records cacheHit=true', () => {
    const s = seed();
    // First call writes the cache.
    const first = buildAutoTerse({ db, sessionId: s.id, now: 5_000 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Second call within TTL hits the cache. Markdown is identical
    // (deterministic) and the audit row records the hit.
    const second = buildAutoTerse({ db, sessionId: s.id, now: 5_001 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.cacheHit).toBe(true);
    expect(second.markdown).toBe(first.markdown);

    const runs = listRecentRecapRuns(db, 10);
    expect(runs).toHaveLength(2);
    // listRecentRecapRuns orders newest-first.
    expect(runs[0]?.cacheHit).toBe(true);
    expect(runs[1]?.cacheHit).toBe(false);
  });

  test('cache write failure does NOT block markdown or audit row (best-effort)', () => {
    const s = seed();
    // Force `writeRecapCache` to throw by installing a trigger
    // that fails every INSERT on `recap_cache`. The helper's
    // try/catch around the write must swallow this and still
    // return ok:true with the rendered markdown. The audit row
    // must still land — `recap_runs` is a separate table and
    // the trigger only blocks `recap_cache` writes.
    db.query(
      `CREATE TRIGGER block_recap_cache_write
       BEFORE INSERT ON recap_cache
       BEGIN SELECT RAISE(FAIL, 'cache write blocked by test trigger'); END;`,
    ).run();

    const result = buildAutoTerse({ db, sessionId: s.id, now: 5_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown.length).toBeGreaterThan(0);
    expect(result.cacheHit).toBe(false);

    // Cache row never landed — trigger blocked it.
    const cacheRows = db
      .query<{ scope_hash: string }, []>('SELECT scope_hash FROM recap_cache')
      .all();
    expect(cacheRows).toHaveLength(0);

    // Audit row landed — separate table, separate try/catch.
    const runs = listRecentRecapRuns(db, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.cacheHit).toBe(false);
  });

  test('returns ok:false on a session that does not exist', () => {
    const result = buildAutoTerse({ db, sessionId: 'no-such-session', now: 5_000 });
    // projectRecap throws when the session cannot be resolved;
    // the helper catches and returns a structured failure so the
    // caller (harness loop / REPL) can surface a diagnostic
    // without breaking their own happy path.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
    // No audit row written on failure — the helper short-circuits
    // before the recordRecapRun call.
    expect(listRecentRecapRuns(db, 10)).toHaveLength(0);
  });

  test('cache hit short-circuits projection (audit-only side effect)', () => {
    const s = seed();
    // Pre-warm the cache with a sentinel output. The helper reads
    // it and returns it verbatim — proves the cache path doesn't
    // re-render.
    const intermediateScope = { kind: 'session_specific' as const, sessionIds: [s.id] };
    // Project once to get the canonical hash.
    const first = buildAutoTerse({ db, sessionId: s.id, now: 5_000 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Now overwrite the cache row with a sentinel that the
    // deterministic renderer would never produce.
    const intermediateForHash = { kind: 'session_specific' as const, sessionIds: [s.id] };
    void intermediateForHash;
    // Use the same helper to derive the scope hash by re-running
    // the projection — it must produce the same hash since the
    // session is unchanged. Then we overwrite the output.
    // Simpler: use writeRecapCache via the intermediate's own
    // hash. We know the helper just wrote this row, so we can
    // read it back, mutate, and write.
    // The projection is in-process; just use the output from `first`.
    // Pull the actual scopeHash out of the cache directly.
    const allRows = db
      .query<{ scope_hash: string }, []>('SELECT scope_hash FROM recap_cache')
      .all();
    expect(allRows).toHaveLength(1);
    const scopeHash = allRows[0]?.scope_hash ?? '';
    expect(scopeHash.length).toBeGreaterThan(0);

    writeRecapCache(db, {
      scopeHash,
      renderer: 'terse',
      output: 'SENTINEL: cache served this.',
      promptVersion: TERSE_DETERMINISTIC_VERSION,
      generatedAt: 5_000,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    });

    const second = buildAutoTerse({ db, sessionId: s.id, now: 5_001 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.cacheHit).toBe(true);
    expect(second.markdown).toBe('SENTINEL: cache served this.');

    // Cache row still readable on read-after-write.
    const cached = readRecapCache(db, { scopeHash, now: 5_002 });
    expect(cached?.output).toBe('SENTINEL: cache served this.');
    void intermediateScope;
  });
});
