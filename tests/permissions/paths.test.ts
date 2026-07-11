import { describe, expect, test } from 'bun:test';
import {
  enterprisePolicyPath,
  projectPolicyPath,
  userPolicyPath,
} from '../../src/permissions/paths.ts';

// Tests pin platform explicitly so they pass deterministically on
// Linux, macOS, AND Windows hosts. Without explicit `platform`, the
// Windows branch would activate on a Windows runner and the Unix
// branch on a Linux/macOS runner, making expectations host-dependent.

describe('enterprisePolicyPath', () => {
  test('Linux returns /etc/forja/permissions.yaml', () => {
    expect(enterprisePolicyPath('linux', {})).toBe('/etc/forja/permissions.yaml');
  });

  test('macOS returns /etc/forja/permissions.yaml', () => {
    expect(enterprisePolicyPath('darwin', {})).toBe('/etc/forja/permissions.yaml');
  });

  test('Windows uses %PROGRAMDATA%\\forja\\permissions.yaml when set', () => {
    expect(enterprisePolicyPath('win32', { PROGRAMDATA: 'C:\\ProgramData' })).toContain('forja');
    expect(enterprisePolicyPath('win32', { PROGRAMDATA: 'C:\\ProgramData' })).toContain(
      'permissions.yaml',
    );
  });

  test('Windows returns null when PROGRAMDATA is unset', () => {
    expect(enterprisePolicyPath('win32', {})).toBeNull();
  });

  test('Windows returns null when PROGRAMDATA is relative', () => {
    expect(enterprisePolicyPath('win32', { PROGRAMDATA: 'relative\\path' })).toBeNull();
  });
});

describe('userPolicyPath — Linux/macOS', () => {
  test('uses XDG_CONFIG_HOME when set', () => {
    expect(userPolicyPath({ XDG_CONFIG_HOME: '/x', HOME: '/h' }, 'linux')).toBe(
      '/x/forja/permissions.yaml',
    );
  });

  test('falls back to ~/.config/forja when XDG is unset', () => {
    expect(userPolicyPath({ HOME: '/home/lex' }, 'linux')).toBe(
      '/home/lex/.config/forja/permissions.yaml',
    );
  });

  test('treats XDG empty string as unset', () => {
    expect(userPolicyPath({ XDG_CONFIG_HOME: '', HOME: '/home/lex' }, 'linux')).toBe(
      '/home/lex/.config/forja/permissions.yaml',
    );
  });

  test('returns null when HOME is unset and XDG is unset', () => {
    expect(userPolicyPath({}, 'linux')).toBeNull();
  });

  test('returns null when HOME is empty string', () => {
    expect(userPolicyPath({ HOME: '' }, 'linux')).toBeNull();
  });

  test('returns null when HOME is relative (not absolute)', () => {
    expect(userPolicyPath({ HOME: 'relative/home' }, 'linux')).toBeNull();
  });

  test('ignores XDG_CONFIG_HOME when relative (per XDG spec)', () => {
    expect(userPolicyPath({ XDG_CONFIG_HOME: 'rel', HOME: '/home/lex' }, 'linux')).toBe(
      '/home/lex/.config/forja/permissions.yaml',
    );
  });

  test('returns null when both XDG and HOME are non-absolute', () => {
    expect(userPolicyPath({ XDG_CONFIG_HOME: 'rel-xdg', HOME: 'rel-home' }, 'linux')).toBeNull();
  });
});

describe('userPolicyPath — Windows', () => {
  test('uses APPDATA when set', () => {
    const result = userPolicyPath({ APPDATA: 'C:\\Users\\Lex\\AppData\\Roaming' }, 'win32');
    expect(result).toContain('forja');
    expect(result).toContain('permissions.yaml');
  });

  test('falls back to USERPROFILE\\AppData\\Roaming when APPDATA is unset', () => {
    const result = userPolicyPath({ USERPROFILE: 'C:\\Users\\Lex' }, 'win32');
    expect(result).toContain('AppData');
    expect(result).toContain('Roaming');
    expect(result).toContain('forja');
  });

  test('still honors XDG_CONFIG_HOME when explicitly set on Windows', () => {
    // Some Windows users (WSL, dotfile managers) opt into XDG. We
    // honor it on every platform when set absolute.
    const result = userPolicyPath({ XDG_CONFIG_HOME: 'C:\\xdg', APPDATA: 'C:\\AppData' }, 'win32');
    expect(result).toContain('xdg');
    expect(result).not.toContain('AppData');
  });

  test('returns null when neither APPDATA nor USERPROFILE is set', () => {
    expect(userPolicyPath({}, 'win32')).toBeNull();
  });

  test('returns null when APPDATA is relative', () => {
    expect(userPolicyPath({ APPDATA: 'relative\\appdata' }, 'win32')).toBeNull();
  });
});

describe('projectPolicyPath', () => {
  test('joins cwd with .forja/permissions.yaml', () => {
    // Asserts on substrings rather than exact path so the test
    // passes regardless of host separator.
    const result = projectPolicyPath('/p');
    expect(result).toContain('.forja');
    expect(result).toContain('permissions.yaml');
  });
});
