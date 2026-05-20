import { describe, expect, test } from 'bun:test';
import { renderShimmer } from '../../../src/tui/render/shimmer.ts';
import type { Capabilities } from '../../../src/tui/term.ts';

const caps: Capabilities = { isTTY: true, cols: 80, rows: 24, color: 'basic', unicode: true };
const noColor: Capabilities = { ...caps, color: 'none' };

describe('renderShimmer', () => {
  test('returns the text untouched under NO_COLOR', () => {
    expect(renderShimmer('Awaiting model…', noColor, 0, 'secondary')).toBe('Awaiting model…');
  });

  test('paints the centre accent, its neighbour default, the rest base', () => {
    // now 0 → centre at index 0: char 0 = accent, char 1 = default
    // (bare), chars 2+ = the base token.
    expect(renderShimmer('abcd', caps, 0, 'secondary')).toBe(
      '\x1b[94ma\x1b[0mb\x1b[90mc\x1b[0m\x1b[90md\x1b[0m',
    );
  });

  test('the highlight advances with now', () => {
    // SHIMMER_SPEED_MS = 90 → now 90 moves the centre one position.
    const at0 = renderShimmer('abcd', caps, 0, 'secondary');
    const at90 = renderShimmer('abcd', caps, 90, 'secondary');
    expect(at90).not.toBe(at0);
    expect(at90).toContain('\x1b[94mb\x1b[0m'); // centre now on index 1
  });

  test('the base token is parametrized (secondary / warn / error)', () => {
    // a char far from the centre takes the base token verbatim.
    expect(renderShimmer('abcd', caps, 0, 'warn')).toContain('\x1b[33md\x1b[0m');
    expect(renderShimmer('abcd', caps, 0, 'error')).toContain('\x1b[31md\x1b[0m');
  });
});
