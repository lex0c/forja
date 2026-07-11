// memory_conflict_attempts repo coverage (T13.4).
//
// Pair canonicalization + INSERT + dedup + retention sweep. Mirror
// of memory-verify-attempts.test.ts but with pair shapes.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  type ConflictPairSide,
  canonicalizePair,
  listRecentConflictAttempts,
  lookupRecentConflictAttempt,
  pruneConflictAttempts,
  recordConflictAttempt,
  SEMANTIC_CONFLICT_DEDUP_WINDOW_MS,
} from '../../src/storage/repos/memory-conflict-attempts.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

afterEach(() => {
  db.close();
});

const side = (overrides: Partial<ConflictPairSide> = {}): ConflictPairSide => ({
  scope: 'project_local',
  name: 'foo',
  contentHash: 'h'.repeat(64),
  ...overrides,
});

// ── canonicalizePair ──────────────────────────────────────────────

describe('canonicalizePair', () => {
  test('lexicographically smaller scope/name becomes side A', () => {
    const x = side({ name: 'zebra' });
    const y = side({ name: 'aardvark' });
    const pair = canonicalizePair(x, y);
    expect(pair.a.name).toBe('aardvark');
    expect(pair.b.name).toBe('zebra');
  });

  test('order-independent: same inputs in either order produce same canonical pair', () => {
    const x = side({ name: 'aardvark' });
    const y = side({ name: 'zebra' });
    const xy = canonicalizePair(x, y);
    const yx = canonicalizePair(y, x);
    expect(xy.a.name).toBe(yx.a.name);
    expect(xy.b.name).toBe(yx.b.name);
  });

  test('cross-scope sort: project_local/foo < user/foo (alphabetical on full key)', () => {
    const a = side({ scope: 'user', name: 'foo' });
    const b = side({ scope: 'project_local', name: 'foo' });
    const pair = canonicalizePair(a, b);
    expect(pair.a.scope).toBe('project_local');
  });

  test('same (scope, name) on both sides throws', () => {
    expect(() => canonicalizePair(side({ name: 'foo' }), side({ name: 'foo' }))).toThrow(
      /same \(scope, name\)/,
    );
  });
});

// ── recordConflictAttempt ─────────────────────────────────────────

describe('recordConflictAttempt', () => {
  test('round-trip with conflicting verdict', () => {
    const pair = canonicalizePair(side({ name: 'a' }), side({ name: 'b' }));
    const row = recordConflictAttempt(db, {
      pair,
      verdict: 'conflicting',
      conflictKind: 'incompatible-implementation',
      confidence: 0.85,
      modelId: 'test/model',
      promptHash: 'p'.repeat(64),
    });
    expect(row.nameA).toBe('a');
    expect(row.nameB).toBe('b');
    expect(row.verdict).toBe('conflicting');
    expect(row.conflictKind).toBe('incompatible-implementation');
    expect(row.confidence).toBeCloseTo(0.85);
  });

  test('compatible verdict with null conflict_kind', () => {
    const pair = canonicalizePair(side({ name: 'a' }), side({ name: 'b' }));
    const row = recordConflictAttempt(db, {
      pair,
      verdict: 'compatible',
      confidence: 0.9,
      modelId: 'test/model',
      promptHash: 'p'.repeat(64),
    });
    expect(row.verdict).toBe('compatible');
    expect(row.conflictKind).toBeNull();
  });

  test('rejects pair not in canonical order', () => {
    // Bypass canonicalizePair to construct an inverted pair literally.
    expect(() =>
      recordConflictAttempt(db, {
        pair: { a: side({ name: 'zebra' }), b: side({ name: 'aardvark' }) },
        verdict: 'compatible',
        confidence: 0.5,
        modelId: 'm',
        promptHash: 'h',
      }),
    ).toThrow(/not in canonical order/);
  });

  test('rejects out-of-range confidence', () => {
    const pair = canonicalizePair(side({ name: 'a' }), side({ name: 'b' }));
    expect(() =>
      recordConflictAttempt(db, {
        pair,
        verdict: 'compatible',
        confidence: 1.5,
        modelId: 'm',
        promptHash: 'h',
      }),
    ).toThrow(/confidence must be in/);
  });

  test('CHECK constraint enforces canonical order at SQL level', () => {
    // Even if the repo guard is bypassed (raw SQL caller), the
    // SQL CHECK refuses non-canonical inserts.
    expect(() =>
      db.exec(
        `INSERT INTO memory_conflict_attempts
         (id, scope_a, name_a, content_hash_a, scope_b, name_b, content_hash_b,
          verdict, conflict_kind, confidence, model_id, prompt_hash, attempted_at)
         VALUES ('id1', 'user', 'zebra', 'h', 'user', 'aardvark', 'h',
                 'compatible', NULL, 0.5, 'm', 'p', 1)`,
      ),
    ).toThrow();
  });
});

