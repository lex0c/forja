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
  test('emits a single top rule + content stack (no intermediate rules)', () => {
    // Redesign per design/permission-modal-redesign.md: one rule
    // at the top, content flows down with whitespace separation.
    // Hint footer gets a blank-line padding above it so it
    // detaches from the last option.
    //
    // Lines: [rule, title, subject, preview×2, question,
    //         option×3, blank-pad, hints] = 11.
    const out = renderModal(baseModal(), unicode);
    expect(out).toHaveLength(11);
    expect(out[0]).toMatch(/^─+$/); // top rule
    expect(out[1]).toContain('Run command'); // title
    expect(out[2]).toContain('rm -rf ./build'); // subject
    expect(out[3]).toContain('$ rm -rf ./build'); // preview 1
    expect(out[4]).toContain('cwd: /home/lex/forja'); // preview 2
    expect(out[5]).toContain('Do you want to run this bash command?'); // question
    expect(out[6]).toContain('1. Yes');
    expect(out[7]).toContain('2. Yes, allow all bash during this session');
    expect(out[8]).toContain('3. No');
    expect(out[9]).toBe(''); // blank padding before hint
    expect(out[10]).toContain('Esc to cancel'); // hint footer
    // Exactly one rule line in the whole output.
    expect(out.filter((l) => /^─+$/.test(l))).toHaveLength(1);
  });

  test('top rule uses ASCII dashes when unicode disabled', () => {
    const out = renderModal(baseModal(), ascii);
    expect(out[0]).toMatch(/^-+$/);
  });

  test('cursor `>` marks the selectedIndex (default = last)', () => {
    const out = renderModal(baseModal(), unicode);
    // No rules between question and options anymore — options sit
    // at indices 6, 7, 8 in the flow above.
    expect(out[6]).toMatch(/^ {2} {2}1\. /); // '    1. ' (no cursor)
    expect(out[8]).toMatch(/^ {2}> 3\. /); // '  > 3. ' (cursor on default)
  });

  test('cursor moves with selectedIndex', () => {
    const out = renderModal(baseModal({ selectedIndex: 0 }), unicode);
    expect(out[6]).toMatch(/^ {2}> 1\. /);
    expect(out[8]).toMatch(/^ {2} {2}3\. /);
  });

  test('option with shortcut shows it in dim parens after the label', () => {
    const out = renderModal(baseModal(), colored);
    // option 2 has shortcut 'shift+tab'; rendered with dim SGR.
    // option 2 is at index 7 in the new layout.
    expect(out[7]).toContain('(shift+tab)');
    expect(out[7]).toContain(`${CSI}2m`);
  });

  test('preview block omitted entirely when preview array is empty', () => {
    const out = renderModal(baseModal({ preview: [] }), unicode);
    // Lines: [rule, title, subject, question, option×3, blank-pad,
    //         hints] = 9. No preview rows.
    expect(out).toHaveLength(9);
    expect(out.filter((l) => /^─+$/.test(l))).toHaveLength(1);
  });

  test('subject omitted when null', () => {
    const out = renderModal(baseModal({ subject: null }), unicode);
    // Lines: [rule, title, preview×2, question, option×3,
    //         blank-pad, hints] = 10.
    expect(out).toHaveLength(10);
    expect(out[1]).toContain('Run command');
    // Preview now sits directly under the title (no rule gap).
    expect(out[2]).toContain('$ rm -rf ./build');
  });

  test('question omitted when null', () => {
    const out = renderModal(baseModal({ question: null }), unicode);
    // Lines: [rule, title, subject, preview×2, option×3,
    //         blank-pad, hints] = 10.
    expect(out).toHaveLength(10);
  });

  test('hints omitted when array is empty (no padding line either)', () => {
    const out = renderModal(baseModal({ hints: [] }), unicode);
    // No hints → no padding line either: padding is gated on the
    // hint footer. Total = 11 - 2 (padding + hints) = 9.
    expect(out).toHaveLength(9);
    // Last line is the third option, not a blank.
    expect(out[8]).toContain('3. No');
  });

  test('hint footer is preceded by a blank-line padding', () => {
    // Pin the padding so a future renderer reshape that drops it
    // (re-fusing the hint into the option list) shows up here.
    const out = renderModal(baseModal(), unicode);
    // Penultimate line is the blank padding; last line is the
    // hint footer.
    expect(out[out.length - 2]).toBe('');
    expect(out[out.length - 1]).toContain('Esc to cancel');
  });

  test('hint footer paints with secondary SGR (not dim)', () => {
    // Secondary (SGR 90) for footer hints lifts them out of the
    // dim baseline that surrounds the modal. A regression that
    // reverts to SGR 2 (dim) loses the visibility on terminals
    // that render faint as default.
    const out = renderModal(baseModal(), colored);
    // Last line is the hint footer.
    expect(out[out.length - 1]).toContain(`${CSI}90m`);
    expect(out[out.length - 1]).not.toContain(`${CSI}2m`);
  });

  test('top rule paints with accent SGR when color is enabled', () => {
    const out = renderModal(baseModal(), colored);
    // SGR 94 (bright blue) is the structural anchor color.
    expect(out[0]).toContain(`${CSI}94m`);
  });

  test('multiple hints joined by " · "', () => {
    const out = renderModal(baseModal({ hints: ['Esc to cancel', 'Tab to amend'] }), unicode);
    expect(out[out.length - 1]).toContain('Esc to cancel · Tab to amend');
  });

  test('title wrapped in accent + bold SGR when color enabled', () => {
    // Title carries the same accent color as the top rule so the
    // two structural anchors read as a unit. Bold gives weight on
    // top of the color. Nested wrap stacks both SGR codes; pin
    // both so a regression that drops one shows up here.
    const out = renderModal(baseModal(), colored);
    expect(out[1]).toContain(`${CSI}94m`); // accent
    expect(out[1]).toContain(`${CSI}1m`); // bold
  });

  test('option key (number + period) painted secondary', () => {
    // The hotkey digit is subordinate to the label — operator's
    // mental scan goes label-first ("Yes", "Allow once", "Deny").
    // Painting the digit `secondary` mutes it so it reads as a
    // hotkey reminder, not as the primary content of the option
    // row. Cursor `>` stays in default paint (active-selection
    // signal).
    const out = renderModal(baseModal(), colored);
    // Option lines start at index 6 in the new layout.
    expect(out[6]).toContain(`${CSI}90m`); // secondary on "1."
    expect(out[7]).toContain(`${CSI}90m`); // secondary on "2."
    expect(out[8]).toContain(`${CSI}90m`); // secondary on "3."
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
