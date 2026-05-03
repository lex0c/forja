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
});
