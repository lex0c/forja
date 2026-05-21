// /skill slash command tests (spec SKILLS.md §6).

import { afterEach, describe, expect, test } from 'bun:test';
import { skillCommand } from '../../../src/cli/slash/commands/skill.ts';
import type { SlashContext } from '../../../src/cli/slash/types.ts';
import { type SkillCatalog, createSkillCatalog } from '../../../src/skills/index.ts';
import {
  brokenDoc,
  cleanupTmpDirs,
  makeRoots,
  makeTmp,
  skillDoc,
  writeSkill,
} from '../../skills/_helpers.ts';

afterEach(cleanupTmpDirs);

// The command reads only `ctx.baseConfig.skillCatalog`; the rest of
// SlashContext is irrelevant to its behavior, so the test ctx is a
// minimal cast carrying just that.
const makeCtx = (catalog?: SkillCatalog): SlashContext =>
  ({ baseConfig: { skillCatalog: catalog } }) as unknown as SlashContext;

describe('/skill', () => {
  test('list reports the resolved catalog', async () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'git-bisect', skillDoc('git-bisect', 'pinpoint a regression'));
    const result = await skillCommand.exec(['list'], makeCtx(createSkillCatalog({ roots })));
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.notes?.some((l) => l.includes('git-bisect'))).toBe(true);
  });

  test('list reports files that failed to load', async () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'broken', brokenDoc('broken'));
    const result = await skillCommand.exec(['list'], makeCtx(createSkillCatalog({ roots })));
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.notes?.some((l) => l.includes('not loaded'))).toBe(true);
    expect(result.notes?.some((l) => l.includes('broken'))).toBe(true);
  });

  test('show prints a skill body', async () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'git-bisect', skillDoc('git-bisect'));
    const result = await skillCommand.exec(
      ['show', 'git-bisect'],
      makeCtx(createSkillCatalog({ roots })),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.notes?.some((l) => l.includes('Body for git-bisect'))).toBe(true);
  });

  test('show errors on an unknown skill', async () => {
    const result = await skillCommand.exec(
      ['show', 'nope'],
      makeCtx(createSkillCatalog({ roots: makeRoots(makeTmp()) })),
    );
    expect(result.kind).toBe('error');
  });

  test('new scaffolds a project_local skill the catalog then resolves', async () => {
    const catalog = createSkillCatalog({ roots: makeRoots(makeTmp()) });
    const result = await skillCommand.exec(['new', 'deploy-check'], makeCtx(catalog));
    expect(result.kind).toBe('ok');
    expect(catalog.lookup('deploy-check')?.scope).toBe('project_local');
  });

  test('promote shared moves a project_local skill to project_shared', async () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectLocal, 'deploy', skillDoc('deploy'));
    const catalog = createSkillCatalog({ roots });
    const result = await skillCommand.exec(['promote', 'shared', 'deploy'], makeCtx(catalog));
    expect(result.kind).toBe('ok');
    expect(catalog.lookup('deploy')?.scope).toBe('project_shared');
  });

  test('promote user only prompts without --confirm, then moves with it', async () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectLocal, 'deploy', skillDoc('deploy'));
    const catalog = createSkillCatalog({ roots });
    const prompt = await skillCommand.exec(['promote', 'user', 'deploy'], makeCtx(catalog));
    expect(prompt.kind).toBe('ok');
    if (prompt.kind === 'ok') {
      expect(prompt.notes?.some((l) => l.includes('--confirm'))).toBe(true);
    }
    expect(catalog.lookup('deploy')?.scope).toBe('project_local');
    const done = await skillCommand.exec(
      ['promote', 'user', 'deploy', '--confirm'],
      makeCtx(catalog),
    );
    expect(done.kind).toBe('ok');
    expect(catalog.lookup('deploy')?.scope).toBe('user');
  });

  test('demote local moves a project_shared skill to project_local', async () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'deploy', skillDoc('deploy'));
    const catalog = createSkillCatalog({ roots });
    const result = await skillCommand.exec(['demote', 'local', 'deploy'], makeCtx(catalog));
    expect(result.kind).toBe('ok');
    expect(catalog.lookup('deploy')?.scope).toBe('project_local');
  });

  test('delete only prompts without --confirm, then removes with it', async () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'old', skillDoc('old'));
    const catalog = createSkillCatalog({ roots });
    const prompt = await skillCommand.exec(['delete', 'old'], makeCtx(catalog));
    expect(prompt.kind).toBe('ok');
    if (prompt.kind === 'ok') {
      expect(prompt.notes?.some((l) => l.includes('--confirm'))).toBe(true);
    }
    expect(catalog.lookup('old')).not.toBeNull();
    const done = await skillCommand.exec(['delete', 'old', '--confirm'], makeCtx(catalog));
    expect(done.kind).toBe('ok');
    expect(catalog.lookup('old')).toBeNull();
  });

  test('delete accepts --confirm in any position', async () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'old', skillDoc('old'));
    const catalog = createSkillCatalog({ roots });
    const done = await skillCommand.exec(['delete', '--confirm', 'old'], makeCtx(catalog));
    expect(done.kind).toBe('ok');
    expect(catalog.lookup('old')).toBeNull();
  });

  test('delete removes a malformed skill the catalog filtered out', async () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'broken', brokenDoc('broken'));
    const catalog = createSkillCatalog({ roots });
    // The broken file is filtered, not a resolved winner — but
    // /skill list surfaces it, so delete must reach it.
    expect(catalog.lookup('broken')).toBeNull();
    expect(catalog.filtered().some((f) => f.name === 'broken')).toBe(true);
    const result = await skillCommand.exec(['delete', 'broken', '--confirm'], makeCtx(catalog));
    expect(result.kind).toBe('ok');
    expect(catalog.filtered().some((f) => f.name === 'broken')).toBe(false);
  });

  test('delete disambiguates by scope when a name is in more than one', async () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectLocal, 'dup', skillDoc('dup'));
    writeSkill(roots.user, 'dup', skillDoc('dup'));
    const catalog = createSkillCatalog({ roots });
    const ambiguous = await skillCommand.exec(['delete', 'dup', '--confirm'], makeCtx(catalog));
    expect(ambiguous.kind).toBe('error');
    const done = await skillCommand.exec(['delete', 'dup', 'user', '--confirm'], makeCtx(catalog));
    expect(done.kind).toBe('ok');
    expect(catalog.lookup('dup')?.scope).toBe('project_local');
  });

  test('delete removes a file whose filename is not kebab-case', async () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'Upper', skillDoc('upper'));
    const catalog = createSkillCatalog({ roots });
    // A non-kebab filename is filtered (malformed) and surfaced by
    // /skill list — delete must reach it.
    expect(catalog.filtered().some((f) => f.name === 'Upper')).toBe(true);
    const result = await skillCommand.exec(['delete', 'Upper', '--confirm'], makeCtx(catalog));
    expect(result.kind).toBe('ok');
    expect(catalog.filtered().some((f) => f.name === 'Upper')).toBe(false);
  });

  test('rejects an unknown subcommand', async () => {
    const result = await skillCommand.exec(
      ['frobnicate'],
      makeCtx(createSkillCatalog({ roots: makeRoots(makeTmp()) })),
    );
    expect(result.kind).toBe('error');
  });

  test('errors cleanly when no catalog is wired', async () => {
    const result = await skillCommand.exec(['list'], makeCtx(undefined));
    expect(result.kind).toBe('error');
  });
});
