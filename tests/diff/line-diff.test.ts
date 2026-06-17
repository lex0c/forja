import { describe, expect, test } from 'bun:test';
import { type DiffLine, lineDiff } from '../../src/diff/line-diff.ts';

const types = (lines: DiffLine[]): string => lines.map((l) => l.type[0]).join('');
const texts = (lines: DiffLine[], type: string): string[] =>
  lines.filter((l) => l.type[0] === type).map((l) => l.text);

describe('lineDiff', () => {
  test('no change → zero counts, empty snippet', () => {
    const d = lineDiff('a\nb\nc\n', 'a\nb\nc\n');
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
    expect(d.snippet).toEqual([]);
    expect(d.hiddenChanges).toBe(0);
  });

  test('single line change → +1 -1 with surrounding context', () => {
    const d = lineDiff('a\nb\nc', 'a\nB\nc');
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    // ctx a, del b, add B, ctx c
    expect(types(d.snippet)).toBe('cdac'); // ctx,del,add,ctx
    expect(texts(d.snippet, 'd')).toEqual(['b']);
    expect(texts(d.snippet, 'a')).toEqual(['B']);
    expect(d.hiddenChanges).toBe(0);
  });

  test('pure insertion → +N, no removals', () => {
    const d = lineDiff('a\nb', 'a\nX\nY\nb');
    expect(d.added).toBe(2);
    expect(d.removed).toBe(0);
    expect(texts(d.snippet, 'a')).toEqual(['X', 'Y']);
  });

  test('pure deletion → -N, no additions', () => {
    const d = lineDiff('a\nX\nY\nb', 'a\nb');
    expect(d.added).toBe(0);
    expect(d.removed).toBe(2);
    expect(texts(d.snippet, 'd')).toEqual(['X', 'Y']);
  });

  test('new file (empty before) → all additions', () => {
    const d = lineDiff('', 'x\ny\nz');
    expect(d.added).toBe(3);
    expect(d.removed).toBe(0);
    expect(types(d.snippet)).toBe('aaa');
  });

  test('counts are accurate across multiple separate changes', () => {
    // a→A and c→C; b and d unchanged.
    const d = lineDiff('a\nb\nc\nd', 'A\nb\nC\nd');
    expect(d.added).toBe(2);
    expect(d.removed).toBe(2);
  });

  test('snippet is bounded; extra changes fold into hiddenChanges', () => {
    const before = Array.from({ length: 20 }, (_, i) => `old${i}`).join('\n');
    const after = Array.from({ length: 20 }, (_, i) => `new${i}`).join('\n');
    const d = lineDiff(before, after, { maxSnippetLines: 6 });
    expect(d.added).toBe(20);
    expect(d.removed).toBe(20);
    expect(d.snippet.length).toBeLessThanOrEqual(6);
    // everything not in the 6-line snippet is hidden
    expect(d.hiddenChanges).toBe(40 - d.snippet.filter((l) => l.type !== 'ctx').length);
    expect(d.hiddenChanges).toBeGreaterThan(0);
  });

  test('a small change in a large file: correct counts, snippet only the changed region', () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const before = big.join('\n');
    const after = [...big];
    after[250] = 'CHANGED';
    const d = lineDiff(before, after.join('\n'));
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    // The snippet is the changed region + a little context — NOT 500 lines.
    expect(d.snippet.length).toBeLessThanOrEqual(8);
    expect(texts(d.snippet, 'a')).toEqual(['CHANGED']);
    expect(texts(d.snippet, 'd')).toEqual(['line 250']);
  });

  test('trailing-newline normalization: "a\\nb\\n" equals "a\\nb"', () => {
    expect(lineDiff('a\nb\n', 'a\nb').added).toBe(0);
    expect(lineDiff('a\nb\n', 'a\nb').removed).toBe(0);
  });
});

describe('lineDiff — line numbers', () => {
  // Compact triple per line for readable assertions: text + the two 1-based
  // positions (undefined where the line doesn't exist on that side).
  const positions = (lines: DiffLine[]) =>
    lines.map((l) => [l.text, l.oldLine, l.newLine] as const);

  test('single replace: ctx carries both, del carries old, add carries new', () => {
    const d = lineDiff('a\nb\nc', 'a\nB\nc');
    expect(positions(d.snippet)).toEqual([
      ['a', 1, 1],
      ['b', 2, undefined], // del → old only
      ['B', undefined, 2], // add → new only
      ['c', 3, 3],
    ]);
  });

  test('pure insertion: added lines get consecutive new-file numbers', () => {
    const d = lineDiff('a\nb', 'a\nX\nY\nb');
    expect(positions(d.snippet)).toEqual([
      ['a', 1, 1],
      ['X', undefined, 2],
      ['Y', undefined, 3],
      ['b', 2, 4], // b shifted down to new line 4
    ]);
  });

  test('pure deletion: deleted lines keep their old-file numbers', () => {
    const d = lineDiff('a\nX\nY\nb', 'a\nb');
    expect(positions(d.snippet)).toEqual([
      ['a', 1, 1],
      ['X', 2, undefined],
      ['Y', 3, undefined],
      ['b', 4, 2], // b moved up to new line 2
    ]);
  });

  test('numbers are absolute, not snippet-relative, for a change deep in a file', () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const after = [...big];
    after[250] = 'CHANGED'; // 0-based index 250 → 1-based line 251
    const d = lineDiff(big.join('\n'), after.join('\n'));
    const del = d.snippet.find((l) => l.type === 'del');
    const add = d.snippet.find((l) => l.type === 'add');
    expect(del?.oldLine).toBe(251);
    expect(add?.newLine).toBe(251);
  });
});
