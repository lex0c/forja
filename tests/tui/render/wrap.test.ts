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

  test('chunk boundary on high surrogate pulls back by one code unit', () => {
    // 'aaaaaaa' = 7 ASCII, then 😀 (UTF-16: D83D DE00). innerWidth=8
    // would put the chunk end at code-unit 8 — that's exactly D83D
    // (high surrogate) with DE00 as the next char. Pull-back makes
    // the first chunk 7 chars wide, second chunk picks up the full
    // pair plus the trailing 'b'.
    const line = `${'a'.repeat(7)}😀b`;
    expect(wrapInputLine(line, 8)).toEqual([
      { start: 0, end: 7 },
      { start: 7, end: 10 }, // 😀b — DE00 ends at 9, b at 10
    ]);
  });

  test('non-boundary surrogate stays in its chunk untouched', () => {
    // Emoji entirely within the first chunk: no pull-back needed.
    const line = `😀${'a'.repeat(10)}`;
    const chunks = wrapInputLine(line, 8);
    // Chunk 0 holds the whole emoji + 6 ASCII = 8 code units.
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

  test('multiple consecutive emoji at boundaries each get pulled back', () => {
    // Two emoji at successive boundaries should each be kept whole.
    const line = `${'a'.repeat(7)}😀${'b'.repeat(6)}😀c`;
    const chunks = wrapInputLine(line, 8);
    const slice = (i: number): string => {
      const c = chunks[i];
      if (c === undefined) throw new Error(`chunk ${i} missing`);
      return line.slice(c.start, c.end);
    };
    // Chunk 0 = 'aaaaaaa' (7) — pulled back from boundary at high
    // surrogate of first emoji.
    expect(slice(0)).toBe('aaaaaaa');
    // Chunk 1 picks up the first 😀 and as much filler as fits up
    // to the next surrogate boundary.
    expect(slice(1).startsWith('😀')).toBe(true);
    // Final chunk must contain the second emoji whole + 'c'.
    expect(slice(chunks.length - 1).endsWith('😀c')).toBe(true);
  });
});
