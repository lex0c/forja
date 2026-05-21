import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createSkillCatalog } from '../../src/skills/catalog.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { listSkillEventsBySession } from '../../src/storage/repos/skill-events.ts';
import { brokenDoc, cleanupTmpDirs, makeRoots, makeTmp, skillDoc, writeSkill } from './_helpers.ts';

afterEach(cleanupTmpDirs);

describe('createSkillCatalog — collection', () => {
  test('an empty workspace yields an empty catalog', () => {
    const catalog = createSkillCatalog({ roots: makeRoots(makeTmp()) });
    expect(catalog.list()).toEqual([]);
    expect(catalog.count()).toBe(0);
    expect(catalog.filtered()).toEqual([]);
  });

  test('list() returns entries sorted by name; list(scope) filters by scope', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'zulu', skillDoc('zulu'));
    writeSkill(roots.projectShared, 'alpha', skillDoc('alpha'));
    writeSkill(roots.user, 'mike', skillDoc('mike'));
    const catalog = createSkillCatalog({ roots });
    expect(catalog.list().map((e) => e.name)).toEqual(['alpha', 'mike', 'zulu']);
    expect(catalog.list('user').map((e) => e.name)).toEqual(['mike']);
    expect(catalog.count()).toBe(3);
  });

  test('lookup() returns the resolved entry or null', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.user, 'known', skillDoc('known'));
    const catalog = createSkillCatalog({ roots });
    expect(catalog.lookup('known')?.scope).toBe('user');
    expect(catalog.lookup('unknown')).toBeNull();
  });
});

describe('createSkillCatalog — resolution', () => {
  test('resolves a name conflict by precedence: local > shared > user', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.user, 'deploy', skillDoc('deploy', 'user version'));
    writeSkill(roots.projectShared, 'deploy', skillDoc('deploy', 'shared version'));
    writeSkill(roots.projectLocal, 'deploy', skillDoc('deploy', 'local version'));
    const catalog = createSkillCatalog({ roots });
    expect(catalog.count()).toBe(1);
    const entry = catalog.lookup('deploy');
    expect(entry?.scope).toBe('project_local');
    expect(entry?.frontmatter.description).toBe('local version');
    const shadowed = catalog.filtered().filter((f) => f.reason === 'shadowed');
    expect(shadowed.map((f) => f.scope).sort()).toEqual(['project_shared', 'user']);
    expect(shadowed.every((f) => f.reason === 'shadowed' && f.shadowedBy === 'project_local')).toBe(
      true,
    );
  });

  test('shared wins over user when there is no local entry', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.user, 'bump', skillDoc('bump', 'user'));
    writeSkill(roots.projectShared, 'bump', skillDoc('bump', 'shared'));
    const catalog = createSkillCatalog({ roots });
    expect(catalog.lookup('bump')?.scope).toBe('project_shared');
  });

  test('a malformed skill is filtered, never surfaced as an entry', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'broken', brokenDoc('broken'));
    const catalog = createSkillCatalog({ roots });
    expect(catalog.count()).toBe(0);
    expect(catalog.filtered().find((f) => f.name === 'broken')?.reason).toBe('malformed');
  });

  test('a malformed skill in a higher scope does not shadow a valid lower one', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectLocal, 'audit', brokenDoc('audit'));
    writeSkill(roots.user, 'audit', skillDoc('audit', 'the valid one'));
    const catalog = createSkillCatalog({ roots });
    expect(catalog.lookup('audit')?.scope).toBe('user');
    expect(
      catalog.filtered().some((f) => f.scope === 'project_local' && f.reason === 'malformed'),
    ).toBe(true);
  });

  test('filters a file whose frontmatter name differs from its filename', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'git-bisect', skillDoc('something-else'));
    const catalog = createSkillCatalog({ roots });
    expect(catalog.count()).toBe(0);
    const mismatch = catalog.filtered().find((f) => f.name === 'git-bisect');
    expect(mismatch?.reason).toBe('name_mismatch');
    if (mismatch?.reason === 'name_mismatch') {
      expect(mismatch.declaredName).toBe('something-else');
    }
  });

  test('a bad-named .md file becomes a filtered entry, not a crashed scan', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'good-one', skillDoc('good-one'));
    writeSkill(roots.projectShared, 'Bad Name', skillDoc('placeholder'));
    const catalog = createSkillCatalog({ roots });
    expect(catalog.count()).toBe(1);
    expect(catalog.filtered().find((f) => f.name === 'Bad Name')?.reason).toBe('malformed');
  });
});

