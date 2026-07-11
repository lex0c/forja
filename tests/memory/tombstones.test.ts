// .tombstones/ storage helpers (MEMORY.md §6.5).
//
// Real filesystem fixtures — each test materializes a tmpdir with
// the three-scope layout (user/shared/local), writes seed memory
// files, exercises moveToTombstone / findLatest / list / expired
// / remove. Same shape as src/memory/loader.test.ts so the
// fixtures stay recognizable.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findLatestTombstone,
  listExpiredTombstones,
  listTombstones,
  moveToTombstone,
  parseTombstoneFilename,
  removeFromTombstones,
  ScopeError,
  type ScopeRoots,
  tombstonePath,
  tombstonesDir,
} from '../../src/memory/index.ts';
import type { MemoryScope } from '../../src/memory/types.ts';

let workdir: string;

const makeRoots = (): ScopeRoots => ({
  user: join(workdir, 'user'),
  projectShared: join(workdir, 'shared'),
  projectLocal: join(workdir, 'local'),
});

const seedMemory = (root: string, name: string, body = 'body'): string => {
  mkdirSync(root, { recursive: true });
  const path = join(root, `${name}.md`);
  writeFileSync(
    path,
    `---\nname: ${name}\ndescription: x\ntype: feedback\nsource: user_explicit\n---\n\n${body}\n`,
  );
  return path;
};

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-tombstones-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

// ── paths ──────────────────────────────────────────────────────────

describe('tombstonesDir', () => {
  test.each<[MemoryScope, 'user' | 'shared' | 'local']>([
    ['user', 'user'],
    ['project_shared', 'shared'],
    ['project_local', 'local'],
  ])('returns the per-scope .tombstones path: %s', (scope, key) => {
    const roots = makeRoots();
    expect(tombstonesDir(roots, scope)).toBe(join(workdir, key, '.tombstones'));
  });
});

describe('tombstonePath', () => {
  test('builds <root>/.tombstones/<name>.<ts>.md', () => {
    const roots = makeRoots();
    expect(tombstonePath(roots, 'user', 'commit-style', 1714138800000)).toBe(
      join(workdir, 'user', '.tombstones', 'commit-style.1714138800000.md'),
    );
  });

  test('validates the name (sandbox layer 1)', () => {
    const roots = makeRoots();
    expect(() => tombstonePath(roots, 'user', 'BAD NAME' as unknown as string, 100)).toThrow();
  });

  test('refuses path traversal via name (would have been caught by validateName, defense-in-depth)', () => {
    const roots = makeRoots();
    expect(() => tombstonePath(roots, 'user', '../escape' as unknown as string, 100)).toThrow();
  });
});

describe('parseTombstoneFilename', () => {
  test('parses canonical shape', () => {
    expect(parseTombstoneFilename('commit-style.1714138800000.md')).toEqual({
      name: 'commit-style',
      ts: 1714138800000,
    });
  });

  test('accepts underscores + digits in name', () => {
    expect(parseTombstoneFilename('feedback_no_auto_commit.1.md')).toEqual({
      name: 'feedback_no_auto_commit',
      ts: 1,
    });
  });

  test('rejects plain memory file (no embedded ts)', () => {
    expect(parseTombstoneFilename('commit-style.md')).toBeNull();
  });

  test('rejects index file', () => {
    expect(parseTombstoneFilename('MEMORY.md')).toBeNull();
  });

  test('rejects non-md extension', () => {
    expect(parseTombstoneFilename('name.100.txt')).toBeNull();
  });

  test('rejects negative or non-digit ts', () => {
    expect(parseTombstoneFilename('name.-100.md')).toBeNull();
    expect(parseTombstoneFilename('name.abc.md')).toBeNull();
    expect(parseTombstoneFilename('name.1.5.md')).toBeNull();
  });

  test('rejects uppercase / spaces / dots in name segment', () => {
    expect(parseTombstoneFilename('BadName.100.md')).toBeNull();
    expect(parseTombstoneFilename('has space.100.md')).toBeNull();
  });
});

// ── moveToTombstone ────────────────────────────────────────────────

