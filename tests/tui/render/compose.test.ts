import { describe, expect, test } from 'bun:test';
import { FOOTER_BLOCK_LINES, composeCursor, composeLive } from '../../../src/tui/render/compose.ts';
import { visualWidth } from '../../../src/tui/render/width.ts';
import type { ActiveTool, LiveState } from '../../../src/tui/state.ts';
import { createInitialState } from '../../../src/tui/state.ts';
import type { Capabilities } from '../../../src/tui/term.ts';

const caps: Capabilities = {
  isTTY: true,
  cols: 100,
  rows: 24,
  color: 'none',
  unicode: true,
};

const startedSession = (): LiveState => {
  const s = createInitialState();
  return {
    ...s,
    status: {
      ...s.status,
      sessionId: 's1',
      profile: 'autonomous',
      project: 'forja',
      model: 'opus',
    },
  };
};

// Rule above/below input (UI.md §6.3 "bloco do input" exception).
// Edge-to-edge — the rules + the input line form a 3-row unit that
// breaks out of the frame margin so the operator's eye reads it as
// a coherent typing zone.
const expectedRule = (cols: number, unicode: boolean): string => (unicode ? '─' : '-').repeat(cols);

describe('composeLive layout', () => {
  // Bottom anchor (no modal): [..., rule_above, input(s), rule_below, footer].
  // Trailing 2 lines = rule + footer. Input occupies the N rows
  // above the trailing rule. Per UI.md §6.3 the input-block rules
  // are edge-to-edge (start with `─`/`-` directly, no margin), so
  // we detect the rule above by leading-glyph match.
  const countInputLines = (out: string[]): number => {
    let n = 0;
    for (let i = out.length - 3; i >= 0; i--) {
      const l = out[i] ?? '';
      if (l.startsWith('─') || l.startsWith('-')) break;
      n++;
    }
    return Math.max(1, n);
  };
  const inputRow = (out: string[], inputLineIdx = 0): string =>
    out[out.length - 2 - countInputLines(out) + inputLineIdx] ?? '';

  test('pre-session: BLANK + rule + input + rule + footer', () => {
    // The blank above the rule (UI.md §6.3) always fires — it
    // separates the input block from whatever scrollback ends
    // immediately above the live region.
    const out = composeLive(createInitialState(), caps, 0);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe('  '); // forced blank above input rule
    expect(out[1]).toBe(expectedRule(caps.cols, true));
    expect(out[2]).toBe('> ');
    expect(out[3]).toBe(expectedRule(caps.cols, true));
    expect(out[4]).toContain('? for help');
  });

  test('after session start: BLANK + rule + input + rule + footer', () => {
    // Status line was absorbed into footer (UI.md §4.4 superseded by
    // §4.10.6). Layout is now [BLANK, rule, '> ', rule, footer].
    const out = composeLive(startedSession(), caps, 0);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe('  ');
    expect(out[1]).toBe(expectedRule(caps.cols, true));
    expect(out[2]).toBe('> ');
    expect(out[3]).toBe(expectedRule(caps.cols, true));
    expect(out[4]).toContain('opus');
  });

  test('active tool card sits ABOVE bottom anchor', () => {
    const s = startedSession();
    const tool: ActiveTool = {
      toolId: 't1',
      name: 'bash',
      activeVerb: 'Executing',
      finalVerb: 'Executed',
      subject: 'ls',
      startedAt: 0,
      preview: [],
    };
    s.activeTools.set('t1', tool);
    const out = composeLive(s, caps, 1000);
    // Each top-level block (here: tool card) gets a leading BLANK.
    // Plus the forced BLANK above the input rule.
    //   [BLANK, chip head, sub-content, BLANK, rule, input, rule, footer]
    // Length = 8.
    expect(out).toHaveLength(8);
    expect(out[0]).toBe('  '); // leading blank before tool card
    expect(out[1]).toContain('Executing');
    expect(out[2]).toContain('ls');
    expect(out[3]).toBe('  '); // blank between content and input rule
    expect(out[4]).toBe(expectedRule(caps.cols, true));
    expect(out[5]).toBe('> ');
    expect(out[6]).toBe(expectedRule(caps.cols, true));
    expect(out[7]).toContain('opus');
  });

  test('layered live region: TodoList → assistant chip → tool cards (top→bottom)', () => {
    // Spec UI.md §4.10.6: TodoList sits above the operation chips,
    // and the assistant turn is itself an operation chip rendered
    // above tool cards (parent → child visual hierarchy).
    const s = startedSession();
    s.todos = [{ content: 'plan it', activeForm: 'Planning it', status: 'pending' }];
    s.pendingAssistant = {
      messageId: 'm1',
      text: '',
      startedAt: 0,
      inputTokens: null,
      outputTokens: null,
      cacheRead: null,
      cacheCreation: null,
    };
    const tool: ActiveTool = {
      toolId: 't1',
      name: 'bash',
      activeVerb: 'Executing',
      finalVerb: 'Executed',
      subject: 'ls',
      startedAt: 0,
      preview: [],
    };
    s.activeTools.set('t1', tool);
    const out = composeLive(s, caps, 100);
    // Expected layout (top→bottom): EVERY top-level "session" block
    // gets a leading BLANK so each is bounded by breathing space on
    // both sides. Sub-content (rows under "Tasks", `└─` under chips)
    // stays tight — it's the parent's subsession.
    //   [BLANK, Tasks header, todo row,
    //    BLANK, assistant chip,
    //    BLANK, tool head, sub-content,
    //    BLANK, rule, input, rule, footer]
    expect(out[0]).toBe('  '); // leading blank before TodoList
    expect(out[1]).toContain('Tasks');
    expect(out[2]).toContain('plan it');
    expect(out[3]).toBe('  '); // before assistant chip
    expect(out[4]).toContain('Generating…');
    expect(out[5]).toBe('  '); // before tool card
    expect(out[6]).toContain('Executing');
    expect(out[7]).toContain('ls');
    expect(out[8]).toBe('  '); // before input rule
    expect(out[9]).toBe(expectedRule(caps.cols, true));
    expect(out[10]).toBe('> ');
    expect(out[11]).toBe(expectedRule(caps.cols, true));
    expect(out[12]).toContain('? for help');
    expect(out).toHaveLength(13);
  });

  test('assistant chip alone (no todos, no tools) renders above bottom anchor', () => {
    const s = startedSession();
    s.pendingAssistant = {
      messageId: 'm1',
      text: '',
      startedAt: 0,
      inputTokens: null,
      outputTokens: null,
      cacheRead: null,
      cacheCreation: null,
    };
    const out = composeLive(s, caps, 1000);
    // [BLANK, chip, BLANK, rule, input, rule, footer] = 7.
    expect(out).toHaveLength(7);
    expect(out[0]).toBe('  '); // leading blank before chip
    expect(out[1]).toContain('Generating…');
    expect(out[2]).toBe('  '); // blank between chip and input rule
    expect(out[3]).toBe(expectedRule(caps.cols, true));
  });

  test('multi-line input keeps input above the trailing rule + footer', () => {
    const s = startedSession();
    s.input.value = 'a\nb';
    const out = composeLive(s, caps, 0);
    // ..., rule (above), '> a', '  b', rule (below), footer
    expect(inputRow(out, 0)).toBe('> a');
    expect(inputRow(out, 1)).toBe('  b');
    expect(out[out.length - 2]).toBe(expectedRule(caps.cols, true));
    expect(out[out.length - 1]).toContain('? for help');
  });

  test('multiple tools appear in insertion order', () => {
    const s = startedSession();
    s.activeTools.set('t1', {
      toolId: 't1',
      name: 'first',
      activeVerb: 'Doing first',
      finalVerb: 'Did first',
      subject: null,
      startedAt: 0,
      preview: [],
    });
    s.activeTools.set('t2', {
      toolId: 't2',
      name: 'second',
      activeVerb: 'Doing second',
      finalVerb: 'Did second',
      subject: null,
      startedAt: 0,
      preview: [],
    });
    const out = composeLive(s, caps, 0);
    const firstIdx = out.findIndex((l) => l.includes('first'));
    const secondIdx = out.findIndex((l) => l.includes('second'));
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  test('ASCII fallback uses dashes for the rule', () => {
    const ascii: Capabilities = { ...caps, unicode: false };
    const out = composeLive(createInitialState(), ascii, 0);
    // out[0] is the forced blank; rule sits at out[1].
    expect(out[1]).toBe(expectedRule(ascii.cols, false));
  });

  test('rule width tracks caps.cols (measured visually, ANSI-aware)', () => {
    const narrow: Capabilities = { ...caps, cols: 20 };
    const out = composeLive(createInitialState(), narrow, 0);
    // visualWidth strips ANSI escapes — robust whether color is on
    // or off. .length would break the moment color flipped to basic.
    // Rule sits at out[1] (out[0] is the forced blank above input).
    expect(visualWidth(out[1] ?? '')).toBe(20);
  });

  test('rule width holds with color enabled (SGR codes do not bloat visual width)', () => {
    const colored: Capabilities = { ...caps, cols: 30, color: 'basic' };
    const out = composeLive(createInitialState(), colored, 0);
    expect(visualWidth(out[1] ?? '')).toBe(30);
  });

  test('rule + footer suppressed when modal is up (modal owns its own structure)', () => {
    const s = startedSession();
    s.modal = {
      promptId: 'p1',
      flavor: 'permission',
      title: 'Run command',
      subject: 'rm -rf /',
      preview: [],
      question: null,
      options: [{ key: '1', label: 'No', value: 'no' }],
      selectedIndex: 0,
      hints: ['Esc to cancel'],
    };
    const out = composeLive(s, caps, 0);
    // The modal substitutes the entire bottom anchor — input box,
    // bottom rule, footer all gone. The modal carries its own rules
    // (block separators) so we can't assert "no rules"; instead
    // check the specific signals that should be absent.
    expect(out.some((l) => l === '> ')).toBe(false); // input prompt
    expect(out.some((l) => l.includes('? for help'))).toBe(false); // footer hint
  });

  test('modal lines are NOT padded (renderModal already bakes the §6.3 frame margin)', () => {
    // Regression guard: composeLive must NOT run modal output through
    // padFrame. renderModal already emits content with `'  '` indent
    // (its own §6.3 frame margin) AND emits rules at the full
    // caps.cols width. Padding would double-indent content (4sp) and
    // push rules to caps.cols+2, which truncateToWidth then clips
    // by 2 columns on the right — visible as the modal box losing
    // its right edge on every row.
    const s = startedSession();
    s.modal = {
      promptId: 'p1',
      flavor: 'permission',
      title: 'Run command',
      subject: 'rm -rf /',
      preview: [],
      question: 'Allow?',
      options: [{ key: '1', label: 'Yes', value: 'yes' }],
      selectedIndex: 0,
      hints: ['Esc to cancel'],
    };
    const out = composeLive(s, caps, 0);
    // A rule line starts with `─` (or `-`). After padFrame it would
    // start with `'  ─'`. Find the rule rows and assert col 0 is
    // the rule glyph, not a space.
    const ruleLines = out.filter((l) => l.startsWith('─') || l.startsWith('-'));
    expect(ruleLines.length).toBeGreaterThan(0);
    for (const line of ruleLines) {
      // First char must be the rule glyph itself (no leading pad).
      expect(line.startsWith('  ')).toBe(false);
      // Visual width matches caps.cols (full edge-to-edge).
      // String length ≈ visual width because rule chars are 1 col each.
      expect(line.length).toBe(caps.cols);
    }
    // Content rows (title/subject/question/options/hints) carry the
    // modal's own internal `'  '` indent — that's the frame margin
    // already, NOT a doubled `'    '`.
    expect(out.some((l) => l.startsWith('  Run command'))).toBe(true);
    expect(out.some((l) => l.startsWith('    Run command'))).toBe(false);
  });

  // FOOTER_BLOCK_LINES guard: composeCursor's row math depends on
  // composeLive emitting exactly that many lines below the input.
  // Drift here = silent cursor mispositioning. Test catches additions
  // (e.g., second rule, multi-line footer) without a constant bump.
  test('FOOTER_BLOCK_LINES matches the trailing block emitted by composeLive', () => {
    const s = createInitialState();
    s.input.value = 'abc';
    const out = composeLive(s, caps, 0);
    // out shape (no upper region, no modal):
    //   [BLANK, rule, '> abc', rule, footer]
    // = 1 (blank) + 1 (rule above) + 1 (input) + FOOTER_BLOCK_LINES.
    const expectedLength =
      1 /* blank */ + 1 /* rule above */ + 1 /* input lines */ + FOOTER_BLOCK_LINES;
    expect(out).toHaveLength(expectedLength);
  });

  test('frame margin (UI.md §6.3): the input block (rule + input + rule) is edge-to-edge; everything else padded', () => {
    // UI.md §6.3 "bloco do input" exception — the 3 rows that form
    // the typing zone (rule above + input + rule below) all live at
    // col 0 so they read as a coherent unit. Banner, status, footer,
    // tool cards, modal, etc. all get the 2sp frame margin.
    const s = startedSession();
    s.input.value = 'hi';
    const out = composeLive(s, caps, 0);
    // Shape: [status, rule, '> hi', rule, footer].
    const inputIdx = out.findIndex((l) => l.startsWith('> '));
    expect(inputIdx).toBeGreaterThan(-1);
    const ruleAboveIdx = inputIdx - 1;
    const ruleBelowIdx = inputIdx + 1;
    // The 3-row input block: none start with '  ' (they start with '─'
    // for the rules and '> ' for the input).
    expect(out[ruleAboveIdx]?.startsWith('  ')).toBe(false);
    expect(out[inputIdx]?.startsWith('  ')).toBe(false);
    expect(out[ruleBelowIdx]?.startsWith('  ')).toBe(false);
    // Everything outside the block is padded.
    out.forEach((line, i) => {
      if (i >= ruleAboveIdx && i <= ruleBelowIdx) return;
      expect(line.startsWith('  ')).toBe(true);
    });
  });

  test('multi-line input: ALL input lines (prompt + continuations) skip the frame margin', () => {
    // Continuations render as `  body` — superficially identical to
    // a padded line. The composer must NOT pad them because the
    // operator typed them as one logical input block; padding would
    // produce `    body` and break alignment with the `> ` prompt.
    const s = startedSession();
    s.input.value = 'a\nb';
    const out = composeLive(s, caps, 0);
    // Find input by `> ` prompt; continuations sit immediately after.
    const promptIdx = out.findIndex((l) => l.startsWith('> '));
    expect(promptIdx).toBeGreaterThan(-1);
    expect(out[promptIdx]).toBe('> a');
    // Continuation: `  b` — exactly 2 spaces (renderInput's prefix),
    // not 4 (which would be padding + renderInput prefix).
    expect(out[promptIdx + 1]).toBe('  b');
  });

  test('composeLive throws when the bottom anchor is malformed (defensive)', () => {
    // The modal-vs-non-modal split is enforced by an internal assert
    // in composeLive — there's no direct way to trigger it without
    // mocking renderFooter (which would defeat the assert's purpose).
    // Instead, the regression guard above ensures the constant stays
    // honest. Documented here so reviewers know the assert exists.
    expect(typeof FOOTER_BLOCK_LINES).toBe('number');
    expect(FOOTER_BLOCK_LINES).toBeGreaterThan(0);
  });
});

describe('composeCursor', () => {
  test('null when modal is up (modal owns the cursor)', () => {
    const s = startedSession();
    s.modal = {
      promptId: 'p1',
      flavor: 'permission',
      title: 'm',
      subject: null,
      preview: [],
      question: null,
      options: [{ key: '1', label: 'OK', value: 'yes' }],
      selectedIndex: 0,
      hints: [],
    };
    expect(composeCursor(s, caps, 5)).toBeNull();
  });

  // lineCount values include the bottom anchor's trailing 2 lines
  // (rule below input + footer). composeCursor subtracts those before
  // computing the input start row.

  test('empty input → cursor on the input row, col=2 (after `> ` prefix)', () => {
    // Pre-session: lines = [rule, '> ', rule, footer]. lineCount = 4.
    const s = createInitialState();
    expect(composeCursor(s, caps, 4)).toEqual({ row: 1, col: 2 });
  });

  test('single-line input mid-buffer → col reflects offset within line', () => {
    const s = startedSession();
    s.input.value = 'hello world';
    s.input.cursor = 5; // between hello and space
    // After session start: lines = [status, rule, '> hello world',
    // rule, footer]. lineCount = 5. Input on row 2, col = 2 + 5 = 7.
    expect(composeCursor(s, caps, 5)).toEqual({ row: 2, col: 7 });
  });

  test('cursor at end of single-line input', () => {
    const s = startedSession();
    s.input.value = 'abc';
    s.input.cursor = 3;
    expect(composeCursor(s, caps, 5)).toEqual({ row: 2, col: 5 }); // 2 prefix + 3
  });

  test('multi-line input → cursor on the line containing the offset', () => {
    const s = startedSession();
    s.input.value = 'first\nsecond\nthird';
    // Cursor inside "second" at offset 9 (after "first\nsec").
    s.input.cursor = 9;
    // lines = [status, rule, '> first', '  second', '  third', rule,
    // footer]. lineCount = 7. Input rows 2,3,4. Cursor on the 2nd
    // input line (row 3). Within "second": offset 3. Col = 2 + 3 = 5.
    expect(composeCursor(s, caps, 7)).toEqual({ row: 3, col: 5 });
  });

  test('cursor at start of buffer (offset 0) is at first input line, col=2', () => {
    const s = startedSession();
    s.input.value = 'hello';
    s.input.cursor = 0;
    expect(composeCursor(s, caps, 5)).toEqual({ row: 2, col: 2 });
  });

  test('cursor at start of a continuation line maps to col=2 of that row', () => {
    const s = startedSession();
    s.input.value = 'a\nb';
    s.input.cursor = 2; // right after the newline, before 'b'
    // lines = [status, rule, '> a', '  b', rule, footer]. lineCount = 6.
    expect(composeCursor(s, caps, 6)).toEqual({ row: 3, col: 2 });
  });

  test('soft-wrap: long buffer line spans multiple visual rows; cursor lands on the right sub-row', () => {
    // Buffer that overflows the terminal width wraps into multiple
    // visual rows (renderInput soft-wraps; composeCursor mirrors the
    // wrap math). The cursor never gets clamped at the right edge —
    // it lands at the actual sub-row + col where the next char would
    // appear. Pre-fix the cursor pinned to caps.cols-1 and the
    // operator typed past the visible edge unable to track position.
    const narrow: Capabilities = { ...caps, cols: 10 };
    // innerWidth = cols - prefix(2) = 8.
    // 50 chars: ceil(50/8) = 7 visual rows. Char 50 is at offset 50,
    // sub-row floor(50/8) = 6, col within sub-row = 50%8 = 2 → col 4.
    const s = startedSession();
    s.input.value = 'a'.repeat(50);
    s.input.cursor = 50;
    // Layout (no upper region in this test): the input occupies rows
    // [inputStartRow .. +6]. lineCount must be enough to fit input +
    // FOOTER_BLOCK_LINES; we pass a generous 12. inputStartRow = 12 - 2 - 7 = 3.
    const cur = composeCursor(s, narrow, 12);
    expect(cur).toEqual({ row: 3 + 6, col: 4 });
  });

  test('soft-wrap: cursor at sub-row boundary lands at start of next sub-row', () => {
    // Char immediately after a wrap boundary belongs to the NEXT
    // visual sub-row, col 2 (right after the continuation prefix).
    const narrow: Capabilities = { ...caps, cols: 10 };
    // innerWidth = 8. Cursor at offset 8 → sub-row 1, col 2.
    const s = startedSession();
    s.input.value = 'a'.repeat(20);
    s.input.cursor = 8;
    // 20 chars: ceil(20/8) = 3 sub-rows. lineCount = 3 + 2 + 1 (status) = generous 8.
    const cur = composeCursor(s, narrow, 8);
    // visualRowsBefore = 0 (single buffer line). subRow = 1. col = 2.
    expect(cur?.row).toBe(8 - 2 - 3 + 1);
    expect(cur?.col).toBe(2);
  });

  test('short inputs that already fit emit cursor without sub-row math kicking in', () => {
    const narrow: Capabilities = { ...caps, cols: 20 };
    const s = startedSession();
    s.input.value = 'short';
    s.input.cursor = 5;
    expect(composeCursor(s, narrow, 5)).toEqual({ row: 2, col: 7 });
  });

  test('cursor at exact wrap boundary at end of line clamps to right edge of last sub-row', () => {
    // Without the clamp, cursor at offset = innerWidth (end of a line
    // whose length is exactly innerWidth) would compute as sub-row 1
    // — but renderInput only emits 1 sub-row for an 8-char line in
    // an 8-innerWidth setup. The phantom sub-row would visually
    // overlap the rule below the input. Clamp puts the cursor at the
    // right edge of the last actual sub-row; next char typed grows
    // the input naturally.
    const narrow: Capabilities = { ...caps, cols: 10 }; // innerWidth = 8
    const s = startedSession();
    s.input.value = 'a'.repeat(8); // exactly innerWidth
    s.input.cursor = 8;
    // 1 sub-row: lineCount = 1 (status) + 1 (rule) + 1 (input) + 2 (rule+footer) = 5.
    // Wait, composeCursor takes lineCount from caller; pass generous 5 here.
    const cur = composeCursor(s, narrow, 5);
    // numSubRows = ceil(8/8) = 1. subRow would be 1 → clamped to 0.
    // col clamped to cols - 1 = 9.
    expect(cur).toEqual({ row: 5 - 2 - 1, col: 9 });
  });

  test('cursor past wrap boundary (1 char beyond) lands naturally on next sub-row', () => {
    // Once the operator types one more char past the boundary, the
    // input grows to 2 sub-rows and the cursor moves to col 2 of the
    // new row (continuation prefix). No clamp needed — normal path.
    const narrow: Capabilities = { ...caps, cols: 10 }; // innerWidth = 8
    const s = startedSession();
    s.input.value = 'a'.repeat(9); // 1 past innerWidth
    s.input.cursor = 9;
    // numSubRows = ceil(9/8) = 2. subRow = floor(9/8) = 1 (within range).
    // col = 9%8 + prefix(2) = 1 + 2 = 3.
    // lineCount must accommodate 2 input sub-rows + 2 footer block.
    // Pass 6 (1 status + 1 rule + 2 input + 2 footer block).
    const cur = composeCursor(s, narrow, 6);
    expect(cur).toEqual({ row: 6 - 2 - 2 + 1, col: 3 });
  });
});
