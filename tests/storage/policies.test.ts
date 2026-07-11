// policies repo tests (FEEDBACK_ADAPTATION §3.2 + state machine).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  countPolicies,
  createPolicy,
  getPolicy,
  IllegalPolicyTransitionError,
  isLegalPolicyTransition,
  listPoliciesByActionSignature,
  listPoliciesByState,
  listPolicyHistory,
  transitionPolicy,
} from '../../src/storage/repos/policies.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

afterEach(() => {
  db.close();
});

describe('isLegalPolicyTransition', () => {
  test('proposed → active is legal', () => {
    expect(isLegalPolicyTransition('proposed', 'active')).toBe(true);
  });

  test('proposed → invalidated is legal (loop frio re-eval reversed)', () => {
    expect(isLegalPolicyTransition('proposed', 'invalidated')).toBe(true);
  });

  test('active → shadow / quarantined / invalidated all legal', () => {
    expect(isLegalPolicyTransition('active', 'shadow')).toBe(true);
    expect(isLegalPolicyTransition('active', 'quarantined')).toBe(true);
    expect(isLegalPolicyTransition('active', 'invalidated')).toBe(true);
  });

  test('shadow ↔ active / quarantined / invalidated', () => {
    expect(isLegalPolicyTransition('shadow', 'active')).toBe(true);
    expect(isLegalPolicyTransition('shadow', 'quarantined')).toBe(true);
    expect(isLegalPolicyTransition('shadow', 'invalidated')).toBe(true);
  });

  test('quarantined → active / invalidated', () => {
    expect(isLegalPolicyTransition('quarantined', 'active')).toBe(true);
    expect(isLegalPolicyTransition('quarantined', 'invalidated')).toBe(true);
  });

  test('invalidated is terminal — no outgoing transitions', () => {
    for (const to of ['proposed', 'active', 'shadow', 'quarantined'] as const) {
      expect(isLegalPolicyTransition('invalidated', to)).toBe(false);
    }
  });

  test('same-state transitions refused', () => {
    expect(isLegalPolicyTransition('active', 'active')).toBe(false);
  });

  test('proposed → shadow refused (must promote to active first)', () => {
    expect(isLegalPolicyTransition('proposed', 'shadow')).toBe(false);
  });
});

describe('createPolicy', () => {
  test('lands a row with defaults', () => {
    const p = createPolicy(db, {
      scopeKind: 'repo',
      scopeId: 'repo-hash',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({ target: 'ripgrep' }),
      state: 'proposed',
    });
    expect(p.id).toBeTruthy();
    expect(p.state).toBe('proposed');
    expect(p.n).toBe(0);
    expect(p.parentId).toBeNull();
    expect(p.ciLow).toBeNull();
    expect(countPolicies(db)).toBe(1);
  });

  test('rejects invalid scope_kind via CHECK', () => {
    expect(() =>
      createPolicy(db, {
        scopeKind: 'bogus' as 'repo',
        scopeId: 'x',
        actionSignature: 'alias:grep:ripgrep',
        actionJson: '{}',
        state: 'proposed',
      }),
    ).toThrow();
  });

  test('rejects invalid state via CHECK', () => {
    expect(() =>
      createPolicy(db, {
        scopeKind: 'repo',
        scopeId: 'x',
        actionSignature: 'alias:grep:ripgrep',
        actionJson: '{}',
        state: 'bogus' as 'proposed',
      }),
    ).toThrow();
  });
});

describe('transitionPolicy', () => {
  test('proposed → active updates state + motivo + recorded_at', () => {
    const p = createPolicy(db, {
      scopeKind: 'repo',
      scopeId: 'r1',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'proposed',
      recordedAt: 1000,
    });
    const updated = transitionPolicy(db, p.id, 'active', 'operator_promote', 5000);
    expect(updated).not.toBeNull();
    expect(updated?.state).toBe('active');
    expect(updated?.motivo).toBe('operator_promote');
    expect(updated?.recordedAt).toBe(5000);

    const refetched = getPolicy(db, p.id);
    expect(refetched?.state).toBe('active');
  });

  test('throws IllegalPolicyTransitionError on illegal path', () => {
    const p = createPolicy(db, {
      scopeKind: 'repo',
      scopeId: 'r1',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'proposed',
    });
    expect(() => transitionPolicy(db, p.id, 'shadow')).toThrow(IllegalPolicyTransitionError);
  });

  test('returns null for nonexistent policy', () => {
    expect(transitionPolicy(db, 'bogus-id', 'active')).toBeNull();
  });

  test('invalidated is terminal — refuses every outgoing transition', () => {
    const p = createPolicy(db, {
      scopeKind: 'repo',
      scopeId: 'r1',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'invalidated',
    });
    for (const to of ['active', 'proposed', 'shadow', 'quarantined'] as const) {
      expect(() => transitionPolicy(db, p.id, to)).toThrow(IllegalPolicyTransitionError);
    }
  });
});

describe('listPoliciesByActionSignature', () => {
  test('filters by action_signature + scope, newest first', () => {
    createPolicy(db, {
      scopeKind: 'repo',
      scopeId: 'r1',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'proposed',
      recordedAt: 100,
    });
    createPolicy(db, {
      scopeKind: 'repo',
      scopeId: 'r1',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'active',
      recordedAt: 200,
    });
    createPolicy(db, {
      scopeKind: 'repo',
      scopeId: 'r2',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'active',
    });

    const rows = listPoliciesByActionSignature(db, 'alias:grep:ripgrep', 'repo', 'r1');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.state).toBe('active');
    expect(rows[1]?.state).toBe('proposed');
  });
});

describe('listPoliciesByState', () => {
  test('returns all rows in the given state', () => {
    createPolicy(db, {
      scopeKind: 'repo',
      scopeId: 'r1',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'proposed',
    });
    createPolicy(db, {
      scopeKind: 'user',
      scopeId: 'u1',
      actionSignature: 'flag:bash:cwd_arg:preferred',
      actionJson: '{}',
      state: 'proposed',
    });
    createPolicy(db, {
      scopeKind: 'global',
      scopeId: 'global',
      actionSignature: 'alias:find:fd',
      actionJson: '{}',
      state: 'active',
    });
    expect(listPoliciesByState(db, 'proposed')).toHaveLength(2);
    expect(listPoliciesByState(db, 'active')).toHaveLength(1);
  });
});

describe('listPolicyHistory', () => {
  test('walks parent chain root-first', () => {
    const root = createPolicy(db, {
      scopeKind: 'global',
      scopeId: 'global',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'active',
    });
    const mid = createPolicy(db, {
      scopeKind: 'user',
      scopeId: 'u1',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'active',
      parentId: root.id,
    });
    const leaf = createPolicy(db, {
      scopeKind: 'repo',
      scopeId: 'r1',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'active',
      parentId: mid.id,
    });

    const history = listPolicyHistory(db, leaf.id);
    expect(history).toHaveLength(3);
    expect(history[0]?.id).toBe(root.id);
    expect(history[1]?.id).toBe(mid.id);
    expect(history[2]?.id).toBe(leaf.id);
  });

  test('returns empty for nonexistent id', () => {
    expect(listPolicyHistory(db, 'bogus')).toEqual([]);
  });
});
