import { describe, expect, test } from 'bun:test';
import { renderModal } from '../../../src/tui/render/modal.ts';
import type { ConfirmOption, ConfirmState } from '../../../src/tui/state.ts';
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

const PERM_OPTIONS: ConfirmOption[] = [
  { key: '1', label: 'Yes', value: 'yes' },
  {
    key: '2',
    label: 'Yes, allow all bash during this session',
    value: 'session-allow',
    shortcut: 'shift+tab',
  },
  { key: '3', label: 'No', value: 'no' },
];

const baseModal = (overrides: Partial<ConfirmState> = {}): ConfirmState => ({
  promptId: 'p1',
  flavor: 'permission',
  title: 'Run command',
  subject: 'rm -rf ./build',
  preview: ['$ rm -rf ./build', 'cwd: /home/lex/forja'],
  question: 'Do you want to run this bash command?',
  options: PERM_OPTIONS,
  selectedIndex: PERM_OPTIONS.length - 1,
  hints: ['Esc to cancel'],
  queueDepth: 0,
  ...overrides,
});

describe('renderModal (UI.md §4.10.13 layout)', () => {
  test('emits 4 blocks separated by horizontal rules', () => {
    const out = renderModal(baseModal(), unicode);
    // Block 1: rule + title + subject (3 lines)
    // Block 2: rule + 2 preview lines (3 lines)
    // Block 3: rule + question + 3 options (5 lines)
    // Block 4: hint footer (1 line)
    // Total = 12.
    expect(out).toHaveLength(12);
    expect(out[0]).toMatch(/^─+$/); // rule 1
    expect(out[1]).toContain('Run command'); // title
    expect(out[2]).toContain('rm -rf ./build'); // subject
    expect(out[3]).toMatch(/^─+$/); // rule 2
    expect(out[4]).toContain('$ rm -rf ./build'); // preview 1
    expect(out[5]).toContain('cwd: /home/lex/forja'); // preview 2
    expect(out[6]).toMatch(/^─+$/); // rule 3
    expect(out[7]).toContain('Do you want to run this bash command?');
    expect(out[8]).toContain('1. Yes');
    expect(out[9]).toContain('2. Yes, allow all bash during this session');
    expect(out[10]).toContain('3. No');
    expect(out[11]).toContain('Esc to cancel');
  });

  test('rules use ASCII dashes when unicode disabled', () => {
    const out = renderModal(baseModal(), ascii);
    expect(out[0]).toMatch(/^-+$/);
    expect(out[3]).toMatch(/^-+$/);
    expect(out[6]).toMatch(/^-+$/);
  });

  test('cursor `>` marks the selectedIndex (default = last)', () => {
    const out = renderModal(baseModal(), unicode);
    expect(out[8]).toMatch(/^ {2} {2}1\. /); // '   1. ' (no cursor)
    expect(out[10]).toMatch(/^ {2}> 3\. /); // '  > 3. ' (cursor)
  });

  test('cursor moves with selectedIndex', () => {
    const out = renderModal(baseModal({ selectedIndex: 0 }), unicode);
    expect(out[8]).toMatch(/^ {2}> 1\. /);
    expect(out[10]).toMatch(/^ {2} {2}3\. /);
  });

  test('option with shortcut shows it in dim parens after the label', () => {
    const out = renderModal(baseModal(), colored);
    // option 2 has shortcut 'shift+tab'; rendered with dim SGR.
    expect(out[9]).toContain('(shift+tab)');
    expect(out[9]).toContain(`${CSI}2m`);
  });

  test('preview block omitted entirely when preview array is empty', () => {
    const out = renderModal(baseModal({ preview: [] }), unicode);
    // Block 1 (3 lines) → block 3 (5 lines) → footer (1 line) = 9.
    // No second rule, no preview lines.
    expect(out).toHaveLength(9);
    // Two rules total instead of three.
    expect(out.filter((l) => /^─+$/.test(l))).toHaveLength(2);
  });

  test('subject omitted when null (title-only block)', () => {
    const out = renderModal(baseModal({ subject: null }), unicode);
    // Block 1 = rule + title only (2 lines). Total = 11.
    expect(out).toHaveLength(11);
    expect(out[1]).toContain('Run command');
    expect(out[2]).toMatch(/^─+$/); // next rule immediately
  });

  test('question omitted when null (block 3 = options only)', () => {
    const out = renderModal(baseModal({ question: null }), unicode);
    // Block 3 loses the question line: rule + 3 options.
    // Total: 3 + 3 + 4 + 1 = 11.
    expect(out).toHaveLength(11);
  });

  test('hints omitted when array is empty', () => {
    const out = renderModal(baseModal({ hints: [] }), unicode);
    // Total = 12 - 1 footer line = 11.
    expect(out).toHaveLength(11);
  });

  test('multiple hints joined by " · "', () => {
    const out = renderModal(baseModal({ hints: ['Esc to cancel', 'Tab to amend'] }), unicode);
    expect(out[out.length - 1]).toContain('Esc to cancel · Tab to amend');
  });

  test('title wrapped in bold SGR when color enabled', () => {
    const out = renderModal(baseModal(), colored);
    expect(out[1]).toContain(`${CSI}1m`);
  });

  test('subject + preview wrapped in dim SGR when color enabled', () => {
    const out = renderModal(baseModal(), colored);
    expect(out[2]).toContain(`${CSI}2m`); // subject dim
    expect(out[4]).toContain(`${CSI}2m`); // preview line dim
  });

  test('color disabled emits no SGR escapes', () => {
    const out = renderModal(baseModal(), unicode);
    for (const line of out) expect(line).not.toContain(CSI);
  });

  test('queueDepth = 0 leaves the title bare (no suffix)', () => {
    const out = renderModal(baseModal({ queueDepth: 0 }), unicode);
    // Title block is rule + title + subject. The bold+ANSI wrap
    // doesn't carry payload we care about here — just verify the
    // raw `Run command` substring with no "(+N waiting)" tail.
    expect(out[1]).toContain('Run command');
    expect(out[1]).not.toContain('waiting');
  });

  test('queueDepth > 0 appends `(+N waiting)` to the title', () => {
    const out = renderModal(baseModal({ queueDepth: 3 }), unicode);
    expect(out[1]).toContain('Run command (+3 waiting)');
  });

  test('queueDepth = 1 still renders (singular vs plural not differentiated by design)', () => {
    // Honest "(+1 waiting)" beats branching on plurals — depth is
    // a count, the suffix wording is consistent. Lock the
    // contract so a future "(+1 ask waiting)" vs "(+2 asks
    // waiting)" branch doesn't sneak in without a deliberate
    // decision.
    const out = renderModal(baseModal({ queueDepth: 1 }), unicode);
    expect(out[1]).toContain('Run command (+1 waiting)');
  });

  test('rule width tracks caps.cols', () => {
    const narrow: Capabilities = { ...unicode, cols: 30 };
    const out = renderModal(baseModal(), narrow);
    expect(out[0]).toBe('─'.repeat(30));
  });

  test('empty preview entry becomes a blank spacer (no indent)', () => {
    const out = renderModal(baseModal({ preview: ['line a', '', 'line c'] }), unicode);
    // Find the spacer line — it should be exactly '' (not '  ').
    const spacerIdx = out.findIndex((l) => l === '');
    expect(spacerIdx).toBeGreaterThan(-1);
  });
});
