import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  defaultDataDir,
  defaultDbPath,
  forjaCacheDir,
  forjaCachePersistBase,
  forjaSessionTmpDir,
} from '../../src/storage/paths.ts';

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

describe('forja cache paths', () => {
  let originalXdgCache: string | undefined;

  beforeEach(() => {
    originalXdgCache = process.env.XDG_CACHE_HOME;
  });

  afterEach(() => {
    if (originalXdgCache === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = originalXdgCache;
    }
  });

  test('honors XDG_CACHE_HOME when set', () => {
    process.env.XDG_CACHE_HOME = '/custom/cache';
    expect(forjaCacheDir()).toBe('/custom/cache/forja');
    expect(forjaCachePersistBase()).toBe('/custom/cache/forja/cache');
    expect(forjaSessionTmpDir('sess-1')).toBe('/custom/cache/forja/tmp/sessions/sess-1');
  });

  test('falls back to ~/.cache when XDG_CACHE_HOME is unset', () => {
    delete process.env.XDG_CACHE_HOME;
    expect(forjaCacheDir()).toBe(join(homedir(), '.cache', 'forja'));
    expect(forjaCachePersistBase()).toBe(join(homedir(), '.cache', 'forja', 'cache'));
  });

  test('falls back when XDG_CACHE_HOME is empty string', () => {
    process.env.XDG_CACHE_HOME = '';
    expect(forjaCacheDir()).toBe(join(homedir(), '.cache', 'forja'));
  });

  test('ignores a non-absolute XDG_CACHE_HOME (a relative bind target would abort the spawn)', () => {
    process.env.XDG_CACHE_HOME = 'relative/cache';
    expect(forjaCacheDir()).toBe(join(homedir(), '.cache', 'forja'));
    expect(forjaCachePersistBase()).toBe(join(homedir(), '.cache', 'forja', 'cache'));
  });

  // Load-bearing invariant: the cache base and the session-tmp tree must
  // be SIBLINGS, never nested — else the `--bind <cacheBase>` would
  // capture the tmp tree (or vice-versa) inside the sandbox.
  test('cache base and session-tmp are siblings, both under the cache root', () => {
    process.env.XDG_CACHE_HOME = '/c';
    const root = forjaCacheDir();
    const cache = forjaCachePersistBase();
    const tmp = forjaSessionTmpDir('s');
    expect(cache.startsWith(`${root}/`)).toBe(true);
    expect(tmp.startsWith(`${root}/`)).toBe(true);
    expect(tmp.startsWith(`${cache}/`)).toBe(false);
    expect(cache.startsWith(`${tmp}/`)).toBe(false);
  });
});
