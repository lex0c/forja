import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createSkillCatalog, type SkillScope } from '../../src/skills/index.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { listSkillEventsBySession } from '../../src/storage/repos/skill-events.ts';
import { skillShowTool } from '../../src/tools/builtin/skill-show.ts';
import { isToolError } from '../../src/tools/types.ts';
import {
  brokenDoc,
  cleanupTmpDirs,
  makeRoots,
  makeTmp,
  skillDoc,
  writeSkill,
} from '../skills/_helpers.ts';
import { makeCtx } from './_helpers.ts';

afterEach(cleanupTmpDirs);

describe('skill_show tool', () => {
  test('returns the raw body with no <skill> trust marker', async () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'git-bisect', skillDoc('git-bisect', 'pinpoint a regression'));
    const result = await skillShowTool.execute(
      { name: 'git-bisect' },
      makeCtx({ skillCatalog: createSkillCatalog({ roots }) }),
    );
    expect(isToolError(result)).toBe(false);
    if (isToolError(result)) return;
    expect(result.name).toBe('git-bisect');
    expect(result.scope).toBe('project_shared');
    expect(result.description).toBe('pinpoint a regression');
    expect(result.body).toBe('Body for git-bisect.\n');
    expect(result.body).not.toContain('<skill');
  });

  test('does NOT record an invoked event — show is read-only', async () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'git-bisect', skillDoc('git-bisect'));
    const db = openMemoryDb();
    migrate(db);
    const sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
    const catalog = createSkillCatalog({ roots, db });
    await skillShowTool.execute(
      { name: 'git-bisect' },
      makeCtx({ skillCatalog: catalog, sessionId }),
    );
    expect(listSkillEventsBySession(db, sessionId)).toHaveLength(0);
  });

  test('errors with not_found for an unknown skill', async () => {
    const result = await skillShowTool.execute(
      { name: 'nope' },
      makeCtx({ skillCatalog: createSkillCatalog({ roots: makeRoots(makeTmp()) }) }),
    );
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) expect(result.error_code).toBe('skill.not_found');
  });

  test('errors with malformed for an unparseable skill', async () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'broken', brokenDoc('broken'));
    const result = await skillShowTool.execute(
      { name: 'broken', scope: 'project_shared' },
      makeCtx({ skillCatalog: createSkillCatalog({ roots }) }),
    );
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) expect(result.error_code).toBe('skill.malformed');
  });

  test('errors cleanly when no catalog is wired', async () => {
    const result = await skillShowTool.execute({ name: 'x' }, makeCtx());
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) expect(result.error_code).toBe('skill.catalog_unavailable');
  });

  test('rejects a path-traversal name as invalid_arg', async () => {
    const result = await skillShowTool.execute(
      { name: '../../etc/passwd' },
      makeCtx({ skillCatalog: createSkillCatalog({ roots: makeRoots(makeTmp()) }) }),
    );
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) expect(result.error_code).toBe('tool.invalid_arg');
  });

  test('rejects an unknown scope argument', async () => {
    const result = await skillShowTool.execute(
      { name: 'x', scope: 'bogus' as SkillScope },
      makeCtx({ skillCatalog: createSkillCatalog({ roots: makeRoots(makeTmp()) }) }),
    );
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) expect(result.error_code).toBe('tool.invalid_arg');
  });

  test('returns body_missing when the file was deleted after the catalog scan', async () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'transient', skillDoc('transient'));
    const catalog = createSkillCatalog({ roots });
    rmSync(join(roots.projectShared, 'transient.md'));
    const result = await skillShowTool.execute(
      { name: 'transient' },
      makeCtx({ skillCatalog: catalog }),
    );
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) expect(result.error_code).toBe('skill.body_missing');
  });
});
