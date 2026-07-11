// memory_verify_attempts repo tests (migration 057, S11 / T11.10).
//
// Substrate pins for the dedup cache the dispatcher + scheduler
// consume. Most contracts are validated at the repo (defensive),
// not just at the DB CHECK — bypass tests prove the DB defends
// itself if a future caller skips the repo.

import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  listRecentAttempts,
  lookupRecentAttempt,
  MEMORY_VERIFY_ATTEMPTS_RETENTION_MS,
  pruneVerifyAttempts,
  type RecordAttemptInput,
  recordAttempt,
  SEMANTIC_VERIFY_DEDUP_WINDOW_MS,
  type SemanticVerifyVerdict,
} from '../../src/storage/repos/memory-verify-attempts.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

const SAMPLE_HASH = 'a'.repeat(64);

const baseAttempt = (overrides: Partial<RecordAttemptInput> = {}): RecordAttemptInput => ({
  memoryScope: 'project_local',
  memoryName: 'foo',
  contentHash: SAMPLE_HASH,
  verdict: 'passed',
  confidence: 0.8,
  modelId: 'test/model',
  promptHash: 'b'.repeat(64),
  ...overrides,
});

describe('recordAttempt — validation', () => {
  test('persists a well-formed row + round-trips every field', () => {
    const row = recordAttempt(
      db,
      baseAttempt({
        verdict: 'contradicted',
        confidence: 0.9,
        subagentRunSessionId: null,
        attemptedAt: 5_000_000_000_000,
      }),
    );
    expect(row.id).toBeTruthy();
    expect(row.memoryScope).toBe('project_local');
    expect(row.memoryName).toBe('foo');
    expect(row.contentHash).toBe(SAMPLE_HASH);
    expect(row.verdict).toBe('contradicted');
    expect(row.confidence).toBeCloseTo(0.9);
    expect(row.modelId).toBe('test/model');
    expect(row.attemptedAt).toBe(5_000_000_000_000);
  });

  test('rejects invalid memoryScope', () => {
    expect(() => recordAttempt(db, baseAttempt({ memoryScope: 'shared' as never }))).toThrow(
      /invalid memoryScope/,
    );
  });

  test('rejects empty memoryName / contentHash / modelId / promptHash', () => {
    expect(() => recordAttempt(db, baseAttempt({ memoryName: '' }))).toThrow(/memoryName/);
    expect(() => recordAttempt(db, baseAttempt({ contentHash: '' }))).toThrow(/contentHash/);
    expect(() => recordAttempt(db, baseAttempt({ modelId: '' }))).toThrow(/modelId/);
    expect(() => recordAttempt(db, baseAttempt({ promptHash: '' }))).toThrow(/promptHash/);
  });

  test('rejects invalid verdict', () => {
    expect(() =>
      recordAttempt(db, baseAttempt({ verdict: 'maybe' as SemanticVerifyVerdict })),
    ).toThrow(/invalid verdict/);
  });

  test('rejects confidence outside [0, 1]', () => {
    expect(() => recordAttempt(db, baseAttempt({ confidence: 1.1 }))).toThrow(/confidence/);
    expect(() => recordAttempt(db, baseAttempt({ confidence: -0.1 }))).toThrow(/confidence/);
    expect(() => recordAttempt(db, baseAttempt({ confidence: Number.NaN }))).toThrow(/confidence/);
  });

  test('rejects non-positive attemptedAt', () => {
    expect(() => recordAttempt(db, baseAttempt({ attemptedAt: 0 }))).toThrow(/attemptedAt/);
  });
});

describe('schema gates (DB-level CHECK bypass)', () => {
  test('CHECK rejects invalid verdict at the DB level', () => {
    expect(() =>
      db
        .query(
          `INSERT INTO memory_verify_attempts
             (id, memory_scope, memory_name, content_hash, verdict, confidence,
              model_id, prompt_hash, attempted_at)
           VALUES (?, 'project_local', 'foo', 'h', 'bogus', 0.5, 'm', 'p', 1000)`,
        )
        .run('id-bad'),
    ).toThrow(/CHECK constraint/);
  });

  test('CHECK rejects confidence outside [0, 1] at the DB level', () => {
    expect(() =>
      db
        .query(
          `INSERT INTO memory_verify_attempts
             (id, memory_scope, memory_name, content_hash, verdict, confidence,
              model_id, prompt_hash, attempted_at)
           VALUES (?, 'project_local', 'foo', 'h', 'passed', 1.5, 'm', 'p', 1000)`,
        )
        .run('id-bad-conf'),
    ).toThrow(/CHECK constraint/);
  });

  test('CHECK rejects non-positive attempted_at', () => {
    expect(() =>
      db
        .query(
          `INSERT INTO memory_verify_attempts
             (id, memory_scope, memory_name, content_hash, verdict, confidence,
              model_id, prompt_hash, attempted_at)
           VALUES (?, 'project_local', 'foo', 'h', 'passed', 0.5, 'm', 'p', 0)`,
        )
        .run('id-bad-ts'),
    ).toThrow(/CHECK constraint/);
  });
});

