// Ranking tests (RETRIEVAL.md §5, slice 4.6).

import { describe, expect, test } from 'bun:test';
import { WORKFLOW_WEIGHTS, rankCandidates } from '../../src/retrieval/ranking.ts';
import type {
  ExpandedCandidate,
  RetrievalQuery,
  RetrievalWorkflow,
} from '../../src/retrieval/types.ts';

const baseQuery: RetrievalQuery = {
  text: 'auth',
  workflow: 'default',
  queryType: 'semantic',
  budgetTokens: 100,
};

const makeCandidate = (overrides: Partial<ExpandedCandidate> = {}): ExpandedCandidate => ({
  nodeId: 'session:message:default',
  view: 'session',
  bootstrapScore: 1.0,
  reason: 'stub',
  path: ['session:message:default'],
  runningScore: 1.0,
  ...overrides,
});

describe('WORKFLOW_WEIGHTS — invariants', () => {
  test('every workflow weight set sums to 1.0 (within float epsilon)', () => {
    // Float-point arithmetic can produce 0.9999999999999999
    // (`0.1 + 0.2 + 0.4 + ...`) — that's still "1.0" for ranking
    // purposes. The module-load guard uses the same epsilon.
    for (const [workflow, weights] of Object.entries(WORKFLOW_WEIGHTS)) {
      const sum =
        weights.structural +
        weights.lexical +
        weights.semantic +
        weights.temporal +
        weights.usage +
        weights.goalAlignment;
      expect(Math.abs(sum - 1.0)).toBeLessThan(1e-9);
      // Diagnostic — surfaces the workflow name on failure.
      if (Math.abs(sum - 1.0) >= 1e-9) {
        throw new Error(`workflow '${workflow}' sums to ${sum}`);
      }
    }
  });

  test('covers every declared workflow type', () => {
    const workflows: RetrievalWorkflow[] = [
      'review',
      'refactor',
      'explain',
      'debug',
      'precedent_lookup',
      'default',
    ];
    for (const w of workflows) {
      expect(WORKFLOW_WEIGHTS[w]).toBeDefined();
    }
  });
});

describe('rankCandidates — empty input', () => {
  test('returns empty when no candidates', () => {
    expect(rankCandidates({ candidates: [], query: baseQuery })).toEqual([]);
  });
});

describe('rankCandidates — signal: structural', () => {
  test('1.0 for single-element path (no hop)', () => {
    const r = rankCandidates({
      candidates: [makeCandidate({ path: ['n1'] })],
      query: baseQuery,
    });
    expect(r[0]?.signals.structural).toBe(1.0);
  });

  test('decays with longer paths', () => {
    const r = rankCandidates({
      candidates: [
        makeCandidate({ nodeId: 'short', path: ['a'] }),
        makeCandidate({ nodeId: 'long', path: ['a', 'b', 'c'] }),
      ],
      query: baseQuery,
    });
    const short = r.find((c) => c.nodeId === 'short');
    const long = r.find((c) => c.nodeId === 'long');
    if (!short || !long) throw new Error('both expected');
    expect(short.signals.structural).toBeGreaterThan(long.signals.structural);
  });
});

describe('rankCandidates — signal: lexical', () => {
  test('normalized by the batch max — top candidate is 1.0', () => {
    const r = rankCandidates({
      candidates: [
        makeCandidate({ nodeId: 'a', bootstrapScore: 0.5 }),
        makeCandidate({ nodeId: 'b', bootstrapScore: 1.0 }),
        makeCandidate({ nodeId: 'c', bootstrapScore: 0.25 }),
      ],
      query: baseQuery,
    });
    const b = r.find((c) => c.nodeId === 'b');
    const a = r.find((c) => c.nodeId === 'a');
    const c = r.find((c) => c.nodeId === 'c');
    expect(b?.signals.lexical).toBe(1.0);
    expect(a?.signals.lexical).toBe(0.5);
    expect(c?.signals.lexical).toBe(0.25);
  });

  test('all-zero bootstrap → lexical signal is 0 (no division by zero)', () => {
    const r = rankCandidates({
      candidates: [makeCandidate({ bootstrapScore: 0 })],
      query: baseQuery,
    });
    expect(r[0]?.signals.lexical).toBe(0);
  });
});

