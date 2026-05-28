// Vendor seed catalog installer tests (spec MEMORY.md §5.7.4 +
// §5.7.8). Pins idempotence (no clobber on re-run), preservation of
// operator-edited bodies (slice 4 will land the full upgrade flow;
// this slice's contract is "skip-if-exists"), and the seeds/MEMORY.md
// regeneration shape.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANONICAL_SEEDS } from '../../src/cli/init-seeds/index.ts';
import { parseIndex } from '../../src/memory/index-file.ts';
import { loadSeedsIndex, readSeedByName } from '../../src/memory/loader.ts';
import { seedIndexFilePath, seedMemoryFilePath, seedsRoot } from '../../src/memory/paths.ts';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { installVendorSeeds } from '../../src/memory/seeds-installer.ts';

const tmpDirs: string[] = [];

const makeRoots = (): ScopeRoots => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-seeds-installer-'));
  tmpDirs.push(dir);
  return {
    user: join(dir, 'user'),
    projectShared: join(dir, 'shared'),
    projectLocal: join(dir, 'local'),
  };
};

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('installVendorSeeds — first install', () => {
  test('creates <user>/seeds/ and writes every canonical seed body', () => {
    const roots = makeRoots();
    const result = installVendorSeeds({ roots });
    expect(result.wrote).toHaveLength(CANONICAL_SEEDS.length);
    expect(result.skipped).toEqual([]);
    expect(existsSync(seedsRoot(roots))).toBe(true);
    for (const seed of CANONICAL_SEEDS) {
      expect(existsSync(seedMemoryFilePath(roots, seed.name))).toBe(true);
    }
  });

  test('regenerates seeds/MEMORY.md with one entry per canonical seed', () => {
    const roots = makeRoots();
    installVendorSeeds({ roots });
    const indexPath = seedIndexFilePath(roots);
    expect(existsSync(indexPath)).toBe(true);
    const parsed = parseIndex(readFileSync(indexPath, 'utf-8'));
    expect(parsed.entries).toHaveLength(CANONICAL_SEEDS.length);
    expect(parsed.malformedLines).toEqual([]);
    for (const seed of CANONICAL_SEEDS) {
      expect(parsed.entries.find((e) => e.href === seed.filename)).toBeDefined();
    }
  });

  test('installed body parses cleanly via parseMemoryFile (round-trip)', () => {
    const roots = makeRoots();
    installVendorSeeds({ roots });
    for (const seed of CANONICAL_SEEDS) {
      const result = readSeedByName(roots, seed.name);
      if (result.kind !== 'present') {
        throw new Error(`expected present for ${seed.name}, got ${result.kind}`);
      }
      expect(result.file.frontmatter.source).toBe('seed');
      expect(result.file.frontmatter.seed_origin).toBe('vendor');
    }
  });
});

describe('installVendorSeeds — idempotence (spec §5.7.5 conservative baseline)', () => {
  test('a second run skips every existing body', () => {
    const roots = makeRoots();
    installVendorSeeds({ roots });
    const second = installVendorSeeds({ roots });
    expect(second.wrote).toEqual([]);
    expect(second.skipped).toHaveLength(CANONICAL_SEEDS.length);
  });

  test('operator-edited bodies are preserved across re-install', () => {
    const roots = makeRoots();
    installVendorSeeds({ roots });
    // Operator edits one seed body — change is detectable but stays
    // a valid seed file (we don't rewrite cross-field constraints).
    const target = seedMemoryFilePath(roots, 'safe-edit-discipline');
    const original = readFileSync(target, 'utf-8');
    const edited = `${original}\n<!-- operator note -->\n`;
    writeFileSync(target, edited);
    const result = installVendorSeeds({ roots });
    expect(result.wrote).toEqual([]);
    expect(readFileSync(target, 'utf-8')).toBe(edited);
  });

  test('regenerates the index even when no body is written', () => {
    const roots = makeRoots();
    installVendorSeeds({ roots });
    const indexPath = seedIndexFilePath(roots);
    // Operator damages the index; the installer rewrites it.
    writeFileSync(indexPath, '# bogus\n');
    installVendorSeeds({ roots });
    const parsed = parseIndex(readFileSync(indexPath, 'utf-8'));
    expect(parsed.entries).toHaveLength(CANONICAL_SEEDS.length);
  });
});

describe('installVendorSeeds — sandbox + custom source seam', () => {
  test('honors a custom source array (test seam for deterministic fixtures)', () => {
    const roots = makeRoots();
    const sub = CANONICAL_SEEDS.slice(0, 2);
    const result = installVendorSeeds({ roots, source: sub });
    expect(result.wrote).toHaveLength(2);
    const index = loadSeedsIndex(roots);
    if (index.kind !== 'present') {
      throw new Error(`expected present index, got ${index.kind}`);
    }
    expect(index.index.entries).toHaveLength(2);
  });

  test('creates the parent <user>/ directory if absent', () => {
    const roots = makeRoots();
    // Make sure user-scope root does NOT exist yet — the installer's
    // mkdir({recursive:true}) must create both layers.
    expect(existsSync(roots.user)).toBe(false);
    installVendorSeeds({ roots });
    expect(existsSync(seedsRoot(roots))).toBe(true);
  });

  test('refuses an empty source array gracefully (index becomes empty)', () => {
    const roots = makeRoots();
    const result = installVendorSeeds({ roots, source: [] });
    expect(result.wrote).toEqual([]);
    const index = loadSeedsIndex(roots);
    if (index.kind !== 'present') {
      throw new Error(`expected present index, got ${index.kind}`);
    }
    expect(index.index.entries).toEqual([]);
  });
});

describe('installVendorSeeds — index round-trip parses', () => {
  test('the rewritten index satisfies parseMemoryFile-free direct parse', () => {
    const roots = makeRoots();
    installVendorSeeds({ roots });
    const raw = readFileSync(seedIndexFilePath(roots), 'utf-8');
    const parsed = parseIndex(raw);
    // Round-trip through the parser — slice 2's loadSeedsIndex
    // depends on this contract.
    expect(parsed.entries.length).toBeGreaterThan(0);
    // Each entry's hook is non-empty (parsed from the canonical
    // description; oversized lines would be flagged by the
    // serializer but not dropped).
    for (const entry of parsed.entries) {
      expect(entry.hook.length).toBeGreaterThan(0);
    }
  });
});
