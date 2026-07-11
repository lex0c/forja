import { describe, expect, test } from 'bun:test';
import { generateUlid, isUlid } from '../../src/permissions/ulid.ts';

describe('generateUlid', () => {
  test('produces 26 characters in Crockford base32', () => {
    const ulid = generateUlid();
    expect(ulid).toHaveLength(26);
    // No I, L, O, U; no lowercase.
    expect(/^[0-9A-HJKMNP-TV-Z]+$/.test(ulid)).toBe(true);
  });

  test('lexicographic order tracks chronological order (time-sortable)', () => {
    // Pin the random part so only the timestamp varies between calls.
    // Earlier ts → smaller string under simple `<` comparison.
    const fixedRand = (): Uint8Array => new Uint8Array(10);
    const a = generateUlid({ now: () => 1_731_000_000_000, randomBytes: fixedRand });
    const b = generateUlid({ now: () => 1_731_000_000_001, randomBytes: fixedRand });
    const c = generateUlid({ now: () => 1_731_000_001_000, randomBytes: fixedRand });
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
    expect(a < c).toBe(true);
  });

  test('deterministic with injected now + randomBytes', () => {
    // Same inputs → same output. Required for tests that anchor on
    // specific ULID values (replay fixtures, golden files).
    const ts = 1_731_000_000_000;
    const rand = (): Uint8Array => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const a = generateUlid({ now: () => ts, randomBytes: rand });
    const b = generateUlid({ now: () => ts, randomBytes: rand });
    expect(a).toBe(b);
  });

  test('different random bytes at same ts produce different ULIDs', () => {
    const ts = 1_731_000_000_000;
    const a = generateUlid({
      now: () => ts,
      randomBytes: () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    });
    const b = generateUlid({
      now: () => ts,
      randomBytes: () => new Uint8Array([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]),
    });
    expect(a).not.toBe(b);
    // Timestamp half (first 10 chars) DOES match — only random half differs.
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    expect(a.slice(10)).not.toBe(b.slice(10));
  });

  test('rejects negative timestamps', () => {
    expect(() => generateUlid({ now: () => -1 })).toThrow(/invalid timestamp/);
  });

  test('rejects timestamps beyond the 48-bit cap', () => {
    // 2^48 = 281474976710656 — one past the cap.
    expect(() => generateUlid({ now: () => 281_474_976_710_656 })).toThrow(/exceeds 48-bit cap/);
  });

  test('rejects NaN / Infinity timestamps', () => {
    expect(() => generateUlid({ now: () => Number.NaN })).toThrow(/invalid timestamp/);
    expect(() => generateUlid({ now: () => Number.POSITIVE_INFINITY })).toThrow(
      /invalid timestamp/,
    );
  });

  test('default RNG produces distinct values across calls (cryptographic)', () => {
    // Sanity: 100 successive calls with the system clock should
    // produce 100 distinct values. ULID collision in this window
    // is cryptographically improbable (80 random bits per call).
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generateUlid());
    expect(seen.size).toBe(100);
  });
});

describe('isUlid', () => {
  test('accepts a fresh ULID', () => {
    expect(isUlid(generateUlid())).toBe(true);
  });

  test('rejects wrong length', () => {
    expect(isUlid('01JN5G8X')).toBe(false); // too short
    expect(isUlid('01JN5G8X'.repeat(5))).toBe(false); // too long
  });

  test('rejects lowercase (ULID canonical form is uppercase)', () => {
    // Even though Crockford base32 is case-insensitive in spec, the
    // ULID canonical encoding is uppercase. Lower-cased pastes
    // should round-trip through `isUlid` returning false so the
    // caller can normalize explicitly.
    const ulid = generateUlid();
    expect(isUlid(ulid.toLowerCase())).toBe(false);
  });

  test('rejects ambiguous glyphs I / L / O / U', () => {
    // Force-construct a 26-char string with the forbidden letters.
    expect(isUlid('IIIIIIIIIIIIIIIIIIIIIIIIII')).toBe(false);
    expect(isUlid('LLLLLLLLLLLLLLLLLLLLLLLLLL')).toBe(false);
    expect(isUlid('OOOOOOOOOOOOOOOOOOOOOOOOOO')).toBe(false);
    expect(isUlid('UUUUUUUUUUUUUUUUUUUUUUUUUU')).toBe(false);
  });

  test('rejects empty + whitespace', () => {
    expect(isUlid('')).toBe(false);
    expect(isUlid('   ')).toBe(false);
  });
});