describe('moveToTombstone', () => {
  test('moves the body file into .tombstones/ atomically', () => {
    const roots = makeRoots();
    const source = seedMemory(roots.user, 'commit-style');
    expect(existsSync(source)).toBe(true);

    const result = moveToTombstone(roots, 'user', 'commit-style', { now: () => 1_500 });

    expect(existsSync(source)).toBe(false);
    expect(existsSync(result.tombstonePath)).toBe(true);
    expect(result.ts).toBe(1_500);
    expect(result.tombstonePath).toBe(join(roots.user, '.tombstones', 'commit-style.1500.md'));
  });

  test('creates the .tombstones/ directory when missing', () => {
    const roots = makeRoots();
    seedMemory(roots.user, 'commit-style');
    expect(existsSync(join(roots.user, '.tombstones'))).toBe(false);
    moveToTombstone(roots, 'user', 'commit-style', { now: () => 100 });
    expect(existsSync(join(roots.user, '.tombstones'))).toBe(true);
  });

  test('multiple evictions of the same name yield distinct files', () => {
    const roots = makeRoots();
    seedMemory(roots.user, 'commit-style', 'first');
    const r1 = moveToTombstone(roots, 'user', 'commit-style', { now: () => 100 });
    // Simulate restore: re-write the memory at its body path so a
    // second eviction has something to rename.
    seedMemory(roots.user, 'commit-style', 'second');
    const r2 = moveToTombstone(roots, 'user', 'commit-style', { now: () => 200 });

    expect(r1.ts).toBe(100);
    expect(r2.ts).toBe(200);
    expect(existsSync(r1.tombstonePath)).toBe(true);
    expect(existsSync(r2.tombstonePath)).toBe(true);
  });

  test('throws when the source body file does not exist', () => {
    const roots = makeRoots();
    expect(() => moveToTombstone(roots, 'user', 'never-existed', { now: () => 100 })).toThrow();
  });

  test('collision: same-ts eviction bumps ts +1 to avoid overwrite', () => {
    const roots = makeRoots();
    // First eviction lands at ts=100.
    seedMemory(roots.user, 'mem', 'first');
    const r1 = moveToTombstone(roots, 'user', 'mem', { now: () => 100 });
    expect(r1.ts).toBe(100);

    // Second eviction at the SAME ms — the collision check must
    // bump ts so the older tombstone survives.
    seedMemory(roots.user, 'mem', 'second');
    const r2 = moveToTombstone(roots, 'user', 'mem', { now: () => 100 });
    expect(r2.ts).toBe(101);
    expect(existsSync(r1.tombstonePath)).toBe(true);
    expect(existsSync(r2.tombstonePath)).toBe(true);
    expect(r1.tombstonePath).not.toBe(r2.tombstonePath);
  });
});

// ── findLatestTombstone ────────────────────────────────────────────

describe('findLatestTombstone', () => {
  test('returns null when the .tombstones/ dir does not exist', () => {
    const roots = makeRoots();
    expect(findLatestTombstone(roots, 'user', 'commit-style')).toBeNull();
  });

  test('returns null when no tombstone matches the name', () => {
    const roots = makeRoots();
    seedMemory(roots.user, 'commit-style');
    moveToTombstone(roots, 'user', 'commit-style', { now: () => 100 });
    expect(findLatestTombstone(roots, 'user', 'other-name')).toBeNull();
  });

  test('returns the most-recent tombstone when multiple exist', () => {
    const roots = makeRoots();
    seedMemory(roots.user, 'commit-style', 'a');
    moveToTombstone(roots, 'user', 'commit-style', { now: () => 100 });
    seedMemory(roots.user, 'commit-style', 'b');
    moveToTombstone(roots, 'user', 'commit-style', { now: () => 300 });
    seedMemory(roots.user, 'commit-style', 'c');
    moveToTombstone(roots, 'user', 'commit-style', { now: () => 200 });

    const latest = findLatestTombstone(roots, 'user', 'commit-style');
    expect(latest?.ts).toBe(300);
  });

  test('ignores tombstones for other names', () => {
    const roots = makeRoots();
    seedMemory(roots.user, 'commit-style');
    moveToTombstone(roots, 'user', 'commit-style', { now: () => 100 });
    seedMemory(roots.user, 'other-mem');
    moveToTombstone(roots, 'user', 'other-mem', { now: () => 500 });

    const latest = findLatestTombstone(roots, 'user', 'commit-style');
    expect(latest?.name).toBe('commit-style');
    expect(latest?.ts).toBe(100);
  });
});

// ── listTombstones ─────────────────────────────────────────────────

