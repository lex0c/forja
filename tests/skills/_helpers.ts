import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Shared fixtures for the skills test suite. Each test file wires
// `afterEach(cleanupTmpDirs)` to drop the tmpdirs it created.

const tmpDirs: string[] = [];

// Create a throwaway tmpdir, tracked for `cleanupTmpDirs`.
export const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-skills-'));
  tmpDirs.push(dir);
  return dir;
};

// Drop every tmpdir created since the last cleanup. Wire as
// `afterEach(cleanupTmpDirs)` so each test cleans up its own dirs.
export const cleanupTmpDirs = (): void => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
};

// Scope roots under `repo` — all three concrete strings (disk-backed
// tests need a real `user` dir). The inferred all-string shape is
// assignable to `SkillScopeRoots` (string ⊆ string | null).
export const makeRoots = (repo: string) => ({
  user: join(repo, 'user'),
  projectShared: join(repo, 'shared'),
  projectLocal: join(repo, 'local'),
});

// A well-formed skill document.
export const skillDoc = (name: string, desc = `Procedure for ${name}.`): string =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\nBody for ${name}.\n`;

// A skill document with invalid frontmatter — the required
// `description` is missing. The canonical "malformed" fixture.
export const brokenDoc = (name: string): string => `---\nname: ${name}\n---\n\nno description\n`;

// Write `<name>.md` into `dir`, creating `dir` if needed.
export const writeSkill = (dir: string, name: string, content: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content);
};
