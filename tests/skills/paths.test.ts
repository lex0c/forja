import { describe, expect, test } from 'bun:test';
import { SkillFrontmatterError } from '../../src/skills/frontmatter.ts';
import {
  ScopeError,
  projectScopeRoots,
  resolveScopeRoots,
  rootForScope,
  skillFilePath,
  userScopeRoot,
} from '../../src/skills/paths.ts';
import type { SkillScopeRoots } from '../../src/skills/paths.ts';

const roots: SkillScopeRoots = {
  user: '/home/dev/.config/agent/skills',
  projectShared: '/repo/.agent/skills/shared',
  projectLocal: '/repo/.agent/skills/local',
};

describe('userScopeRoot', () => {
  test('resolves <HOME>/.config/agent/skills on POSIX', () => {
    expect(userScopeRoot({ HOME: '/home/dev' }, 'linux')).toBe('/home/dev/.config/agent/skills');
  });

  test('honors an absolute XDG_CONFIG_HOME', () => {
    expect(userScopeRoot({ XDG_CONFIG_HOME: '/custom/cfg' }, 'linux')).toBe(
      '/custom/cfg/agent/skills',
    );
  });

  test('resolves the Windows APPDATA location', () => {
    expect(userScopeRoot({ APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' }, 'win32')).toBe(
      'C:\\Users\\dev\\AppData\\Roaming\\agent\\skills',
    );
  });

  test('returns null when no config root can be derived', () => {
    expect(userScopeRoot({}, 'linux')).toBeNull();
  });
});

describe('projectScopeRoots / resolveScopeRoots', () => {
  test('places shared + local under .agent/skills', () => {
    expect(projectScopeRoots('/repo')).toEqual({
      shared: '/repo/.agent/skills/shared',
      local: '/repo/.agent/skills/local',
    });
  });

  test('resolveScopeRoots combines the user + project roots', () => {
    expect(resolveScopeRoots('/repo', { XDG_CONFIG_HOME: '/cfg' }, 'linux')).toEqual({
      user: '/cfg/agent/skills',
      projectShared: '/repo/.agent/skills/shared',
      projectLocal: '/repo/.agent/skills/local',
    });
  });

  test('resolveScopeRoots carries a null user root through', () => {
    const resolved = resolveScopeRoots('/repo', {}, 'linux');
    expect(resolved.user).toBeNull();
    expect(resolved.projectShared).toBe('/repo/.agent/skills/shared');
  });
});

describe('rootForScope', () => {
  test('maps each scope to its root', () => {
    expect(rootForScope(roots, 'user')).toBe(roots.user);
    expect(rootForScope(roots, 'project_shared')).toBe(roots.projectShared);
    expect(rootForScope(roots, 'project_local')).toBe(roots.projectLocal);
  });

  test('returns null for an unavailable user scope', () => {
    expect(rootForScope({ ...roots, user: null }, 'user')).toBeNull();
  });
});

describe('skillFilePath', () => {
  test('builds <root>/<name>.md for a valid name', () => {
    expect(skillFilePath(roots, 'project_shared', 'triage-flaky-test')).toBe(
      '/repo/.agent/skills/shared/triage-flaky-test.md',
    );
  });

  test('rejects a name with path-traversal segments', () => {
    expect(() => skillFilePath(roots, 'user', '../../etc/passwd')).toThrow(SkillFrontmatterError);
  });

  test('rejects a name with a separator', () => {
    expect(() => skillFilePath(roots, 'user', 'sub/skill')).toThrow(SkillFrontmatterError);
  });

  test('throws ScopeError when the scope has no root', () => {
    expect(() => skillFilePath({ ...roots, user: null }, 'user', 'rename-symbol')).toThrow(
      ScopeError,
    );
  });
});
