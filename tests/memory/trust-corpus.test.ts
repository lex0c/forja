// Substrate tests for the shared-corpus trust module (S5/T5.1).
//
// Three classes of assertion:
//   1. Fingerprint determinism / canonicalization (the hash is
//      stable across run order and detects every meaningful kind
//      of change).
//   2. Fingerprint resilience (missing corpus, partial reads, non-
//      .md files, subdirs other than .tombstones/).
//   3. Repo helpers (get/set/clear round-trip, upsert semantics,
//      multi-scope isolation).
//
// Operator-facing flow (boot modal, bulk transition) is NOT
// exercised here — those land in T5.5 once T5.2/T5.3 are in.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearSharedTrust,
  computeSharedFingerprint,
  getSharedTrust,
  setSharedTrust,
} from '../../src/memory/trust-corpus.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-trust-corpus-'));
  tmpDirs.push(dir);
  return dir;
};

const writeFile = (dir: string, name: string, body: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
};

describe('computeSharedFingerprint — canonicalization', () => {
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing scope root returns the stable empty-corpus hash', () => {
    const a = computeSharedFingerprint('/nonexistent/forja-test-path');
    const b = computeSharedFingerprint('/another/nonexistent-path');
    expect(a).toBeString();
    expect(a).toBe(b);
  });

  test('empty directory (no .md files) hashes the domain-separator only', () => {
    const dir = makeTmp();
    const h = computeSharedFingerprint(dir);
    expect(h).toBeString();
    // Distinct from the no-corpus sentinel — an empty dir IS a
    // (vacuous) corpus; absence of the dir is "never had one".
    expect(h).not.toBe(computeSharedFingerprint('/nonexistent/path'));
  });

  test('identical content in different filesystem order hashes identically', () => {
    const a = makeTmp();
    const b = makeTmp();
    writeFile(a, 'alpha.md', 'A body\n');
    writeFile(a, 'beta.md', 'B body\n');
    // Reverse write order in b — readdir on different OS/FS may
    // return either order, so the sort step is what we're pinning.
    writeFile(b, 'beta.md', 'B body\n');
    writeFile(b, 'alpha.md', 'A body\n');
    expect(computeSharedFingerprint(a)).toBe(computeSharedFingerprint(b));
  });

  test('adding a body file changes the hash', () => {
    const dir = makeTmp();
    writeFile(dir, 'alpha.md', 'body\n');
    const before = computeSharedFingerprint(dir);
    writeFile(dir, 'beta.md', 'new\n');
    const after = computeSharedFingerprint(dir);
    expect(after).not.toBe(before);
  });

  test('modifying an existing body file changes the hash', () => {
    const dir = makeTmp();
    writeFile(dir, 'alpha.md', 'original\n');
    const before = computeSharedFingerprint(dir);
    writeFile(dir, 'alpha.md', 'modified\n');
    const after = computeSharedFingerprint(dir);
    expect(after).not.toBe(before);
  });

  test('renaming a body file changes the hash (filename is in the frame)', () => {
    const a = makeTmp();
    const b = makeTmp();
    writeFile(a, 'alpha.md', 'same body\n');
    writeFile(b, 'beta.md', 'same body\n');
    expect(computeSharedFingerprint(a)).not.toBe(computeSharedFingerprint(b));
  });

  test('MEMORY.md is part of the corpus and changes propagate', () => {
    const dir = makeTmp();
    writeFile(dir, 'MEMORY.md', '- a hook\n');
    writeFile(dir, 'alpha.md', 'body\n');
    const before = computeSharedFingerprint(dir);
    writeFile(dir, 'MEMORY.md', '- a hook\n- another hook\n');
    const after = computeSharedFingerprint(dir);
    expect(after).not.toBe(before);
  });

  test('length-prefix prevents adjacency collisions', () => {
    // Without the byte-length prefix, splitting "helloworld" across
    // two files would collide with concatenating them into one.
    const a = makeTmp();
    const b = makeTmp();
    writeFile(a, 'x.md', 'hello');
    writeFile(a, 'y.md', 'world');
    writeFile(b, 'x.md', 'helloworld');
    writeFile(b, 'y.md', '');
    expect(computeSharedFingerprint(a)).not.toBe(computeSharedFingerprint(b));
  });

  test('present-but-empty file differs from absent file', () => {
    const a = makeTmp();
    const b = makeTmp();
    writeFile(a, 'x.md', '');
    // b stays without x.md
    mkdirSync(b, { recursive: true });
    expect(computeSharedFingerprint(a)).not.toBe(computeSharedFingerprint(b));
  });
});

