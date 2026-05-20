import { describe, expect, test } from 'bun:test';
import { renderMarkdown } from '../../../src/tui/render/markdown.ts';
import type { Capabilities } from '../../../src/tui/term.ts';

// Wide enough that the short fixtures below never wrap; the wrap test
// shrinks `cols` itself.
const caps: Capabilities = { isTTY: true, cols: 60, rows: 24, color: 'none', unicode: true };
const ascii: Capabilities = { ...caps, unicode: false };
const colored: Capabilities = { ...caps, color: 'basic' };

describe('renderMarkdown', () => {
  test('heading renders without the # prefix', () => {
    expect(renderMarkdown('# Title', caps)).toEqual(['Title']);
  });

  test('plain prose passes through as a paragraph', () => {
    expect(renderMarkdown('just text', caps)).toEqual(['just text']);
  });

  test('empty input renders nothing', () => {
    expect(renderMarkdown('', caps)).toEqual([]);
  });

  test('a blank line separates blocks', () => {
    expect(renderMarkdown('one\n\ntwo', caps)).toEqual(['one', '', 'two']);
  });

  test('a paragraph word-wraps to the frame width', () => {
    // cols 22 → frameWidth 20. No styling (color none) → line.length
    // is the visible width.
    const out = renderMarkdown('word '.repeat(30).trim(), { ...caps, cols: 22 });
    expect(out.length).toBeGreaterThan(1);
    for (const line of out) expect(line.length).toBeLessThanOrEqual(20);
  });

  test('bullet list: • marker under Unicode, - under ASCII', () => {
    expect(renderMarkdown('- a\n- b', caps)).toEqual(['• a', '• b']);
    expect(renderMarkdown('- a\n- b', ascii)).toEqual(['- a', '- b']);
  });

  test('ordered list numbers from the list start', () => {
    expect(renderMarkdown('1. a\n2. b', caps)).toEqual(['1. a', '2. b']);
  });

  test('task list renders [ ] / [x] checkboxes', () => {
    expect(renderMarkdown('- [ ] todo\n- [x] done', caps)).toEqual(['[ ] todo', '[x] done']);
  });

  test('a nested list indents under its parent, no blank between', () => {
    expect(renderMarkdown('- a\n  - b', caps)).toEqual(['• a', '  • b']);
  });

  test('code fence: indented two columns, fence markers dropped', () => {
    expect(renderMarkdown('```ts\nconst x = 1\n```', caps)).toEqual(['  const x = 1']);
  });

  test('blockquote: │ prefix (| under ASCII)', () => {
    expect(renderMarkdown('> quoted', caps)).toEqual(['│ quoted']);
    expect(renderMarkdown('> quoted', ascii)).toEqual(['| quoted']);
  });

  test('thematic break: a rule the width of the frame', () => {
    // cols 12 → frameWidth 10.
    expect(renderMarkdown('---', { ...caps, cols: 12 })).toEqual(['──────────']);
  });

  test('GFM table: rows as cells joined by a separator (slice-A fallback)', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |';
    expect(renderMarkdown(md, caps)).toEqual(['A · B', '1 · 2']);
    expect(renderMarkdown(md, ascii)).toEqual(['A | B', '1 | 2']);
  });

  test('inline emphasis maps to SGR runs (colored)', () => {
    const out = renderMarkdown('a **b** `c` *d* ~~e~~', colored);
    expect(out[0]).toBe('a \x1b[1mb\x1b[0m \x1b[90mc\x1b[0m \x1b[3md\x1b[0m \x1b[9me\x1b[0m');
  });

  test('inline styling is absent under color: none', () => {
    expect(renderMarkdown('a **b** `c`', caps)).toEqual(['a b c']);
  });

  test('a link shows the URL dimmed alongside the label', () => {
    expect(renderMarkdown('see [docs](https://x.io)', caps)).toEqual(['see docs (https://x.io)']);
  });
});
