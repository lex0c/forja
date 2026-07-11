import { afterEach, describe, expect, test } from 'bun:test';
import { assembleSkillCatalogSection } from '../../src/cli/skills-prompt.ts';
import { createSkillCatalog } from '../../src/skills/index.ts';
import { cleanupTmpDirs, makeRoots, makeTmp, skillDoc, writeSkill } from '../skills/_helpers.ts';

afterEach(cleanupTmpDirs);

describe('assembleSkillCatalogSection', () => {
  test('an empty catalog yields an empty section', () => {
    expect(assembleSkillCatalogSection(createSkillCatalog({ roots: makeRoots(makeTmp()) }))).toBe(
      '',
    );
  });

  test('renders one line per skill — scope, name, description — sorted by name', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'git-bisect', skillDoc('git-bisect', 'pinpoint a regression'));
    writeSkill(roots.user, 'commit-style', skillDoc('commit-style', 'personal commit flow'));
    const section = assembleSkillCatalogSection(createSkillCatalog({ roots }));
    expect(section).toContain('# Skills');
    expect(section).toContain('skill_invoke');
    const lines = section.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toEqual([
      '- [user] commit-style — personal commit flow',
      '- [project_shared] git-bisect — pinpoint a regression',
    ]);
  });

  test('preserves backticks in a description (line-sanitized, not code-span-mangled)', () => {
    // Description is author-controlled and rendered into the system prompt; it is
    // sanitized for injection (newline/control) but NOT through the code-span
    // sanitizer, so a legitimate `code` reference must survive. A regression to
    // sanitizeForCodeSpan would turn the backticks into apostrophes.
    const roots = makeRoots(makeTmp());
    writeSkill(roots.user, 'grep-tips', skillDoc('grep-tips', 'use `grep -n` to find lines'));
    const section = assembleSkillCatalogSection(createSkillCatalog({ roots }));
    expect(section).toContain('- [user] grep-tips — use `grep -n` to find lines');
  });

  test('a shadowed skill does not appear — only resolved winners render', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.user, 'deploy', skillDoc('deploy', 'user version'));
    writeSkill(roots.projectLocal, 'deploy', skillDoc('deploy', 'local version'));
    const section = assembleSkillCatalogSection(createSkillCatalog({ roots }));
    const lines = section.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toEqual(['- [project_local] deploy — local version']);
  });
});