// ── lookupRecentConflictAttempt ───────────────────────────────────

describe('lookupRecentConflictAttempt', () => {
  test('returns row when within window for compatible verdict', () => {
    const pair = canonicalizePair(side({ name: 'a' }), side({ name: 'b' }));
    recordConflictAttempt(db, {
      pair,
      verdict: 'compatible',
      confidence: 0.9,
      modelId: 'm',
      promptHash: 'p',
      attemptedAt: 1_000_000,
    });
    const hit = lookupRecentConflictAttempt(db, pair, {
      nowMs: 1_000_000 + 60_000,
      windowMs: SEMANTIC_CONFLICT_DEDUP_WINDOW_MS,
    });
    expect(hit).not.toBeNull();
    expect(hit?.verdict).toBe('compatible');
  });

  test('returns null for conflicting verdict (always re-dispatch)', () => {
    const pair = canonicalizePair(side({ name: 'a' }), side({ name: 'b' }));
    recordConflictAttempt(db, {
      pair,
      verdict: 'conflicting',
      conflictKind: 'incompatible-value',
      confidence: 0.9,
      modelId: 'm',
      promptHash: 'p',
      attemptedAt: 1_000_000,
    });
    const hit = lookupRecentConflictAttempt(db, pair, {
      nowMs: 1_000_000 + 60_000,
    });
    expect(hit).toBeNull();
  });

  test('returns null past window even for compatible', () => {
    const pair = canonicalizePair(side({ name: 'a' }), side({ name: 'b' }));
    recordConflictAttempt(db, {
      pair,
      verdict: 'compatible',
      confidence: 0.9,
      modelId: 'm',
      promptHash: 'p',
      attemptedAt: 1_000,
    });
    const hit = lookupRecentConflictAttempt(db, pair, {
      nowMs: 1_000 + SEMANTIC_CONFLICT_DEDUP_WINDOW_MS,
    });
    expect(hit).toBeNull();
  });

  test('content_hash drift busts the dedup', () => {
    const pair = canonicalizePair(
      side({ name: 'a', contentHash: 'h1'.padEnd(64, '0') }),
      side({ name: 'b', contentHash: 'h2'.padEnd(64, '0') }),
    );
    recordConflictAttempt(db, {
      pair,
      verdict: 'compatible',
      confidence: 0.9,
      modelId: 'm',
      promptHash: 'p',
      attemptedAt: 1_000_000,
    });
    // Same pair (scope, name) but body of A changed → different hash.
    const drifted = canonicalizePair(
      side({ name: 'a', contentHash: 'h1-edit'.padEnd(64, '0') }),
      side({ name: 'b', contentHash: 'h2'.padEnd(64, '0') }),
    );
    const hit = lookupRecentConflictAttempt(db, drifted, { nowMs: 1_000_001 });
    expect(hit).toBeNull();
  });
});

// ── pruneConflictAttempts ─────────────────────────────────────────

describe('pruneConflictAttempts', () => {
  test('drops rows strictly older than cutoff', () => {
    const pair1 = canonicalizePair(side({ name: 'a' }), side({ name: 'b' }));
    const pair2 = canonicalizePair(side({ name: 'c' }), side({ name: 'd' }));
    recordConflictAttempt(db, {
      pair: pair1,
      verdict: 'compatible',
      confidence: 0.9,
      modelId: 'm',
      promptHash: 'p',
      attemptedAt: 100,
    });
    recordConflictAttempt(db, {
      pair: pair2,
      verdict: 'compatible',
      confidence: 0.9,
      modelId: 'm',
      promptHash: 'p',
      attemptedAt: 200,
    });
    const deleted = pruneConflictAttempts(db, 150);
    expect(deleted).toBe(1);
    const remaining = listRecentConflictAttempts(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.attemptedAt).toBe(200);
  });
});