describe('lookupRecentAttempt — dedup semantics', () => {
  const nowMs = 5_000_000_000_000;

  test('returns null when no attempt exists', () => {
    expect(lookupRecentAttempt(db, 'project_local', 'foo', SAMPLE_HASH, { nowMs })).toBeNull();
  });

  test('returns the row when passed verdict is within the window', () => {
    recordAttempt(db, baseAttempt({ verdict: 'passed', attemptedAt: nowMs - 1_000 }));
    const row = lookupRecentAttempt(db, 'project_local', 'foo', SAMPLE_HASH, { nowMs });
    expect(row).not.toBeNull();
    expect(row?.verdict).toBe('passed');
  });

  test('returns the row when inconclusive verdict is within the window', () => {
    recordAttempt(db, baseAttempt({ verdict: 'inconclusive', attemptedAt: nowMs - 1_000 }));
    const row = lookupRecentAttempt(db, 'project_local', 'foo', SAMPLE_HASH, { nowMs });
    expect(row?.verdict).toBe('inconclusive');
  });

  test('contradicted ALWAYS re-dispatches (returns null even just-recorded)', () => {
    recordAttempt(db, baseAttempt({ verdict: 'contradicted', attemptedAt: nowMs - 100 }));
    expect(lookupRecentAttempt(db, 'project_local', 'foo', SAMPLE_HASH, { nowMs })).toBeNull();
  });

  test('passed past the window returns null (re-dispatch)', () => {
    recordAttempt(
      db,
      baseAttempt({
        verdict: 'passed',
        attemptedAt: nowMs - SEMANTIC_VERIFY_DEDUP_WINDOW_MS - 1,
      }),
    );
    expect(lookupRecentAttempt(db, 'project_local', 'foo', SAMPLE_HASH, { nowMs })).toBeNull();
  });

  test('passed at exactly the window boundary → null (window is exclusive on equality)', () => {
    recordAttempt(
      db,
      baseAttempt({
        verdict: 'passed',
        attemptedAt: nowMs - SEMANTIC_VERIFY_DEDUP_WINDOW_MS,
      }),
    );
    expect(lookupRecentAttempt(db, 'project_local', 'foo', SAMPLE_HASH, { nowMs })).toBeNull();
  });

  test('content_hash mismatch → null even with same scope/name', () => {
    recordAttempt(db, baseAttempt({ verdict: 'passed', attemptedAt: nowMs - 100 }));
    expect(lookupRecentAttempt(db, 'project_local', 'foo', 'c'.repeat(64), { nowMs })).toBeNull();
  });

  test('windowMs override widens / narrows the dedup gate', () => {
    recordAttempt(db, baseAttempt({ verdict: 'passed', attemptedAt: nowMs - 10_000 }));
    // 5_000ms window: 10_000ms-old is outside → null.
    expect(
      lookupRecentAttempt(db, 'project_local', 'foo', SAMPLE_HASH, {
        nowMs,
        windowMs: 5_000,
      }),
    ).toBeNull();
    // 100_000ms window: 10_000ms-old is inside → returns row.
    expect(
      lookupRecentAttempt(db, 'project_local', 'foo', SAMPLE_HASH, {
        nowMs,
        windowMs: 100_000,
      }),
    ).not.toBeNull();
  });
});

describe('listRecentAttempts', () => {
  test('returns rows most-recent first, capped by limit', () => {
    recordAttempt(db, baseAttempt({ memoryName: 'oldest', attemptedAt: 1_000_000_000_000 }));
    recordAttempt(db, baseAttempt({ memoryName: 'middle', attemptedAt: 2_000_000_000_000 }));
    recordAttempt(db, baseAttempt({ memoryName: 'newest', attemptedAt: 3_000_000_000_000 }));
    const rows = listRecentAttempts(db, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.memoryName).toBe('newest');
    expect(rows[1]?.memoryName).toBe('middle');
  });

  test('empty when no rows', () => {
    expect(listRecentAttempts(db)).toHaveLength(0);
  });
});

describe('pruneVerifyAttempts — retention sweep', () => {
  test('drops rows older than cutoff (exclusive); keeps the boundary row', () => {
    const now = 5_000_000_000_000;
    const cutoff = now - MEMORY_VERIFY_ATTEMPTS_RETENTION_MS;
    recordAttempt(db, baseAttempt({ memoryName: 'old', attemptedAt: cutoff - 1 }));
    recordAttempt(db, baseAttempt({ memoryName: 'boundary', attemptedAt: cutoff }));
    recordAttempt(db, baseAttempt({ memoryName: 'fresh', attemptedAt: now }));
    const dropped = pruneVerifyAttempts(db, cutoff);
    expect(dropped).toBe(1);
    const remaining = listRecentAttempts(db, 50).map((r) => r.memoryName);
    expect(remaining).toContain('boundary');
    expect(remaining).toContain('fresh');
    expect(remaining).not.toContain('old');
  });

  test('returns 0 when no rows match the cutoff', () => {
    expect(pruneVerifyAttempts(db, 1_000)).toBe(0);
  });
});
