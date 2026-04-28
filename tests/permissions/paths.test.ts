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

  test('project path is cwd/.agent/permissions.yaml', () => {
    expect(projectPolicyPath('/p')).toBe('/p/.agent/permissions.yaml');
  });
});
