// Pins for `tool_token_attributions` repo.
// Spec: `docs/spec/TOKEN_ATTRIBUTION.md`.

import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import {
  aggregateToolAttributionsByName,
  aggregateToolAttributionsGlobal,
  appendToolAttribution,
  countToolAttributions,
  listToolAttributionsBySession,
} from '../../src/storage/repos/tool-token-attributions.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

const seedSession = (id: string): void => {
  createSession(db, { id, model: 'sonnet-4.6', cwd: '/tmp' });
};

describe('tool_token_attributions repo', () => {
  test('appendToolAttribution writes a row readable by listBySession', () => {
    seedSession('s1');
    appendToolAttribution(db, {
      sessionId: 's1',
      stepN: 1,
      toolUseId: 'tu_01ABC',
      toolName: 'bash',
      resultInputTokens: 1234,
      callOutputTokens: 42,
      estimatedCostUsd: 0.0123,
      createdAt: 1000,
    });
    const rows = listToolAttributionsBySession(db, 's1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: 's1',
      stepN: 1,
      toolUseId: 'tu_01ABC',
      toolName: 'bash',
      resultInputTokens: 1234,
      callOutputTokens: 42,
      estimatedCostUsd: 0.0123,
      createdAt: 1000,
    });
  });

  test('UNIQUE(tool_use_id) — second INSERT for the same call is silently ignored', () => {
    // Spec §1.1: `INSERT OR IGNORE` defends retry paths. First
    // emission wins; a re-entry for the same toolUseId must be
    // a no-op, not an error.
    seedSession('s1');
    appendToolAttribution(db, {
      sessionId: 's1',
      stepN: 1,
      toolUseId: 'tu_dup',
      toolName: 'bash',
      resultInputTokens: 100,
      callOutputTokens: 10,
    });
    appendToolAttribution(db, {
      sessionId: 's1',
      stepN: 2, // different step
      toolUseId: 'tu_dup', // same tool_use_id
      toolName: 'bash',
      resultInputTokens: 999, // different content
      callOutputTokens: 99,
    });
    const rows = listToolAttributionsBySession(db, 's1');
    expect(rows).toHaveLength(1);
    // First emission's values persist.
    expect(rows[0]?.resultInputTokens).toBe(100);
    expect(rows[0]?.stepN).toBe(1);
  });

  test('estimatedCostUsd null is preserved (caller defers cost compute to reader)', () => {
    seedSession('s1');
    appendToolAttribution(db, {
      sessionId: 's1',
      stepN: 1,
      toolUseId: 'tu_no_cost',
      toolName: 'grep',
      resultInputTokens: 500,
      callOutputTokens: 30,
      // estimatedCostUsd intentionally omitted
    });
    const rows = listToolAttributionsBySession(db, 's1');
    expect(rows[0]?.estimatedCostUsd).toBeNull();
  });

  test('listBySession orders by step_n ASC, then created_at ASC', () => {
    // Determinism: operator inspecting a session expects rows in
    // chronological order within step. Order by id as final tiebreak.
    seedSession('s1');
    // Insert out of order intentionally:
    appendToolAttribution(db, {
      sessionId: 's1',
      stepN: 2,
      toolUseId: 'tu_b',
      toolName: 'read_file',
      resultInputTokens: 10,
      callOutputTokens: 1,
      createdAt: 2000,
    });
    appendToolAttribution(db, {
      sessionId: 's1',
      stepN: 1,
      toolUseId: 'tu_a',
      toolName: 'bash',
      resultInputTokens: 20,
      callOutputTokens: 2,
      createdAt: 1000,
    });
    appendToolAttribution(db, {
      sessionId: 's1',
      stepN: 1,
      toolUseId: 'tu_a2',
      toolName: 'bash',
      resultInputTokens: 30,
      callOutputTokens: 3,
      createdAt: 1500,
    });
    const rows = listToolAttributionsBySession(db, 's1');
    expect(rows.map((r) => r.toolUseId)).toEqual(['tu_a', 'tu_a2', 'tu_b']);
  });

  test('aggregateByName groups + orders by total_result_input DESC', () => {
    // The default sort is "biggest context drains first" — operator
    // looking at `agent stats --tools` wants the cost drivers up top.
    seedSession('s1');
    appendToolAttribution(db, {
      sessionId: 's1',
      stepN: 1,
      toolUseId: 'tu_1',
      toolName: 'bash',
      resultInputTokens: 1000,
      callOutputTokens: 50,
      estimatedCostUsd: 0.01,
    });
    appendToolAttribution(db, {
      sessionId: 's1',
      stepN: 2,
      toolUseId: 'tu_2',
      toolName: 'read_file',
      resultInputTokens: 500,
      callOutputTokens: 25,
      estimatedCostUsd: 0.005,
    });
    appendToolAttribution(db, {
      sessionId: 's1',
      stepN: 3,
      toolUseId: 'tu_3',
      toolName: 'bash',
      resultInputTokens: 2000,
      callOutputTokens: 80,
      estimatedCostUsd: 0.02,
    });
    const agg = aggregateToolAttributionsByName(db, 's1');
    expect(agg).toHaveLength(2);
    expect(agg[0]?.toolName).toBe('bash');
    expect(agg[0]?.calls).toBe(2);
    expect(agg[0]?.totalResultInputTokens).toBe(3000);
    expect(agg[0]?.totalCallOutputTokens).toBe(130);
    expect(agg[0]?.totalEstimatedCostUsd).toBeCloseTo(0.03, 4);
    expect(agg[0]?.rowsWithoutCost).toBe(0);
    expect(agg[1]?.toolName).toBe('read_file');
  });

  test('aggregateByName counts rows_without_cost separately', () => {
    // The "(N calls com cost estimado on-the-fly)" rodapé na CLI
    // depende deste counter — sem ele o operator não sabe se o
    // totalEstimatedCostUsd é completo ou lower bound.
    seedSession('s1');
    appendToolAttribution(db, {
      sessionId: 's1',
      stepN: 1,
      toolUseId: 'tu_a',
      toolName: 'bash',
      resultInputTokens: 100,
      callOutputTokens: 10,
      estimatedCostUsd: 0.001,
    });
    appendToolAttribution(db, {
      sessionId: 's1',
      stepN: 2,
      toolUseId: 'tu_b',
      toolName: 'bash',
      resultInputTokens: 200,
      callOutputTokens: 20,
      estimatedCostUsd: null,
    });
    appendToolAttribution(db, {
      sessionId: 's1',
      stepN: 3,
      toolUseId: 'tu_c',
      toolName: 'bash',
      resultInputTokens: 300,
      callOutputTokens: 30,
      // omitted = null
    });
    const agg = aggregateToolAttributionsByName(db, 's1');
    expect(agg).toHaveLength(1);
    expect(agg[0]?.calls).toBe(3);
    expect(agg[0]?.rowsWithoutCost).toBe(2);
    // Only the one explicit cost contributes to the sum.
    expect(agg[0]?.totalEstimatedCostUsd).toBeCloseTo(0.001, 6);
  });

  test('aggregateGlobal counts DISTINCT sessions per tool name', () => {
    // Cross-session aggregation: same `bash` call across two sessions
    // → `sessions: 2`. Critical for `agent stats --tools --all` so the
    // operator can see "bash ran in 14 sessions total" vs "bash ran 14
    // times in one session".
    seedSession('sA');
    seedSession('sB');
    appendToolAttribution(db, {
      sessionId: 'sA',
      stepN: 1,
      toolUseId: 'tu_a',
      toolName: 'bash',
      resultInputTokens: 100,
      callOutputTokens: 10,
    });
    appendToolAttribution(db, {
      sessionId: 'sB',
      stepN: 1,
      toolUseId: 'tu_b',
      toolName: 'bash',
      resultInputTokens: 200,
      callOutputTokens: 20,
    });
    const agg = aggregateToolAttributionsGlobal(db);
    expect(agg).toHaveLength(1);
    expect(agg[0]?.toolName).toBe('bash');
    expect(agg[0]?.calls).toBe(2);
    expect(agg[0]?.sessions).toBe(2);
    expect(agg[0]?.totalResultInputTokens).toBe(300);
  });

  test('aggregateGlobal respects sinceMs filter', () => {
    seedSession('s1');
    appendToolAttribution(db, {
      sessionId: 's1',
      stepN: 1,
      toolUseId: 'tu_old',
      toolName: 'bash',
      resultInputTokens: 100,
      callOutputTokens: 10,
      createdAt: 1000,
    });
    appendToolAttribution(db, {
      sessionId: 's1',
      stepN: 2,
      toolUseId: 'tu_new',
      toolName: 'bash',
      resultInputTokens: 500,
      callOutputTokens: 50,
      createdAt: 5000,
    });
    const recent = aggregateToolAttributionsGlobal(db, { sinceMs: 3000 });
    expect(recent[0]?.totalResultInputTokens).toBe(500);
    expect(recent[0]?.calls).toBe(1);
  });

  test('aggregateGlobal respects limit clause', () => {
    seedSession('s1');
    // 3 distinct tool names, varying total_result_input.
    appendToolAttribution(db, {
      sessionId: 's1',
      stepN: 1,
      toolUseId: 'tu_a',
      toolName: 'bash',
      resultInputTokens: 1000,
      callOutputTokens: 10,
    });
    appendToolAttribution(db, {
      sessionId: 's1',
      stepN: 2,
      toolUseId: 'tu_b',
      toolName: 'grep',
      resultInputTokens: 500,
      callOutputTokens: 5,
    });
    appendToolAttribution(db, {
      sessionId: 's1',
      stepN: 3,
      toolUseId: 'tu_c',
      toolName: 'read_file',
      resultInputTokens: 250,
      callOutputTokens: 3,
    });
    const top2 = aggregateToolAttributionsGlobal(db, { limit: 2 });
    expect(top2).toHaveLength(2);
    expect(top2.map((r) => r.toolName)).toEqual(['bash', 'grep']);
  });

  test('FK CASCADE: deleting the session drops its attributions', () => {
    // Cascade is the retention story per spec §1.3 — purge a
    // session, attributions go with it. Without CASCADE we'd have
    // orphan rows that pin disk space forever.
    seedSession('s1');
    appendToolAttribution(db, {
      sessionId: 's1',
      stepN: 1,
      toolUseId: 'tu_a',
      toolName: 'bash',
      resultInputTokens: 100,
      callOutputTokens: 10,
    });
    expect(countToolAttributions(db, 's1')).toBe(1);
    db.query('DELETE FROM sessions WHERE id = ?').run('s1');
    expect(countToolAttributions(db, 's1')).toBe(0);
  });

  test('countToolAttributions: global vs per-session shapes', () => {
    seedSession('s1');
    seedSession('s2');
    appendToolAttribution(db, {
      sessionId: 's1',
      stepN: 1,
      toolUseId: 'tu_a',
      toolName: 'bash',
      resultInputTokens: 1,
      callOutputTokens: 1,
    });
    appendToolAttribution(db, {
      sessionId: 's2',
      stepN: 1,
      toolUseId: 'tu_b',
      toolName: 'bash',
      resultInputTokens: 1,
      callOutputTokens: 1,
    });
    expect(countToolAttributions(db)).toBe(2);
    expect(countToolAttributions(db, 's1')).toBe(1);
    expect(countToolAttributions(db, 'unknown-session')).toBe(0);
  });

  test('FK violation: attribution for unknown session throws', () => {
    // The repo doesn't seed sessions; relies on the FK to defend
    // against attribution rows orphaned by definition. The loop's
    // capture site is best-effort (try/catch), so this throw is
    // observable in tests but caught in production.
    expect(() =>
      appendToolAttribution(db, {
        sessionId: 'nope',
        stepN: 1,
        toolUseId: 'tu_x',
        toolName: 'bash',
        resultInputTokens: 1,
        callOutputTokens: 1,
      }),
    ).toThrow();
  });
});
