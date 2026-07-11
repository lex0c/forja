import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  DEFAULT_RECAP_CACHE_TTL_MS,
  canonicalScopeHash,
  getEffectiveRecapCacheTtlMs,
  purgeExpiredRecapCache,
  readRecapCache,
  recapMiniCacheKey,
  setRecapCacheTtlOverride,
  writeRecapCache,
} from '../../src/storage/repos/recap-cache.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

const SAMPLE_INTERMEDIATE = {
  schemaVersion: 'v1',
  scope: { kind: 'session_specific', sessionIds: ['s-1'] },
  goal: { text: 'do the thing', sourceStepId: 'step-1' },
  actions: { filesRead: [], filesWritten: [], commandsRun: [] },
};

describe('canonicalScopeHash', () => {
  test('is deterministic for the same inputs', () => {
    const h1 = canonicalScopeHash({
      scopeKind: 'session_specific',
      sessionIds: ['s-1'],
      renderer: 'pr',
      promptVersion: 'pr-v1',
      intermediate: SAMPLE_INTERMEDIATE,
    });
    const h2 = canonicalScopeHash({
      scopeKind: 'session_specific',
      sessionIds: ['s-1'],
      renderer: 'pr',
      promptVersion: 'pr-v1',
      intermediate: SAMPLE_INTERMEDIATE,
    });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  test('session_ids order does not affect the hash (sorted internally)', () => {
    const a = canonicalScopeHash({
      scopeKind: 'day',
      sessionIds: ['b', 'a', 'c'],
      renderer: 'pr',
      promptVersion: 'pr-v1',
      intermediate: SAMPLE_INTERMEDIATE,
    });
    const b = canonicalScopeHash({
      scopeKind: 'day',
      sessionIds: ['c', 'b', 'a'],
      renderer: 'pr',
      promptVersion: 'pr-v1',
      intermediate: SAMPLE_INTERMEDIATE,
    });
    expect(a).toBe(b);
  });

  test('changing the intermediate produces a different hash (correctness leg)', () => {
    const base = canonicalScopeHash({
      scopeKind: 'session_specific',
      sessionIds: ['s-1'],
      renderer: 'pr',
      promptVersion: 'pr-v1',
      intermediate: SAMPLE_INTERMEDIATE,
    });
    const mutated = canonicalScopeHash({
      scopeKind: 'session_specific',
      sessionIds: ['s-1'],
      renderer: 'pr',
      promptVersion: 'pr-v1',
      intermediate: {
        ...SAMPLE_INTERMEDIATE,
        goal: { text: 'a different goal', sourceStepId: 'step-2' },
      },
    });
    expect(base).not.toBe(mutated);
  });

  test('changing the render model produces a different hash (no cross-model serve)', () => {
    const base = canonicalScopeHash({
      scopeKind: 'session_specific',
      sessionIds: ['s-1'],
      renderer: 'pr',
      promptVersion: 'pr-v1',
      intermediate: SAMPLE_INTERMEDIATE,
      modelId: 'anthropic/claude-haiku-4-5',
    });
    const other = canonicalScopeHash({
      scopeKind: 'session_specific',
      sessionIds: ['s-1'],
      renderer: 'pr',
      promptVersion: 'pr-v1',
      intermediate: SAMPLE_INTERMEDIATE,
      modelId: 'anthropic/claude-opus-4-8',
    });
    expect(base).not.toBe(other);
    // Omitting modelId stays stable with the legacy/deterministic
    // empty-string default (no spurious miss for existing entries).
    const legacy1 = canonicalScopeHash({
      scopeKind: 'session_specific',
      sessionIds: ['s-1'],
      renderer: 'pr',
      promptVersion: 'pr-v1',
      intermediate: SAMPLE_INTERMEDIATE,
    });
    const legacy2 = canonicalScopeHash({
      scopeKind: 'session_specific',
      sessionIds: ['s-1'],
      renderer: 'pr',
      promptVersion: 'pr-v1',
      intermediate: SAMPLE_INTERMEDIATE,
      modelId: '',
    });
    expect(legacy1).toBe(legacy2);
  });

  test('changing the renderer produces a different hash', () => {
    const a = canonicalScopeHash({
      scopeKind: 'session_specific',
      sessionIds: ['s-1'],
      renderer: 'pr',
      promptVersion: 'pr-v1',
      intermediate: SAMPLE_INTERMEDIATE,
    });
    const b = canonicalScopeHash({
      scopeKind: 'session_specific',
      sessionIds: ['s-1'],
      renderer: 'changelog',
      promptVersion: 'pr-v1',
      intermediate: SAMPLE_INTERMEDIATE,
    });
    expect(a).not.toBe(b);
  });

  test('bumping prompt_version produces a different hash (auto-invalidation)', () => {
    const v1 = canonicalScopeHash({
      scopeKind: 'session_specific',
      sessionIds: ['s-1'],
      renderer: 'pr',
      promptVersion: 'pr-v1',
      intermediate: SAMPLE_INTERMEDIATE,
    });
    const v2 = canonicalScopeHash({
      scopeKind: 'session_specific',
      sessionIds: ['s-1'],
      renderer: 'pr',
      promptVersion: 'pr-v2',
      intermediate: SAMPLE_INTERMEDIATE,
    });
    expect(v1).not.toBe(v2);
  });

  test('volatile fields (generatedAt) do NOT affect the hash', () => {
    // The cache represents "what is in the audit log right now",
    // not "when did we last project it". `generatedAt` is the
    // wall-clock at projection time and changes on every call,
    // so including it in the hash would force a miss every time.
    const a = canonicalScopeHash({
      scopeKind: 'session_specific',
      sessionIds: ['s-1'],
      renderer: 'pr',
      promptVersion: 'pr-v1',
      intermediate: { ...SAMPLE_INTERMEDIATE, generatedAt: 1_000 },
    });
    const b = canonicalScopeHash({
      scopeKind: 'session_specific',
      sessionIds: ['s-1'],
      renderer: 'pr',
      promptVersion: 'pr-v1',
      intermediate: { ...SAMPLE_INTERMEDIATE, generatedAt: 9_999_999 },
    });
    expect(a).toBe(b);
  });

  test('insertion-order changes inside intermediate do NOT change the hash', () => {
    // Two structurally equal RecapIntermediates with different
    // in-memory key insertion order must collide. canonicalJson
    // (used by the hasher) is responsible; this test is the
    // observable contract.
    const ordered = {
      schemaVersion: 'v1',
      scope: { kind: 'session_specific', sessionIds: ['s-1'] },
      goal: { text: 'go', sourceStepId: 'step-1' },
    };
    const reordered = {
      goal: { sourceStepId: 'step-1', text: 'go' },
      scope: { sessionIds: ['s-1'], kind: 'session_specific' },
      schemaVersion: 'v1',
    };
    const h1 = canonicalScopeHash({
      scopeKind: 'session_specific',
      sessionIds: ['s-1'],
      renderer: 'pr',
      promptVersion: 'pr-v1',
      intermediate: ordered,
    });
    const h2 = canonicalScopeHash({
      scopeKind: 'session_specific',
      sessionIds: ['s-1'],
      renderer: 'pr',
      promptVersion: 'pr-v1',
      intermediate: reordered,
    });
    expect(h1).toBe(h2);
  });
});

describe('recap_cache repo', () => {
  test('write then read returns the cached entry', () => {
    const hash = canonicalScopeHash({
      scopeKind: 'session_specific',
      sessionIds: ['s-1'],
      renderer: 'pr',
      promptVersion: 'pr-v1',
      intermediate: SAMPLE_INTERMEDIATE,
    });
    writeRecapCache(db, {
      scopeHash: hash,
      renderer: 'pr',
      output: '## Summary\n- did things',
      promptVersion: 'pr-v1',
      generatedAt: 1_000,
      costUsd: 0.0012,
      tokensIn: 800,
      tokensOut: 200,
    });
    const got = readRecapCache(db, { scopeHash: hash, now: 1_500 });
    expect(got?.output).toBe('## Summary\n- did things');
    expect(got?.renderer).toBe('pr');
    expect(got?.promptVersion).toBe('pr-v1');
    expect(got?.generatedAt).toBe(1_000);
    expect(got?.expiresAt).toBe(1_000 + DEFAULT_RECAP_CACHE_TTL_MS);
    expect(got?.costUsd).toBeCloseTo(0.0012, 6);
    expect(got?.tokensIn).toBe(800);
    expect(got?.tokensOut).toBe(200);
  });

  test('miss on unknown hash returns null', () => {
    expect(readRecapCache(db, { scopeHash: 'no-such-hash', now: 0 })).toBeNull();
  });

  test('expired entry returns null and is evicted inline', () => {
    const hash = 'abc';
    writeRecapCache(db, {
      scopeHash: hash,
      renderer: 'pr',
      output: 'old',
      promptVersion: 'pr-v1',
      generatedAt: 0,
      ttlMs: 100,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    });
    // Just past TTL
    expect(readRecapCache(db, { scopeHash: hash, now: 101 })).toBeNull();
    // The row was deleted; even now=0 (which would normally hit) returns null
    expect(readRecapCache(db, { scopeHash: hash, now: 0 })).toBeNull();
  });

  test('boundary: now == expires_at counts as expired (exclusive end)', () => {
    const hash = 'edge';
    writeRecapCache(db, {
      scopeHash: hash,
      renderer: 'pr',
      output: 'edge',
      promptVersion: 'pr-v1',
      generatedAt: 0,
      ttlMs: 100,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    });
    // expires_at = 100 exactly; reading at 100 must be a miss to avoid
    // off-by-one drift across the boundary.
    expect(readRecapCache(db, { scopeHash: hash, now: 100 })).toBeNull();
  });

  test('rewrite (INSERT OR REPLACE) updates output and resets TTL', () => {
    const hash = 'rewrite';
    writeRecapCache(db, {
      scopeHash: hash,
      renderer: 'pr',
      output: 'first',
      promptVersion: 'pr-v1',
      generatedAt: 0,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    });
    writeRecapCache(db, {
      scopeHash: hash,
      renderer: 'pr',
      output: 'second',
      promptVersion: 'pr-v1',
      generatedAt: 1_000,
      costUsd: 0.5,
      tokensIn: 10,
      tokensOut: 20,
    });
    const got = readRecapCache(db, { scopeHash: hash, now: 1_500 });
    expect(got?.output).toBe('second');
    expect(got?.generatedAt).toBe(1_000);
    expect(got?.costUsd).toBe(0.5);
  });

  test('recapMiniCacheKey is deterministic and content-keyed', () => {
    const a = recapMiniCacheKey({
      sessionId: 'sid-1',
      status: 'done',
      endedAt: 2_000,
      costUsd: 0.04,
      promptVersion: 'mini-v1',
    });
    const b = recapMiniCacheKey({
      sessionId: 'sid-1',
      status: 'done',
      endedAt: 2_000,
      costUsd: 0.04,
      promptVersion: 'mini-v1',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('recapMiniCacheKey changes when status / endedAt / cost / version change', () => {
    const base = {
      sessionId: 'sid-1',
      status: 'done' as const,
      endedAt: 2_000,
      costUsd: 0.04,
      promptVersion: 'mini-v1',
    };
    const k0 = recapMiniCacheKey(base);
    expect(recapMiniCacheKey({ ...base, status: 'error' })).not.toBe(k0);
    expect(recapMiniCacheKey({ ...base, endedAt: 9_999 })).not.toBe(k0);
    expect(recapMiniCacheKey({ ...base, costUsd: 0.05 })).not.toBe(k0);
    expect(recapMiniCacheKey({ ...base, promptVersion: 'mini-v2' })).not.toBe(k0);
  });

  test('recapMiniCacheKey accepts null endedAt (running session)', () => {
    const key = recapMiniCacheKey({
      sessionId: 'sid-1',
      status: 'running',
      endedAt: null,
      costUsd: 0,
      promptVersion: 'mini-v1',
    });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  test('purgeExpiredRecapCache deletes only expired rows', () => {
    writeRecapCache(db, {
      scopeHash: 'live',
      renderer: 'pr',
      output: '',
      promptVersion: 'pr-v1',
      generatedAt: 1_000,
      ttlMs: 1_000,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    });
    writeRecapCache(db, {
      scopeHash: 'dead',
      renderer: 'pr',
      output: '',
      promptVersion: 'pr-v1',
      generatedAt: 0,
      ttlMs: 100,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    });
    const removed = purgeExpiredRecapCache(db, 500);
    expect(removed).toBe(1);
    expect(readRecapCache(db, { scopeHash: 'live', now: 500 })).not.toBeNull();
    expect(readRecapCache(db, { scopeHash: 'dead', now: 500 })).toBeNull();
  });
});

describe('setRecapCacheTtlOverride — config-driven TTL wiring', () => {
  // Operator-reported bug: [audit.retention].recap_cache parsed +
  // surfaced but never wired to the write path. Operators setting
  // a non-default TTL saw it ignored — writes still used the
  // hardcoded 1h default.
  // Fix: module-level effective default + bootstrap setter. Pin
  // both the override applies AND the reset restores baseline.

  afterEach(() => {
    // Reset so override doesn't leak across tests (module-level state).
    setRecapCacheTtlOverride(undefined);
  });

  test('baseline: getEffectiveRecapCacheTtlMs returns DEFAULT', () => {
    expect(getEffectiveRecapCacheTtlMs()).toBe(DEFAULT_RECAP_CACHE_TTL_MS);
  });

  test('override changes the value used by writeRecapCache (no explicit ttlMs)', () => {
    setRecapCacheTtlOverride(5 * 60 * 1000); // 5 minutes
    expect(getEffectiveRecapCacheTtlMs()).toBe(5 * 60 * 1000);

    const generatedAt = 1_000_000;
    const entry = writeRecapCache(db, {
      scopeHash: 'override-test',
      renderer: 'pr',
      promptVersion: 'v1',
      output: 'x',
      // NO ttlMs — should pick up the override.
      generatedAt,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    });
    // Load-bearing: expires_at = generatedAt + override (5m), not
    // the canonical 1h default.
    expect(entry.expiresAt).toBe(generatedAt + 5 * 60 * 1000);
  });

  test('explicit ttlMs still wins over the override (per-call escape)', () => {
    setRecapCacheTtlOverride(5 * 60 * 1000); // 5m
    const generatedAt = 2_000_000;
    const entry = writeRecapCache(db, {
      scopeHash: 'explicit-ttl',
      renderer: 'pr',
      promptVersion: 'v1',
      output: 'x',
      ttlMs: 30_000, // 30s — should override the override
      generatedAt,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    });
    expect(entry.expiresAt).toBe(generatedAt + 30_000);
  });

  test('setRecapCacheTtlOverride(undefined) reverts to DEFAULT', () => {
    setRecapCacheTtlOverride(5 * 60 * 1000);
    setRecapCacheTtlOverride(undefined);
    expect(getEffectiveRecapCacheTtlMs()).toBe(DEFAULT_RECAP_CACHE_TTL_MS);
  });
});
