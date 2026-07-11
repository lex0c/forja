// Resolver tier coverage (T13.5). One test per tier proves the
// chain decides at the named level; chained tests prove later tiers
// fire only after earlier ones tie.

import { describe, expect, test } from 'bun:test';
import {
  type ConflictCandidate,
  resolveConflictWinner,
} from '../../src/memory/conflict-resolver.ts';

const mk = (overrides: Partial<ConflictCandidate> = {}): ConflictCandidate => ({
  scope: 'project_local',
  name: 'foo',
  source: 'user_explicit',
  mtimeMs: 1_000,
  body: 'body',
  ...overrides,
});

describe('resolveConflictWinner — tier 1: provenance', () => {
  test('user_explicit beats inferred', () => {
    const a = mk({ source: 'user_explicit', name: 'a' });
    const b = mk({ source: 'inferred', name: 'b' });
    const r = resolveConflictWinner(a, b);
    expect(r.tier).toBe('provenance');
    expect(r.winner).toBe(a);
    expect(r.loser).toBe(b);
  });

  test('inferred beats imported', () => {
    const a = mk({ source: 'inferred', name: 'a' });
    const b = mk({ source: 'imported', name: 'b' });
    const r = resolveConflictWinner(a, b);
    expect(r.tier).toBe('provenance');
    expect(r.winner).toBe(a);
  });

  test('user_explicit beats seed (operator customization > vendor catalog)', () => {
    const a = mk({ source: 'user_explicit', name: 'a' });
    const b = mk({ source: 'seed', name: 'b' });
    const r = resolveConflictWinner(a, b);
    expect(r.tier).toBe('provenance');
    expect(r.winner).toBe(a);
  });

  test('seed beats inferred (vendor curation > model proposal)', () => {
    const a = mk({ source: 'seed', name: 'a' });
    const b = mk({ source: 'inferred', name: 'b' });
    const r = resolveConflictWinner(a, b);
    expect(r.tier).toBe('provenance');
    expect(r.winner).toBe(a);
  });

  test('seed beats imported', () => {
    const a = mk({ source: 'seed', name: 'a' });
    const b = mk({ source: 'imported', name: 'b' });
    const r = resolveConflictWinner(a, b);
    expect(r.tier).toBe('provenance');
    expect(r.winner).toBe(a);
  });

  test('order-independent — swapping arguments swaps winner', () => {
    const a = mk({ source: 'imported', name: 'a' });
    const b = mk({ source: 'user_explicit', name: 'b' });
    const r = resolveConflictWinner(a, b);
    expect(r.winner).toBe(b);
    expect(r.loser).toBe(a);
  });
});

describe('resolveConflictWinner — tier 2: recency', () => {
  test('newer mtime wins when provenance ties', () => {
    const a = mk({ name: 'a', mtimeMs: 1_000 });
    const b = mk({ name: 'b', mtimeMs: 2_000 });
    const r = resolveConflictWinner(a, b);
    expect(r.tier).toBe('recency');
    expect(r.winner).toBe(b);
  });

  test('mtimeMs=0 (caller without a real file) loses recency', () => {
    const a = mk({ name: 'a', mtimeMs: 0 });
    const b = mk({ name: 'b', mtimeMs: 1 });
    const r = resolveConflictWinner(a, b);
    expect(r.tier).toBe('recency');
    expect(r.winner).toBe(b);
  });
});

describe('resolveConflictWinner — tier 3: scope specificity', () => {
  test('project_local beats user when provenance + recency tie', () => {
    const a = mk({ scope: 'user', name: 'a' });
    const b = mk({ scope: 'project_local', name: 'b' });
    const r = resolveConflictWinner(a, b);
    expect(r.tier).toBe('scope');
    expect(r.winner).toBe(b);
  });

  test('user beats project_shared', () => {
    const a = mk({ scope: 'project_shared', name: 'a' });
    const b = mk({ scope: 'user', name: 'b' });
    const r = resolveConflictWinner(a, b);
    expect(r.tier).toBe('scope');
    expect(r.winner).toBe(b);
  });
});

describe('resolveConflictWinner — tier 4: body length', () => {
  test('longer body wins when earlier tiers tie', () => {
    const a = mk({ name: 'a', body: 'short' });
    const b = mk({ name: 'b', body: 'much longer body that wins' });
    const r = resolveConflictWinner(a, b);
    expect(r.tier).toBe('body_length');
    expect(r.winner).toBe(b);
  });
});

describe('resolveConflictWinner — tier 5: lexicographic', () => {
  test('alphabetically-earlier name wins when everything else ties', () => {
    const a = mk({ name: 'aardvark' });
    const b = mk({ name: 'zebra' });
    const r = resolveConflictWinner(a, b);
    expect(r.tier).toBe('lexicographic');
    expect(r.winner).toBe(a);
  });

  test('identical inputs collapse to argument-order tiebreak (a wins)', () => {
    const a = mk({ name: 'same' });
    const b = mk({ name: 'same' });
    const r = resolveConflictWinner(a, b);
    expect(r.tier).toBe('lexicographic');
    expect(r.winner).toBe(a);
  });
});

describe('resolveConflictWinner — tier ordering invariants', () => {
  test('provenance fires BEFORE recency (older user_explicit beats newer inferred)', () => {
    const a = mk({ source: 'user_explicit', name: 'a', mtimeMs: 1_000 });
    const b = mk({ source: 'inferred', name: 'b', mtimeMs: 10_000 });
    const r = resolveConflictWinner(a, b);
    expect(r.tier).toBe('provenance');
    expect(r.winner).toBe(a); // older, but higher-tier provenance
  });

  test('recency fires BEFORE scope (older project_local loses to newer user)', () => {
    const a = mk({ scope: 'project_local', name: 'a', mtimeMs: 1_000 });
    const b = mk({ scope: 'user', name: 'b', mtimeMs: 2_000 });
    const r = resolveConflictWinner(a, b);
    expect(r.tier).toBe('recency');
    expect(r.winner).toBe(b);
  });

  test('scope fires BEFORE body_length (longer project_shared loses to shorter project_local)', () => {
    const a = mk({ scope: 'project_local', name: 'a', body: 'short' });
    const b = mk({ scope: 'project_shared', name: 'b', body: 'very long body' });
    const r = resolveConflictWinner(a, b);
    expect(r.tier).toBe('scope');
    expect(r.winner).toBe(a);
  });
});
