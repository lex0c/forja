import { describe, expect, test } from 'bun:test';
import {
  enterpriseHooksPath,
  projectHooksPath,
  resolveHookPaths,
  userHooksPath,
} from '../../src/hooks/paths.ts';

describe('enterpriseHooksPath', () => {
  test('Linux/macOS uses /etc literal regardless of env', () => {
    expect(enterpriseHooksPath({}, 'linux')).toBe('/etc/forja/hooks.toml');
    expect(enterpriseHooksPath({ HOME: '/home/x' }, 'darwin')).toBe('/etc/forja/hooks.toml');
  });

  test('Windows honors PROGRAMDATA when absolute', () => {
    expect(enterpriseHooksPath({ PROGRAMDATA: 'C:\\ProgramData' }, 'win32')).toBe(
      'C:\\ProgramData\\forja\\hooks.toml',
    );
  });

  test('Windows returns null when PROGRAMDATA is missing or relative', () => {
    expect(enterpriseHooksPath({}, 'win32')).toBeNull();
    expect(enterpriseHooksPath({ PROGRAMDATA: 'relative\\path' }, 'win32')).toBeNull();
    expect(enterpriseHooksPath({ PROGRAMDATA: '' }, 'win32')).toBeNull();
  });
});

describe('userHooksPath', () => {
  test('honors XDG_CONFIG_HOME when absolute', () => {
    expect(userHooksPath({ XDG_CONFIG_HOME: '/custom/xdg', HOME: '/home/x' })).toBe(
      '/custom/xdg/forja/hooks.toml',
    );
  });

  test('falls back to $HOME/.config when XDG absent', () => {
    expect(userHooksPath({ HOME: '/home/x' })).toBe('/home/x/.config/forja/hooks.toml');
  });

  test('rejects non-absolute XDG (path-traversal defense)', () => {
    // Operator with `XDG_CONFIG_HOME=../etc` would otherwise let
    // a project file shadow the enterprise layer.
    const result = userHooksPath({ XDG_CONFIG_HOME: '../etc', HOME: '/home/x' });
    expect(result).toBe('/home/x/.config/forja/hooks.toml');
  });
});

describe('projectHooksPath', () => {
  test('joins with .forja/hooks.toml', () => {
    expect(projectHooksPath('/repo')).toBe('/repo/.forja/hooks.toml');
  });
});

describe('resolveHookPaths', () => {
  test('builds all three layers in priority order', () => {
    const paths = resolveHookPaths('/repo', { XDG_CONFIG_HOME: '/x', HOME: '/h' }, 'linux');
    expect(paths.enterprise).toBe('/etc/forja/hooks.toml');
    expect(paths.user).toBe('/x/forja/hooks.toml');
    expect(paths.project).toBe('/repo/.forja/hooks.toml');
  });
});
