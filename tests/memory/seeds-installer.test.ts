// Vendor seed catalog installer tests (spec MEMORY.md §5.7.4 +
// §5.7.8). Pins idempotence (no clobber on re-run), preservation of
// operator-edited bodies (slice 4 will land the full upgrade flow;
// this slice's contract is "skip-if-exists"), and the seeds/MEMORY.md
// regeneration shape.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANONICAL_SEEDS, type CanonicalSeed } from '../../src/cli/init-seeds/index.ts';
import { parseIndex } from '../../src/memory/index-file.ts';
import { loadSeedsIndex, readSeedByName } from '../../src/memory/loader.ts';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import {
  seedArchivedDir,
  seedIndexFilePath,
  seedManifestPath,
  seedMemoryFilePath,
  seedsRoot,
} from '../../src/memory/paths.ts';
import { writeDisabledSeeds } from '../../src/memory/seeds-disabled.ts';
import { installVendorSeeds } from '../../src/memory/seeds-installer.ts';
import { hashSeedContent, loadSeedManifest } from '../../src/memory/seeds-manifest.ts';

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
    expect(result.fresh).toHaveLength(CANONICAL_SEEDS.length);
    expect(result.unchanged).toEqual([]);
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
  test('a second run reports every existing body as unchanged', () => {
    const roots = makeRoots();
    installVendorSeeds({ roots });
    const second = installVendorSeeds({ roots });
    expect(second.fresh).toEqual([]);
    expect(second.unchanged).toHaveLength(CANONICAL_SEEDS.length);
    expect(second.vendorUpdated).toEqual([]);
    expect(second.userKept).toEqual([]);
  });

  test('operator-edited bodies are preserved across re-install (user_kept)', () => {
    const roots = makeRoots();
    installVendorSeeds({ roots });
    // Operator edits one seed body — change is detectable but stays
    // a valid seed file (we don't rewrite cross-field constraints).
    const target = seedMemoryFilePath(roots, 'measure-twice-cut-once');
    const original = readFileSync(target, 'utf-8');
    const edited = `${original}\n<!-- operator note -->\n`;
    writeFileSync(target, edited);
    const result = installVendorSeeds({ roots });
    expect(result.fresh).toEqual([]);
    expect(result.userKept).toContain('measure-twice-cut-once.md');
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
    expect(result.fresh).toHaveLength(2);
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
    expect(result.fresh).toEqual([]);
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

// ── Slice 4: upgrade lifecycle (spec §5.7.5) ────────────────────────────
//
// Each test below builds on the installer's state machine. We fabricate
// the {name, version, hash} triple deliberately by editing the manifest
// (or the body) between installs to drive the installer into each branch.

const makeSeed = (overrides: Partial<CanonicalSeed> & { name: string }): CanonicalSeed => {
  const name = overrides.name;
  const filename = overrides.filename ?? `${name}.md`;
  const version = overrides.version ?? '1.0';
  const description = overrides.description ?? `desc for ${name}`;
  const content =
    overrides.content ??
    `---\nname: ${name}\ndescription: ${description}\ntype: feedback\nsource: seed\nseed_origin: vendor\nseed_version: "${version}"\n---\n\nbody for ${name}.\n`;
  return { filename, name, description, version, content };
};

describe('installVendorSeeds — upgrade state machine (spec §5.7.5)', () => {
  test('fresh: new seed lands when neither file nor manifest entry exists', () => {
    const roots = makeRoots();
    const seed = makeSeed({ name: 'alpha-rule' });
    const result = installVendorSeeds({ roots, source: [seed] });
    expect(result.fresh).toEqual([seed.filename]);
    expect(result.unchanged).toEqual([]);
    expect(result.vendorUpdated).toEqual([]);
    expect(result.userKept).toEqual([]);
    const manifest = loadSeedManifest(roots);
    expect(manifest[seed.name]).toEqual({ version: '1.0', hash: hashSeedContent(seed.content) });
  });

  test('unchanged: same version + body hash → no disk write reported', () => {
    const roots = makeRoots();
    const seed = makeSeed({ name: 'alpha-rule' });
    installVendorSeeds({ roots, source: [seed] });
    const result = installVendorSeeds({ roots, source: [seed] });
    expect(result.unchanged).toEqual([seed.filename]);
    expect(result.fresh).toEqual([]);
    expect(result.vendorUpdated).toEqual([]);
  });

  test('vendor_updated: vendor bumps version, user clean → silent rewrite', () => {
    const roots = makeRoots();
    const v1 = makeSeed({ name: 'alpha-rule', version: '1.0' });
    installVendorSeeds({ roots, source: [v1] });
    const v2 = makeSeed({
      name: 'alpha-rule',
      version: '1.1',
      description: v1.description,
      content: v1.content
        .replace('body for alpha-rule.', 'body for alpha-rule v1.1.')
        .replace('seed_version: "1.0"', 'seed_version: "1.1"'),
    });
    const result = installVendorSeeds({ roots, source: [v2] });
    expect(result.vendorUpdated).toEqual([v2.filename]);
    expect(result.userKept).toEqual([]);
    const onDisk = readFileSync(seedMemoryFilePath(roots, v2.name), 'utf-8');
    expect(onDisk).toBe(v2.content);
    const manifest = loadSeedManifest(roots);
    expect(manifest[v2.name]?.version).toBe('1.1');
    expect(manifest[v2.name]?.hash).toBe(hashSeedContent(v2.content));
  });

  test('user_kept: user-edited body + vendor bump → preserve user, manifest stays at OLD baseline', () => {
    const roots = makeRoots();
    const v1 = makeSeed({ name: 'alpha-rule', version: '1.0' });
    installVendorSeeds({ roots, source: [v1] });
    // User edits the body.
    const target = seedMemoryFilePath(roots, 'alpha-rule');
    const userEdit = `${v1.content}<!-- user note -->\n`;
    writeFileSync(target, userEdit);
    const v2 = makeSeed({
      name: 'alpha-rule',
      version: '1.1',
      content: v1.content.replace('body for alpha-rule.', 'body for alpha-rule v1.1.'),
    });
    const result = installVendorSeeds({ roots, source: [v2] });
    expect(result.userKept).toEqual([v2.filename]);
    expect(result.vendorUpdated).toEqual([]);
    // Body preserved verbatim.
    expect(readFileSync(target, 'utf-8')).toBe(userEdit);
    // Manifest must keep the OLD {1.0, v1-hash} so the divergence
    // signal survives. Refreshing the hash here would silently
    // bless the user's edit on the next vendor bump.
    const manifest = loadSeedManifest(roots);
    expect(manifest[v2.name]).toEqual({
      version: '1.0',
      hash: hashSeedContent(v1.content),
    });
  });

  test('user_kept: user-edited body, same vendor version → preserve, no-op', () => {
    const roots = makeRoots();
    const seed = makeSeed({ name: 'alpha-rule' });
    installVendorSeeds({ roots, source: [seed] });
    const target = seedMemoryFilePath(roots, 'alpha-rule');
    const userEdit = `${seed.content}<!-- tweak -->\n`;
    writeFileSync(target, userEdit);
    const result = installVendorSeeds({ roots, source: [seed] });
    expect(result.userKept).toEqual([seed.filename]);
    expect(readFileSync(target, 'utf-8')).toBe(userEdit);
  });

  test('user_kept: operator pre-populated a body with no manifest → preserve + record baseline', () => {
    const roots = makeRoots();
    const seed = makeSeed({ name: 'alpha-rule' });
    // Drop a body into seeds/ BEFORE the first install. The
    // installer mkdir's the seeds/ dir; do it here so writeFileSync
    // has a parent.
    mkdirSync(seedsRoot(roots), { recursive: true });
    const target = seedMemoryFilePath(roots, seed.name);
    const preExisting = `---\nname: alpha-rule\ndescription: pre-existing\ntype: feedback\nsource: seed\nseed_origin: vendor\nseed_version: "1.0"\n---\n\nuser pre-populated.\n`;
    writeFileSync(target, preExisting);
    const result = installVendorSeeds({ roots, source: [seed] });
    expect(result.userKept).toEqual([seed.filename]);
    expect(result.fresh).toEqual([]);
    expect(readFileSync(target, 'utf-8')).toBe(preExisting);
    const manifest = loadSeedManifest(roots);
    // Records the on-disk hash so future runs see "unchanged" until
    // either the operator edits again or the vendor bumps past 1.0.
    expect(manifest[seed.name]).toEqual({
      version: '1.0',
      hash: hashSeedContent(preExisting),
    });
  });

  test('archived: seed dropped from the canonical catalog → moved to seeds/archived/<name>.<ts>.md', () => {
    const roots = makeRoots();
    const a = makeSeed({ name: 'alpha-rule' });
    const b = makeSeed({ name: 'beta-rule' });
    installVendorSeeds({ roots, source: [a, b] });
    // New catalog only carries `a`. `b` must migrate to archived/
    // with a timestamped filename — slice-4 review fix #1 closed
    // the silent-overwrite hole on the second archive of the same
    // name.
    const result = installVendorSeeds({ roots, source: [a], now: () => 1000 });
    expect(result.archived).toEqual(['beta-rule.1000.md']);
    expect(existsSync(seedMemoryFilePath(roots, 'beta-rule'))).toBe(false);
    expect(existsSync(join(seedArchivedDir(roots), 'beta-rule.1000.md'))).toBe(true);
    // Manifest row dropped for the archived seed.
    const manifest = loadSeedManifest(roots);
    expect(manifest['beta-rule']).toBeUndefined();
    expect(manifest['alpha-rule']).toBeDefined();
  });

  test('archived: double archive of the same name preserves both versions (no overwrite)', () => {
    // Regression for slice-4 review #1: catalog reintroduces a name
    // an operator already restored-and-edited from archive, then drops
    // it again. The second archive must NOT clobber the first.
    const roots = makeRoots();
    const a = makeSeed({ name: 'alpha-rule' });
    const b1 = makeSeed({
      name: 'beta-rule',
      content:
        '---\nname: beta-rule\ndescription: v1\ntype: feedback\nsource: seed\nseed_origin: vendor\nseed_version: "1.0"\n---\n\nbeta v1.\n',
    });
    installVendorSeeds({ roots, source: [a, b1], now: () => 100 });
    // First archive at ts=2000.
    installVendorSeeds({ roots, source: [a], now: () => 2000 });
    expect(existsSync(join(seedArchivedDir(roots), 'beta-rule.2000.md'))).toBe(true);
    // Catalog reintroduces beta with new content; operator boots.
    const b2 = makeSeed({
      name: 'beta-rule',
      content:
        '---\nname: beta-rule\ndescription: v2\ntype: feedback\nsource: seed\nseed_origin: vendor\nseed_version: "1.0"\n---\n\nbeta v2.\n',
    });
    installVendorSeeds({ roots, source: [a, b2], now: () => 3000 });
    // Catalog drops it again at ts=4000.
    installVendorSeeds({ roots, source: [a], now: () => 4000 });
    // Both archived versions survive — operator can restore either.
    expect(existsSync(join(seedArchivedDir(roots), 'beta-rule.2000.md'))).toBe(true);
    expect(existsSync(join(seedArchivedDir(roots), 'beta-rule.4000.md'))).toBe(true);
    const v1Archived = readFileSync(join(seedArchivedDir(roots), 'beta-rule.2000.md'), 'utf-8');
    const v2Archived = readFileSync(join(seedArchivedDir(roots), 'beta-rule.4000.md'), 'utf-8');
    expect(v1Archived).toContain('beta v1.');
    expect(v2Archived).toContain('beta v2.');
  });

  test('operator-deleted body (manifest row present) is NOT reinstalled', () => {
    const roots = makeRoots();
    const seed = makeSeed({ name: 'alpha-rule' });
    installVendorSeeds({ roots, source: [seed] });
    // Operator manually deletes the body (slice 5 will add a proper
    // disable surface; today's behavior: leave the manifest row,
    // skip reinstall).
    unlinkSync(seedMemoryFilePath(roots, seed.name));
    const result = installVendorSeeds({ roots, source: [seed] });
    expect(result.fresh).toEqual([]);
    expect(result.userKept).toEqual([seed.filename]);
    expect(existsSync(seedMemoryFilePath(roots, seed.name))).toBe(false);
    // Index skips the absent body so /memory list doesn't advertise it.
    const indexEntries = parseIndex(readFileSync(seedIndexFilePath(roots), 'utf-8')).entries;
    expect(indexEntries.find((e) => e.href === seed.filename)).toBeUndefined();
  });
});

describe('installVendorSeeds — manifest persistence', () => {
  test('manifest is sorted by key for stable cross-boot diffs', () => {
    const roots = makeRoots();
    const seeds = ['zeta', 'alpha', 'mu'].map((n) => makeSeed({ name: n }));
    installVendorSeeds({ roots, source: seeds });
    const raw = readFileSync(seedManifestPath(roots), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['alpha', 'mu', 'zeta']);
  });

  test('malformed manifest → installer treats as empty and rewrites', () => {
    const roots = makeRoots();
    const seed = makeSeed({ name: 'alpha-rule' });
    installVendorSeeds({ roots, source: [seed] });
    // Corrupt the manifest.
    writeFileSync(seedManifestPath(roots), '{not valid json');
    // Body still on disk; with empty effective manifest the
    // installer will see hash mismatch (no prior entry) and route
    // to user_kept (records the on-disk hash as baseline).
    const result = installVendorSeeds({ roots, source: [seed] });
    expect(result.userKept).toEqual([seed.filename]);
    // Manifest re-written with the on-disk hash.
    const manifest = loadSeedManifest(roots);
    expect(manifest[seed.name]).toBeDefined();
  });

  test('manifest with an invalid-name key (e.g., `../old`) self-heals — install does not throw', () => {
    // Reported bug: a hand-edited or corrupt manifest key that
    // fails `validateName` would crash `forja init --only=seeds`
    // because the orphan-archive loop called `seedMemoryFilePath`
    // on it BEFORE the manifest could be rewritten — leaving no
    // recovery path. Fix: `loadSeedManifest` filters invalid-name
    // keys at load time (with stderr warn), so the orphan loop
    // never sees them and the rewrite drops them from disk.
    const roots = makeRoots();
    const seed = makeSeed({ name: 'alpha-rule' });
    // Land a valid manifest first so seedsRoot exists.
    installVendorSeeds({ roots, source: [seed] });
    // Now corrupt the manifest by adding an entry with a path-
    // traversal key that validateName rejects. Mix in one VALID
    // entry too so we can prove the loader doesn't drop valid
    // siblings alongside the invalid row.
    writeFileSync(
      seedManifestPath(roots),
      JSON.stringify({
        '../old': { version: '1.0', hash: 'deadbeef' },
        'alpha-rule': { version: '1.0', hash: hashSeedContent(seed.content) },
      }),
    );
    // Install must complete without throwing.
    expect(() => installVendorSeeds({ roots, source: [seed] })).not.toThrow();
    // The invalid key is gone from the rewritten manifest; the
    // valid sibling survives the self-heal.
    const manifest = loadSeedManifest(roots);
    expect(Object.hasOwn(manifest, '../old')).toBe(false);
    expect(manifest['alpha-rule']).toBeDefined();
    // No spurious archive file landed (validateName rejected the
    // name before the archive loop could touch the filesystem).
    expect(existsSync(seedArchivedDir(roots))).toBe(false);
  });
});

// Per-seed opt-out sentinel (spec §5.7.6). The installer honors
// `<user>/seeds/.disabled.json` BEFORE the upgrade state machine,
// so disabling a seed survives a vendor catalog bump that would
// otherwise route the body through `vendor_updated` or `unchanged`.
describe('installVendorSeeds — disabled-sentinel handling (spec §5.7.6)', () => {
  test('first install: disabled seed routes through disabled action, body NOT written', () => {
    const roots = makeRoots();
    const seed = makeSeed({ name: 'alpha-rule' });
    // mkdir + write the sentinel BEFORE the first install — the
    // installer's mkdir({ recursive: true }) on seedsRoot also
    // satisfies writeDisabledSeeds's parent-dir prereq, but the
    // sentinel writer would race that on a fresh tree. Run the
    // installer once with NO source to get the directory in place,
    // then add the sentinel and install with the real source.
    installVendorSeeds({ roots, source: [] });
    writeDisabledSeeds(roots, { 'alpha-rule': { disabled_at: '2026-05-28T00:00:00Z' } });
    const result = installVendorSeeds({ roots, source: [seed] });
    expect(result.disabled).toEqual([seed.filename]);
    expect(result.fresh).toEqual([]);
    // Body must NOT have landed on disk — opt-out means the operator
    // doesn't want even the inert copy at <user>/seeds/<name>.md.
    expect(existsSync(seedMemoryFilePath(roots, seed.name))).toBe(false);
    // Index regen MUST exclude disabled entries.
    const indexEntries = parseIndex(readFileSync(seedIndexFilePath(roots), 'utf-8')).entries;
    expect(indexEntries.find((e) => e.href === seed.filename)).toBeUndefined();
  });

  test('disabled seed with a prior install preserves the body on disk', () => {
    const roots = makeRoots();
    const seed = makeSeed({ name: 'alpha-rule' });
    // First install lands the body normally.
    installVendorSeeds({ roots, source: [seed] });
    expect(existsSync(seedMemoryFilePath(roots, seed.name))).toBe(true);
    // Operator disables the seed AFTER the install.
    writeDisabledSeeds(roots, { 'alpha-rule': { disabled_at: '2026-05-28T00:00:00Z' } });
    const result = installVendorSeeds({ roots, source: [seed] });
    expect(result.disabled).toEqual([seed.filename]);
    // Body preserved — `disable` is reversible. Without this, a
    // future `enable` would have to reinstall from scratch instead
    // of just dropping the sentinel.
    expect(existsSync(seedMemoryFilePath(roots, seed.name))).toBe(true);
    // Index excludes it.
    const indexEntries = parseIndex(readFileSync(seedIndexFilePath(roots), 'utf-8')).entries;
    expect(indexEntries.find((e) => e.href === seed.filename)).toBeUndefined();
  });

  test('disabled status survives a vendor version bump (sentinel beats state machine)', () => {
    const roots = makeRoots();
    const v1 = makeSeed({ name: 'alpha-rule', version: '1.0' });
    installVendorSeeds({ roots, source: [v1] });
    writeDisabledSeeds(roots, { 'alpha-rule': { disabled_at: '2026-05-28T00:00:00Z' } });
    // Vendor catalog bumps to v2 (different body). Without the
    // sentinel-first check, this would route through `vendor_updated`
    // (hash matches the prior manifest, version bumped) and silently
    // rewrite the body — defeating the opt-out.
    const v2 = makeSeed({
      name: 'alpha-rule',
      version: '2.0',
      content:
        '---\nname: alpha-rule\ndescription: desc\ntype: feedback\nsource: seed\nseed_origin: vendor\nseed_version: "2.0"\n---\n\nv2 body.\n',
    });
    const result = installVendorSeeds({ roots, source: [v2] });
    expect(result.disabled).toEqual([v2.filename]);
    expect(result.vendorUpdated).toEqual([]);
    // Manifest preserved at the v1 entry (the sentinel doesn't
    // refresh the manifest — a future `enable` resumes from v1
    // baseline, which then triggers vendor_updated on the next pass
    // and the operator gets the v2 body if they want it).
    const manifest = loadSeedManifest(roots);
    expect(manifest[v2.name]?.version).toBe('1.0');
  });

  test('removing the sentinel (mimicking enable) restores normal state-machine routing', () => {
    const roots = makeRoots();
    const seed = makeSeed({ name: 'alpha-rule' });
    installVendorSeeds({ roots, source: [seed] });
    writeDisabledSeeds(roots, { 'alpha-rule': { disabled_at: '2026-05-28T00:00:00Z' } });
    let result = installVendorSeeds({ roots, source: [seed] });
    expect(result.disabled).toEqual([seed.filename]);
    // Operator re-enables: clear the sentinel.
    writeDisabledSeeds(roots, {});
    result = installVendorSeeds({ roots, source: [seed] });
    // Body present + manifest match the canonical version → unchanged.
    expect(result.unchanged).toEqual([seed.filename]);
    expect(result.disabled).toEqual([]);
    // Index re-adds the entry.
    const indexEntries = parseIndex(readFileSync(seedIndexFilePath(roots), 'utf-8')).entries;
    expect(indexEntries.find((e) => e.href === seed.filename)).toBeDefined();
  });

  test('disabled seed alongside enabled siblings — only the named seed is suppressed', () => {
    const roots = makeRoots();
    const alpha = makeSeed({ name: 'alpha-rule' });
    const beta = makeSeed({ name: 'beta-rule' });
    installVendorSeeds({ roots, source: [alpha, beta] });
    writeDisabledSeeds(roots, { 'alpha-rule': { disabled_at: '2026-05-28T00:00:00Z' } });
    const result = installVendorSeeds({ roots, source: [alpha, beta] });
    expect(result.disabled).toEqual([alpha.filename]);
    expect(result.unchanged).toEqual([beta.filename]);
    // Index keeps beta, drops alpha.
    const indexEntries = parseIndex(readFileSync(seedIndexFilePath(roots), 'utf-8')).entries;
    expect(indexEntries.map((e) => e.href)).toEqual([beta.filename]);
  });

  test('disable → vendor bump → enable cycle resumes from the preserved baseline (spec §5.7.6 + §5.7.5)', () => {
    // BACKLOG promise (slice 5b): "prior manifest entry is preserved
    // verbatim (so a future enable resumes from the same baseline)".
    // This pins the resumption side of that contract: after a vendor
    // bump landed during the disabled window, clearing the sentinel
    // and re-running the installer routes through `vendor_updated`
    // using the v1 manifest baseline — the operator gets the v2
    // body for free, exactly as if the disable had never happened.
    // Without the manifest preservation, the post-enable routing
    // could mis-fire to `unchanged` (silently keeping v1) or to a
    // user-modified path (claiming a divergence that doesn't exist).
    const roots = makeRoots();
    const v1 = makeSeed({ name: 'alpha-rule', version: '1.0' });
    installVendorSeeds({ roots, source: [v1] });
    // Operator disables the seed.
    writeDisabledSeeds(roots, { 'alpha-rule': { disabled_at: '2026-05-28T00:00:00Z' } });
    // Vendor bumps to v2 DURING the disabled window — installer
    // routes through `disabled`, manifest preserves the v1 entry.
    const v2 = makeSeed({
      name: 'alpha-rule',
      version: '2.0',
      content:
        '---\nname: alpha-rule\ndescription: desc\ntype: feedback\nsource: seed\nseed_origin: vendor\nseed_version: "2.0"\n---\n\nv2 body.\n',
    });
    let result = installVendorSeeds({ roots, source: [v2] });
    expect(result.disabled).toEqual([v2.filename]);
    // Manifest preserved at v1 — this is the resumption baseline.
    let manifest = loadSeedManifest(roots);
    expect(manifest['alpha-rule']?.version).toBe('1.0');
    // Operator re-enables; v2 catalog is still the active vendor pack.
    writeDisabledSeeds(roots, {});
    result = installVendorSeeds({ roots, source: [v2] });
    // Body present + manifest at v1 + canonical at v2 → vendor_updated:
    // the silent-rewrite path delivers v2 to the operator. This is
    // the spec's "User não editou (hash bate): atualiza silenciosamente"
    // landing — operator gets the new vendor content on enable, not
    // a stale v1.
    expect(result.vendorUpdated).toEqual([v2.filename]);
    expect(result.disabled).toEqual([]);
    // Manifest now reflects v2 (resumption complete).
    manifest = loadSeedManifest(roots);
    expect(manifest['alpha-rule']?.version).toBe('2.0');
    // On-disk body matches v2 canonical.
    expect(readFileSync(seedMemoryFilePath(roots, 'alpha-rule'), 'utf-8')).toBe(v2.content);
  });
});
