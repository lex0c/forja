import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DB } from '../../src/storage/db.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import {
  HISTORY_CAP_DEFAULT,
  appendHistory,
  clearHistory,
  countHistory,
  loadHistory,
  searchHistory,
} from '../../src/storage/history.ts';
import { migrate } from '../../src/storage/migrate.ts';

let db: DB;
const PROJECT_A = '/projects/a';
const PROJECT_B = '/projects/b';

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  // Defensive: tests must not be affected by an env left set in
  // the developer's shell.
  delete process.env.FORJA_NO_HISTORY;
});

afterEach(() => {
  delete process.env.FORJA_NO_HISTORY;
});

describe('history storage — append/load', () => {
  test('append + load returns oldest-first', () => {
    appendHistory(db, PROJECT_A, 'first', { ts: 1 });
    appendHistory(db, PROJECT_A, 'second', { ts: 2 });
    appendHistory(db, PROJECT_A, 'third', { ts: 3 });
    expect(loadHistory(db, PROJECT_A)).toEqual(['first', 'second', 'third']);
  });

  test('empty history returns empty array', () => {
    expect(loadHistory(db, PROJECT_A)).toEqual([]);
    expect(countHistory(db, PROJECT_A)).toBe(0);
  });

  test('multi-line prompts are stored verbatim', () => {
    const multi = 'line one\nline two\n  indented';
    appendHistory(db, PROJECT_A, multi, { ts: 1 });
    expect(loadHistory(db, PROJECT_A)).toEqual([multi]);
  });

  test('per-project isolation: project A and B do not cross', () => {
    appendHistory(db, PROJECT_A, 'a-prompt', { ts: 1 });
    appendHistory(db, PROJECT_B, 'b-prompt', { ts: 2 });
    expect(loadHistory(db, PROJECT_A)).toEqual(['a-prompt']);
    expect(loadHistory(db, PROJECT_B)).toEqual(['b-prompt']);
  });

  test('load respects limit and returns the most-recent slice oldest-first', () => {
    for (let i = 0; i < 10; i++) appendHistory(db, PROJECT_A, `p${i}`, { ts: i + 1 });
    expect(loadHistory(db, PROJECT_A, 3)).toEqual(['p7', 'p8', 'p9']);
  });

  test('load with limit=0 returns []', () => {
    appendHistory(db, PROJECT_A, 'x', { ts: 1 });
    expect(loadHistory(db, PROJECT_A, 0)).toEqual([]);
  });

  test('id ties break ts collisions deterministically', () => {
    // Two inserts with the same ts must still produce a stable
    // oldest-first ordering on load (insertion order via id).
    appendHistory(db, PROJECT_A, 'first', { ts: 100 });
    appendHistory(db, PROJECT_A, 'second', { ts: 100 });
    expect(loadHistory(db, PROJECT_A)).toEqual(['first', 'second']);
  });
});

describe('history storage — dup-of-last suppression', () => {
  test('identical consecutive submits collapse to one row', () => {
    appendHistory(db, PROJECT_A, 'same', { ts: 1 });
    appendHistory(db, PROJECT_A, 'same', { ts: 2 });
    appendHistory(db, PROJECT_A, 'same', { ts: 3 });
    expect(countHistory(db, PROJECT_A)).toBe(1);
    expect(loadHistory(db, PROJECT_A)).toEqual(['same']);
  });

  test('non-consecutive duplicates are kept', () => {
    appendHistory(db, PROJECT_A, 'a', { ts: 1 });
    appendHistory(db, PROJECT_A, 'b', { ts: 2 });
    appendHistory(db, PROJECT_A, 'a', { ts: 3 });
    expect(loadHistory(db, PROJECT_A)).toEqual(['a', 'b', 'a']);
  });

  test('suppression is per-project, not global', () => {
    appendHistory(db, PROJECT_A, 'shared', { ts: 1 });
    // Same prompt in project B is fine — A's "last" doesn't gate B.
    appendHistory(db, PROJECT_B, 'shared', { ts: 2 });
    expect(countHistory(db, PROJECT_A)).toBe(1);
    expect(countHistory(db, PROJECT_B)).toBe(1);
  });
});

