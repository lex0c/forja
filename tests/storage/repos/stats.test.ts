import { beforeEach, describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../../../src/storage/db.ts';
import type { DB } from '../../../src/storage/db.ts';
import { migrate } from '../../../src/storage/migrate.ts';
import { appendCompactionEvent } from '../../../src/storage/repos/compaction-events.ts';
import { appendMessage } from '../../../src/storage/repos/messages.ts';
import {
  completeSession,
  createSession,
  markSessionUsageIncomplete,
  updateSessionCost,
} from '../../../src/storage/repos/sessions.ts';
import {
  cacheHitRatio,
  cacheWriteAmplification,
  computeUsageStats,
} from '../../../src/storage/repos/stats.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

// Append an assistant message carrying provider usage. Tokens come from
// messages; cost is the session-level rollup (set via updateSessionCost).
const usage = (
  sessionId: string,
  u: { in: number; out: number; cacheRead: number; cacheCreation: number },
): void => {
  appendMessage(db, {
    sessionId,
    role: 'assistant',
    content: 'x',
    tokensIn: u.in,
    tokensOut: u.out,
    cachedTokens: u.cacheRead,
    cacheCreationTokens: u.cacheCreation,
    costUsd: 0.001,
  });
};

describe('computeUsageStats', () => {
  test('empty root list returns zeroed, complete stats', () => {
    const s = computeUsageStats(db, []);
    expect(s).toEqual({
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheCreation: 0,
      usageComplete: true,
      sessionCount: 0,
      models: [],
      cacheWriteParent: 0,
      cacheWriteSubagent: 0,
      cacheWriteCompaction: 0,
      turns: 0,
      compactionCount: 0,
      reclaimedTokens: 0,
    });
  });

  test('single session: sums its messages and reads its session cost', () => {
    const root = createSession(db, { model: 'm', cwd: '/p' });
    updateSessionCost(db, root.id, 0.05);
    usage(root.id, { in: 100, out: 200, cacheRead: 50, cacheCreation: 10 });
    usage(root.id, { in: 5, out: 7, cacheRead: 0, cacheCreation: 0 });
    const s = computeUsageStats(db, [root.id]);
    expect(s.costUsd).toBeCloseTo(0.05, 9);
    expect(s.tokensIn).toBe(105);
    expect(s.tokensOut).toBe(207);
    expect(s.cacheRead).toBe(50);
    expect(s.cacheCreation).toBe(10);
    expect(s.usageComplete).toBe(true);
    expect(s.sessionCount).toBe(1);
  });

  test('models reflects the per-turn models a session billed on, not its initial model', () => {
    // A session created on 'mock/initial' that /model-switched: two assistant turns on
    // different models. computeUsageStats must surface the ACTUAL models (migration 077),
    // not the stale sessions.model — so /stats resolves scope metering correctly.
    const root = createSession(db, { model: 'mock/initial', cwd: '/p' });
    appendMessage(db, {
      sessionId: root.id,
      role: 'assistant',
      content: 'a',
      model: 'ollama/glm-5.2',
      costUsd: 0,
    });
    appendMessage(db, {
      sessionId: root.id,
      role: 'assistant',
      content: 'b',
      model: 'anthropic/claude-opus-4-8',
      costUsd: 0.01,
    });
    const s = computeUsageStats(db, [root.id]);
    expect([...s.models].sort()).toEqual(['anthropic/claude-opus-4-8', 'ollama/glm-5.2']);
    expect(s.models).not.toContain('mock/initial'); // the stale initial model is NOT used
  });

  test('models falls back to the session model when no turn recorded one', () => {
    // Pre-migration rows / turns with no resolved provider record NULL model →
    // effectiveSessionModels falls back to sessions.model so the scope is never empty.
    const root = createSession(db, { model: 'mock/initial', cwd: '/p' });
    usage(root.id, { in: 1, out: 1, cacheRead: 0, cacheCreation: 0 }); // assistant turn, NULL model
    const s = computeUsageStats(db, [root.id]);
    expect(s.models).toEqual(['mock/initial']);
  });

  test('walks subagent descendants (cost + tokens) via parent_session_id', () => {
    const root = createSession(db, { model: 'm', cwd: '/p' });
    updateSessionCost(db, root.id, 0.04);
    usage(root.id, { in: 100, out: 50, cacheRead: 0, cacheCreation: 0 });
    // task_* subagent child
    const child = createSession(db, { model: 'm', cwd: '/p', parentSessionId: root.id });
    updateSessionCost(db, child.id, 0.02);
    usage(child.id, { in: 30, out: 20, cacheRead: 10, cacheCreation: 5 });
    // grandchild (nested subagent)
    const gc = createSession(db, { model: 'm', cwd: '/p', parentSessionId: child.id });
    updateSessionCost(db, gc.id, 0.01);
    usage(gc.id, { in: 1, out: 1, cacheRead: 0, cacheCreation: 0 });

    const s = computeUsageStats(db, [root.id]);
    expect(s.costUsd).toBeCloseTo(0.07, 9); // 0.04 + 0.02 + 0.01
    expect(s.tokensIn).toBe(131); // 100 + 30 + 1
    expect(s.tokensOut).toBe(71); // 50 + 20 + 1
    expect(s.cacheRead).toBe(10);
    expect(s.cacheCreation).toBe(5);
    expect(s.sessionCount).toBe(3);
  });

  test('aggregates across multiple roots (replSessionIds with several entries)', () => {
    const a = createSession(db, { model: 'm', cwd: '/p' });
    updateSessionCost(db, a.id, 0.01);
    usage(a.id, { in: 10, out: 20, cacheRead: 0, cacheCreation: 0 });
    const b = createSession(db, { model: 'm', cwd: '/p' });
    updateSessionCost(db, b.id, 0.02);
    usage(b.id, { in: 30, out: 40, cacheRead: 5, cacheCreation: 0 });

    const s = computeUsageStats(db, [a.id, b.id]);
    expect(s.costUsd).toBeCloseTo(0.03, 9);
    expect(s.tokensIn).toBe(40);
    expect(s.tokensOut).toBe(60);
    expect(s.cacheRead).toBe(5);
    expect(s.sessionCount).toBe(2);
  });

  test('usageComplete is false when any session in scope is incomplete', () => {
    const root = createSession(db, { model: 'm', cwd: '/p' });
    usage(root.id, { in: 10, out: 10, cacheRead: 0, cacheCreation: 0 });
    const child = createSession(db, { model: 'm', cwd: '/p', parentSessionId: root.id });
    usage(child.id, { in: 5, out: 5, cacheRead: 0, cacheCreation: 0 });
    // A subagent turn billed tokens but reported no usage.
    markSessionUsageIncomplete(db, child.id);

    const s = computeUsageStats(db, [root.id]);
    expect(s.usageComplete).toBe(false);
  });

  test('null token columns COALESCE to 0 (no-usage turn contributes nothing)', () => {
    const root = createSession(db, { model: 'm', cwd: '/p' });
    // A message with all-null usage (e.g. a tool result row).
    appendMessage(db, { sessionId: root.id, role: 'tool', content: 'r' });
    usage(root.id, { in: 7, out: 3, cacheRead: 0, cacheCreation: 0 });
    const s = computeUsageStats(db, [root.id]);
    expect(s.tokensIn).toBe(7);
    expect(s.tokensOut).toBe(3);
  });

  test('dedupes a root that is also reachable as a descendant', () => {
    const root = createSession(db, { model: 'm', cwd: '/p' });
    updateSessionCost(db, root.id, 0.01);
    const child = createSession(db, { model: 'm', cwd: '/p', parentSessionId: root.id });
    updateSessionCost(db, child.id, 0.02);
    // Pass both root AND child as roots — child must not be counted twice.
    const s = computeUsageStats(db, [root.id, child.id]);
    expect(s.costUsd).toBeCloseTo(0.03, 9);
    expect(s.sessionCount).toBe(2);
  });

  test('includes compaction-call tokens (cost/token consistency across a compaction)', () => {
    // The harness folds a compaction call's cost into total_cost_usd AND its
    // tokens into usage, but writes no messages row for it. The aggregator
    // must recover those tokens from compaction_events so the token totals
    // line up with the cost (which already includes compaction).
    const root = createSession(db, { model: 'm', cwd: '/p' });
    updateSessionCost(db, root.id, 0.06); // includes the compaction call's cost
    usage(root.id, { in: 100, out: 50, cacheRead: 0, cacheCreation: 0 }); // turn messages
    // A compaction LLM call billed 2000 in / 400 out / 800 cache-read.
    appendCompactionEvent(db, {
      sessionId: root.id,
      strategy: 'llm',
      foldedCount: 8,
      beforeHash: 'a',
      afterHash: 'b',
      callUsage: { tokensIn: 2000, tokensOut: 400, cacheRead: 800, cacheCreation: 0 },
      recordedAt: 1,
    });
    const s = computeUsageStats(db, [root.id]);
    // messages (100/50/0/0) + compaction (2000/400/800/0)
    expect(s.tokensIn).toBe(2100);
    expect(s.tokensOut).toBe(450);
    expect(s.cacheRead).toBe(800);
  });

  test('splits cache write by source (parent / subagent / compaction), summing to total', () => {
    const root = createSession(db, { model: 'm', cwd: '/p' }); // is_subagent=0
    usage(root.id, { in: 0, out: 0, cacheRead: 0, cacheCreation: 1000 }); // parent write
    const child = createSession(db, { model: 'm', cwd: '/p', parentSessionId: root.id }); // is_subagent=1
    usage(child.id, { in: 0, out: 0, cacheRead: 0, cacheCreation: 400 }); // subagent write
    appendCompactionEvent(db, {
      sessionId: root.id,
      strategy: 'llm',
      foldedCount: 1,
      beforeHash: 'a',
      afterHash: 'b',
      callUsage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreation: 89 },
      recordedAt: 1,
    });
    const s = computeUsageStats(db, [root.id]);
    expect(s.cacheWriteParent).toBe(1000);
    expect(s.cacheWriteSubagent).toBe(400);
    expect(s.cacheWriteCompaction).toBe(89);
    // The three buckets are disjoint and sum to the grand cache_creation.
    expect(s.cacheWriteParent + s.cacheWriteSubagent + s.cacheWriteCompaction).toBe(
      s.cacheCreation,
    );
  });

  test('relevance-only compaction contributes no tokens (no provider call)', () => {
    const root = createSession(db, { model: 'm', cwd: '/p' });
    usage(root.id, { in: 10, out: 5, cacheRead: 0, cacheCreation: 0 });
    appendCompactionEvent(db, {
      sessionId: root.id,
      strategy: 'relevance',
      foldedCount: 2,
      beforeHash: 'a',
      afterHash: 'b',
      elidedIds: ['t1'],
      recordedAt: 1,
    });
    const s = computeUsageStats(db, [root.id]);
    expect(s.tokensIn).toBe(10);
    expect(s.tokensOut).toBe(5);
  });

  test('turns counts assistant rows only (tool/user excluded), summed across tree', () => {
    const root = createSession(db, { model: 'm', cwd: '/p' });
    usage(root.id, { in: 1, out: 1, cacheRead: 0, cacheCreation: 0 }); // assistant
    usage(root.id, { in: 1, out: 1, cacheRead: 0, cacheCreation: 0 }); // assistant
    appendMessage(db, { sessionId: root.id, role: 'tool', content: 'r' }); // not a turn
    appendMessage(db, { sessionId: root.id, role: 'user', content: 'q' }); // not a turn
    const child = createSession(db, { model: 'm', cwd: '/p', parentSessionId: root.id });
    usage(child.id, { in: 1, out: 1, cacheRead: 0, cacheCreation: 0 }); // assistant (subagent)
    const s = computeUsageStats(db, [root.id]);
    expect(s.turns).toBe(3); // 2 parent + 1 subagent
  });

  test('compaction reclaim sums before-after; skips forced /compact and non-shrinking rows', () => {
    const root = createSession(db, { model: 'm', cwd: '/p' });
    usage(root.id, { in: 1, out: 1, cacheRead: 0, cacheCreation: 0 });
    // A normal trigger compaction: 5000 -> 2000 context tokens.
    appendCompactionEvent(db, {
      sessionId: root.id,
      strategy: 'llm',
      foldedCount: 4,
      beforeHash: 'a',
      afterHash: 'b',
      tokensBefore: 5000,
      tokensAfter: 2000,
      recordedAt: 1,
    });
    // A forced /compact: no tokens_before (NULL) — counts as a run, 0 reclaim.
    appendCompactionEvent(db, {
      sessionId: root.id,
      strategy: 'llm',
      foldedCount: 2,
      beforeHash: 'c',
      afterHash: 'd',
      recordedAt: 2,
    });
    // A degenerate row that didn't shrink (after >= before): counts, 0 reclaim.
    appendCompactionEvent(db, {
      sessionId: root.id,
      strategy: 'relevance',
      foldedCount: 1,
      beforeHash: 'e',
      afterHash: 'f',
      tokensBefore: 1000,
      tokensAfter: 1200,
      recordedAt: 3,
    });
    const s = computeUsageStats(db, [root.id]);
    expect(s.compactionCount).toBe(3);
    expect(s.reclaimedTokens).toBe(3000); // only the 5000->2000 row
  });

  test('completeSession-written cost is picked up (not just updateSessionCost)', () => {
    const root = createSession(db, { model: 'm', cwd: '/p' });
    usage(root.id, { in: 100, out: 100, cacheRead: 0, cacheCreation: 0 });
    completeSession(db, root.id, 'done', 0.123, true);
    const s = computeUsageStats(db, [root.id]);
    expect(s.costUsd).toBeCloseTo(0.123, 9);
    expect(s.usageComplete).toBe(true);
  });
});

