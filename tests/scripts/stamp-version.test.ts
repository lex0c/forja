import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeVersion, stampSource, stampVersionFile } from '../../scripts/stamp-version.ts';

describe('normalizeVersion', () => {
  test('strips a single leading v', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3');
    expect(normalizeVersion('1.2.3')).toBe('1.2.3');
  });

  test('accepts prerelease and build metadata', () => {
    expect(normalizeVersion('v1.2.3-rc.1')).toBe('1.2.3-rc.1');
    expect(normalizeVersion('1.2.3+build.5')).toBe('1.2.3+build.5');
    expect(normalizeVersion('v2.0.0-beta.2+exp.sha.5114f85')).toBe('2.0.0-beta.2+exp.sha.5114f85');
  });

  test('rejects non-semver', () => {
    for (const bad of ['1.2', 'v1', 'latest', '1.2.3.4', '', 'vv1.2.3', 'v1.2.x']) {
      expect(() => normalizeVersion(bad)).toThrow();
    }
  });
});

describe('stampSource', () => {
  const line = (v: string): string => `export const VERSION = '${v}';`;

  test('replaces the single VERSION const', () => {
    const src = `export const APP_NAME = 'Forja';\n${line('0.0.0')}\n`;
    const out = stampSource(src, '1.2.3');
    expect(out).toContain(line('1.2.3'));
    expect(out).not.toContain(line('0.0.0'));
    // Unrelated lines are preserved.
    expect(out).toContain(`export const APP_NAME = 'Forja';`);
  });

  test('throws when the VERSION const is absent', () => {
    expect(() => stampSource(`export const APP_NAME = 'Forja';\n`, '1.2.3')).toThrow(/not found/);
  });

  test('throws when more than one VERSION const is present', () => {
    expect(() => stampSource(`${line('0.0.0')}\n${line('9.9.9')}\n`, '1.2.3')).toThrow(
      /exactly one/,
    );
  });
});

describe('stampVersionFile', () => {
  test('writes the normalized version to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-stamp-'));
    try {
      const f = join(dir, 'version.ts');
      writeFileSync(f, `export const APP_NAME = 'Forja';\nexport const VERSION = '0.0.0';\n`);
      const r = stampVersionFile(f, 'v7.8.9');
      expect(r.version).toBe('7.8.9');
      expect(readFileSync(f, 'utf-8')).toContain(`export const VERSION = '7.8.9';`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects a bad version before touching the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-stamp-'));
    try {
      const f = join(dir, 'version.ts');
      const original = `export const VERSION = '0.0.0';\n`;
      writeFileSync(f, original);
      expect(() => stampVersionFile(f, 'nope')).toThrow();
      expect(readFileSync(f, 'utf-8')).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
