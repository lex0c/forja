import { describe, expect, test } from 'bun:test';
import {
  agentConfigDir,
  enterpriseAgentPath,
  projectAgentPath,
  userAgentPath,
} from '../../src/config/agent-paths.ts';

// Tests for the shared agent-path resolvers. The per-subsystem
// callers (`permissions/paths.ts`, `hooks/paths.ts`,
// `config/paths.ts`) have their own tests pinning their filename
// suffix; THIS file pins the shared XDG / HOME / Windows logic
// directly so a refactor to the shared module surfaces here
// rather than in 3 places downstream.

describe('agentConfigDir', () => {
  test('XDG_CONFIG_HOME wins when absolute (POSIX)', () => {
    expect(agentConfigDir({ XDG_CONFIG_HOME: '/xdg', HOME: '/home/u' }, 'linux')).toBe(
      '/xdg/forja',
    );
  });

  test('falls back to $HOME/.config when XDG missing (POSIX)', () => {
    expect(agentConfigDir({ HOME: '/home/u' }, 'linux')).toBe('/home/u/.config/forja');
  });

  test('rejects non-absolute XDG (path-traversal defense)', () => {
    // `XDG_CONFIG_HOME=../etc` would let a project file shadow
    // higher-precedence layers if joined as a relative path —
    // `existsSync` resolves against cwd. Reject and fall through
    // to HOME-rooted path.
    expect(agentConfigDir({ XDG_CONFIG_HOME: '../etc', HOME: '/home/u' }, 'linux')).toBe(
      '/home/u/.config/forja',
    );
  });

  test('returns null when neither XDG nor HOME yield an absolute path', () => {
    // Stripped-down env (containers, CI workers, systemd
    // one-shots). Null is the explicit "user layer unavailable"
    // marker; callers must NOT fall back to a relative path.
    expect(agentConfigDir({}, 'linux')).toBe(null);
  });

  test('Windows: APPDATA absolute → APPDATA/forja', () => {
    // Pre-consolidation, hooks/paths.ts and config/paths.ts
    // missed Windows handling entirely — operator on Windows
    // without XDG_CONFIG_HOME got `null` and the user layer was
    // silently unavailable. This pin guards against regression
    // to the POSIX-only shape.
    expect(agentConfigDir({ APPDATA: 'C:\\Users\\op\\AppData\\Roaming' }, 'win32')).toBe(
      'C:\\Users\\op\\AppData\\Roaming\\forja',
    );
  });

  test('Windows: USERPROFILE fallback when APPDATA absent', () => {
    expect(agentConfigDir({ USERPROFILE: 'C:\\Users\\op' }, 'win32')).toBe(
      'C:\\Users\\op\\AppData\\Roaming\\forja',
    );
  });

  test('Windows: XDG still honored when explicitly set (WSL / dotfile managers)', () => {
    expect(
      agentConfigDir({ XDG_CONFIG_HOME: 'C:\\xdg', APPDATA: 'C:\\AppData\\Roaming' }, 'win32'),
    ).toBe('C:\\xdg\\forja');
  });

  test('Windows: returns null when no env var yields an absolute path', () => {
    expect(agentConfigDir({}, 'win32')).toBe(null);
  });
});

describe('userAgentPath', () => {
  test('appends filename under the resolved config root', () => {
    expect(userAgentPath('config.toml', { HOME: '/home/u' }, 'linux')).toBe(
      '/home/u/.config/forja/config.toml',
    );
  });

  test('null when config root unavailable', () => {
    expect(userAgentPath('config.toml', {}, 'linux')).toBe(null);
  });

  test('Windows: appends filename to APPDATA/forja', () => {
    // Same Windows-handling pin as agentConfigDir, exercised via
    // the public surface a typical caller hits.
    expect(userAgentPath('hooks.toml', { APPDATA: 'C:\\AppData\\Roaming' }, 'win32')).toBe(
      'C:\\AppData\\Roaming\\forja\\hooks.toml',
    );
  });
});

describe('enterpriseAgentPath', () => {
  test('POSIX: /etc/forja/<filename> regardless of env state', () => {
    // /etc/forja/ is canonical on POSIX; no env var lookup
    // required. Mirrors the original hardcoded behavior.
    expect(enterpriseAgentPath('permissions.yaml', {}, 'linux')).toBe(
      '/etc/forja/permissions.yaml',
    );
  });

  test('Windows: PROGRAMDATA absolute → PROGRAMDATA/forja/<filename>', () => {
    expect(enterpriseAgentPath('hooks.toml', { PROGRAMDATA: 'C:\\ProgramData' }, 'win32')).toBe(
      'C:\\ProgramData\\forja\\hooks.toml',
    );
  });

  test('Windows: returns null when PROGRAMDATA missing or non-absolute', () => {
    expect(enterpriseAgentPath('hooks.toml', {}, 'win32')).toBe(null);
    expect(enterpriseAgentPath('hooks.toml', { PROGRAMDATA: 'relative' }, 'win32')).toBe(null);
  });
});

describe('projectAgentPath', () => {
  test('joins repoRoot with .forja/<filename> (POSIX)', () => {
    expect(projectAgentPath('/repo', 'permissions.yaml', 'linux')).toBe(
      '/repo/.forja/permissions.yaml',
    );
  });

  test('Windows: joins with backslash separators when platform=win32', () => {
    // Platform-aware join — tests on a POSIX runner exercising
    // Windows behavior need the path module to know which slash
    // semantic applies.
    expect(projectAgentPath('C:\\repo', 'config.toml', 'win32')).toBe(
      'C:\\repo\\.forja\\config.toml',
    );
  });
});
