import { describe, expect, test } from 'bun:test';
import {
  compareSemver,
  formatSemver,
  isNewer,
  parseSemver,
  type Semver,
} from '../../src/update/semver.ts';

const mustParse = (v: string): Semver => {
  const r = parseSemver(v);
  if (r === null) throw new Error(`expected ${v} to parse`);
  return r;
};

describe('parseSemver', () => {
  test('parses plain and v-prefixed', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver('v0.2.0')).toEqual({ major: 0, minor: 2, patch: 0, prerelease: [] });
  });
  test('parses prerelease and drops build metadata', () => {
    expect(parseSemver('1.2.3-rc.1')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ['rc', '1'],
    });
    expect(parseSemver('1.2.3+build.5')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver('1.2.3-rc.1+build')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ['rc', '1'],
    });
  });
  test('rejects malformed (null, never throw)', () => {
    for (const bad of ['1.2', '1.2.3.4', 'abc', '', '1.2.x', '-1.2.3', '1.2.3-', '1..3', 'v']) {
      expect(parseSemver(bad)).toBeNull();
    }
  });
});

describe('compareSemver', () => {
  const cmp = (a: string, b: string) => compareSemver(mustParse(a), mustParse(b));
  test('orders numeric triplet', () => {
    expect(cmp('1.2.3', '1.2.4')).toBe(-1);
    expect(cmp('2.0.0', '1.9.9')).toBe(1);
    expect(cmp('1.2.3', '1.2.3')).toBe(0);
  });
  test('stable outranks prerelease of same triplet', () => {
    expect(cmp('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(cmp('1.0.0', '1.0.0-rc.1')).toBe(1);
  });
  test('orders prerelease identifiers', () => {
    expect(cmp('1.0.0-rc.1', '1.0.0-rc.2')).toBe(-1);
    expect(cmp('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(cmp('1.0.0-rc.1', '1.0.0-rc.1.1')).toBe(-1); // more identifiers → higher
    expect(cmp('1.0.0-1', '1.0.0-alpha')).toBe(-1); // numeric < alpha
  });
});

describe('isNewer / formatSemver', () => {
  test('isNewer is strict', () => {
    expect(isNewer('0.2.0', '0.1.3')).toBe(true);
    expect(isNewer('0.1.3', '0.1.3')).toBe(false);
    expect(isNewer('0.1.2', '0.1.3')).toBe(false); // downgrade
    expect(isNewer('0.2.0', '0.2.0-rc.1')).toBe(true); // running RC → stable
  });
  test('malformed → false, never a false nag', () => {
    expect(isNewer('garbage', '0.1.3')).toBe(false);
    expect(isNewer('0.2.0', 'garbage')).toBe(false);
  });
  test('formatSemver round-trips', () => {
    for (const v of ['1.2.3', '0.2.0-rc.1', '10.0.0-alpha.1.2']) {
      expect(formatSemver(mustParse(v))).toBe(v);
    }
  });
});

describe('parseSemver — untrusted prerelease bytes (§0.4)', () => {
  // Build the control chars at runtime so no literal ESC/BEL/newline lives in
  // the source (invisible + fragile). These stand in for a forged release tag.
  const ch = (code: number): string => String.fromCharCode(code);
  test('rejects control chars / ANSI / whitespace / non-ASCII in prerelease', () => {
    for (const bad of [
      `9.9.9-${ch(27)}[2J`, // ESC — ANSI clear-screen
      `9.9.9-a${ch(10)}b`, // newline
      `9.9.9-a${ch(9)}b`, // tab
      '9.9.9-a b', // space
      '9.9.9-café', // non-ASCII
      `9.9.9-a.b${ch(7)}`, // BEL in the second identifier
    ]) {
      expect(parseSemver(bad)).toBeNull();
    }
  });
  test('accepts valid alnum/hyphen identifiers', () => {
    for (const ok of ['9.9.9-rc.1', '9.9.9-alpha-1', '1.0.0-x.7.z.92', '9.9.9-0']) {
      expect(parseSemver(ok)).not.toBeNull();
    }
  });
  test('rejects a leading-zero numeric identifier (SemVer §9)', () => {
    expect(parseSemver('9.9.9-01')).toBeNull();
    expect(parseSemver('9.9.9-1')).not.toBeNull();
  });
});

describe('parseSemver — length + large-numeric bounds', () => {
  test('rejects an over-long tag (DoS via a ~64KB prerelease)', () => {
    expect(parseSemver(`1.0.1-${'a'.repeat(300)}`)).toBeNull();
    expect(parseSemver(`1.0.0-${'a'.repeat(200)}`)).not.toBeNull(); // within the cap
  });
  test('numeric prerelease of 10-15 digits orders numerically, not lexically', () => {
    // 9999999999 (10 digits) < 10000000000 (11); a lexical compare flips it.
    expect(isNewer('1.0.0-9999999999', '1.0.0-10000000000')).toBe(false);
    expect(isNewer('1.0.0-10000000000', '1.0.0-9999999999')).toBe(true);
  });
  test('accepts a 10-15 digit main segment (epoch / CalVer)', () => {
    expect(isNewer('10000000000.0.0', '1.0.0')).toBe(true);
    expect(parseSemver('20240101.0.0')).not.toBeNull();
  });
});
