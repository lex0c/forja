import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleMemorySection, composeSystemPrompt } from '../../src/cli/memory-prompt.ts';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import type { BootContext, BootTrigger } from '../../src/memory/triggers.ts';

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

  test('header carries verify-before-act guidance (spec §6.1)', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [X](x.md) — h\n');
    const registry = createMemoryRegistry({ roots });
    const text = assembleMemorySection({ registry }).text;
    // Verification rule names the right axis (factual vs preference).
    expect(text).toContain('FACTUAL');
    expect(text).toContain('PREFERENCE');
    // Names a concrete verification tool so the model knows what
    // to invoke (grep / read_file are the canonical pair).
    expect(text).toContain('grep');
    expect(text).toContain('read_file');
    // The "drift → discard" rule is part of the guidance.
    expect(text.toLowerCase()).toContain('drift');
  });

  test('verify-before-act guidance does NOT render when the memory section is empty', () => {
    // No memories → no section, hence no guidance. Avoids
    // wasting tokens on a verification rule with nothing to
    // verify.
    const repo = makeTmp();
    const registry = createMemoryRegistry({ roots: makeRoots(repo) });
    const result = assembleMemorySection({ registry });
    expect(result.text).toBe('');
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

describe('assembleMemorySection — boot trigger filter (spec §4.3)', () => {
  const makeCtx = (...triggers: BootTrigger[]): BootContext => ({
    triggers: new Set(triggers),
  });

  test('untagged memories load regardless of boot context', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Plain](plain.md) — h\n');
    writeBody(roots.projectLocal, 'plain'); // no triggers
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry, bootContext: makeCtx() });
    expect(result.entryCount).toBe(1);
    expect(result.text).toContain('plain');
  });

  test('tagged memory with matching trigger loads', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [GitOps](git-ops.md) — h\n');
    // Use the trigger-aware writeBody helper via inline body write.
    mkdirSync(roots.projectLocal, { recursive: true });
    writeFileSync(
      join(roots.projectLocal, 'git-ops.md'),
      [
        '---',
        'name: git-ops',
        'description: hook for git-ops',
        'type: feedback',
        'source: user_explicit',
        'triggers:',
        '  - git',
        '---',
        '',
        'body',
      ].join('\n'),
    );
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry, bootContext: makeCtx('git') });
    expect(result.entryCount).toBe(1);
    expect(result.text).toContain('git-ops');
  });

  test('tagged memory without matching trigger does NOT load', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [GitOps](git-ops.md) — h\n');
    mkdirSync(roots.projectLocal, { recursive: true });
    writeFileSync(
      join(roots.projectLocal, 'git-ops.md'),
      [
        '---',
        'name: git-ops',
        'description: hook for git-ops',
        'type: feedback',
        'source: user_explicit',
        'triggers:',
        '  - git',
        '---',
        '',
        'body',
      ].join('\n'),
    );
    const registry = createMemoryRegistry({ roots });
    // boot context has no `git` trigger
    const result = assembleMemorySection({ registry, bootContext: makeCtx('env') });
    expect(result.entryCount).toBe(0);
    expect(result.text).toBe('');
  });

  test('operator-defined runtime tag (no well-known): unconditional load (rule 2)', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Bash](bash-tips.md) — h\n');
    mkdirSync(roots.projectLocal, { recursive: true });
    writeFileSync(
      join(roots.projectLocal, 'bash-tips.md'),
      [
        '---',
        'name: bash-tips',
        'description: hook for bash-tips',
        'type: feedback',
        'source: user_explicit',
        'triggers:',
        '  - bash', // not a well-known boot trigger
        '---',
        '',
        'body',
      ].join('\n'),
    );
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry, bootContext: makeCtx() });
    // Rule 2: all-operator-defined triggers pass through
    // unconditionally at boot.
    expect(result.entryCount).toBe(1);
    expect(result.text).toContain('bash-tips');
  });

  test('mixed well-known + operator-defined: matches on well-known half', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Mixed](mixed.md) — h\n');
    mkdirSync(roots.projectLocal, { recursive: true });
    writeFileSync(
      join(roots.projectLocal, 'mixed.md'),
      [
        '---',
        'name: mixed',
        'description: hook for mixed',
        'type: feedback',
        'source: user_explicit',
        'triggers:',
        '  - git',
        '  - bash',
        '---',
        '',
        'body',
      ].join('\n'),
    );
    const registry = createMemoryRegistry({ roots });
    // Without git trigger fired: filtered out (well-known half wins
    // when present).
    expect(assembleMemorySection({ registry, bootContext: makeCtx() }).entryCount).toBe(0);
    // With git fired: loaded.
    expect(assembleMemorySection({ registry, bootContext: makeCtx('git') }).entryCount).toBe(1);
  });

  test('omitted bootContext defaults to empty (only well-known-tagged filtered)', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [GitOps](git-ops.md) — h\n');
    mkdirSync(roots.projectLocal, { recursive: true });
    writeFileSync(
      join(roots.projectLocal, 'git-ops.md'),
      [
        '---',
        'name: git-ops',
        'description: hook for git-ops',
        'type: feedback',
        'source: user_explicit',
        'triggers:',
        '  - git',
        '---',
        '',
        'body',
      ].join('\n'),
    );
    const registry = createMemoryRegistry({ roots });
    // No bootContext arg → EMPTY_BOOT_CONTEXT default.
    const result = assembleMemorySection({ registry });
    expect(result.entryCount).toBe(0);
  });
});