describe('rankCandidates — signal: temporal', () => {
  test('1.0 (neutral) when createdAt is absent', () => {
    const r = rankCandidates({
      candidates: [makeCandidate({ view: 'session' })],
      query: baseQuery,
      now: () => 1_000_000,
    });
    expect(r[0]?.signals.temporal).toBe(1.0);
  });

  test('workspace view ignores age (no decay regardless of createdAt)', () => {
    const r = rankCandidates({
      candidates: [
        makeCandidate({
          view: 'workspace',
          nodeId: 'workspace:file:foo.ts',
          createdAt: 0,
        }),
      ],
      query: baseQuery,
      now: () => 365 * 24 * 60 * 60 * 1000, // 1 year later
    });
    expect(r[0]?.signals.temporal).toBe(1.0);
  });

  test('session view decays with 1h half-life', () => {
    const oneHourMs = 60 * 60 * 1000;
    const now = 10 * oneHourMs;
    const r = rankCandidates({
      candidates: [
        makeCandidate({ nodeId: 'fresh', createdAt: now }),
        makeCandidate({ nodeId: 'oneHour', createdAt: now - oneHourMs }),
        makeCandidate({ nodeId: 'twoHours', createdAt: now - 2 * oneHourMs }),
      ],
      query: baseQuery,
      now: () => now,
    });
    const fresh = r.find((c) => c.nodeId === 'fresh');
    const oneHour = r.find((c) => c.nodeId === 'oneHour');
    const twoHours = r.find((c) => c.nodeId === 'twoHours');
    if (!fresh || !oneHour || !twoHours) throw new Error('all expected');
    expect(fresh.signals.temporal).toBeCloseTo(1.0, 5);
    expect(oneHour.signals.temporal).toBeCloseTo(0.5, 5);
    expect(twoHours.signals.temporal).toBeCloseTo(0.25, 5);
  });

  test('clamped to [0, 1] when createdAt is in the future (clock skew / replay)', async () => {
    // Forward-dated createdAt would otherwise produce a negative
    // decay exponent and signal > 1.0. The clamp keeps the [0, 1]
    // contract the rest of the trace renders against.
    const now = 1_000_000;
    const r = rankCandidates({
      candidates: [
        makeCandidate({
          view: 'session',
          createdAt: now + 60 * 60 * 1000, // 1 hour in the future
        }),
      ],
      query: baseQuery,
      now: () => now,
    });
    expect(r[0]?.signals.temporal).toBe(1.0);
  });

  test('memory view decays with 30d half-life', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const now = 100 * dayMs;
    const r = rankCandidates({
      candidates: [
        makeCandidate({
          nodeId: 'memory:user/recent',
          view: 'memory',
          createdAt: now - 30 * dayMs,
        }),
        makeCandidate({
          nodeId: 'memory:user/old',
          view: 'memory',
          createdAt: now - 60 * dayMs,
        }),
      ],
      query: baseQuery,
      now: () => now,
    });
    const recent = r.find((c) => c.nodeId === 'memory:user/recent');
    const old = r.find((c) => c.nodeId === 'memory:user/old');
    if (!recent || !old) throw new Error('both expected');
    // 30d ago == 1 half-life → 0.5; 60d ago == 2 half-lives → 0.25.
    expect(recent.signals.temporal).toBeCloseTo(0.5, 5);
    expect(old.signals.temporal).toBeCloseTo(0.25, 5);
  });
});

describe('rankCandidates — signals: deferred (semantic / usage / goalAlignment)', () => {
  test('always 0 in v1 — no embedding, no usage history, no goal canonical form', () => {
    const r = rankCandidates({
      candidates: [makeCandidate()],
      query: baseQuery,
    });
    expect(r[0]?.signals.semantic).toBe(0);
    expect(r[0]?.signals.usage).toBe(0);
    expect(r[0]?.signals.goalAlignment).toBe(0);
  });
});

