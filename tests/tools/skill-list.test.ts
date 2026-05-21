import { afterEach, describe, expect, test } from 'bun:test';
import { createSkillCatalog } from '../../src/skills/index.ts';
import type { SkillScope } from '../../src/skills/index.ts';
import { skillListTool } from '../../src/tools/builtin/skill-list.ts';
import { isToolError } from '../../src/tools/types.ts';
import { cleanupTmpDirs, makeRoots, makeTmp, skillDoc, writeSkill } from '../skills/_helpers.ts';
import { makeCtx } from './_helpers.ts';

afterEach(cleanupTmpDirs);

describe('skill_list tool', () => {
  test('lists the resolved catalog — name, description, scope — sorted by name', async () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'git-bisect', skillDoc('git-bisect', 'pinpoint a regression'));
    writeSkill(roots.user, 'commit-style', skillDoc('commit-style', 'personal commit flow'));
    const result = await skillListTool.execute(
      {},
      makeCtx({ skillCatalog: createSkillCatalog({ roots }) }),
    );
    expect(isToolError(result)).toBe(false);
    if (isToolError(result)) return;
    expect(result.skills.map((s) => s.name)).toEqual(['commit-style', 'git-bisect']);
    expect(result.count).toBe(2);
    const bisect = result.skills.find((s) => s.name === 'git-bisect');
    expect(bisect?.scope).toBe('project_shared');
    expect(bisect?.description).toBe('pinpoint a regression');
  });

  test('the scope filter keeps only skills resolved to that scope', async () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'shared-one', skillDoc('shared-one'));
    writeSkill(roots.user, 'user-one', skillDoc('user-one'));
    const result = await skillListTool.execute(
      { scope: 'user' },
      makeCtx({ skillCatalog: createSkillCatalog({ roots }) }),
    );
    expect(isToolError(result)).toBe(false);
    if (isToolError(result)) return;
    expect(result.skills.map((s) => s.name)).toEqual(['user-one']);
  });

  test('an empty catalog yields an empty list', async () => {
    const result = await skillListTool.execute(
      {},
      makeCtx({ skillCatalog: createSkillCatalog({ roots: makeRoots(makeTmp()) }) }),
    );
    expect(isToolError(result)).toBe(false);
    if (isToolError(result)) return;
    expect(result.count).toBe(0);
  });

  test('errors cleanly when no catalog is wired', async () => {
    const result = await skillListTool.execute({}, makeCtx());
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) expect(result.error_code).toBe('skill.catalog_unavailable');
  });

  test('rejects an unknown scope argument', async () => {
    const result = await skillListTool.execute(
      { scope: 'bogus' as SkillScope },
      makeCtx({ skillCatalog: createSkillCatalog({ roots: makeRoots(makeTmp()) }) }),
    );
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) expect(result.error_code).toBe('tool.invalid_arg');
  });
});
