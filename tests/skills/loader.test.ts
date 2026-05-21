import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSkillNames, readSkillByName, scanScope } from '../../src/skills/loader.ts';
import type { SkillScopeRoots } from '../../src/skills/paths.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-skill-loader-'));
  tmpDirs.push(dir);
  return dir;
};

// All three roots are real strings here — the disk-backed tests
// need a concrete `user` dir. The inferred all-string shape is
// still assignable to `SkillScopeRoots` (string ⊆ string | null),
// so it passes straight to the loader functions.
const makeRoots = (repo: string) => ({
  user: join(repo, 'user'),
  projectShared: join(repo, 'shared'),
  projectLocal: join(repo, 'local'),
});

// A well-formed skill document. `desc` defaults short so callers can
// override it only when a test exercises the description rules.
const skillDoc = (name: string, desc = 'A valid skill description.'): string =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\nBody for ${name}.\n`;

// A skill file with structurally-invalid frontmatter — the required
// `description` is missing. The canonical "malformed" fixture.
const brokenDoc = (name: string): string => `---\nname: ${name}\n---\n\nno description\n`;

const writeSkill = (dir: string, name: string, content: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content);
};

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('readSkillByName', () => {
  test('reads and parses a present skill', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.user, 'rename-symbol', skillDoc('rename-symbol'));
    const result = readSkillByName(roots, 'user', 'rename-symbol');
    expect(result.kind).toBe('present');
    if (result.kind === 'present') {
      expect(result.file.frontmatter.name).toBe('rename-symbol');
      expect(result.file.body).toBe('Body for rename-symbol.\n');
    }
  });

  test('returns missing when the file does not exist', () => {
    const roots = makeRoots(makeTmp());
    mkdirSync(roots.user, { recursive: true });
    expect(readSkillByName(roots, 'user', 'absent').kind).toBe('missing');
  });

  test('returns missing when the scope directory does not exist', () => {
    const roots = makeRoots(makeTmp());
    expect(readSkillByName(roots, 'project_shared', 'absent').kind).toBe('missing');
  });

  test('returns malformed for broken frontmatter', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.user, 'broken', brokenDoc('broken'));
    expect(readSkillByName(roots, 'user', 'broken').kind).toBe('malformed');
  });

  test('refuses a symlinked skill file', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    mkdirSync(roots.user, { recursive: true });
    const outside = join(repo, 'outside.md');
    writeFileSync(outside, skillDoc('outside'));
    symlinkSync(outside, join(roots.user, 'evil.md'));
    const result = readSkillByName(roots, 'user', 'evil');
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.error).toContain('symlink');
    }
  });
});

describe('listSkillNames', () => {
  test('returns an empty list for an absent scope directory', () => {
    expect(listSkillNames(makeRoots(makeTmp()), 'user')).toEqual([]);
  });

  test('lists *.md basenames sorted, skipping dotfiles and non-md', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'zebra', skillDoc('zebra'));
    writeSkill(roots.projectShared, 'alpha', skillDoc('alpha'));
    writeFileSync(join(roots.projectShared, 'README.txt'), 'not a skill');
    writeFileSync(join(roots.projectShared, '.hidden.md'), skillDoc('hidden'));
    expect(listSkillNames(roots, 'project_shared')).toEqual(['alpha', 'zebra']);
  });
});

describe('scanScope', () => {
  test('returns present and malformed entries together', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectLocal, 'good', skillDoc('good'));
    writeSkill(roots.projectLocal, 'bad', brokenDoc('bad'));
    const scanned = scanScope(roots, 'project_local');
    expect(scanned.map((s) => s.name)).toEqual(['bad', 'good']);
    expect(scanned.find((s) => s.name === 'good')?.kind).toBe('present');
    expect(scanned.find((s) => s.name === 'bad')?.kind).toBe('malformed');
  });

  test('returns an empty array for an absent scope directory', () => {
    expect(scanScope(makeRoots(makeTmp()), 'user')).toEqual([]);
  });
});

describe('null scope root (homeless env)', () => {
  // `agentConfigDir` returns null with no derivable home, so the
  // user scope can carry a null root. The loader treats it as an
  // empty scope without ever touching disk — projectShared /
  // projectLocal here are never read.
  const homeless: SkillScopeRoots = {
    user: null,
    projectShared: '/nonexistent/shared',
    projectLocal: '/nonexistent/local',
  };

  test('listSkillNames returns [] when the scope root is null', () => {
    expect(listSkillNames(homeless, 'user')).toEqual([]);
  });

  test('readSkillByName returns missing when the scope root is null', () => {
    expect(readSkillByName(homeless, 'user', 'anything').kind).toBe('missing');
  });

  test('scanScope returns [] when the scope root is null', () => {
    expect(scanScope(homeless, 'user')).toEqual([]);
  });
});
