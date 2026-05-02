import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listOrphanFiles,
  loadScopeIndex,
  memoryNameFromPath,
  readMemoryByName,
} from '../../src/memory/loader.ts';
import type { ScopeRoots } from '../../src/memory/paths.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-mem-loader-'));
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

const writeMemory = (dir: string, name: string, frontmatter: string, body: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}---\n\n${body}`);
};

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadScopeIndex', () => {
  test('returns absent when scope dir does not exist', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const result = loadScopeIndex(roots, 'user');
    expect(result.kind).toBe('absent');
  });

  test('returns absent when MEMORY.md does not exist but dir does', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    mkdirSync(roots.user, { recursive: true });
    expect(loadScopeIndex(roots, 'user').kind).toBe('absent');
  });

  test('returns parsed entries when index exists', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Role](role.md) — full-stack TS\n');
    const result = loadScopeIndex(roots, 'user');
    if (result.kind !== 'present') {
      throw new Error(`expected present, got ${result.kind}`);
    }
    expect(result.index.entries).toEqual([
      { title: 'Role', href: 'role.md', hook: 'full-stack TS' },
    ]);
  });
});

describe('readMemoryByName', () => {
  test('returns missing when file does not exist', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const result = readMemoryByName(roots, 'user', 'role');
    expect(result.kind).toBe('missing');
  });

  test('returns parsed file when present', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeMemory(
      roots.user,
      'role',
      'name: role\ndescription: full-stack\ntype: user\nsource: user_explicit\n',
      'Body content here.\n',
    );
    const result = readMemoryByName(roots, 'user', 'role');
    if (result.kind !== 'present') {
      throw new Error(`expected present, got ${result.kind}`);
    }
    expect(result.file.frontmatter.name).toBe('role');
    expect(result.file.body).toBe('Body content here.\n');
  });

  test('returns malformed when frontmatter is invalid', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeMemory(
      roots.user,
      'broken',
      'name: x\ndescription: y\ntype: bogus\nsource: user_explicit\n',
      'body',
    );
    const result = readMemoryByName(roots, 'user', 'broken');
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.error).toMatch(/type/);
    }
  });

  test('throws on invalid memory name (sandbox)', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    expect(() => readMemoryByName(roots, 'user', '../escape')).toThrow();
    expect(() => readMemoryByName(roots, 'user', 'has/slash')).toThrow();
  });
});

describe('listOrphanFiles', () => {
  test('returns empty when scope dir absent', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    expect(listOrphanFiles(roots, 'user')).toEqual([]);
  });

  test('returns empty when only indexed files exist', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — A\n- [B](b.md) — B\n');
    writeMemory(
      roots.user,
      'a',
      'name: a\ndescription: a\ntype: user\nsource: user_explicit\n',
      '',
    );
    writeMemory(
      roots.user,
      'b',
      'name: b\ndescription: b\ntype: user\nsource: user_explicit\n',
      '',
    );
    expect(listOrphanFiles(roots, 'user')).toEqual([]);
  });

  test('reports .md files not in index', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — A\n');
    writeMemory(
      roots.user,
      'a',
      'name: a\ndescription: a\ntype: user\nsource: user_explicit\n',
      '',
    );
    writeMemory(
      roots.user,
      'orphan',
      'name: orphan\ndescription: o\ntype: user\nsource: user_explicit\n',
      '',
    );
    const orphans = listOrphanFiles(roots, 'user');
    expect(orphans).toEqual([join(roots.user, 'orphan.md')]);
  });

  test('excludes MEMORY.md and dotfiles', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '');
    writeFileSync(join(roots.user, '.hidden.md'), '');
    writeFileSync(join(roots.user, 'README.md'), 'docs');
    const orphans = listOrphanFiles(roots, 'user');
    expect(orphans).toEqual([join(roots.user, 'README.md')]);
  });

  test('ignores subdirectories', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    mkdirSync(roots.user, { recursive: true });
    mkdirSync(join(roots.user, 'subdir'), { recursive: true });
    writeFileSync(join(roots.user, 'subdir', 'nested.md'), '');
    expect(listOrphanFiles(roots, 'user')).toEqual([]);
  });
});

describe('memoryNameFromPath', () => {
  test('strips .md suffix', () => {
    expect(memoryNameFromPath('/x/y/role.md')).toBe('role');
    expect(memoryNameFromPath('role.md')).toBe('role');
  });

  test('throws when file does not end in .md', () => {
    expect(() => memoryNameFromPath('/x/y/role.txt')).toThrow();
  });
});
