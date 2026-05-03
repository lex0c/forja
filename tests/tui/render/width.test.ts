import { describe, expect, test } from 'bun:test';
import { truncateToWidth, visualWidth } from '../../../src/tui/render/width.ts';

describe('visualWidth', () => {
  test('ASCII counts as code-unit length', () => {
    expect(visualWidth('hello')).toBe(5);
  });

  test('CJK characters count as 2 columns each', () => {
    expect(visualWidth('日本')).toBe(4);
  });

  test('emoji presentation counts as 2 columns', () => {
    expect(visualWidth('🚀')).toBe(2);
  });

  test('ANSI escapes have zero visual width', () => {
    expect(visualWidth('\x1b[31mred\x1b[0m')).toBe(3);
  });

  test('empty string is zero', () => {
    expect(visualWidth('')).toBe(0);
  });
});

describe('truncateToWidth', () => {
  test('returns original when it already fits', () => {
    expect(truncateToWidth('hello', 10)).toBe('hello');
  });

  test('truncates ASCII at exact column', () => {
    expect(truncateToWidth('hello world', 5)).toBe('hello');
  });

  test('truncates CJK respecting 2-column glyphs', () => {
    // Each kanji = 2 cols. Budget 5 fits 2 + 1 leftover col we can't
    // use (next char would be 2 wide), so output is 2 chars / 4 cols.
    expect(truncateToWidth('日本語', 5)).toBe('日本');
  });

  test('budget 0 returns empty', () => {
    expect(truncateToWidth('hello', 0)).toBe('');
  });

  test('budget negative returns empty', () => {
    expect(truncateToWidth('hello', -1)).toBe('');
  });

  test('emoji that does not fit is dropped, not split', () => {
    // '🚀' is one codepoint, 2 cols. Budget 1 → no fit, output empty.
    expect(truncateToWidth('🚀', 1)).toBe('');
  });

  test('keeps preceding ASCII before an oversize emoji', () => {
    // 'ab🚀' → budget 3 fits 'ab' (2 cols) + '🚀' (2 cols) = 4 cols
    // total. Stops before emoji because adding it overflows.
    expect(truncateToWidth('ab🚀', 3)).toBe('ab');
  });

  test('preserves CSI escape sequences as zero-width', () => {
    const colored = '\x1b[31mhello\x1b[0m'; // visualWidth = 5
    // Exact-fit: passes through intact.
    expect(truncateToWidth(colored, 5)).toBe(colored);
    // Truncate visible content but keep escape sequences whole.
    expect(truncateToWidth(colored, 3)).toBe('\x1b[31mhel\x1b[0m');
    expect(truncateToWidth(colored, 1)).toBe('\x1b[31mh\x1b[0m');
  });

  test('does not corrupt CSI sequences when budget runs out mid-text', () => {
    // 'ab\x1b[31mc\x1b[0md' has visual width 4. Budget 2 should
    // emit 'ab' + the CSI escapes that follow with zero remaining
    // budget for visible content — never split a sequence into 'ab\x1b'.
    const out = truncateToWidth('ab\x1b[31mc\x1b[0md', 2);
    // No orphan ESC at the tail (escape byte not followed by `[`).
    const ESC = '';
    const tail = out.charCodeAt(out.length - 1);
    expect(tail).not.toBe(0x1b);
    // No half-CSI at the tail (escape sequence with no final byte).
    const lastEsc = out.lastIndexOf(ESC);
    if (lastEsc !== -1) {
      const lastByte = out.charCodeAt(out.length - 1);
      expect(lastByte).toBeGreaterThanOrEqual(0x40);
      expect(lastByte).toBeLessThanOrEqual(0x7e);
    }
    expect(out.startsWith('ab')).toBe(true);
  });
});
