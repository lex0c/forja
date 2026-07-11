// Scope resolver tests (FEEDBACK_ADAPTATION §6).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolveActivePolicy } from '../../src/feedback/scope-resolver.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createPolicy } from '../../src/storage/repos/policies.ts';

let db: DB;

const CHAIN = {
  session: 'sess-1',
  repo: 'repo-hash-A',
  user: 'user-1',
  language: 'typescript',
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

afterEach(() => {
  db.close();
});

describe('resolveActivePolicy', () => {
  test('returns none when no policy exists', () => {
    const r = resolveActivePolicy(db, 'alias:grep:ripgrep', CHAIN);
    expect(r.kind).toBe('none');
  });

  test('matches at session level first (most-specific wins)', () => {
    createPolicy(db, {
      scopeKind: 'global',
      scopeId: 'global',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({ target: 'rg-global' }),
      state: 'active',
    });
    createPolicy(db, {
      scopeKind: 'session',
      scopeId: CHAIN.session,
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({ target: 'rg-session' }),
      state: 'active',
    });

    const r = resolveActivePolicy(db, 'alias:grep:ripgrep', CHAIN);
    expect(r.kind).toBe('found');
    if (r.kind !== 'found') return;
    expect(r.matchedScope).toBe('session');
    expect(JSON.parse(r.policy.actionJson)).toEqual({ target: 'rg-session' });
  });

  test('falls through session → repo → user → language → global', () => {
    createPolicy(db, {
      scopeKind: 'language',
      scopeId: CHAIN.language,
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({ target: 'rg-ts' }),
      state: 'active',
    });
    createPolicy(db, {
      scopeKind: 'global',
      scopeId: 'global',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({ target: 'rg-global' }),
      state: 'active',
    });

    const r = resolveActivePolicy(db, 'alias:grep:ripgrep', CHAIN);
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.matchedScope).toBe('language');
  });

  test('falls through to global when only global matches', () => {
    createPolicy(db, {
      scopeKind: 'global',
      scopeId: 'global',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({ target: 'rg-global' }),
      state: 'active',
    });
    const r = resolveActivePolicy(db, 'alias:grep:ripgrep', CHAIN);
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.matchedScope).toBe('global');
  });

  test('ignores proposed / invalidated / quarantined policies by default', () => {
    for (const state of ['proposed', 'invalidated', 'quarantined'] as const) {
      createPolicy(db, {
        scopeKind: 'session',
        scopeId: CHAIN.session,
        actionSignature: 'alias:grep:ripgrep',
        actionJson: '{}',
        state,
      });
    }
    const r = resolveActivePolicy(db, 'alias:grep:ripgrep', CHAIN);
    expect(r.kind).toBe('none');
  });

  test('honors desiredStates override (shadow inclusion)', () => {
    createPolicy(db, {
      scopeKind: 'repo',
      scopeId: CHAIN.repo,
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'shadow',
    });

    const defaultR = resolveActivePolicy(db, 'alias:grep:ripgrep', CHAIN);
    expect(defaultR.kind).toBe('none');

    const inclusive = resolveActivePolicy(db, 'alias:grep:ripgrep', CHAIN, ['active', 'shadow']);
    if (inclusive.kind !== 'found') throw new Error('expected found');
    expect(inclusive.policy.state).toBe('shadow');
  });

  test('most-recent wins when multiple rows exist at same scope level', () => {
    createPolicy(db, {
      scopeKind: 'repo',
      scopeId: CHAIN.repo,
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({ target: 'old' }),
      state: 'active',
      recordedAt: 100,
    });
    createPolicy(db, {
      scopeKind: 'repo',
      scopeId: CHAIN.repo,
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({ target: 'new' }),
      state: 'active',
      recordedAt: 200,
    });
    const r = resolveActivePolicy(db, 'alias:grep:ripgrep', CHAIN);
    if (r.kind !== 'found') throw new Error('expected found');
    expect(JSON.parse(r.policy.actionJson)).toEqual({ target: 'new' });
  });

  test('different action_signature in scope chain: no match', () => {
    createPolicy(db, {
      scopeKind: 'session',
      scopeId: CHAIN.session,
      actionSignature: 'alias:find:fd',
      actionJson: '{}',
      state: 'active',
    });
    const r = resolveActivePolicy(db, 'alias:grep:ripgrep', CHAIN);
    expect(r.kind).toBe('none');
  });
});
