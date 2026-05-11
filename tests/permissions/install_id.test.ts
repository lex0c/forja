import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureInstallId, isFirstBoot } from '../../src/permissions/install_id.ts';

describe('ensureInstallId', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-install-id-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('creates identity at supplied path with mode 0600 on first call', () => {
    const path = join(tmp, 'agent', 'install_id');
    const id = ensureInstallId({
      pathOverride: path,
      now: () => 1731000000000,
      uuid: () => 'fixed-uuid-aaaa-bbbb-cccc-dddddddddddd',
    });

    expect(id.install_id).toBe('fixed-uuid-aaaa-bbbb-cccc-dddddddddddd');
    expect(id.created_at_ms).toBe(1731000000000);
    expect(existsSync(path)).toBe(true);

    // Mode 0600 (-rw-------) on posix. Skip on platforms that
    // don't honor unix bits to keep the test cross-platform.
    if (process.platform !== 'win32') {
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    const written = JSON.parse(readFileSync(path, 'utf-8'));
    expect(written).toEqual(id as unknown as Record<string, unknown>);
  });

  test('subsequent calls return the same identity (idempotent)', () => {
    const path = join(tmp, 'install_id');
    const first = ensureInstallId({
      pathOverride: path,
      now: () => 1731000000000,
      uuid: () => 'first-call-uuid',
    });
    const second = ensureInstallId({
      pathOverride: path,
      // These getters should NEVER fire on the second call — if
      // they do, the function regenerated instead of reading.
      now: () => {
        throw new Error('now() should not be called when identity exists');
      },
      uuid: () => {
        throw new Error('uuid() should not be called when identity exists');
      },
    });
    expect(second).toEqual(first);
  });

  test('rejects malformed JSON', () => {
    const path = join(tmp, 'install_id');
    require('node:fs').writeFileSync(path, '{not json', { mode: 0o600 });
    expect(() => ensureInstallId({ pathOverride: path })).toThrow('not valid JSON');
  });

  test('rejects wrong shape', () => {
    const path = join(tmp, 'install_id');
    require('node:fs').writeFileSync(
      path,
      JSON.stringify({ install_id: 'x' }), // missing created_at_ms
      { mode: 0o600 },
    );
    expect(() => ensureInstallId({ pathOverride: path })).toThrow('wrong shape');
  });

  test('rejects install_id of wrong type', () => {
    const path = join(tmp, 'install_id');
    require('node:fs').writeFileSync(path, JSON.stringify({ install_id: 123, created_at_ms: 0 }), {
      mode: 0o600,
    });
    expect(() => ensureInstallId({ pathOverride: path })).toThrow('wrong shape');
  });

  test('throws when no config dir can be derived', () => {
    expect(() =>
      ensureInstallId({
        env: {}, // no HOME / no XDG / no APPDATA
        platform: 'linux',
      }),
    ).toThrow('cannot determine config directory');
  });

  test('uses installIdPath discovery when pathOverride absent', () => {
    const id = ensureInstallId({
      env: { HOME: tmp },
      platform: 'linux',
      uuid: () => 'discovered-path-uuid',
      now: () => 1731000000001,
    });
    expect(existsSync(join(tmp, '.config', 'agent', 'install_id'))).toBe(true);
    expect(id.install_id).toBe('discovered-path-uuid');
  });
});

describe('isFirstBoot (slice 46)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-first-boot-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('returns true when the install_id file does not exist', () => {
    const path = join(tmp, 'agent', 'install_id');
    expect(isFirstBoot({ pathOverride: path })).toBe(true);
  });

  test('returns false after ensureInstallId creates the file', () => {
    const path = join(tmp, 'agent', 'install_id');
    ensureInstallId({
      pathOverride: path,
      now: () => 1731000000000,
      uuid: () => 'first-boot-test-uuid',
    });
    expect(isFirstBoot({ pathOverride: path })).toBe(false);
  });

  test('returns false when the path cannot be derived (no env, silently)', () => {
    // No HOME / XDG_CONFIG_HOME / APPDATA — installIdPath returns
    // null. Slice 46 contract: don't nudge in this state (the
    // bootstrap error path will surface the real diagnostic).
    expect(isFirstBoot({ env: {}, platform: 'linux' })).toBe(false);
  });

  test('honors env-discovered path on Linux', () => {
    const cfg = join(tmp, '.config');
    expect(isFirstBoot({ env: { HOME: tmp, XDG_CONFIG_HOME: cfg }, platform: 'linux' })).toBe(true);
    // Create the discovered file and re-check.
    ensureInstallId({
      env: { HOME: tmp, XDG_CONFIG_HOME: cfg },
      platform: 'linux',
      now: () => 1731000000000,
      uuid: () => 'env-discover-uuid',
    });
    expect(isFirstBoot({ env: { HOME: tmp, XDG_CONFIG_HOME: cfg }, platform: 'linux' })).toBe(
      false,
    );
  });
});