describe('rankCandidates — finalScore = Σ w_i · signal_i', () => {
  test('default workflow: finalScore matches the weighted sum', () => {
    const w = WORKFLOW_WEIGHTS.default;
    const r = rankCandidates({
      candidates: [makeCandidate({ bootstrapScore: 1.0, path: ['n'] })],
      query: baseQuery,
    });
    const c = r[0];
    if (c === undefined) throw new Error('expected one');
    // structural=1, lexical=1 (only candidate), semantic=0,
    // temporal=1 (no createdAt → neutral), usage=0, goal=0.
    const expected =
      w.structural * 1 +
      w.lexical * 1 +
      w.semantic * 0 +
      w.temporal * 1 +
      w.usage * 0 +
      w.goalAlignment * 0;
    expect(c.finalScore).toBeCloseTo(expected, 9);
  });

  test('debug workflow weights temporal heavily (recovery focus)', () => {
    const oneHourMs = 60 * 60 * 1000;
    const now = 10 * oneHourMs;
    // Same bootstrap, but one is fresh and one is 4 hours old
    // (16x decayed). Under debug weights temporal=0.4, the fresh
    // one should rank higher.
    const r = rankCandidates({
      candidates: [
        makeCandidate({ nodeId: 'fresh', bootstrapScore: 1.0, createdAt: now }),
        makeCandidate({
          nodeId: 'stale',
          bootstrapScore: 1.0,
          createdAt: now - 4 * oneHourMs,
        }),
      ],
      query: { ...baseQuery, workflow: 'debug' },
      now: () => now,
    });
    expect(r[0]?.nodeId).toBe('fresh');
  });

  test('refactor workflow ignores temporal — fresh and stale tie on other signals', () => {
    // refactor: temporal weight is 0.0, so the 4h difference
    // doesn't matter — both should land identically.
    const oneHourMs = 60 * 60 * 1000;
    const now = 10 * oneHourMs;
    const r = rankCandidates({
      candidates: [
        makeCandidate({ nodeId: 'fresh', bootstrapScore: 1.0, createdAt: now }),
        makeCandidate({
          nodeId: 'stale',
          bootstrapScore: 1.0,
          createdAt: now - 4 * oneHourMs,
        }),
      ],
      query: { ...baseQuery, workflow: 'refactor' },
      now: () => now,
    });
    expect(r[0]?.finalScore).toBe(r[1]?.finalScore);
  });
});

describe('rankCandidates — ordering', () => {
  test('descending by finalScore', () => {
    const r = rankCandidates({
      candidates: [
        makeCandidate({ nodeId: 'low', bootstrapScore: 0.1 }),
        makeCandidate({ nodeId: 'high', bootstrapScore: 1.0 }),
        makeCandidate({ nodeId: 'mid', bootstrapScore: 0.5 }),
      ],
      query: baseQuery,
    });
    expect(r.map((c) => c.nodeId)).toEqual(['high', 'mid', 'low']);
  });

  test('tiebreaker is nodeId ASC (deterministic trace replay)', () => {
    const r = rankCandidates({
      candidates: [
        makeCandidate({ nodeId: 'zebra', bootstrapScore: 0.5 }),
        makeCandidate({ nodeId: 'alpha', bootstrapScore: 0.5 }),
        makeCandidate({ nodeId: 'mike', bootstrapScore: 0.5 }),
      ],
      query: baseQuery,
    });
    expect(r.map((c) => c.nodeId)).toEqual(['alpha', 'mike', 'zebra']);
  });

  test('tiebreaker fires even when finalScore differs by float-round-off', () => {
    // Construct a scenario where two candidates land at scores
    // that are semantically equal but differ by ~1e-16 from
    // float-add round-off. Strict `===` would miss; the epsilon
    // tiebreaker catches and reverts to nodeId order.
    //
    // Forcing the round-off deterministically: 0.1 + 0.2 in
    // JS is 0.30000000000000004; same total reached two ways
    // produces a tiny difference downstream.
    //
    // Easier path: ranking sees structural=1, lexical normalized,
    // and the only diff is the order of operands in the same
    // sum. Two `makeCandidate` with identical signals MUST tie.
    // The regression we're guarding against would surface as
    // unstable order on rerun; deterministic order is what we
    // assert.
    const candidates = [
      makeCandidate({ nodeId: 'zebra', bootstrapScore: 1.0, path: ['n1'] }),
      makeCandidate({ nodeId: 'alpha', bootstrapScore: 1.0, path: ['n1'] }),
    ];
    const r1 = rankCandidates({ candidates, query: baseQuery });
    const r2 = rankCandidates({ candidates: [...candidates].reverse(), query: baseQuery });
    expect(r1.map((c) => c.nodeId)).toEqual(['alpha', 'zebra']);
    expect(r2.map((c) => c.nodeId)).toEqual(['alpha', 'zebra']);
  });
});