describe('computeSharedFingerprint — corpus filter', () => {
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ignores non-.md files (operator junk, .DS_Store, swap files)', () => {
    const dir = makeTmp();
    writeFile(dir, 'alpha.md', 'body\n');
    const baseline = computeSharedFingerprint(dir);
    // Drop unrelated files in the same root.
    writeFile(dir, '.DS_Store', 'mac junk\n');
    writeFile(dir, 'README', 'no extension\n');
    writeFile(dir, 'notes.txt', 'plain text\n');
    writeFile(dir, '.alpha.md.swp', 'editor swap\n');
    expect(computeSharedFingerprint(dir)).toBe(baseline);
  });

  test('ignores .tombstones/ and other subdirectories', () => {
    const dir = makeTmp();
    writeFile(dir, 'alpha.md', 'body\n');
    const baseline = computeSharedFingerprint(dir);
    // Tombstone directory should not affect the hash — evicted
    // memories are not part of the live operator-facing corpus.
    mkdirSync(join(dir, '.tombstones'), { recursive: true });
    writeFileSync(join(dir, '.tombstones', 'old.123.md'), 'tomb body\n');
    // Arbitrary subdir (operator made one by accident) — also out.
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'nested', 'foo.md'), 'subdir body\n');
    expect(computeSharedFingerprint(dir)).toBe(baseline);
  });

  test('a directory named `something.md` is not treated as a corpus file', () => {
    const dir = makeTmp();
    writeFile(dir, 'alpha.md', 'body\n');
    const baseline = computeSharedFingerprint(dir);
    // Operator did `mkdir corpus.md/`; we skip it via the
    // isFile() stat check.
    mkdirSync(join(dir, 'mistake.md'), { recursive: true });
    expect(computeSharedFingerprint(dir)).toBe(baseline);
  });
});

describe('shared_corpus_trust repo helpers', () => {
  let db: DB;

  beforeEach(() => {
    db = openMemoryDb();
    migrate(db);
  });

  afterEach(() => {
    db.close();
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('getSharedTrust returns null when no row exists', () => {
    expect(getSharedTrust(db, '/repo/.agent/memory/shared')).toBeNull();
  });

  test('setSharedTrust inserts a row, getSharedTrust round-trips', () => {
    const root = '/repo/.agent/memory/shared';
    setSharedTrust(db, root, 'hash-abc', 1_700_000_000_000);
    const row = getSharedTrust(db, root);
    expect(row).toEqual({
      scopeRoot: root,
      lastConfirmedHash: 'hash-abc',
      lastConfirmedAtMs: 1_700_000_000_000,
    });
  });

  test('setSharedTrust upserts on the same scope_root', () => {
    const root = '/repo/.agent/memory/shared';
    setSharedTrust(db, root, 'hash-1', 1000);
    setSharedTrust(db, root, 'hash-2', 2000);
    const row = getSharedTrust(db, root);
    expect(row?.lastConfirmedHash).toBe('hash-2');
    expect(row?.lastConfirmedAtMs).toBe(2000);
    // PK guarantees a single row per scope_root.
    const count = db
      .prepare('SELECT COUNT(*) AS c FROM shared_corpus_trust WHERE scope_root = ?')
      .get(root) as { c: number };
    expect(count.c).toBe(1);
  });

  test('different scope_root values are independent', () => {
    setSharedTrust(db, '/a/shared', 'hash-a', 1000);
    setSharedTrust(db, '/b/shared', 'hash-b', 2000);
    expect(getSharedTrust(db, '/a/shared')?.lastConfirmedHash).toBe('hash-a');
    expect(getSharedTrust(db, '/b/shared')?.lastConfirmedHash).toBe('hash-b');
  });

  test('clearSharedTrust removes the row', () => {
    const root = '/repo/.agent/memory/shared';
    setSharedTrust(db, root, 'hash', 1000);
    expect(getSharedTrust(db, root)).not.toBeNull();
    clearSharedTrust(db, root);
    expect(getSharedTrust(db, root)).toBeNull();
  });

  test('clearSharedTrust on a non-existent row is a no-op', () => {
    // No throw, no row affected.
    expect(() => clearSharedTrust(db, '/never/existed')).not.toThrow();
  });

  test('CHECK constraint rejects non-positive last_confirmed_at', () => {
    expect(() => setSharedTrust(db, '/a/shared', 'h', 0)).toThrow();
    expect(() => setSharedTrust(db, '/a/shared', 'h', -1)).toThrow();
  });
});
