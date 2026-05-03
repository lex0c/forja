import { describe, expect, test } from 'bun:test';
import { renderInput } from '../../../src/tui/render/input.ts';
import type { Capabilities } from '../../../src/tui/term.ts';

const caps: Capabilities = {
  isTTY: true,
  cols: 80,
  rows: 24,
  color: 'none',
  unicode: true,
};

describe('renderInput', () => {
  test('empty input shows just the prompt prefix', () => {
    expect(renderInput({ value: '', cursor: 0 }, caps)).toEqual(['> ']);
  });

  test('single line gets prompt prefix', () => {
    expect(renderInput({ value: 'hello', cursor: 5 }, caps)).toEqual(['> hello']);
  });

  test('multi-line indents continuation rows by 2 spaces', () => {
    expect(renderInput({ value: 'first\nsecond\nthird', cursor: 0 }, caps)).toEqual([
      '> first',
      '  second',
      '  third',
    ]);
  });

  test('preserves a trailing empty line', () => {
    // User pressed Shift+Enter at the end — there's a trailing newline
    // and we surface it as an empty continuation row so the cursor has
    // somewhere visible to live.
    expect(renderInput({ value: 'abc\n', cursor: 4 }, caps)).toEqual(['> abc', '  ']);
  });

  test('soft-wrap does not split a surrogate pair across rows', () => {
    // Regression: previously `line.slice(pos, pos + innerWidth)` would
    // cut emoji like 😀 (U+1F600 — surrogate pair "😀") in
    // half if the wrap boundary fell between its two code units. The
    // terminal then rendered U+FFFD halves and every column drifted
    // by one for the rest of the line.
    //
    // Build a line whose 1F600 sits exactly at the boundary: with
    // narrow caps cols=10, prompt prefix = 2, innerWidth = 8. Filler
    // of 7 ASCII chars lands the high surrogate at column 8; without
    // the fix the chunk would be `'\uD83D'` (broken) and the next
    // would start with `'\uDE00'` (also broken).
    const narrow: Capabilities = { ...caps, cols: 10 };
    const line = `${'a'.repeat(7)}😀b`;
    const out = renderInput({ value: line, cursor: 0 }, narrow);
    // First sub-row must NOT end with a lone high surrogate.
    expect(out[0]).toBe('> aaaaaaa');
    // Second sub-row carries the full emoji intact.
    expect(out[1]).toBe('  😀b');
  });
});
