import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultDataDir, defaultDbPath } from '../../src/storage/paths.ts';

describe('storage paths', () => {
  let originalXdg: string | undefined;

  beforeEach(() => {
    originalXdg = process.env.XDG_DATA_HOME;
  });

  afterEach(() => {
    if (originalXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdg;
    }
  });

  test('uses XDG_DATA_HOME when set', () => {
    process.env.XDG_DATA_HOME = '/custom/data';
    expect(defaultDataDir()).toBe('/custom/data/forja');
    expect(defaultDbPath()).toBe('/custom/data/forja/sessions.db');
  });

  test('falls back to ~/.local/share when XDG is unset', () => {
    delete process.env.XDG_DATA_HOME;
    expect(defaultDataDir()).toBe(join(homedir(), '.local', 'share', 'forja'));
  });

  test('falls back when XDG is empty string', () => {
    process.env.XDG_DATA_HOME = '';
    expect(defaultDataDir()).toBe(join(homedir(), '.local', 'share', 'forja'));
  });
});