describe('cacheHitRatio', () => {
  const stats = (over: Partial<Parameters<typeof cacheHitRatio>[0]>) => ({
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheCreation: 0,
    usageComplete: true,
    sessionCount: 0,
    models: [],
    cacheWriteParent: 0,
    cacheWriteSubagent: 0,
    cacheWriteCompaction: 0,
    turns: 0,
    compactionCount: 0,
    reclaimedTokens: 0,
    ...over,
  });

  test('cache reads over total input (output excluded)', () => {
    // cacheRead 3500 / (input 6000 + read 3500 + creation 500) = 0.35
    expect(
      cacheHitRatio(stats({ tokensIn: 6000, cacheRead: 3500, cacheCreation: 500 })),
    ).toBeCloseTo(0.35, 10);
  });

  test('output does not affect the ratio', () => {
    const a = cacheHitRatio(stats({ tokensIn: 100, cacheRead: 100 }));
    const b = cacheHitRatio(stats({ tokensIn: 100, cacheRead: 100, tokensOut: 9999 }));
    expect(a).toBe(b);
    expect(a).toBeCloseTo(0.5, 10);
  });

  test('first turn (all cache_creation, no reads) is 0%', () => {
    expect(cacheHitRatio(stats({ tokensIn: 1000, cacheCreation: 2000 }))).toBe(0);
  });

  test('no input yet → 0 (no division by zero)', () => {
    expect(cacheHitRatio(stats({ tokensOut: 500 }))).toBe(0);
  });

  test('cacheWriteAmplification = write / (read + write); 0 with no cache traffic', () => {
    // 1000 write / (9000 read + 1000 write) = 0.10 — a healthy low ratio.
    expect(cacheWriteAmplification(stats({ cacheRead: 9000, cacheCreation: 1000 }))).toBeCloseTo(
      0.1,
      10,
    );
    expect(cacheWriteAmplification(stats({ cacheRead: 0, cacheCreation: 0 }))).toBe(0);
  });
});
