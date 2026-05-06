import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import {
  insertSubagentGateDecision,
  listSubagentGateDecisionsByParent,
  listSubagentGateDecisionsByType,
} from '../../src/storage/repos/subagent-gate-decisions.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

describe('subagent_gate_decisions repo', () => {
  test('insert + listByParent round-trip with chronological ordering', () => {
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    insertSubagentGateDecision(db, {
      parentSessionId: parent.id,
      decisionType: 'unknown_subagent',
      toolName: 'task_async',
      requestedName: 'explorer',
      details: { available: ['explore', 'review'] },
      decidedAt: 1_700_000_000_000,
    });
    insertSubagentGateDecision(db, {
      parentSessionId: parent.id,
      decisionType: 'budget_exhausted',
      toolName: 'task_async',
      requestedName: 'explore',
      details: { spent: 4.5, estimate: 0.5, projected: 5.0, cap: 4.99 },
      decidedAt: 1_700_000_001_000,
    });
    insertSubagentGateDecision(db, {
      parentSessionId: parent.id,
      decisionType: 'depth_exceeded',
      toolName: 'task_sync',
      requestedName: 'explore',
      details: { depth: 4, max_depth: 3 },
      decidedAt: 1_700_000_002_000,
    });
    const rows = listSubagentGateDecisionsByParent(db, parent.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.decisionType)).toEqual([
      'unknown_subagent',
      'budget_exhausted',
      'depth_exceeded',
    ]);
    expect(rows[0]?.details).toEqual({ available: ['explore', 'review'] });
    expect(rows[1]?.details).toEqual({
      spent: 4.5,
      estimate: 0.5,
      projected: 5.0,
      cap: 4.99,
    });
    expect(rows[2]?.toolName).toBe('task_sync');
  });

  test('listByType filters per decision_type', () => {
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    insertSubagentGateDecision(db, {
      parentSessionId: parent.id,
      decisionType: 'budget_exhausted',
      toolName: 'task_async',
      requestedName: 'a',
      details: { spent: 1, estimate: 1, projected: 2, cap: 1.5 },
    });
    insertSubagentGateDecision(db, {
      parentSessionId: parent.id,
      decisionType: 'unknown_subagent',
      toolName: 'task_async',
      requestedName: 'typo',
      details: { available: [] },
    });
    insertSubagentGateDecision(db, {
      parentSessionId: parent.id,
      decisionType: 'budget_exhausted',
      toolName: 'task_sync',
      requestedName: 'b',
      details: { spent: 2, estimate: 1, projected: 3, cap: 2.5 },
    });
    const budgetRows = listSubagentGateDecisionsByType(db, parent.id, 'budget_exhausted');
    expect(budgetRows).toHaveLength(2);
    expect(budgetRows.map((r) => r.requestedName)).toEqual(['a', 'b']);
    const unknownRows = listSubagentGateDecisionsByType(db, parent.id, 'unknown_subagent');
    expect(unknownRows).toHaveLength(1);
    expect(unknownRows[0]?.requestedName).toBe('typo');
  });

  test('CHECK constraint rejects unrecognized decision_type', () => {
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    expect(() => {
      db.query(
        `INSERT INTO subagent_gate_decisions
           (parent_session_id, decision_type, tool_name, requested_name, details, decided_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(parent.id, 'made_up_kind', 'task_async', 'x', '{}', Date.now());
    }).toThrow();
  });

  test('CHECK constraint rejects unrecognized tool_name', () => {
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    expect(() => {
      db.query(
        `INSERT INTO subagent_gate_decisions
           (parent_session_id, decision_type, tool_name, requested_name, details, decided_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(parent.id, 'unknown_subagent', 'bogus_tool', 'x', '{}', Date.now());
    }).toThrow();
  });

  test('FK cascade: dropping parent session reaps gate decisions', () => {
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    insertSubagentGateDecision(db, {
      parentSessionId: parent.id,
      decisionType: 'unknown_subagent',
      toolName: 'task_async',
      requestedName: 'x',
      details: { available: [] },
    });
    expect(listSubagentGateDecisionsByParent(db, parent.id)).toHaveLength(1);
    db.query('DELETE FROM sessions WHERE id = ?').run(parent.id);
    expect(listSubagentGateDecisionsByParent(db, parent.id)).toHaveLength(0);
  });

  test('details parses defensively on corrupt JSON', () => {
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    db.query(
      `INSERT INTO subagent_gate_decisions
         (parent_session_id, decision_type, tool_name, requested_name, details, decided_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(parent.id, 'unknown_subagent', 'task_async', 'x', 'not-json{{{', Date.now());
    const rows = listSubagentGateDecisionsByParent(db, parent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toBeNull();
  });

  test('insert with default decidedAt uses Date.now()', () => {
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    const before = Date.now();
    insertSubagentGateDecision(db, {
      parentSessionId: parent.id,
      decisionType: 'unknown_subagent',
      toolName: 'task_async',
      requestedName: 'x',
      details: { available: [] },
    });
    const after = Date.now();
    const rows = listSubagentGateDecisionsByParent(db, parent.id);
    expect(rows).toHaveLength(1);
    const decided = rows[0]?.decidedAt ?? 0;
    expect(decided).toBeGreaterThanOrEqual(before);
    expect(decided).toBeLessThanOrEqual(after);
  });
});
