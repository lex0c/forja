import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleMemorySection, composeSystemPrompt } from '../../src/cli/memory-prompt.ts';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-mem-prompt-'));
  tmpDirs.push(dir);
  return dir;
};

const makeRoots = (repo: string): ScopeRoots => ({
  user: join(repo, 'user'),
  projectShared: join(repo, 'shared'),
  projectLocal: join(repo, 'local'),
});

const writeIndex = (dir: string, body: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), body);
};

// Write a memory body file with explicit frontmatter. Used by trust-
// filter tests where the body's `trust:` field has to be present
// for assembleMemorySection's peek() to read it.
const writeBody = (
  dir: string,
  name: string,
  fmExtras: { trust?: string; type?: string; source?: string } = {},
): void => {
  mkdirSync(dir, { recursive: true });
  const lines = [
    `name: ${name}`,
    `description: hook for ${name}`,
    `type: ${fmExtras.type ?? 'feedback'}`,
    `source: ${fmExtras.source ?? 'user_explicit'}`,
  ];
  if (fmExtras.trust !== undefined) lines.push(`trust: ${fmExtras.trust}`);
  writeFileSync(join(dir, `${name}.md`), `---\n${lines.join('\n')}\n---\n\nbody of ${name}\n`);
};

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('assembleMemorySection', () => {
  test('returns empty string and zero count when no memories exist', () => {
    const repo = makeTmp();
    const registry = createMemoryRegistry({ roots: makeRoots(repo) });
    const result = assembleMemorySection({ registry });
    expect(result.text).toBe('');
    expect(result.entryCount).toBe(0);
  });

  test('renders entries with scope prefix', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Role](role.md) — full-stack TS dev\n');
    writeIndex(roots.projectShared, '- [Conv](team-conv.md) — code review conventions\n');
    writeIndex(roots.projectLocal, '- [Style](commit-style.md) — Title Case verbs\n');
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry });
    expect(result.entryCount).toBe(3);
    expect(result.text).toContain('# Memory');
    expect(result.text).toContain('memory_read');
    expect(result.text).toContain('[project_local] commit-style — Title Case verbs');
    expect(result.text).toContain('[project_shared] team-conv — code review conventions');
    expect(result.text).toContain('[user] role — full-stack TS dev');
  });

  test('orders entries by scope precedence (local > shared > user)', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [U](u.md) — user\n');
    writeIndex(roots.projectShared, '- [S](s.md) — shared\n');
    writeIndex(roots.projectLocal, '- [L](l.md) — local\n');
    const registry = createMemoryRegistry({ roots });
    const text = assembleMemorySection({ registry }).text;
    const localIdx = text.indexOf('[project_local]');
    const sharedIdx = text.indexOf('[project_shared]');
    const userIdx = text.indexOf('[user]');
    expect(localIdx).toBeGreaterThan(-1);
    expect(localIdx).toBeLessThan(sharedIdx);
    expect(sharedIdx).toBeLessThan(userIdx);
  });

  test('dedupes shadowed names to most-specific scope', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Style](commit-style.md) — user version\n');
    writeIndex(roots.projectShared, '- [Style](commit-style.md) — shared version\n');
    writeIndex(roots.projectLocal, '- [Style](commit-style.md) — local version\n');
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry });
    expect(result.entryCount).toBe(1);
    expect(result.text).toContain('[project_local] commit-style — local version');
    expect(result.text).not.toContain('shared version');
    expect(result.text).not.toContain('user version');
  });
});

