import { describe, expect, test } from 'bun:test';
import { truncateUtf8, writeAll } from '../../src/fs/atomic-write.ts';

// writeAll is the partial-write-safe loop atomicWrite uses. A real local
// filesystem won't short-write a small buffer, so the loop is tested
// directly with a fake writer that returns whatever byte counts we want —
// no fs / fault injection needed.
describe('writeAll — partial-write-safe loop', () => {
  test('one call when the writer accepts everything', () => {
    const offsets: number[] = [];
    writeAll(
      (off) => {
        offsets.push(off);
        return 10 - off;
      },
      10,
      'x',
    );
    expect(offsets).toEqual([0]);
  });

  test('loops across short writes until all bytes land', () => {
    const offsets: number[] = [];
    writeAll(
      (off) => {
        offsets.push(off);
        return 3; // every write accepts only 3 bytes
      },
      10,
      'x',
    );
    // 3 + 3 + 3 + 1 = 10
    expect(offsets).toEqual([0, 3, 6, 9]);
  });

  test('throws (does not spin) when the writer makes no progress', () => {
    let calls = 0;
    expect(() =>
      writeAll(
        () => {
          calls += 1;
          return 0; // disk full / no forward progress
        },
        10,
        'g.txt',
      ),
    ).toThrow(/short write: only 0 of 10 bytes written to g\.txt/);
    expect(calls).toBe(1); // threw on the first no-progress write, no loop
  });

  test('makes no write call for zero-length content', () => {
    let called = false;
    writeAll(
      () => {
        called = true;
        return 0;
      },
      0,
      'empty',
    );
    expect(called).toBe(false);
  });
});

describe('truncateUtf8 — byte-bounded, char-safe truncation', () => {
  test('returns the string unchanged when within the byte budget', () => {
    expect(truncateUtf8('hello', 10)).toBe('hello');
    expect(truncateUtf8('hello', 5)).toBe('hello');
  });

  test('truncates ASCII to exactly the byte budget', () => {
    expect(truncateUtf8('abcdefghij', 4)).toBe('abcd');
  });

  test('never splits a 3-byte char and stays within budget', () => {
    // '中' is 3 UTF-8 bytes; a 4-byte budget keeps one whole char, not 1⅓.
    const out = truncateUtf8('中中中', 4);
    expect(out).toBe('中');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(4);
  });

  test('never splits a 4-byte char (emoji) at the boundary', () => {
    // '🚀' is 4 UTF-8 bytes (2 UTF-16 units): a 3-byte budget can't fit it.
    expect(truncateUtf8('🚀x', 3)).toBe('');
    expect(truncateUtf8('🚀x', 4)).toBe('🚀');
  });

  test('caps a long non-ASCII name well under NAME_MAX (the bug this fixes)', () => {
    // 200 × '中' = 600 UTF-8 bytes but only 200 UTF-16 units — a code-unit
    // slice(0,128) would leave ~384 bytes. The byte cap keeps it ≤ 80.
    const slice = truncateUtf8('中'.repeat(200), 80);
    expect(Buffer.byteLength(slice, 'utf8')).toBeLessThanOrEqual(80);
    expect(slice).toBe('中'.repeat(26)); // 26 × 3 = 78 bytes; a 27th would hit 81
  });
});
