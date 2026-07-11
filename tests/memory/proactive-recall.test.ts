// Proactive recall producer tests (MEMORY.md §4.4 Slice P1, I4).
// Pure unit tests: a fake `search` returns candidates with explicit
// bootstrapScores and a fake `loadBody` maps node ids to bodies, so
// the floor / top-K / query-build / ranking logic is deterministic
// without a registry or a runner.

import { describe, expect, test } from 'bun:test';
import {
  buildProactiveRecall,
  PROACTIVE_RECALL_MIN_SCORE,
  PROACTIVE_RECALL_TOP_K,
} from '../../src/memory/proactive-recall.ts';
import type { Candidate } from '../../src/retrieval/types.ts';

const cand = (nodeId: string, score: number): Candidate => ({
  nodeId,
  view: 'memory',
  bootstrapScore: score,
  reason: `BM25 match in ${nodeId}`,
});

const fakeSearch = (candidates: Candidate[]) => async (): Promise<readonly Candidate[]> =>
  candidates;

const bodyFor =
  (bodies: Record<string, string>) =>
  (nodeId: string): string | null =>
    bodies[nodeId] ?? null;

describe('buildProactiveRecall', () => {
  test('empty goal + prompt → no recall, search never called', async () => {
    let called = false;
    const recall = buildProactiveRecall({
      search: async () => {
        called = true;
        return [];
      },
      loadBody: () => 'body',
    });
    expect(await recall({ goalText: '   ', prompt: '' })).toEqual([]);
    expect(called).toBe(false);
  });

  test('floor cuts matches below PROACTIVE_RECALL_MIN_SCORE', async () => {
    const recall = buildProactiveRecall({
      search: fakeSearch([cand('memory:user/strong', 2.0), cand('memory:user/weak', 0.3)]),
      loadBody: bodyFor({ 'memory:user/strong': 'S', 'memory:user/weak': 'W' }),
    });
    const out = await recall({ goalText: 'auth', prompt: 'login' });
    expect(out.map((r) => r.nodeId)).toEqual(['memory:user/strong']);
  });

  test('top-K caps the number recalled', async () => {
    const cands = Array.from({ length: 6 }, (_, i) => cand(`memory:user/m${i}`, 5 - i * 0.1));
    const bodies = Object.fromEntries(cands.map((c) => [c.nodeId, 'b']));
    const recall = buildProactiveRecall({
      search: fakeSearch(cands),
      loadBody: bodyFor(bodies),
      topK: 2,
    });
    const out = await recall({ goalText: 'x', prompt: 'y' });
    expect(out.map((r) => r.nodeId)).toEqual(['memory:user/m0', 'memory:user/m1']);
  });

  test('topK 0 recalls nothing (cap checked before the push)', async () => {
    const recall = buildProactiveRecall({
      search: fakeSearch([cand('memory:user/m', 2.0)]),
      loadBody: bodyFor({ 'memory:user/m': 'B' }),
      topK: 0,
    });
    expect(await recall({ goalText: 'x', prompt: 'y' })).toEqual([]);
  });

  test('trusts the view score-desc order: stops at the first sub-floor hit', async () => {
    // The view always returns score-desc (active-only ⇒ no penalty
    // reshuffle), so the producer breaks at the first sub-floor
    // candidate and never re-ranks a later high score above it.
    const recall = buildProactiveRecall({
      search: fakeSearch([
        cand('memory:user/a', 2.0),
        cand('memory:user/below', 0.3),
        cand('memory:user/late', 9.0),
      ]),
      loadBody: bodyFor({
        'memory:user/a': 'A',
        'memory:user/below': 'B',
        'memory:user/late': 'L',
      }),
    });
    expect((await recall({ goalText: 'x', prompt: 'y' })).map((r) => r.nodeId)).toEqual([
      'memory:user/a',
    ]);
  });

  test('drops survivors whose body cannot load (null, empty, or whitespace-only)', async () => {
    const recall = buildProactiveRecall({
      search: fakeSearch([
        cand('memory:user/withbody', 3.0),
        cand('memory:user/nullbody', 2.5),
        cand('memory:user/emptybody', 2.0),
        cand('memory:user/wsbody', 1.5),
      ]),
      loadBody: bodyFor({
        'memory:user/withbody': 'B',
        'memory:user/emptybody': '',
        'memory:user/wsbody': '   \n  ',
      }),
    });
    const out = await recall({ goalText: 'x', prompt: 'y' });
    expect(out.map((r) => r.nodeId)).toEqual(['memory:user/withbody']);
  });

  test('carries node id + raw score + body for the injection point', async () => {
    const recall = buildProactiveRecall({
      search: fakeSearch([cand('memory:user/a', 4.2)]),
      loadBody: bodyFor({ 'memory:user/a': 'the body text' }),
    });
    expect(await recall({ goalText: 'g', prompt: 'p' })).toEqual([
      { nodeId: 'memory:user/a', score: 4.2, body: 'the body text' },
    ]);
  });

  test('default constants are the documented contract values', () => {
    expect(PROACTIVE_RECALL_MIN_SCORE).toBe(1.0);
    expect(PROACTIVE_RECALL_TOP_K).toBe(3);
  });
});
