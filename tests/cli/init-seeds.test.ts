// Bundled vendor seed catalog tests (spec MEMORY.md §5.7.8).
// Validates that every canonical seed ships parseable through the
// memory frontmatter parser AND honors the seed-specific gates
// (source=seed cross-fields, body ≤ 30 lines, trust trusted).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANONICAL_SEEDS } from '../../src/cli/init-seeds/index.ts';
import { runInit } from '../../src/cli/init.ts';
import { SEED_BODY_MAX_LINES, parseMemoryFile } from '../../src/memory/frontmatter.ts';

describe('CANONICAL_SEEDS — bundled vendor seed catalog', () => {
  test('ships exactly 11 seeds (spec §5.7.7 hard cap)', () => {
    expect(CANONICAL_SEEDS.length).toBeLessThanOrEqual(11);
    expect(CANONICAL_SEEDS).toHaveLength(11);
  });

  test('each canonical seed parses cleanly with seed cross-field rules', () => {
    for (const seed of CANONICAL_SEEDS) {
      // parseMemoryFile throws FrontmatterError on bad frontmatter
      // (including source=seed cross-checks: required seed_origin
      // + seed_version, forbidden expires, forbidden trust=untrusted)
      // AND on bodies exceeding SEED_BODY_MAX_LINES. A regression in
      // any seed surfaces here with a message naming the offending
      // file, before the asset ships.
      const file = parseMemoryFile(seed.content);
      expect(file.frontmatter.source).toBe('seed');
      expect(file.frontmatter.seed_origin).toBe('vendor');
      expect(file.frontmatter.seed_version).toBe('1.0');
      expect(`${file.frontmatter.name}.md`).toBe(seed.filename);
      // The index entry's pinned `name`/`description`/`version`
      // must match the frontmatter — the installer copies them into
      // seeds/MEMORY.md and into the install manifest without
      // re-parsing each body. A developer who bumps the .md
      // frontmatter `seed_version` without updating the index.ts
      // entry would otherwise ship a catalog whose manifest records
      // the wrong version, silently misclassifying future upgrade
      // boots (slice-4 review fix #3).
      expect(seed.name).toBe(file.frontmatter.name);
      expect(seed.description).toBe(file.frontmatter.description);
      // seed_version is `string | undefined` on the MemoryFrontmatter
      // type, but the parser's cross-field rule guarantees it's set
      // when source=seed (which we just asserted above). Pin both
      // halves so the assertion's contract is explicit.
      expect(file.frontmatter.seed_version).toBeDefined();
      expect(seed.version).toBe(file.frontmatter.seed_version ?? '');
    }
  });

  test('every seed body is within the SEED_BODY_MAX_LINES cap', () => {
    for (const seed of CANONICAL_SEEDS) {
      const file = parseMemoryFile(seed.content);
      // The parser already enforces the cap (throws on >30 lines).
      // This assertion documents the invariant for the reader and
      // double-protects against a regression that loosens the cap.
      const lines = file.body.split('\n');
      const effective = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
      expect(effective).toBeLessThanOrEqual(SEED_BODY_MAX_LINES);
    }
  });

  test('filenames are unique and alphabetically ordered', () => {
    const filenames = CANONICAL_SEEDS.map((s) => s.filename);
    expect(new Set(filenames).size).toBe(filenames.length);
    const sorted = [...filenames].sort((a, b) => a.localeCompare(b));
    expect(filenames).toEqual(sorted);
  });

  test('names are unique', () => {
    const names = CANONICAL_SEEDS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// Vendor seed catalog ships with `agent init`. The integration test
// isolates XDG_CONFIG_HOME so the install lands in a tmp tree instead
// of polluting the developer's real ~/.config/agent.
describe('agent init seeds — installs vendor catalog under user scope', () => {
  const cleanup: string[] = [];
  let originalXdg: string | undefined;

  // Capture the original XDG BEFORE any test body runs. If we'd done
  // this inside each test, a throw from mkdtempSync (or any setup
  // call) before the capture line would leave originalXdg as
  // `undefined` from the prior afterEach reset — afterEach would then
  // `delete` the var even if it was set originally, leaking into
  // every subsequent test in this process. Capturing in beforeEach
  // ensures the value is locked in BEFORE the test body has a chance
  // to throw.
  beforeEach(() => {
    originalXdg = process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    while (cleanup.length > 0) {
      const dir = cleanup.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('runInit with only=[seeds] writes the 11 canonical bodies + index + manifest', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'forja-init-seeds-'));
    const userHome = mkdtempSync(join(tmpdir(), 'forja-init-seeds-xdg-'));
    cleanup.push(cwd, userHome);
    process.env.XDG_CONFIG_HOME = userHome;

    const out: string[] = [];
    const err: string[] = [];
    const code = runInit({
      cwd,
      mode: 'strict',
      only: ['seeds'],
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    expect(code).toBe(0);

    // Bodies land at <XDG>/agent/memory/seeds/<name>.md.
    const seedsDir = join(userHome, 'agent', 'memory', 'seeds');
    expect(existsSync(seedsDir)).toBe(true);
    for (const seed of CANONICAL_SEEDS) {
      expect(existsSync(join(seedsDir, seed.filename))).toBe(true);
    }

    // Index regenerated from canonical entries (one line per seed).
    const indexBody = readFileSync(join(seedsDir, 'MEMORY.md'), 'utf-8');
    for (const seed of CANONICAL_SEEDS) {
      expect(indexBody).toContain(seed.filename);
    }

    // Manifest persisted, one entry per canonical seed.
    const manifestRaw = readFileSync(join(seedsDir, '.installed.json'), 'utf-8');
    const manifest = JSON.parse(manifestRaw) as Record<string, { version: string; hash: string }>;
    expect(Object.keys(manifest).length).toBe(CANONICAL_SEEDS.length);

    // The `forja: wrote ...` lines reflect every canonical install.
    const stdout = out.join('');
    for (const seed of CANONICAL_SEEDS) {
      expect(stdout).toContain(`wrote ${join(seedsDir, seed.filename)}`);
    }
  });

  test('idempotent: a second run reports unchanged for every seed', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'forja-init-seeds-idem-'));
    const userHome = mkdtempSync(join(tmpdir(), 'forja-init-seeds-idem-xdg-'));
    cleanup.push(cwd, userHome);
    process.env.XDG_CONFIG_HOME = userHome;

    runInit({
      cwd,
      mode: 'strict',
      only: ['seeds'],
      out: () => {},
      err: () => {},
    });
    const out: string[] = [];
    const code = runInit({
      cwd,
      mode: 'strict',
      only: ['seeds'],
      out: (s) => out.push(s),
      err: () => {},
    });
    expect(code).toBe(0);
    // No `wrote ` lines on the second pass — the report shows
    // "0 wrote" in the summary.
    const stdout = out.join('');
    expect(stdout).toContain('0 wrote');
    // The skipped counter equals the catalog size (every seed routed
    // through `unchanged`).
    expect(stdout).toContain(`${CANONICAL_SEEDS.length} skipped`);
  });

  test('summary surfaces `K disabled` suffix when sentinel is populated (spec §5.7.6)', async () => {
    // Slice 5b: an operator who disabled some seeds (via slash, or
    // by hand-editing the sentinel) should see the count in the
    // init summary. Without this pin, a refactor of the totals
    // aggregator could silently drop the suffix and the operator
    // running `agent init` after a long pause would lose the
    // signal that their opt-outs are still active.
    const cwd = mkdtempSync(join(tmpdir(), 'forja-init-seeds-disabled-'));
    const userHome = mkdtempSync(join(tmpdir(), 'forja-init-seeds-disabled-xdg-'));
    cleanup.push(cwd, userHome);
    process.env.XDG_CONFIG_HOME = userHome;

    // First pass: install the full catalog so a disable has something
    // to act against.
    runInit({ cwd, mode: 'strict', only: ['seeds'], out: () => {}, err: () => {} });
    // Hand-write the sentinel for two seeds. Going through the slash
    // surface would require wiring a full SlashContext; the sentinel
    // file is the contract the installer reads from, and this test
    // pins the installer + summary behavior, not the slash dispatch
    // (which has its own tests).
    const { writeDisabledSeeds } = await import('../../src/memory/seeds-disabled.ts');
    const { resolveScopeRoots, resolveRepoRoot } = await import('../../src/memory/paths.ts');
    // `resolveScopeRoots` reads `XDG_CONFIG_HOME` for the user-scope
    // root, which the test already set above to the isolated
    // userHome — passing process.env honors that override.
    const roots = resolveScopeRoots(resolveRepoRoot(cwd), process.env);
    const targets = CANONICAL_SEEDS.slice(0, 2);
    const sentinel: Record<string, { disabled_at: string }> = {};
    for (const seed of targets) {
      sentinel[seed.name] = { disabled_at: '2026-05-28T00:00:00Z' };
    }
    writeDisabledSeeds(roots, sentinel);

    // Re-run init with the sentinel in place.
    const out: string[] = [];
    const code = runInit({
      cwd,
      mode: 'strict',
      only: ['seeds'],
      out: (s) => out.push(s),
      err: () => {},
    });
    expect(code).toBe(0);
    const stdout = out.join('');
    expect(stdout).toContain(`${targets.length} disabled`);
    // Per-seed log line names the file + the re-enable hint.
    for (const seed of targets) {
      expect(stdout).toContain(`/memory seeds enable ${seed.name}`);
    }
  });
});
