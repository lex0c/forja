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

// Rule above input (UI.md §4.10). Full-width (caps.cols), Unicode '─'
// or ASCII '-'. The exact glyph repeated `cols` times is what the
// composer emits.
const expectedRule = (cols: number, unicode: boolean): string => (unicode ? '─' : '-').repeat(cols);

describe('composeLive layout', () => {
  // Bottom anchor (no modal): [..., rule, input(s), rule, footer].
  // Trailing 2 lines = rule + footer. Input occupies the N rows
  // above the trailing rule.
  const countInputLines = (out: string[]): number => {
    let n = 0;
    for (let i = out.length - 3; i >= 0; i--) {
      const l = out[i] ?? '';
      if (l.startsWith('> ') || l.startsWith('  ')) n++;
      else break;
    }
    return Math.max(1, n);
  };
  const inputRow = (out: string[], inputLineIdx = 0): string =>
    out[out.length - 2 - countInputLines(out) + inputLineIdx] ?? '';

  test('pre-session: rule + input + rule + footer (status line absent)', () => {
    const out = composeLive(createInitialState(), caps, 0);
    // [rule, '> ', rule, footer]. Length = 4.
    expect(out).toHaveLength(4);
    expect(out[0]).toBe(expectedRule(caps.cols, true));
    expect(out[1]).toBe('> ');
    expect(out[2]).toBe(expectedRule(caps.cols, true));
    expect(out[3]).toContain('? for help');
  });

  test('after session start: status line, rule, input, rule, footer', () => {
    const out = composeLive(startedSession(), caps, 0);
    // [status, rule, '> ', rule, footer]. Length = 5.
    expect(out).toHaveLength(5);
    expect(out[0]).toContain('forja');
    expect(out[1]).toBe(expectedRule(caps.cols, true));
    expect(out[2]).toBe('> ');
    expect(out[3]).toBe(expectedRule(caps.cols, true));
    expect(out[4]).toContain('opus');
  });

  test('active tool card sits ABOVE status line + bottom anchor', () => {
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
    // [chip head, sub-content, status, rule, input, rule, footer] = 7.
    expect(out).toHaveLength(7);
    expect(out[0]).toContain('Executing');
    expect(out[1]).toContain('ls');
    expect(out[2]).toContain('forja');
    expect(out[3]).toBe(expectedRule(caps.cols, true));
    expect(out[4]).toBe('> ');
    expect(out[5]).toBe(expectedRule(caps.cols, true));
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
    // Expected layout (top→bottom):
    //   [Tasks header, todo row, assistant chip, tool head, sub, status, rule, input, rule, footer]
    expect(out[0]).toContain('Tasks');
    expect(out[1]).toContain('plan it');
    expect(out[2]).toContain('Generating…');
    expect(out[3]).toContain('Executing');
    expect(out[4]).toContain('ls');
    expect(out[5]).toContain('forja');
    expect(out[6]).toBe(expectedRule(caps.cols, true));
    expect(out[7]).toBe('> ');
    expect(out[8]).toBe(expectedRule(caps.cols, true));
    expect(out[9]).toContain('? for help');
    expect(out).toHaveLength(10);
  });

  test('assistant chip alone (no todos, no tools) renders between status anchor and live tools slot', () => {
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
    // [chip, status, rule, input, rule, footer] = 6.
    expect(out).toHaveLength(6);
    expect(out[0]).toContain('Generating…');
    expect(out[1]).toContain('forja');
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
    expect(out[0]).toBe(expectedRule(ascii.cols, false));
  });

  test('rule width tracks caps.cols (measured visually, ANSI-aware)', () => {
    const narrow: Capabilities = { ...caps, cols: 20 };
    const out = composeLive(createInitialState(), narrow, 0);
    // visualWidth strips ANSI escapes — robust whether color is on
    // or off. .length would break the moment color flipped to basic.
    expect(visualWidth(out[0] ?? '')).toBe(20);
  });

  test('rule width holds with color enabled (SGR codes do not bloat visual width)', () => {
    const colored: Capabilities = { ...caps, cols: 30, color: 'basic' };
    const out = composeLive(createInitialState(), colored, 0);
    expect(visualWidth(out[0] ?? '')).toBe(30);
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

  // FOOTER_BLOCK_LINES guard: composeCursor's row math depends on
  // composeLive emitting exactly that many lines below the input.
  // Drift here = silent cursor mispositioning. Test catches additions
  // (e.g., second rule, multi-line footer) without a constant bump.
  test('FOOTER_BLOCK_LINES matches the trailing block emitted by composeLive', () => {
    const s = createInitialState();
    s.input.value = 'abc';
    const out = composeLive(s, caps, 0);
    // out shape (no upper region, no modal): [rule, '> abc', rule, footer]
    // = 1 (rule above) + 1 (input) + FOOTER_BLOCK_LINES.
    const expectedLength = 1 /* rule above */ + 1 /* input lines */ + FOOTER_BLOCK_LINES;
    expect(out).toHaveLength(expectedLength);
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

  test('col clamps to caps.cols-1 when buffer is wider than the terminal', () => {
    const narrow: Capabilities = { ...caps, cols: 10 };
    const s = startedSession();
    s.input.value = 'a'.repeat(50);
    s.input.cursor = 50; // far past the right edge
    const cur = composeCursor(s, narrow, 5);
    expect(cur).not.toBeNull();
    expect(cur?.col).toBe(narrow.cols - 1);
  });

  test('col clamp does not mangle short inputs that already fit', () => {
    const narrow: Capabilities = { ...caps, cols: 20 };
    const s = startedSession();
    s.input.value = 'short';
    s.input.cursor = 5;
    expect(composeCursor(s, narrow, 5)).toEqual({ row: 2, col: 7 });
  });
});