describe('assembleMemorySection — memory_filter (slice 9)', () => {
  // Helper: write a memory body with a typed frontmatter and
  // optional triggers list. The `type` field is required by the
  // frontmatter parser; tests pin it so the filter can exercise
  // the type-vs-trigger branch independently.
  const writeBodyWithTriggers = (
    dir: string,
    name: string,
    type: 'user' | 'feedback' | 'project' | 'reference',
    triggers: string[] = [],
  ): void => {
    mkdirSync(dir, { recursive: true });
    const lines = [
      `name: ${name}`,
      `description: hook for ${name}`,
      `type: ${type}`,
      'source: user_explicit',
    ];
    if (triggers.length > 0) {
      lines.push('triggers:');
      for (const t of triggers) lines.push(`  - ${t}`);
    }
    writeFileSync(join(dir, `${name}.md`), `---\n${lines.join('\n')}\n---\n\nbody of ${name}\n`);
  };

  test('absent filter is a no-op (existing behavior preserved)', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [A](a.md) — h\n- [B](b.md) — h\n');
    writeBodyWithTriggers(roots.projectLocal, 'a', 'feedback');
    writeBodyWithTriggers(roots.projectLocal, 'b', 'project');
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry });
    expect(result.entryCount).toBe(2);
  });

  test('empty filter is treated as absent', () => {
    // Spec PLAYBOOKS.md §1.1: an empty list is "no filter
    // declared" — same effect as omitting the field. Authors
    // who intentionally blank the list want the unfiltered
    // shape, not the strict refuse-everything shape.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [A](a.md) — h\n');
    writeBodyWithTriggers(roots.projectLocal, 'a', 'feedback');
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry, memoryFilter: [] });
    expect(result.entryCount).toBe(1);
  });

  test('keeps entries whose type matches a filter value', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [A](a.md) — h\n- [B](b.md) — h\n- [C](c.md) — h\n');
    writeBodyWithTriggers(roots.projectLocal, 'a', 'feedback');
    writeBodyWithTriggers(roots.projectLocal, 'b', 'project');
    writeBodyWithTriggers(roots.projectLocal, 'c', 'reference');
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry, memoryFilter: ['reference'] });
    // Only `c` (type=reference) survives.
    expect(result.entryCount).toBe(1);
    expect(result.text).toContain('c');
    expect(result.text).not.toContain('— h\n- [A]');
  });

  test('keeps entries whose triggers intersect a filter value', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [A](a.md) — h\n- [B](b.md) — h\n');
    // `a` is feedback with `security` trigger; `b` is feedback
    // with no triggers. Filter ['security'] keeps `a` only.
    writeBodyWithTriggers(roots.projectLocal, 'a', 'feedback', ['security']);
    writeBodyWithTriggers(roots.projectLocal, 'b', 'feedback');
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry, memoryFilter: ['security'] });
    expect(result.entryCount).toBe(1);
    expect(result.text).toContain('a');
  });

  test('a filter value matches BOTH type and trigger axes', () => {
    // The canonical playbook example mixes `reference` (a type
    // value) with `security` / `architecture` (trigger tags).
    // The filter has to walk both axes for each entry rather
    // than picking one — testing the cross-axis fallthrough.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [A](a.md) — h\n- [B](b.md) — h\n- [C](c.md) — h\n');
    writeBodyWithTriggers(roots.projectLocal, 'a', 'reference'); // type match
    writeBodyWithTriggers(roots.projectLocal, 'b', 'feedback', ['security']); // trigger match
    writeBodyWithTriggers(roots.projectLocal, 'c', 'feedback', ['unrelated']); // no match
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({
      registry,
      memoryFilter: ['security', 'reference'],
    });
    expect(result.entryCount).toBe(2);
    expect(result.text).toContain('a');
    expect(result.text).toContain('b');
    expect(result.text).not.toContain('— h\n- [project_local] c');
  });

  test('no entry matches → empty section', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [A](a.md) — h\n');
    writeBodyWithTriggers(roots.projectLocal, 'a', 'feedback');
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry, memoryFilter: ['nonexistent'] });
    expect(result.entryCount).toBe(0);
    expect(result.text).toBe('');
  });
});

