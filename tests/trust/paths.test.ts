import { describe, expect, test } from 'bun:test';
import { trustListPath } from '../../src/trust/paths.ts';

describe('trustListPath', () => {
  test('XDG_CONFIG_HOME wins on POSIX when explicitly set', () => {
    expect(trustListPath({ XDG_CONFIG_HOME: '/tmp/xdg' }, 'linux')).toBe(
      '/tmp/xdg/forja/trusted_dirs.json',
    );
  });

  test('relative XDG_CONFIG_HOME is rejected (defensive)', () => {
    // Without this guard a repo could ship a `.config/forja/...`
    // override of the trust list. Same vector mitigated in
    // `userPolicyPath`.
    expect(trustListPath({ XDG_CONFIG_HOME: 'relative/path', HOME: '/home/lex' }, 'linux')).toBe(
      '/home/lex/.config/forja/trusted_dirs.json',
    );
  });

  test('Linux/macOS uses HOME/.config/forja', () => {
    expect(trustListPath({ HOME: '/home/lex' }, 'linux')).toBe(
      '/home/lex/.config/forja/trusted_dirs.json',
    );
    expect(trustListPath({ HOME: '/Users/lex' }, 'darwin')).toBe(
      '/Users/lex/.config/forja/trusted_dirs.json',
    );
  });

  test('Windows uses APPDATA when set', () => {
    expect(trustListPath({ APPDATA: 'C:\\Users\\lex\\AppData\\Roaming' }, 'win32')).toBe(
      'C:\\Users\\lex\\AppData\\Roaming\\forja\\trusted_dirs.json',
    );
  });

  test('Windows falls back to USERPROFILE when APPDATA missing', () => {
    expect(trustListPath({ USERPROFILE: 'C:\\Users\\lex' }, 'win32')).toBe(
      'C:\\Users\\lex\\AppData\\Roaming\\forja\\trusted_dirs.json',
    );
  });

  test('null when no home-rooted absolute path can be derived', () => {
    expect(trustListPath({}, 'linux')).toBeNull();
    expect(trustListPath({ HOME: 'relative' }, 'linux')).toBeNull();
    expect(trustListPath({}, 'win32')).toBeNull();
  });
});
