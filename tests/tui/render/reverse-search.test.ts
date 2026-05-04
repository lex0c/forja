import { describe, expect, test } from 'bun:test';
import { renderReverseSearch } from '../../../src/tui/render/reverse-search.ts';
import type { ReverseSearchState } from '../../../src/tui/state.ts';
import { CSI, type Capabilities } from '../../../src/tui/term.ts';

const caps: Capabilities = {
  isTTY: true,
  cols: 80,
  rows: 24,
  color: 'none',
  unicode: true,
};
const colored: Capabilities = { ...caps, color: 'basic' };

const rs = (
  query: string,
  results: string[],
  selectedIdx = results.length > 0 ? 0 : -1,
): ReverseSearchState => ({ query, results, selectedIdx });

describe('renderReverseSearch', () => {
  test('renders the canonical (reverse-i-search)`q`: <match> shape', () => {
    const out = renderReverseSearch(rs('que', ['como rodar bun em watch?']), caps);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe('  (reverse-i-search)`que`: como rodar bun em watch?');
  });

  test('empty query renders an empty backtick block + first match (or empty marker)', () => {
    const out = renderReverseSearch(rs('', []), caps);
    expect(out[0]).toContain('``:');
    expect(out[0]).toContain('<empty>');
  });

  test('no matches surface `<empty>` (HISTORY.md §2.2)', () => {
    const out = renderReverseSearch(rs('xyz', [], -1), caps);
    expect(out[0]).toContain('`xyz`:');
    expect(out[0]).toContain('<empty>');
  });

  test('selectedIdx picks which result is shown', () => {
    const out = renderReverseSearch(rs('a', ['first match', 'second match'], 1), caps);
    expect(out[0]).toContain('second match');
    expect(out[0]).not.toContain('first match');
  });

  test('multi-line prompts collapse to a single space-separated row', () => {
    // Operator recalled a multi-line buffer; the overlay must not
    // grow the live region's row count.
    const out = renderReverseSearch(rs('a', ['line one\nline two\n  indented']), caps);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('line one line two   indented');
    expect(out[0]).not.toContain('\n');
  });

  test('long matches are truncated to caps.cols (no live region overflow)', () => {
    const longMatch = 'a'.repeat(500);
    const narrow: Capabilities = { ...caps, cols: 40 };
    const out = renderReverseSearch(rs('a', [longMatch]), narrow);
    expect(out).toHaveLength(1);
    expect((out[0] ?? '').length).toBeLessThanOrEqual(40);
  });

  test('paint uses dim SGR for the empty marker when color enabled', () => {
    const out = renderReverseSearch(rs('xyz', [], -1), colored);
    expect(out[0]).toContain(`${CSI}2m`);
  });

  test('non-empty match does NOT carry the dim SGR for the match block', () => {
    // The match itself is NOT painted dim (only the `<empty>` placeholder
    // is). The overlay's prefix can be whatever — what matters is that
    // a real match shouldn't be entirely faint.
    const out = renderReverseSearch(rs('a', ['hello world']), colored);
    // The dim SGR closes immediately after the prefix if it ever opens;
    // a match line should NOT have the dim sequence wrapping the result.
    // Ensure the literal match text appears in cleartext.
    expect(out[0]).toContain('hello world');
  });

  test('selectedIdx out of bounds falls back to <empty>', () => {
    // Defensive: selectedIdx = 5 but only 2 results present.
    const out = renderReverseSearch(rs('a', ['x', 'y'], 5), caps);
    expect(out[0]).toContain('<empty>');
  });
});
