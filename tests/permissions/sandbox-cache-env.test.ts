import { afterEach, describe, expect, test } from 'bun:test';
import {
  CACHE_ENV_MAP,
  buildCacheRedirectEnv,
  getCachePersistenceOverride,
  setCachePersistenceOverride,
} from '../../src/permissions/sandbox-cache-env.ts';

const SUPPORTED = [
  'npm',
  'yarn',
  'pnpm',
  'bun',
  'pip',
  'uv',
  'go',
  'nuget',
  'composer',
  'gradle',
  'maven',
];

describe('sandbox-cache-env: CACHE_ENV_MAP', () => {
  test('covers every supported toolchain with at least one var', () => {
    for (const key of SUPPORTED) {
      const entries = CACHE_ENV_MAP[key];
      expect(entries).toBeDefined();
      expect((entries ?? []).length).toBeGreaterThan(0);
    }
  });

  test('go exposes BOTH the build cache and the module cache', () => {
    const names = (CACHE_ENV_MAP.go ?? []).map((e) => e.name);
    expect(names).toContain('GOCACHE');
    expect(names).toContain('GOMODCACHE');
  });

  test('no env-var name collides across toolchains', () => {
    const seen = new Set<string>();
    for (const entries of Object.values(CACHE_ENV_MAP)) {
      for (const { name } of entries) {
        expect(seen.has(name)).toBe(false);
        seen.add(name);
      }
    }
  });

  test('every subdir is a clean relative path (no leading slash / no ..)', () => {
    for (const entries of Object.values(CACHE_ENV_MAP)) {
      for (const { subdir } of entries) {
        expect(subdir.startsWith('/')).toBe(false);
        expect(subdir.split('/')).not.toContain('..');
      }
    }
  });
});

describe('sandbox-cache-env: buildCacheRedirectEnv', () => {
  const base = '/home/op/.cache/forja/cache';

  test('maps plain cache vars to <base>/<subdir>', () => {
    const env = buildCacheRedirectEnv(base);
    expect(env.GOCACHE).toBe(`${base}/go/build`);
    expect(env.GOMODCACHE).toBe(`${base}/go/mod`);
    expect(env.npm_config_cache).toBe(`${base}/npm`);
    expect(env.PIP_CACHE_DIR).toBe(`${base}/pip`);
    expect(env.BUN_INSTALL_CACHE_DIR).toBe(`${base}/bun`);
    expect(env.NUGET_PACKAGES).toBe(`${base}/nuget`);
    expect(env.GRADLE_USER_HOME).toBe(`${base}/gradle`);
  });

  test('Maven uses the -Dmaven.repo.local flag form, not a bare path', () => {
    const env = buildCacheRedirectEnv(base);
    expect(env.MAVEN_ARGS).toBe(`-Dmaven.repo.local=${base}/maven`);
  });

  test('produces exactly one entry per map var', () => {
    const env = buildCacheRedirectEnv(base);
    const total = Object.values(CACHE_ENV_MAP).reduce((n, e) => n + e.length, 0);
    expect(Object.keys(env).length).toBe(total);
  });
});

describe('sandbox-cache-env: persistence override (tri-state)', () => {
  afterEach(() => setCachePersistenceOverride(undefined));

  test('undefined by default (runner treats as off)', () => {
    setCachePersistenceOverride(undefined);
    expect(getCachePersistenceOverride()).toBeUndefined();
  });

  test('round-trips explicit true / false', () => {
    setCachePersistenceOverride(true);
    expect(getCachePersistenceOverride()).toBe(true);
    setCachePersistenceOverride(false);
    expect(getCachePersistenceOverride()).toBe(false);
  });
});