describe('listTombstones', () => {
  test('returns [] when .tombstones/ does not exist', () => {
    const roots = makeRoots();
    expect(listTombstones(roots, 'user')).toEqual([]);
  });

  test('returns all tombstones sorted by ts descending', () => {
    const roots = makeRoots();
    seedMemory(roots.user, 'a');
    moveToTombstone(roots, 'user', 'a', { now: () => 100 });
    seedMemory(roots.user, 'b');
    moveToTombstone(roots, 'user', 'b', { now: () => 300 });
    seedMemory(roots.user, 'c');
    moveToTombstone(roots, 'user', 'c', { now: () => 200 });

    const list = listTombstones(roots, 'user');
    expect(list.map((e) => e.name)).toEqual(['b', 'c', 'a']);
    expect(list.map((e) => e.ts)).toEqual([300, 200, 100]);
  });

  test('silently skips junk filenames in .tombstones/', () => {
    const roots = makeRoots();
    seedMemory(roots.user, 'real-one');
    moveToTombstone(roots, 'user', 'real-one', { now: () => 100 });
    // Operator drops a README into .tombstones/ — list ignores it.
    const dir = join(roots.user, '.tombstones');
    writeFileSync(join(dir, 'README.txt'), 'not-a-tombstone');
    writeFileSync(join(dir, 'plain.md'), 'no-ts-embedded');

    const list = listTombstones(roots, 'user');
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('real-one');
  });

  test("scopes are isolated — tombstones in user don't appear under shared", () => {
    const roots = makeRoots();
    seedMemory(roots.user, 'in-user');
    moveToTombstone(roots, 'user', 'in-user', { now: () => 100 });
    seedMemory(roots.projectShared, 'in-shared');
    moveToTombstone(roots, 'project_shared', 'in-shared', { now: () => 200 });

    expect(listTombstones(roots, 'user').map((e) => e.name)).toEqual(['in-user']);
    expect(listTombstones(roots, 'project_shared').map((e) => e.name)).toEqual(['in-shared']);
    expect(listTombstones(roots, 'project_local')).toEqual([]);
  });
});

// ── listExpiredTombstones ──────────────────────────────────────────

describe('listExpiredTombstones', () => {
  test('returns only tombstones whose age exceeds retentionMs', () => {
    const roots = makeRoots();
    seedMemory(roots.user, 'old');
    moveToTombstone(roots, 'user', 'old', { now: () => 100 });
    seedMemory(roots.user, 'recent');
    moveToTombstone(roots, 'user', 'recent', { now: () => 900 });

    // now=1000, retention=500 — 'old' (age 900) > 500; 'recent'
    // (age 100) <= 500.
    const expired = listExpiredTombstones(roots, 'user', 1_000, 500);
    expect(expired.map((e) => e.name)).toEqual(['old']);
  });

  test('boundary is strict (>): age === retention is NOT expired', () => {
    const roots = makeRoots();
    seedMemory(roots.user, 'edge');
    moveToTombstone(roots, 'user', 'edge', { now: () => 100 });
    // age = now-ts = 600; with retention 600, NOT expired (strict
    // `>`). This mirrors the strict-comparison gate the GC sweep
    // will apply downstream — at retention exactly, the operator
    // can still restore.
    expect(listExpiredTombstones(roots, 'user', 700, 600)).toEqual([]);
    expect(listExpiredTombstones(roots, 'user', 701, 600).map((e) => e.name)).toEqual(['edge']);
  });

  test('returns [] when dir is empty / does not exist', () => {
    const roots = makeRoots();
    expect(listExpiredTombstones(roots, 'user', 1_000, 100)).toEqual([]);
  });
});

// ── removeFromTombstones ───────────────────────────────────────────

describe('removeFromTombstones', () => {
  test('unlinks an existing tombstone and returns true', () => {
    const roots = makeRoots();
    seedMemory(roots.user, 'doomed');
    const r = moveToTombstone(roots, 'user', 'doomed', { now: () => 100 });
    expect(existsSync(r.tombstonePath)).toBe(true);

    expect(removeFromTombstones(roots, 'user', 'doomed', 100)).toBe(true);
    expect(existsSync(r.tombstonePath)).toBe(false);
  });

  test('returns false (idempotent) when the tombstone does not exist', () => {
    const roots = makeRoots();
    expect(removeFromTombstones(roots, 'user', 'never-existed', 100)).toBe(false);
  });

  test('only removes the targeted (name, ts) — siblings survive', () => {
    const roots = makeRoots();
    seedMemory(roots.user, 'a', 'one');
    moveToTombstone(roots, 'user', 'a', { now: () => 100 });
    seedMemory(roots.user, 'a', 'two');
    moveToTombstone(roots, 'user', 'a', { now: () => 200 });

    expect(removeFromTombstones(roots, 'user', 'a', 100)).toBe(true);
    // The other tombstone (ts=200) survives.
    const remaining = readdirSync(join(roots.user, '.tombstones'));
    expect(remaining).toEqual(['a.200.md']);
  });
});

// ── sandbox edge: ScopeError surfaces, not silent path traversal ──

describe('sandbox: tombstonePath is the path sandbox', () => {
  test('a malformed name (synthetic via cast) throws ScopeError or FrontmatterError', () => {
    const roots = makeRoots();
    // The name validator throws FrontmatterError before the
    // sandbox check fires; either error class is acceptable here
    // because both surface as a hard refusal at the boundary.
    let threw: unknown;
    try {
      tombstonePath(roots, 'user', '..' as unknown as string, 100);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
    // ScopeError is the path-layer wrapper; FrontmatterError is
    // the name-validator wrapper. Either is correct since both
    // are sandbox enforcers.
    const errName = (threw as Error)?.name ?? '';
    expect(['ScopeError', 'FrontmatterError']).toContain(errName);
    void ScopeError; // satisfy unused-import check
  });
});
