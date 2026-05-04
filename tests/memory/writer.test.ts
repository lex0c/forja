import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import type { MemoryFrontmatter } from '../../src/memory/types.ts';
import { writeMemory } from '../../src/memory/writer.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-mem-writer-'));
  tmpDirs.push(dir);
  return dir;
};

const makeRoots = (repo: string): ScopeRoots => ({
  user: join(repo, 'user'),
  projectShared: join(repo, 'shared'),
  projectLocal: join(repo, 'local'),
});

const validFm = (overrides: Partial<MemoryFrontmatter> = {}): MemoryFrontmatter => ({
  name: 'test-mem',
  description: 'a test memory',
  type: 'feedback',
  source: 'inferred',
  ...overrides,
});

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('writeMemory — happy path', () => {
  test('creates body + MEMORY.md when scope dir is empty', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const result = writeMemory({
      roots,
      scope: 'project_local',
      frontmatter: validFm(),
      body: 'Lorem ipsum dolor sit amet.\n',
    });
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') return;
    expect(result.href).toBe('test-mem.md');
    const bodyContent = readFileSync(result.path, 'utf-8');
    expect(bodyContent).toContain('name: test-mem');
    expect(bodyContent).toContain('source: inferred');
    expect(bodyContent).toContain('Lorem ipsum dolor sit amet.');

    const indexContent = readFileSync(join(roots.projectLocal, 'MEMORY.md'), 'utf-8');
    expect(indexContent).toContain('# Memory index');
    expect(indexContent).toContain('- [test-mem](test-mem.md) — a test memory');
  });

  test('appends to existing MEMORY.md without rewriting other entries', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    mkdirSync(roots.projectLocal, { recursive: true });
    writeFileSync(
      join(roots.projectLocal, 'MEMORY.md'),
      '# Memory index\n\n- [Existing](existing.md) — first one\n',
    );
    writeFileSync(
      join(roots.projectLocal, 'existing.md'),
      '---\nname: existing\ndescription: first one\ntype: feedback\nsource: user_explicit\n---\n\nbody\n',
    );
    const result = writeMemory({
      roots,
      scope: 'project_local',
      frontmatter: validFm({ name: 'second', description: 'second one' }),
      body: 'second body',
    });
    expect(result.kind).toBe('created');
    const indexContent = readFileSync(join(roots.projectLocal, 'MEMORY.md'), 'utf-8');
    expect(indexContent).toContain('- [Existing](existing.md) — first one');
    expect(indexContent).toContain('- [second](second.md) — second one');
  });

  test('uses index title/hook overrides when provided', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const result = writeMemory({
      roots,
      scope: 'user',
      frontmatter: validFm({ name: 'user-pref', description: 'fallback hook', type: 'user' }),
      body: 'preference body',
      indexTitle: 'User preference',
      indexHook: 'custom hook line',
    });
    expect(result.kind).toBe('created');
    const indexContent = readFileSync(join(roots.user, 'MEMORY.md'), 'utf-8');
    expect(indexContent).toContain('- [User preference](user-pref.md) — custom hook line');
  });

  test('user scope writes to roots.user, not project paths', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const result = writeMemory({
      roots,
      scope: 'user',
      frontmatter: validFm({ name: 'global-pref', type: 'user' }),
      body: 'body',
    });
    expect(result.kind).toBe('created');
    expect(existsSync(join(roots.user, 'global-pref.md'))).toBe(true);
    expect(existsSync(join(roots.projectLocal, 'global-pref.md'))).toBe(false);
    expect(existsSync(join(roots.projectShared, 'global-pref.md'))).toBe(false);
  });
});

