import { describe, expect, test } from 'bun:test';
import { writeAll } from '../../src/fs/atomic-write.ts';

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