describe('createSkillCatalog — read', () => {
  test('read() loads the winning-scope body when no scope is given', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.user, 'bump', skillDoc('bump', 'user'));
    writeSkill(roots.projectLocal, 'bump', skillDoc('bump', 'local'));
    const catalog = createSkillCatalog({ roots });
    const result = catalog.read('bump');
    expect(result.kind).toBe('present');
    if (result.kind === 'present') {
      expect(result.scope).toBe('project_local');
      expect(result.file.body).toBe('Body for bump.\n');
    }
  });

  test('read(name, scope) reads a shadowed entry strictly, bypassing precedence', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.user, 'bump', skillDoc('bump', 'user'));
    writeSkill(roots.projectLocal, 'bump', skillDoc('bump', 'local'));
    const catalog = createSkillCatalog({ roots });
    const result = catalog.read('bump', 'user');
    expect(result.kind).toBe('present');
    if (result.kind === 'present') {
      expect(result.scope).toBe('user');
      expect(result.file.frontmatter.description).toBe('user');
    }
  });

  test('read() returns not_found for an unknown name', () => {
    const catalog = createSkillCatalog({ roots: makeRoots(makeTmp()) });
    expect(catalog.read('nope').kind).toBe('not_found');
  });

  test('read(name, scope) returns missing when the strict-scope file is absent', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectLocal, 'here', skillDoc('here'));
    const catalog = createSkillCatalog({ roots });
    expect(catalog.read('here', 'user').kind).toBe('missing');
  });

  test('read() of a catalog winner whose file was deleted returns missing', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'transient', skillDoc('transient'));
    const catalog = createSkillCatalog({ roots });
    expect(catalog.lookup('transient')).not.toBeNull();
    rmSync(join(roots.projectShared, 'transient.md'));
    expect(catalog.read('transient').kind).toBe('missing');
  });
});

describe('createSkillCatalog — reload', () => {
  test('reload() picks up a newly added skill', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'first', skillDoc('first'));
    const catalog = createSkillCatalog({ roots });
    expect(catalog.count()).toBe(1);
    writeSkill(roots.projectShared, 'second', skillDoc('second'));
    expect(catalog.count()).toBe(1);
    catalog.reload();
    expect(catalog.count()).toBe(2);
  });
});

describe('createSkillCatalog — recordEvent', () => {
  let db: DB;
  let sessionId: string;

  beforeEach(() => {
    db = openMemoryDb();
    migrate(db);
    sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  });

  test('writes a skill_events row when a db is wired', () => {
    const catalog = createSkillCatalog({ roots: makeRoots(makeTmp()), db, sessionId });
    catalog.recordEvent({ action: 'invoked', scope: 'project_shared', skillName: 'git-bisect' });
    const events = listSkillEventsBySession(db, sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('invoked');
    expect(events[0]?.skillName).toBe('git-bisect');
    expect(events[0]?.scope).toBe('project_shared');
    expect(events[0]?.sessionId).toBe(sessionId);
  });

  test('a per-call sessionId overrides the constructor default', () => {
    const liveSession = createSession(db, { model: 'm', cwd: '/p' }).id;
    const catalog = createSkillCatalog({ roots: makeRoots(makeTmp()), db, sessionId });
    catalog.recordEvent({
      action: 'surfaced',
      scope: 'user',
      skillName: 'x',
      sessionId: liveSession,
    });
    expect(listSkillEventsBySession(db, liveSession)).toHaveLength(1);
    expect(listSkillEventsBySession(db, sessionId)).toHaveLength(0);
  });

  test('resolves cwd from the constructor default and the per-call override', () => {
    const catalog = createSkillCatalog({
      roots: makeRoots(makeTmp()),
      db,
      sessionId,
      cwd: '/boot',
    });
    catalog.recordEvent({ action: 'surfaced', scope: 'user', skillName: 'a' });
    catalog.recordEvent({ action: 'invoked', scope: 'user', skillName: 'b', cwd: '/live' });
    const events = listSkillEventsBySession(db, sessionId);
    expect(events.find((e) => e.skillName === 'a')?.cwd).toBe('/boot');
    expect(events.find((e) => e.skillName === 'b')?.cwd).toBe('/live');
  });

  test('carries details through to the row', () => {
    const catalog = createSkillCatalog({ roots: makeRoots(makeTmp()), db, sessionId });
    catalog.recordEvent({
      action: 'filtered',
      scope: 'project_local',
      skillName: 'dup',
      details: { reason: 'shadowed', shadowedBy: 'project_shared' },
    });
    expect(listSkillEventsBySession(db, sessionId)[0]?.details).toEqual({
      reason: 'shadowed',
      shadowedBy: 'project_shared',
    });
  });

  test('swallows a DB failure instead of throwing (the audit-drift contract)', () => {
    const catalog = createSkillCatalog({ roots: makeRoots(makeTmp()), db, sessionId });
    // Drop the table so the INSERT inside recordEvent throws — the
    // catch must keep the failure off the caller's path.
    db.query('DROP TABLE skill_events').run();
    expect(() =>
      catalog.recordEvent({ action: 'invoked', scope: 'user', skillName: 'x' }),
    ).not.toThrow();
  });

  test('recordEvent is a no-op (no throw) when no db is wired', () => {
    const catalog = createSkillCatalog({ roots: makeRoots(makeTmp()) });
    expect(() =>
      catalog.recordEvent({ action: 'invoked', scope: 'user', skillName: 'x' }),
    ).not.toThrow();
  });
});