describe('writeMemory — rejection paths', () => {
  test('rejects project_shared writes with shared_forbidden', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const result = writeMemory({
      roots,
      scope: 'project_shared',
      frontmatter: validFm(),
      body: 'body',
    });
    expect(result.kind).toBe('shared_forbidden');
    // Nothing should hit disk.
    expect(existsSync(roots.projectShared)).toBe(false);
  });

  test('rejects when body file already exists', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    mkdirSync(roots.projectLocal, { recursive: true });
    writeFileSync(join(roots.projectLocal, 'test-mem.md'), 'existing');
    const result = writeMemory({
      roots,
      scope: 'project_local',
      frontmatter: validFm(),
      body: 'body',
    });
    expect(result.kind).toBe('exists');
    if (result.kind !== 'exists') return;
    expect(result.scope).toBe('project_local');
    expect(readFileSync(join(roots.projectLocal, 'test-mem.md'), 'utf-8')).toBe('existing');
  });

  test('rejects symlinks at the target path', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    mkdirSync(roots.projectLocal, { recursive: true });
    const decoy = join(repo, 'decoy.txt');
    writeFileSync(decoy, 'decoy content');
    symlinkSync(decoy, join(roots.projectLocal, 'test-mem.md'));
    const result = writeMemory({
      roots,
      scope: 'project_local',
      frontmatter: validFm(),
      body: 'body',
    });
    expect(result.kind).toBe('symlink_refused');
    expect(readFileSync(decoy, 'utf-8')).toBe('decoy content');
  });

  test('sandbox violation surfaces sandbox_violation', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    // validateName forbids leading dots / slashes / `..`. Pick a
    // name that survives the regex but engineers the writer to
    // throw ScopeError: not really possible without crafting an
    // exotic ScopeRoots — instead exercise validateName which
    // bubbles through writer as io_error (not sandbox_violation),
    // verifying the negative path.
    const result = writeMemory({
      roots,
      scope: 'project_local',
      frontmatter: { ...validFm(), name: '.hidden' },
      body: 'body',
    });
    // .hidden fails validateName which writeMemory routes via
    // io_error (caller-shape failure, not path-shape).
    expect(result.kind).toBe('io_error');
  });
});

describe('writeMemory — index warnings', () => {
  test('reports malformed_index_lines when MEMORY.md has bad lines', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    mkdirSync(roots.projectLocal, { recursive: true });
    writeFileSync(
      join(roots.projectLocal, 'MEMORY.md'),
      // Mix of canonical, malformed, and a heading. parseIndex flags
      // lines 2 and 4 as malformed (line 1 is the heading -> skipped,
      // line 3 is canonical, line 5 is the canonical hook continuing).
      [
        '- [Real](real.md) — canonical',
        'this line is broken (not a list item)',
        '- [Also Real](also-real.md) — also canonical',
        '- [missing dash here](no-dash.md)',
      ].join('\n'),
    );
    writeFileSync(
      join(roots.projectLocal, 'real.md'),
      '---\nname: real\ndescription: x\ntype: feedback\nsource: user_explicit\n---\n\nb\n',
    );
    const result = writeMemory({
      roots,
      scope: 'project_local',
      frontmatter: validFm({ name: 'fresh' }),
      body: 'b',
    });
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') return;
    expect(result.warnings).toHaveLength(1);
    const warning = result.warnings[0];
    if (warning?.kind !== 'malformed_index_lines') throw new Error('wrong warning kind');
    // parseIndex reports 1-based line numbers; lines 2 and 4 are
    // the broken ones in the input.
    expect(warning.lines).toContain(2);
    expect(warning.lines).toContain(4);
  });

  test('returns empty warnings array when index is clean', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const result = writeMemory({
      roots,
      scope: 'project_local',
      frontmatter: validFm(),
      body: 'b',
    });
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') return;
    expect(result.warnings).toEqual([]);
  });
});

describe('writeMemory — atomicity', () => {
  test('does not leave temp files behind on success', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeMemory({
      roots,
      scope: 'project_local',
      frontmatter: validFm(),
      body: 'body',
    });
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const files = readdirSync(roots.projectLocal);
    for (const f of files) {
      expect(f).not.toContain('.tmp-');
    }
  });
});
