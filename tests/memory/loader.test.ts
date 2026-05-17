import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  test('refuses symlinked MEMORY.md as malformed (S5 review)', () => {
    // Trust-attestation symmetry: trust-corpus.ts's
    // `listSharedCorpusFiles` excludes symlinks from the
    // fingerprint inventory. Without the loader-side mirror, an
    // attacker who symlinks project_shared/MEMORY.md to an
    // out-of-scope file would change the corpus the model sees
    // (the symlinked index can declare arbitrary in-scope bodies
    // to load) while leaving the trust hash unchanged. The loader
    // must reject symlinked indexes for the gate to hold.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const repo = makeTmp();
    const roots = makeRoots(repo);
    mkdirSync(roots.projectShared, { recursive: true });
    const targetPath = join(repo, 'attacker-index.md');
    writeFileSync(targetPath, '- [Evil](evil.md) — fortress\n');
    symlinkSync(targetPath, join(roots.projectShared, 'MEMORY.md'));
    const result = loadScopeIndex(roots, 'project_shared');
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.error).toContain('symlink');
    }
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

  test('refuses a symlinked body file as malformed (S5 review)', () => {
    // Pre-fix: readFileSync would follow the symlink and return
    // the target's bytes; the shared-corpus fingerprint already
    // excludes symlinks at the listing layer, so the trust hash
    // would stay constant across boots while the model silently
    // saw attacker-target content. Loader-side rejection closes
    // the asymmetry: same file is now treated as malformed at
    // load time too, matching the modal inventory.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const repo = makeTmp();
    const roots = makeRoots(repo);
    mkdirSync(roots.user, { recursive: true });
    // Real "target" the symlink points at — could be any file the
    // agent's UID can read. We use a tmp file with deliberately
    // recognizable bytes so a regression that reads the target
    // surfaces clearly.
    const targetPath = join(repo, 'attacker-secret.md');
    writeFileSync(
      targetPath,
      '---\nname: stolen\ndescription: stolen secret\ntype: feedback\nsource: user_explicit\n---\n\nATTACKER_PAYLOAD\n',
    );
    symlinkSync(targetPath, join(roots.user, 'evil.md'));
    const result = readMemoryByName(roots, 'user', 'evil');
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.error).toContain('symlink');
      // The attacker's body content MUST NOT appear in the result.
      // Pre-fix it would have parsed and returned as kind:'present'.
      expect(JSON.stringify(result)).not.toContain('ATTACKER_PAYLOAD');
    }
  });

  test('refuses a non-regular .md path (directory named foo.md) as malformed', () => {
    // Defense-in-depth: an operator typo or attacker plant could
    // produce `foo.md/` as a directory in the scope root. The
    // pre-read regular-file check rejects it cleanly so the loader
    // never blocks or returns garbage from readFileSync on a
    // non-regular inode.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    mkdirSync(roots.user, { recursive: true });
    mkdirSync(join(roots.user, 'weird.md'));
    const result = readMemoryByName(roots, 'user', 'weird');
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.error).toContain('regular');
    }
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
