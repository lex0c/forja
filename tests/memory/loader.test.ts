import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listOrphanFiles,
  listSeedOrphanFiles,
  loadScopeIndex,
  loadSeedsIndex,
  memoryNameFromPath,
  readMemoryByName,
  readSeedByName,
} from '../../src/memory/loader.ts';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { seedsRoot } from '../../src/memory/paths.ts';

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

  test('excludes a directory whose name ends in .md (operator typo / attacker plant)', () => {
    // A directory entry like `weird.md/` would pass a name-shape
    // filter that doesn't check the dirent type — the orphan list
    // would then carry a phantom path that isn't a file. Downstream
    // gc/audit callers acting on the list (rm, move, format) would
    // see a non-regular inode where they expected a body file.
    // The withFileTypes filter rejects this at the source.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    mkdirSync(roots.user, { recursive: true });
    mkdirSync(join(roots.user, 'weird.md'));
    expect(listOrphanFiles(roots, 'user')).toEqual([]);
  });

  test('excludes a symlinked .md entry from the orphan list (S5 parity)', () => {
    // The loader's S5 gate refuses symlinked bodies at READ time
    // (readMemoryAt → checkRegularFile). The orphan walker should
    // match that posture: a symlinked entry is not a "real" file
    // and shouldn't be advertised as an orphan body that gc could
    // safely act on.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const repo = makeTmp();
    const roots = makeRoots(repo);
    mkdirSync(roots.user, { recursive: true });
    const targetPath = join(repo, 'target.md');
    writeFileSync(
      targetPath,
      '---\nname: t\ndescription: t\ntype: user\nsource: user_explicit\n---\n',
    );
    symlinkSync(targetPath, join(roots.user, 'linked.md'));
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

describe('loadSeedsIndex (spec §5.7.4)', () => {
  test('returns absent when seeds/ dir does not exist', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    expect(loadSeedsIndex(roots).kind).toBe('absent');
  });

  test('returns absent when seeds/ exists but MEMORY.md missing', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    mkdirSync(seedsRoot(roots), { recursive: true });
    expect(loadSeedsIndex(roots).kind).toBe('absent');
  });

  test('returns parsed entries when seeds/MEMORY.md exists', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(seedsRoot(roots), '- [Safe edit](safe-edit-discipline.md) — ler antes de Edit\n');
    const result = loadSeedsIndex(roots);
    if (result.kind !== 'present') {
      throw new Error(`expected present, got ${result.kind}`);
    }
    expect(result.index.entries).toEqual([
      { title: 'Safe edit', href: 'safe-edit-discipline.md', hook: 'ler antes de Edit' },
    ]);
  });

  test('refuses symlinked seeds/MEMORY.md (mirrors loadScopeIndex S5 gate)', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const repo = makeTmp();
    const roots = makeRoots(repo);
    mkdirSync(seedsRoot(roots), { recursive: true });
    const targetPath = join(repo, 'attacker-seed-index.md');
    writeFileSync(targetPath, '- [Evil](evil.md) — fortress\n');
    symlinkSync(targetPath, join(seedsRoot(roots), 'MEMORY.md'));
    const result = loadSeedsIndex(roots);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.error).toContain('symlink');
    }
  });
});

describe('readSeedByName (spec §5.7.4)', () => {
  const seedFrontmatter =
    'name: safe-edit-discipline\n' +
    'description: ler antes de Edit; Edit em existente\n' +
    'type: feedback\n' +
    'source: seed\n' +
    'seed_origin: vendor\n' +
    'seed_version: "1.0"\n';

  test('returns missing when seed file does not exist', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    expect(readSeedByName(roots, 'safe-edit-discipline').kind).toBe('missing');
  });

  test('returns parsed seed when present', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeMemory(seedsRoot(roots), 'safe-edit-discipline', seedFrontmatter, 'Body line.\n');
    const result = readSeedByName(roots, 'safe-edit-discipline');
    if (result.kind !== 'present') {
      throw new Error(`expected present, got ${result.kind}`);
    }
    expect(result.file.frontmatter.source).toBe('seed');
    expect(result.file.frontmatter.seed_origin).toBe('vendor');
    expect(result.file.frontmatter.seed_version).toBe('1.0');
  });

  test('returns malformed on bad frontmatter', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeMemory(
      seedsRoot(roots),
      'bad',
      // source=seed without seed_origin/seed_version → cross-field error
      'name: bad\ndescription: x\ntype: feedback\nsource: seed\n',
      'body',
    );
    const result = readSeedByName(roots, 'bad');
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.error).toMatch(/seed_origin|seed_version/);
    }
  });

  test('throws on path traversal name (sandbox)', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    expect(() => readSeedByName(roots, '../escape')).toThrow();
    expect(() => readSeedByName(roots, 'has/slash')).toThrow();
  });

  test('refuses symlinked seed body (S5 gate parity)', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const repo = makeTmp();
    const roots = makeRoots(repo);
    mkdirSync(seedsRoot(roots), { recursive: true });
    const targetPath = join(repo, 'attacker-seed-body.md');
    writeFileSync(targetPath, `---\n${seedFrontmatter}---\n\nATTACKER_SEED_PAYLOAD\n`);
    symlinkSync(targetPath, join(seedsRoot(roots), 'evil.md'));
    const result = readSeedByName(roots, 'evil');
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.error).toContain('symlink');
      expect(JSON.stringify(result)).not.toContain('ATTACKER_SEED_PAYLOAD');
    }
  });
});

describe('listSeedOrphanFiles (spec §5.7.4)', () => {
  const seedFrontmatter = (name: string): string =>
    `name: ${name}\ndescription: x\ntype: feedback\nsource: seed\nseed_origin: vendor\nseed_version: "1.0"\n`;

  test('returns empty when seeds dir absent', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    expect(listSeedOrphanFiles(roots)).toEqual([]);
  });

  test('returns empty when all seeds are indexed', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(seedsRoot(roots), '- [A](a.md) — a\n');
    writeMemory(seedsRoot(roots), 'a', seedFrontmatter('a'), '');
    expect(listSeedOrphanFiles(roots)).toEqual([]);
  });

  test('reports orphan seeds not in seeds/MEMORY.md', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(seedsRoot(roots), '- [A](a.md) — a\n');
    writeMemory(seedsRoot(roots), 'a', seedFrontmatter('a'), '');
    writeMemory(seedsRoot(roots), 'orphan', seedFrontmatter('orphan'), '');
    expect(listSeedOrphanFiles(roots)).toEqual([join(seedsRoot(roots), 'orphan.md')]);
  });

  test('does not see seeds when only the top-level user scope has files', () => {
    // Regression guard: listSeedOrphanFiles must read the seeds/
    // subdir, not the user-scope root. If it accidentally read the
    // parent, hand-authored user memories would show up as "seed
    // orphans" — completely wrong attribution.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeMemory(
      roots.user,
      'role',
      'name: role\ndescription: y\ntype: user\nsource: user_explicit\n',
      '',
    );
    expect(listSeedOrphanFiles(roots)).toEqual([]);
  });

  test('excludes a directory named <name>.md inside seeds/ (parity with listOrphanFiles)', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    mkdirSync(seedsRoot(roots), { recursive: true });
    mkdirSync(join(seedsRoot(roots), 'weird.md'));
    expect(listSeedOrphanFiles(roots)).toEqual([]);
  });
});
