import { describe, expect, test } from 'bun:test';
import { wrapInputLine } from '../../../src/tui/render/wrap.ts';

describe('wrapInputLine', () => {
  test('empty line yields no chunks', () => {
    expect(wrapInputLine('', 8)).toEqual([]);
  });

  test('line shorter than innerWidth is one chunk', () => {
    expect(wrapInputLine('abc', 8)).toEqual([{ start: 0, end: 3 }]);
  });

  test('line at exactly innerWidth is one chunk', () => {
    expect(wrapInputLine('abcdefgh', 8)).toEqual([{ start: 0, end: 8 }]);
  });

  test('long ASCII line splits into uniform chunks', () => {
    expect(wrapInputLine('abcdefghij', 4)).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 8 },
      { start: 8, end: 10 },
    ]);
  });

  test('surrogate pair is never split across a chunk boundary', () => {
    // 'aaaaaaa' = 7 ASCII (7 cols), then 😀 (2 cols, UTF-16 D83D DE00).
    // After 7 cols the emoji (2 cols) doesn't fit in the width-8 budget,
    // so it wraps to the next chunk WHOLE — codepoint-stepping means the
    // boundary lands at code-unit 7, never inside the pair.
    const line = `${'a'.repeat(7)}😀b`;
    expect(wrapInputLine(line, 8)).toEqual([
      { start: 0, end: 7 },
      { start: 7, end: 10 }, // 😀b — DE00 ends at 9, b at 10
    ]);
  });

  test('emoji that fits stays whole in its chunk', () => {
    // 😀 (2 cols) + 6 ASCII (6 cols) = 8 cols = budget → one chunk, pair
    // intact.
    const line = `😀${'a'.repeat(10)}`;
    const chunks = wrapInputLine(line, 8);
    expect(chunks[0]).toEqual({ start: 0, end: 8 });
  });

  test('innerWidth=1 with a non-BMP char emits an over-wide chunk (forward progress)', () => {
    // Pathological: width 1 can't hold a surrogate pair without
    // splitting it. We accept a 2-unit chunk to guarantee
    // termination — better an over-wide row than an infinite loop.
    const line = '😀a';
    const chunks = wrapInputLine(line, 1);
    expect(chunks[0]).toEqual({ start: 0, end: 2 });
    expect(chunks[1]).toEqual({ start: 2, end: 3 });
  });

  test('wraps by VISUAL width, not code units (wide CJK = 2 cols)', () => {
    // '中' is one UTF-16 code unit but renders 2 columns. At innerWidth
    // 8 only FOUR fit per row (4×2 = 8 cols) — code-unit chunking would
    // have packed 8 per row and overflowed the terminal to ~16 cols.
    expect(wrapInputLine('中'.repeat(6), 8)).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 6 },
    ]);
  });

  test('wide chars that fit exactly stay in one chunk', () => {
    // 4 × '中' = 8 cols = innerWidth → single chunk, no overflow.
    expect(wrapInputLine('中中中中', 8)).toEqual([{ start: 0, end: 4 }]);
  });

  test('a single wide glyph wider than innerWidth gets its own over-budget chunk', () => {
    // innerWidth 1 can't hold a 2-col glyph; admit it alone (forward
    // progress) rather than loop forever.
    expect(wrapInputLine('中a', 1)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ]);
  });

  test('multiple emoji across wraps each stay whole', () => {
    const line = `${'a'.repeat(7)}😀${'b'.repeat(6)}😀c`;
    const chunks = wrapInputLine(line, 8);
    const slice = (i: number): string => {
      const c = chunks[i];
      if (c === undefined) throw new Error(`chunk ${i} missing`);
      return line.slice(c.start, c.end);
    };
    // Chunk 0 = 'aaaaaaa' (7 cols); the first emoji (2 cols) didn't fit.
    expect(slice(0)).toBe('aaaaaaa');
    // Chunk 1 opens with the first 😀, whole.
    expect(slice(1).startsWith('😀')).toBe(true);
    // Final chunk holds the second emoji whole + 'c'.
    expect(slice(chunks.length - 1).endsWith('😀c')).toBe(true);
  });
});
