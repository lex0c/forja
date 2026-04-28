import { describe, expect, test } from 'bun:test';
import {
  ENTERPRISE_POLICY_PATH,
  projectPolicyPath,
  userPolicyPath,
} from '../../src/permissions/paths.ts';

describe('permission policy paths', () => {
  test('enterprise path is /etc/agent/permissions.yaml', () => {
    expect(ENTERPRISE_POLICY_PATH).toBe('/etc/agent/permissions.yaml');
  });

  test('user path uses XDG_CONFIG_HOME when set', () => {
    expect(userPolicyPath({ XDG_CONFIG_HOME: '/x', HOME: '/h' })).toBe('/x/agent/permissions.yaml');
  });

  test('user path falls back to ~/.config/agent when XDG is unset', () => {
    expect(userPolicyPath({ HOME: '/home/lex' })).toBe('/home/lex/.config/agent/permissions.yaml');
  });

  test('user path falls back gracefully when XDG is empty string (not just unset)', () => {
    // Empty XDG should be treated like unset — some shells export
    // XDG_CONFIG_HOME='' which would otherwise produce
    // '/agent/permissions.yaml' (root path).
    expect(userPolicyPath({ XDG_CONFIG_HOME: '', HOME: '/home/lex' })).toBe(
      '/home/lex/.config/agent/permissions.yaml',
    );
  });

  test('user path returns null when HOME is unset and XDG is unset', () => {
    // Regression: previously fell through to join('', '.config',
    // 'agent', 'permissions.yaml') which produces a RELATIVE path.
    // existsSync would then check against the current cwd, letting
    // a repo-local `.config/agent/permissions.yaml` masquerade as
    // the user layer. Returning null tells the resolver to skip.
    expect(userPolicyPath({})).toBeNull();
  });

  test('user path returns null when HOME is empty string', () => {
    expect(userPolicyPath({ HOME: '' })).toBeNull();
  });

  test('user path returns null when HOME is relative (not absolute)', () => {
    // Defensive: a non-absolute HOME would still produce a relative
    // joined path. Per XDG/POSIX, HOME should always be absolute;
    // refuse rather than guess.
    expect(userPolicyPath({ HOME: 'relative/home' })).toBeNull();
  });

  test('user path ignores XDG_CONFIG_HOME when it is relative (per XDG spec)', () => {
    // XDG spec: "If the value is not an absolute path, the value
    // is invalid and should be discarded."
    expect(userPolicyPath({ XDG_CONFIG_HOME: 'rel', HOME: '/home/lex' })).toBe(
      '/home/lex/.config/agent/permissions.yaml',
    );
  });

  test('user path returns null when both XDG and HOME are non-absolute', () => {
    expect(userPolicyPath({ XDG_CONFIG_HOME: 'rel-xdg', HOME: 'rel-home' })).toBeNull();
  });

  test('project path is cwd/.agent/permissions.yaml', () => {
    expect(projectPolicyPath('/p')).toBe('/p/.agent/permissions.yaml');
  });
});
