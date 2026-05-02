import { describe, expect, test } from 'bun:test';
import { renderModal } from '../../../src/tui/render/modal.ts';
import type { ConfirmState } from '../../../src/tui/state.ts';
import { CSI, type Capabilities } from '../../../src/tui/term.ts';

const ascii: Capabilities = {
  isTTY: true,
  cols: 80,
  rows: 24,
  color: 'none',
  unicode: false,
};
const unicode: Capabilities = { ...ascii, unicode: true };
const colored: Capabilities = { ...unicode, color: 'basic' };

const baseModal = (overrides: Partial<ConfirmState> = {}): ConfirmState => ({
  promptId: 'p1',
  flavor: 'permission',
  message: 'bash: rm -rf ./build',
  details: ['cwd: /home/lex/forja'],
  selected: 'no',
  ...overrides,
});

describe('renderModal', () => {
  test('emits headline + details + selector + horizontal rules', () => {
    const out = renderModal(baseModal(), unicode);
    // Top rule, headline, blank, details, blank, selector, bottom rule.
    expect(out).toHaveLength(7);
    expect(out[0]).toMatch(/^─+$/);
    expect(out[1]).toContain('bash: rm -rf ./build');
    expect(out[3]).toContain('cwd: /home/lex/forja');
    expect(out[5]).toContain('YES');
    expect(out[5]).toContain('NO');
    expect(out[6]).toMatch(/^─+$/);
  });

  test('rules use ASCII dashes when unicode disabled', () => {
    const out = renderModal(baseModal(), ascii);
    expect(out[0]).toMatch(/^-+$/);
    expect(out[out.length - 1]).toMatch(/^-+$/);
  });

  test('selected="no" puts the pointer next to NO (default safety)', () => {
    const out = renderModal(baseModal({ selected: 'no' }), unicode);
    const sel = out[5] ?? '';
    // Pointer (▶) precedes NO; YES has a leading space placeholder.
    expect(sel).toContain('▶ NO');
    expect(sel).toContain('  YES');
    expect(sel).not.toContain('▶ YES');
  });

  test('selected="yes" puts the pointer next to YES', () => {
    const out = renderModal(baseModal({ selected: 'yes' }), unicode);
    const sel = out[5] ?? '';
    expect(sel).toContain('▶ YES');
    expect(sel).toContain('  NO');
    expect(sel).not.toContain('▶ NO');
  });

  test('ASCII pointer is ">"', () => {
    const out = renderModal(baseModal({ selected: 'yes' }), ascii);
    const sel = out[5] ?? '';
    expect(sel).toContain('> YES');
  });

  test('no details: collapses the empty section', () => {
    const out = renderModal(baseModal({ details: [] }), unicode);
    // Top rule, headline, blank, selector, bottom rule = 5 lines.
    expect(out).toHaveLength(5);
  });

  test('empty details entry becomes a blank spacer (no indent, no content)', () => {
    const out = renderModal(baseModal({ details: ['line one', '', 'line three'] }), unicode);
    // Find the section after the headline+blank.
    const fragment = out.slice(3, 6);
    expect(fragment[0]).toContain('line one');
    expect(fragment[1]).toBe('');
    expect(fragment[2]).toContain('line three');
  });

  test('headline wrapped in bold SGR when color enabled', () => {
    const out = renderModal(baseModal(), colored);
    expect(out[1]).toContain(`${CSI}1m`);
    expect(out[1]).toContain('bash: rm -rf ./build');
  });

  test('details wrapped in dim SGR when color enabled', () => {
    const out = renderModal(baseModal(), colored);
    expect(out[3]).toContain(`${CSI}2m`);
  });

  test('color disabled: no SGR escapes anywhere', () => {
    const out = renderModal(baseModal(), ascii);
    for (const line of out) {
      expect(line).not.toContain(CSI);
    }
  });

  test('rule adapts to caps.cols when narrower than the default 41', () => {
    const narrow: Capabilities = { ...unicode, cols: 30 };
    const out = renderModal(baseModal(), narrow);
    // cols - 2 = 28 (the indent). Rule is 28 wide, not the default 41.
    expect(out[0]?.length).toBe(28);
    expect(out[out.length - 1]?.length).toBe(28);
  });

  test('rule honors the minimum width when caps.cols is tiny', () => {
    const tiny: Capabilities = { ...unicode, cols: 4 };
    const out = renderModal(baseModal(), tiny);
    // Min rule width = 8 (constant in renderer).
    expect(out[0]?.length).toBe(8);
  });

  test('rule does not exceed the default width on wide terminals', () => {
    const wide: Capabilities = { ...unicode, cols: 200 };
    const out = renderModal(baseModal(), wide);
    expect(out[0]?.length).toBe(41);
  });
});
