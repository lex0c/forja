import { describe, expect, test } from 'bun:test';
import { TRUST_GATE_FLAVORS, renderModal } from '../../../src/tui/render/modal.ts';
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
  { key: '2', label: 'No', value: 'no' },
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
    // renderModal owns the inter-section spacing: a blank line above
    // the preview block and above the question/options block (same gap
    // every flavor gets), plus the blank-pad before the hint footer.
    // Lines: [rule, title, subject, blank, preview×2, blank, question,
    //         option×2, blank-pad, hints] = 12.
    const out = renderModal(baseModal(), unicode);
    expect(out).toHaveLength(12);
    expect(out[0]).toMatch(/^─+$/); // top rule
    expect(out[1]).toContain('Run command'); // title
    expect(out[2]).toContain('rm -rf ./build'); // subject
    expect(out[3]).toBe(''); // blank above preview
    expect(out[4]).toContain('$ rm -rf ./build'); // preview 1
    expect(out[5]).toContain('cwd: /home/lex/forja'); // preview 2
    expect(out[6]).toBe(''); // blank above question/options
    expect(out[7]).toContain('Do you want to run this bash command?'); // question
    expect(out[8]).toContain('1. Yes');
    expect(out[9]).toContain('2. No');
    expect(out[10]).toBe(''); // blank padding before hint
    expect(out[11]).toContain('Esc to cancel'); // hint footer
    // Exactly one rule line in the whole output.
    expect(out.filter((l) => /^─+$/.test(l))).toHaveLength(1);
  });

  test('top rule uses ASCII dashes when unicode disabled', () => {
    const out = renderModal(baseModal(), ascii);
    expect(out[0]).toMatch(/^-+$/);
  });

  test('cursor `>` marks the selectedIndex (default = last)', () => {
    const out = renderModal(baseModal(), unicode);
    // Options sit at indices 8, 9 (after the blank-above-preview, the
    // two preview rows, the blank-above-options, and the question).
    expect(out[8]).toMatch(/^ {2} {2}1\. /); // '    1. ' (no cursor)
    expect(out[9]).toMatch(/^ {2}> 2\. /); // '  > 2. ' (cursor on default)
  });

  test('cursor moves with selectedIndex', () => {
    const out = renderModal(baseModal({ selectedIndex: 0 }), unicode);
    expect(out[8]).toMatch(/^ {2}> 1\. /);
    expect(out[9]).toMatch(/^ {2} {2}2\. /);
  });

  test('preview block omitted entirely when preview array is empty', () => {
    const out = renderModal(baseModal({ preview: [] }), unicode);
    // No preview block (no blank-above-preview either). Lines: [rule,
    // title, subject, blank, question, option×2, blank-pad, hints] = 9.
    expect(out).toHaveLength(9);
    expect(out.filter((l) => /^─+$/.test(l))).toHaveLength(1);
  });

  test('subject omitted when null', () => {
    const out = renderModal(baseModal({ subject: null }), unicode);
    // Lines: [rule, title, blank, preview×2, blank, question,
    //         option×2, blank-pad, hints] = 11.
    expect(out).toHaveLength(11);
    expect(out[1]).toContain('Run command');
    // Blank-above-preview, then the preview block under the title.
    expect(out[2]).toBe('');
    expect(out[3]).toContain('$ rm -rf ./build');
  });

  test('question omitted when null', () => {
    const out = renderModal(baseModal({ question: null }), unicode);
    // Question drops but the blank-above-options + options stay.
    // Lines: [rule, title, subject, blank, preview×2, blank,
    //         option×2, blank-pad, hints] = 11.
    expect(out).toHaveLength(11);
  });

  test('hints omitted when array is empty (no padding line either)', () => {
    const out = renderModal(baseModal({ hints: [] }), unicode);
    // No hints → no padding line either: padding is gated on the
    // hint footer. Total = 12 - 2 (padding + hints) = 10.
    expect(out).toHaveLength(10);
    // Last line is the second option, not a blank.
    expect(out[9]).toContain('2. No');
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

  // Consent-gate flavors shift the anchor tone from the routine
  // `accent` blue to `warn` yellow so the operator reads them as "stop
  // and read" — and that warm tone covers the whole structural unit:
  // top rule, title, AND the selected option row. Iterates the actual
  // TRUST_GATE_FLAVORS set the renderer keys on, so a flavor added
  // there is covered here automatically (no parallel literal to drift).
  // baseModal selects the last option, so out[9] is the selected row.
  for (const flavor of [...TRUST_GATE_FLAVORS]) {
    test(`${flavor} flavor paints rule + title + selected row warn (yellow), not accent`, () => {
      const out = renderModal(baseModal({ flavor }), colored);
      expect(out[0]).toContain(`${CSI}33m`); // rule warn (yellow)
      expect(out[0]).not.toContain(`${CSI}94m`); // not accent
      expect(out[1]).toContain(`${CSI}33m`); // title warn
      expect(out[1]).toContain(`${CSI}1m`); // title still bold
      expect(out[1]).not.toContain(`${CSI}94m`); // not accent
      expect(out[9]).toContain(`${CSI}33m`); // selected option row warn
      expect(out[9]).not.toContain(`${CSI}94m`); // not accent
    });
  }

  // The non-gate flavors keep the routine `accent` (blue) anchor.
  // Pinned explicitly: the permission-only tests above don't cover
  // these, so a regression that widened the warn branch to a routine
  // confirm (or inverted the gate predicate) fails right here.
  for (const flavor of ['permission', 'memory-write', 'critique', 'history-clear'] as const) {
    test(`${flavor} (non-gate) keeps accent anchor, not warn`, () => {
      const out = renderModal(baseModal({ flavor }), colored);
      expect(out[0]).toContain(`${CSI}94m`); // rule accent (blue)
      expect(out[0]).not.toContain(`${CSI}33m`); // not warn
    });
  }

  test('selected row keeps its key digit secondary while label goes accent', () => {
    // The hotkey digit on UNSELECTED rows is subordinate to the
    // label — painting it `secondary` mutes it to a hotkey reminder.
    // The SELECTED row is painted `accent` (blue) as a single run so
    // the active choice reads as one highlighted unit (cursor + key +
    // label together) instead of a row with a muted digit.
    const out = renderModal(baseModal(), colored);
    // baseModal selects the last option → out[9] is selected, out[8]
    // is the unselected option above it.
    expect(out[8]).toContain(`${CSI}90m`); // secondary on unselected "1."
    expect(out[9]).toContain(`${CSI}94m`); // accent on the selected row
    expect(out[9]).toContain(`${CSI}90m`); // selected key digit still secondary
  });

  test('selected row tokenizes cursor/label accent + key secondary (digit not blue)', () => {
    // Pin the tokenization so a regression that re-merges the digit
    // into the accent run (turning "1." blue) shows up here.
    const out = renderModal(baseModal({ selectedIndex: 0 }), colored);
    // out[8] is now the selected row (option 1); out[9] the other.
    expect(out[8]).toContain(`${CSI}94m>`); // cursor accent
    expect(out[8]).toContain(`${CSI}90m1.`); // key digit secondary (not blue)
    expect(out[8]).toContain(`${CSI}94mYes`); // label accent
    // The other option keeps the secondary-keyed style, no accent.
    expect(out[9]).toContain(`${CSI}90m`);
    expect(out[9]).not.toContain(`${CSI}94m`);
  });

  test('subject + preview wrapped in dim SGR when color enabled', () => {
    const out = renderModal(baseModal(), colored);
    expect(out[2]).toContain(`${CSI}2m`); // subject dim (out[3] is the blank above preview)
    expect(out[4]).toContain(`${CSI}2m`); // preview line dim
  });

  test('subject painted secondary when subjectTone = "secondary"', () => {
    // Permission flavor opts its framing line into `secondary` so it
    // lifts out of the dim baseline. Default (no subjectTone) stays
    // dim — pinned by the test above.
    const out = renderModal(baseModal({ subjectTone: 'secondary' }), colored);
    expect(out[2]).toContain(`${CSI}90m`); // subject secondary
    expect(out[2]).not.toContain(`${CSI}2m`); // not dim
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
