// Disabled-seeds sentinel helpers (spec MEMORY.md §5.7.6).

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { disabledSeedsPath, seedsRoot } from '../../src/memory/paths.ts';
import {
  isSeedDisabled,
  loadDisabledSeeds,
  writeDisabledSeeds,
} from '../../src/memory/seeds-disabled.ts';

const tmpDirs: string[] = [];

const makeRoots = (): ScopeRoots => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-disabled-seeds-'));
  tmpDirs.push(dir);
  return {
    user: join(dir, 'user'),
    projectShared: join(dir, 'shared'),
    projectLocal: join(dir, 'local'),
  };
};

// The seedsRoot needs to exist before writeDisabledSeeds can land
// the file (atomicWrite writes the temp file alongside, which fails
// if the parent directory is missing). The installer creates the
// dir on the production path; tests that only exercise the sentinel
// helpers must create it explicitly.
const ensureSeedsRoot = (roots: ScopeRoots): void => {
  const path = seedsRoot(roots);
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
};

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadDisabledSeeds', () => {
  test('absent file → empty map (first-boot baseline)', () => {
    const roots = makeRoots();
    expect(loadDisabledSeeds(roots)).toEqual({});
  });

  test('round-trips a well-formed write', () => {
    const roots = makeRoots();
    ensureSeedsRoot(roots);
    const payload = {
      'alpha-rule': { disabled_at: '2026-05-28T12:00:00Z' },
      'beta-rule': { disabled_at: '2026-05-28T13:00:00Z' },
    };
    writeDisabledSeeds(roots, payload);
    expect(loadDisabledSeeds(roots)).toEqual(payload);
  });

  test('keys are sorted alphabetically on disk for stable diffs', () => {
    const roots = makeRoots();
    ensureSeedsRoot(roots);
    writeDisabledSeeds(roots, {
      zeta: { disabled_at: '2026-05-28T01:00:00Z' },
      alpha: { disabled_at: '2026-05-28T02:00:00Z' },
      mu: { disabled_at: '2026-05-28T03:00:00Z' },
    });
    const raw = readFileSync(disabledSeedsPath(roots), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['alpha', 'mu', 'zeta']);
  });

  test('malformed JSON → empty map (with stderr warn) — safer default is "no opt-outs"', () => {
    // We deliberately collapse to empty rather than throw: refusing to
    // load means the operator loses every seed unrelated to the
    // corruption, while collapsing means a previously-disabled seed
    // reappears once (visible, recoverable). Stderr is consumed by the
    // bun:test runner but the path is exercised — no throw is enough
    // to pin the contract.
    const roots = makeRoots();
    ensureSeedsRoot(roots);
    writeFileSync(disabledSeedsPath(roots), '{not valid json');
    expect(loadDisabledSeeds(roots)).toEqual({});
  });

  test('per-entry corruption drops the entry but keeps valid siblings', () => {
    const roots = makeRoots();
    ensureSeedsRoot(roots);
    // Hand-craft a payload mixing a valid row with two malformed rows.
    // The loader must preserve the valid entry and drop the others,
    // each with its own stderr line (slice-4 manifest pattern).
    const raw = JSON.stringify({
      'valid-rule': { disabled_at: '2026-05-28T00:00:00Z' },
      'wrong-shape': 'not an object',
      'wrong-field-type': { disabled_at: 12345 },
    });
    writeFileSync(disabledSeedsPath(roots), raw);
    const loaded = loadDisabledSeeds(roots);
    expect(loaded).toEqual({ 'valid-rule': { disabled_at: '2026-05-28T00:00:00Z' } });
  });

  test('non-object top-level (array, null) → empty map', () => {
    const roots = makeRoots();
    ensureSeedsRoot(roots);
    writeFileSync(disabledSeedsPath(roots), '["alpha-rule"]');
    expect(loadDisabledSeeds(roots)).toEqual({});
  });
});

describe('isSeedDisabled', () => {
  test('positive + negative lookup', () => {
    const map = { 'alpha-rule': { disabled_at: '2026-05-28T00:00:00Z' } };
    expect(isSeedDisabled(map, 'alpha-rule')).toBe(true);
    expect(isSeedDisabled(map, 'beta-rule')).toBe(false);
  });

  test('prototype-chain lookup is rejected (Object.hasOwn guard)', () => {
    // Without the Object.hasOwn guard, a seed named `toString` would
    // appear disabled by virtue of `Record<string, ...>` inheriting
    // from Object.prototype. The defense-in-depth is one line in the
    // helper; this test pins it so a future refactor to `name in map`
    // gets caught.
    const map = {} as Record<string, { disabled_at: string }>;
    expect(isSeedDisabled(map, 'toString')).toBe(false);
    expect(isSeedDisabled(map, 'hasOwnProperty')).toBe(false);
    expect(isSeedDisabled(map, '__proto__')).toBe(false);
  });
});
