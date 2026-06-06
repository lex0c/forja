import { afterEach, describe, expect, test } from 'bun:test';
import {
  CACHE_ENV_MAP,
  buildCacheRedirectEnv,
  getCachePersistenceOverride,
  setCachePersistenceOverride,
} from '../../src/permissions/sandbox-cache-env.ts';

// The map holds ONLY the holdouts that ignore $XDG_CACHE_HOME; everything
// XDG-compliant rides the XDG_CACHE_HOME catch-all in buildCacheRedirectEnv.
const HOLDOUTS = ['npm', 'pnpm', 'bun', 'go', 'nuget', 'gradle', 'maven'];
// These MUST NOT be in the map — they honor XDG_CACHE_HOME.
const XDG_COVERED_VARS = [
  'GOCACHE',
  'PIP_CACHE_DIR',
  'UV_CACHE_DIR',
  'COMPOSER_CACHE_DIR',
  'YARN_CACHE_FOLDER',
];

describe('sandbox-cache-env: CACHE_ENV_MAP (holdouts only)', () => {
  test('covers every non-XDG holdout toolchain with at least one var', () => {
    for (const key of HOLDOUTS) {
      const entries = CACHE_ENV_MAP[key];
      expect(entries).toBeDefined();
      expect((entries ?? []).length).toBeGreaterThan(0);
    }
  });

  test('go maps the MODULE cache only (build cache rides XDG_CACHE_HOME)', () => {
    const names = (CACHE_ENV_MAP.go ?? []).map((e) => e.name);
    expect(names).toContain('GOMODCACHE');
    expect(names).not.toContain('GOCACHE');
  });

  test('XDG-compliant tools are NOT in the map (covered by the catch-all)', () => {
    const allNames = Object.values(CACHE_ENV_MAP).flatMap((es) => es.map((e) => e.name));
    for (const v of XDG_COVERED_VARS) {
      expect(allNames).not.toContain(v);
    }
    // and the toolKeys themselves are gone
    expect(CACHE_ENV_MAP.pip).toBeUndefined();
    expect(CACHE_ENV_MAP.uv).toBeUndefined();
    expect(CACHE_ENV_MAP.composer).toBeUndefined();
    expect(CACHE_ENV_MAP.yarn).toBeUndefined();
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

  test('sets the XDG_CACHE_HOME catch-all to <base>/xdg', () => {
    expect(buildCacheRedirectEnv(base).XDG_CACHE_HOME).toBe(`${base}/xdg`);
  });

  test('maps the holdout vars to <base>/<subdir>', () => {
    const env = buildCacheRedirectEnv(base);
    expect(env.npm_config_cache).toBe(`${base}/npm`);
    expect(env.GOMODCACHE).toBe(`${base}/go/mod`);
    expect(env.NUGET_PACKAGES).toBe(`${base}/nuget`);
    expect(env.GRADLE_USER_HOME).toBe(`${base}/gradle`);
    expect(env.BUN_INSTALL_CACHE_DIR).toBe(`${base}/bun`);
  });

  test('XDG-covered tools get NO dedicated var (they follow XDG_CACHE_HOME)', () => {
    const env = buildCacheRedirectEnv(base);
    expect(env.GOCACHE).toBeUndefined();
    expect(env.PIP_CACHE_DIR).toBeUndefined();
    expect(env.COMPOSER_CACHE_DIR).toBeUndefined();
  });

  test('Maven uses the -Dmaven.repo.local flag form, not a bare path', () => {
    expect(buildCacheRedirectEnv(base).MAVEN_ARGS).toBe(`-Dmaven.repo.local=${base}/maven`);
  });

  test('produces XDG_CACHE_HOME + exactly one entry per map var', () => {
    const env = buildCacheRedirectEnv(base);
    const mapVars = Object.values(CACHE_ENV_MAP).reduce((n, e) => n + e.length, 0);
    expect(Object.keys(env).length).toBe(mapVars + 1); // +1 for XDG_CACHE_HOME
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
