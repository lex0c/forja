import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
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

  test('re-scans disk: a skill added mid-session (outside /skill) appears', async () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'first', skillDoc('first'));
    const catalog = createSkillCatalog({ roots });
    const ctx = makeCtx({ skillCatalog: catalog });

    const before = await skillListTool.execute({}, ctx);
    expect(isToolError(before)).toBe(false);
    if (isToolError(before)) return;
    expect(before.skills.map((s) => s.name)).toEqual(['first']);

    // Operator hand-adds a skill after the catalog was built, without
    // going through the /skill command (which would reload).
    writeSkill(roots.projectLocal, 'second', skillDoc('second', 'added mid-session'));

    const after = await skillListTool.execute({}, ctx);
    expect(isToolError(after)).toBe(false);
    if (isToolError(after)) return;
    expect(after.skills.map((s) => s.name)).toEqual(['first', 'second']);
    expect(after.skills.find((s) => s.name === 'second')?.description).toBe('added mid-session');
  });

  test('re-scans disk: an edited description and a removed skill are reflected', async () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'keep', skillDoc('keep', 'original description'));
    writeSkill(roots.projectShared, 'gone', skillDoc('gone'));
    const catalog = createSkillCatalog({ roots });
    const ctx = makeCtx({ skillCatalog: catalog });

    // Edit one description, delete the other — both out-of-band.
    writeSkill(roots.projectShared, 'keep', skillDoc('keep', 'edited description'));
    rmSync(join(roots.projectShared, 'gone.md'));

    const result = await skillListTool.execute({}, ctx);
    expect(isToolError(result)).toBe(false);
    if (isToolError(result)) return;
    expect(result.skills.map((s) => s.name)).toEqual(['keep']);
    expect(result.skills[0]?.description).toBe('edited description');
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