describe('assembleMemorySection — trust filter (spec §7.2.2)', () => {
  test('skips entries whose body frontmatter has trust: untrusted', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(
      roots.projectLocal,
      '- [Trusted](trusted-mem.md) — trusted hook\n- [Untrusted](untrusted-mem.md) — untrusted hook\n',
    );
    writeBody(roots.projectLocal, 'trusted-mem'); // no trust marker
    writeBody(roots.projectLocal, 'untrusted-mem', { trust: 'untrusted' });
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry });
    expect(result.entryCount).toBe(1);
    expect(result.text).toContain('trusted-mem');
    expect(result.text).not.toContain('untrusted-mem');
    expect(result.text).not.toContain('untrusted hook');
  });

  test('explicit trust: trusted is included (parser preserves the marker)', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Pref](pref.md) — explicit trusted\n');
    writeBody(roots.user, 'pref', { trust: 'trusted', type: 'user' });
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry });
    expect(result.entryCount).toBe(1);
    expect(result.text).toContain('pref');
  });

  test('returns empty section when every entry is untrusted', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Only](only.md) — h\n');
    writeBody(roots.projectLocal, 'only', { trust: 'untrusted' });
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry });
    expect(result.entryCount).toBe(0);
    expect(result.text).toBe('');
  });

  test('uncertain peek (missing body) defaults to INCLUDE the index entry', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Ghost](ghost.md) — body absent\n');
    // Index entry exists; body file does not. peek returns 'missing'.
    // Including the entry preserves operator visibility into the
    // index while /memory list (when it lands) surfaces the
    // missing-body diagnostic.
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry });
    expect(result.entryCount).toBe(1);
    expect(result.text).toContain('ghost');
  });

  test('untrusted shadow does NOT eclipse a trusted entry of the same name in a less-specific scope', () => {
    // Spec §7.2.2: trust is per-MEMORY, not per-name. If
    // project_local/commit-style is untrusted but user/commit-style
    // is trusted, the user version must surface in the eager-load
    // (the operator's intent: "promote the trusted shadow to
    // active when the more-specific scope is marked untrusted").
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Style](commit-style.md) — local untrusted version\n');
    writeIndex(roots.user, '- [Style](commit-style.md) — user trusted version\n');
    writeBody(roots.projectLocal, 'commit-style', { trust: 'untrusted' });
    writeBody(roots.user, 'commit-style');
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry });
    expect(result.entryCount).toBe(1);
    // The user-scope (trusted) shadow must be the one rendered.
    expect(result.text).toContain('[user] commit-style');
    expect(result.text).toContain('user trusted version');
    expect(result.text).not.toContain('[project_local] commit-style');
    expect(result.text).not.toContain('local untrusted version');
  });

  test('untrusted in less-specific scope is filtered; more-specific trusted scope still wins', () => {
    // Inverse shadow: project_local is trusted, user is untrusted.
    // Standard precedence picks project_local; user's untrust
    // marker is irrelevant because it was already shadowed out.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Style](commit-style.md) — local trusted\n');
    writeIndex(roots.user, '- [Style](commit-style.md) — user untrusted\n');
    writeBody(roots.projectLocal, 'commit-style');
    writeBody(roots.user, 'commit-style', { trust: 'untrusted' });
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry });
    expect(result.entryCount).toBe(1);
    expect(result.text).toContain('[project_local] commit-style');
    expect(result.text).not.toContain('[user] commit-style');
  });

  test('all-scope untrusted shadows produce empty section (every shadow filtered)', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Style](commit-style.md) — local\n');
    writeIndex(roots.projectShared, '- [Style](commit-style.md) — shared\n');
    writeIndex(roots.user, '- [Style](commit-style.md) — user\n');
    writeBody(roots.projectLocal, 'commit-style', { trust: 'untrusted' });
    writeBody(roots.projectShared, 'commit-style', { trust: 'untrusted' });
    writeBody(roots.user, 'commit-style', { trust: 'untrusted' });
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry });
    expect(result.entryCount).toBe(0);
    expect(result.text).toBe('');
  });

  test('peek call does NOT emit memory_events read rows (no audit)', async () => {
    // Smoke: peek-based filter should not double up the read
    // audit. We run assembleMemorySection with a registry wired
    // to a real DB and assert listMemoryEventsByName returns
    // nothing.
    const { openMemoryDb } = await import('../../src/storage/db.ts');
    const { migrate } = await import('../../src/storage/migrate.ts');
    const { listMemoryEventsByName } = await import('../../src/storage/repos/memory-events.ts');
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [A](a.md) — h\n');
    writeBody(roots.projectLocal, 'a');
    const db = openMemoryDb();
    migrate(db);
    const registry = createMemoryRegistry({ roots, db });
    assembleMemorySection({ registry });
    expect(listMemoryEventsByName(db, 'a')).toEqual([]);
  });
});

describe('composeSystemPrompt', () => {
  test('returns base unchanged when memory section is empty', () => {
    expect(composeSystemPrompt('You are an agent.', '')).toBe('You are an agent.');
  });

  test('returns memory section alone when base is undefined', () => {
    expect(composeSystemPrompt(undefined, '# Memory\n- entry')).toBe('# Memory\n- entry');
  });

  test('returns memory section alone when base is empty string', () => {
    expect(composeSystemPrompt('', '# Memory\n- entry')).toBe('# Memory\n- entry');
  });

  test('returns undefined when both are empty', () => {
    expect(composeSystemPrompt(undefined, '')).toBeUndefined();
  });

  test('appends memory after base with blank line separator', () => {
    const out = composeSystemPrompt('You are an agent.', '# Memory\n- entry');
    expect(out).toBe('You are an agent.\n\n# Memory\n- entry');
  });
});
