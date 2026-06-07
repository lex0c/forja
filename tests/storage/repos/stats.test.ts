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
import { computeUsageStats } from '../../../src/storage/repos/stats.ts';

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

  test('completeSession-written cost is picked up (not just updateSessionCost)', () => {
    const root = createSession(db, { model: 'm', cwd: '/p' });
    usage(root.id, { in: 100, out: 100, cacheRead: 0, cacheCreation: 0 });
    completeSession(db, root.id, 'done', 0.123, true);
    const s = computeUsageStats(db, [root.id]);
    expect(s.costUsd).toBeCloseTo(0.123, 9);
    expect(s.usageComplete).toBe(true);
  });
});