describe('history storage — trim on cap', () => {
  test('insert past cap drops oldest until back at cap', () => {
    for (let i = 0; i < 5; i++) appendHistory(db, PROJECT_A, `p${i}`, { ts: i + 1, cap: 3 });
    expect(countHistory(db, PROJECT_A)).toBe(3);
    expect(loadHistory(db, PROJECT_A)).toEqual(['p2', 'p3', 'p4']);
  });

  test('trim is per-project — exceeding cap in A leaves B alone', () => {
    appendHistory(db, PROJECT_B, 'b1', { ts: 1, cap: 2 });
    appendHistory(db, PROJECT_B, 'b2', { ts: 2, cap: 2 });
    for (let i = 0; i < 5; i++) appendHistory(db, PROJECT_A, `p${i}`, { ts: i + 10, cap: 2 });
    expect(loadHistory(db, PROJECT_A)).toEqual(['p3', 'p4']);
    expect(loadHistory(db, PROJECT_B)).toEqual(['b1', 'b2']);
  });

  test('default cap matches HISTORY_CAP_DEFAULT constant', () => {
    expect(HISTORY_CAP_DEFAULT).toBe(10_000);
  });
});

describe('history storage — clear', () => {
  test('clearHistory wipes the project and leaves others intact', () => {
    appendHistory(db, PROJECT_A, 'a', { ts: 1 });
    appendHistory(db, PROJECT_B, 'b', { ts: 2 });
    clearHistory(db, PROJECT_A);
    expect(loadHistory(db, PROJECT_A)).toEqual([]);
    expect(loadHistory(db, PROJECT_B)).toEqual(['b']);
  });

  test('clear on empty project is a no-op', () => {
    expect(() => clearHistory(db, PROJECT_A)).not.toThrow();
    expect(countHistory(db, PROJECT_A)).toBe(0);
  });
});

describe('history storage — search (reverse-search backend)', () => {
  beforeEach(() => {
    appendHistory(db, PROJECT_A, 'how to run bun in watch mode', { ts: 1 });
    appendHistory(db, PROJECT_A, 'How to write a TypeScript decorator', { ts: 2 });
    appendHistory(db, PROJECT_A, 'reverse search prompt', { ts: 3 });
  });

  test('substring match, case-insensitive, newest first', () => {
    expect(searchHistory(db, PROJECT_A, 'how')).toEqual([
      'How to write a TypeScript decorator',
      'how to run bun in watch mode',
    ]);
  });

  test('empty query returns no matches', () => {
    expect(searchHistory(db, PROJECT_A, '')).toEqual([]);
  });

  test('LIKE wildcards in the query are escaped — `%` matches literal percent', () => {
    appendHistory(db, PROJECT_A, '50% off promo', { ts: 4 });
    appendHistory(db, PROJECT_A, 'plain text', { ts: 5 });
    // `%` should not match anything from "plain text".
    expect(searchHistory(db, PROJECT_A, '%')).toEqual(['50% off promo']);
  });

  test('respects per-project boundary', () => {
    appendHistory(db, PROJECT_B, 'how is project B today', { ts: 10 });
    expect(searchHistory(db, PROJECT_B, 'how')).toEqual(['how is project B today']);
  });
});

describe('history storage — opt-out', () => {
  test('FORJA_NO_HISTORY=1 → append/load are no-ops', () => {
    process.env.FORJA_NO_HISTORY = '1';
    appendHistory(db, PROJECT_A, 'never persisted', { ts: 1 });
    expect(countHistory(db, PROJECT_A)).toBe(0);
    expect(loadHistory(db, PROJECT_A)).toEqual([]);
  });

  test('FORJA_NO_HISTORY=1 hides preexisting entries from load', () => {
    appendHistory(db, PROJECT_A, 'pre', { ts: 1 });
    process.env.FORJA_NO_HISTORY = '1';
    expect(loadHistory(db, PROJECT_A)).toEqual([]);
    // count + clear stay live so an operator can still wipe.
    expect(countHistory(db, PROJECT_A)).toBe(1);
    clearHistory(db, PROJECT_A);
    delete process.env.FORJA_NO_HISTORY;
    expect(loadHistory(db, PROJECT_A)).toEqual([]);
  });

  test('.agent/no-history file marker disables persistence per-project', () => {
    const root = mkdtempSync(join(tmpdir(), 'forja-history-marker-'));
    try {
      mkdirSync(join(root, '.agent'), { recursive: true });
      writeFileSync(join(root, '.agent', 'no-history'), '');
      appendHistory(db, root, 'never persisted', { ts: 1 });
      expect(loadHistory(db, root)).toEqual([]);
      expect(countHistory(db, root)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('.agent/no-history in project A does not affect project B', () => {
    const rootA = mkdtempSync(join(tmpdir(), 'forja-history-marker-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'forja-history-marker-b-'));
    try {
      mkdirSync(join(rootA, '.agent'), { recursive: true });
      writeFileSync(join(rootA, '.agent', 'no-history'), '');
      appendHistory(db, rootA, 'A', { ts: 1 });
      appendHistory(db, rootB, 'B', { ts: 2 });
      expect(loadHistory(db, rootA)).toEqual([]);
      expect(loadHistory(db, rootB)).toEqual(['B']);
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });
});