describe('assembleMemorySection — eagerLoaded inventory (S1/T1.4)', () => {
  // Helper specifically for these tests: write a body with a
  // specific state. Avoids leaking state-aware setup into every
  // suite above.
  const writeBodyWithState = (
    dir: string,
    name: string,
    state: string | undefined,
    trust: string | undefined,
  ): void => {
    mkdirSync(dir, { recursive: true });
    const lines = [
      `name: ${name}`,
      `description: hook for ${name}`,
      'type: feedback',
      'source: user_explicit',
    ];
    if (state !== undefined) lines.push(`state: ${state}`);
    if (trust !== undefined) lines.push(`trust: ${trust}`);
    writeFileSync(join(dir, `${name}.md`), `---\n${lines.join('\n')}\n---\n\nbody of ${name}\n`);
  };

  test('every rendered entry appears in eagerLoaded with hash + state', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — h\n- [B](b.md) — h\n');
    writeBodyWithState(roots.user, 'a', undefined, undefined); // defaults active
    writeBodyWithState(roots.user, 'b', 'quarantined', undefined);
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry });
    expect(result.entryCount).toBe(2);
    expect(result.eagerLoaded).toHaveLength(2);
    const aEntry = result.eagerLoaded.find((e) => e.name === 'a');
    expect(aEntry?.scope).toBe('user');
    expect(aEntry?.memoryStateAtExposure).toBe('active');
    expect(aEntry?.memoryContentHash).toMatch(/^[0-9a-f]{64}$/);
    const bEntry = result.eagerLoaded.find((e) => e.name === 'b');
    expect(bEntry?.memoryStateAtExposure).toBe('quarantined');
  });

  test('untrusted entries are excluded from eagerLoaded', () => {
    // Same filter that drops the entry from `text` MUST drop it
    // from `eagerLoaded` — keeping it would emit a provenance row
    // for a memory the model never saw.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — h\n- [B](b.md) — h\n');
    writeBodyWithState(roots.user, 'a', undefined, undefined);
    writeBodyWithState(roots.user, 'b', undefined, 'untrusted');
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry });
    expect(result.eagerLoaded.map((e) => e.name)).toEqual(['a']);
  });

  test('dedupe by name applies to eagerLoaded too (one row per name)', () => {
    // Spec: "once per (session, memory)". Two scopes with the
    // same name MUST produce only one eager row — the most-
    // specific scope wins.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Same](same.md) — local\n');
    writeIndex(roots.user, '- [Same](same.md) — user\n');
    writeBodyWithState(roots.projectLocal, 'same', undefined, undefined);
    writeBodyWithState(roots.user, 'same', undefined, undefined);
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry });
    expect(result.entryCount).toBe(1);
    expect(result.eagerLoaded).toHaveLength(1);
    expect(result.eagerLoaded[0]?.scope).toBe('project_local');
  });

  test('empty registry produces empty eagerLoaded', () => {
    const repo = makeTmp();
    const registry = createMemoryRegistry({ roots: makeRoots(repo) });
    const result = assembleMemorySection({ registry });
    expect(result.eagerLoaded).toEqual([]);
  });

  test('peek-uncertainty entry (missing body) still appears with null hash', () => {
    // Index references a body that doesn't exist. The eager section
    // includes it (uncertainty → include); the provenance row must
    // emit too — with NULL hash and the default 'active' state —
    // so the audit trail records that the operator-visible index
    // line DID surface, even when the body was unreadable.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Ghost](ghost.md) — phantom\n');
    // No body file written.
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry });
    expect(result.eagerLoaded).toHaveLength(1);
    expect(result.eagerLoaded[0]?.name).toBe('ghost');
    expect(result.eagerLoaded[0]?.memoryContentHash).toBeNull();
    expect(result.eagerLoaded[0]?.memoryStateAtExposure).toBe('active');
  });

  test('hash is deterministic across two calls on unchanged file', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — h\n');
    writeBodyWithState(roots.user, 'a', undefined, undefined);
    const registry = createMemoryRegistry({ roots });
    const r1 = assembleMemorySection({ registry });
    const r2 = assembleMemorySection({ registry });
    expect(r1.eagerLoaded[0]?.memoryContentHash).toBe(r2.eagerLoaded[0]?.memoryContentHash);
  });
});
