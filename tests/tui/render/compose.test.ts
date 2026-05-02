import { describe, expect, test } from 'bun:test';
import { composeCursor, composeLive } from '../../../src/tui/render/compose.ts';
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
  test('pre-session: rule + input box (status line absent)', () => {
    const out = composeLive(createInitialState(), caps, 0);
    expect(out).toEqual([expectedRule(caps.cols, true), '> ']);
  });

  test('after session start: status line, rule, input', () => {
    const out = composeLive(startedSession(), caps, 0);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('forja');
    expect(out[1]).toBe(expectedRule(caps.cols, true));
    expect(out[2]).toBe('> ');
  });

  test('active tool card sits ABOVE status line + rule + input', () => {
    const s = startedSession();
    const tool: ActiveTool = {
      toolId: 't1',
      name: 'bash',
      args: 'ls',
      startedAt: 0,
      preview: [],
    };
    s.activeTools.set('t1', tool);
    const out = composeLive(s, caps, 1000);
    // [tool head, status line, rule, input]
    expect(out).toHaveLength(4);
    expect(out[0]).toContain('bash');
    expect(out[0]).toContain('ls');
    expect(out[1]).toContain('forja');
    expect(out[2]).toBe(expectedRule(caps.cols, true));
    expect(out[3]).toBe('> ');
  });

  test('multi-line input keeps input at the bottom and rule above first input line', () => {
    const s = startedSession();
    s.input.value = 'a\nb';
    const out = composeLive(s, caps, 0);
    expect(out[out.length - 3]).toBe(expectedRule(caps.cols, true));
    expect(out[out.length - 2]).toBe('> a');
    expect(out[out.length - 1]).toBe('  b');
  });

  test('multiple tools appear in insertion order', () => {
    const s = startedSession();
    s.activeTools.set('t1', {
      toolId: 't1',
      name: 'first',
      args: '',
      startedAt: 0,
      preview: [],
    });
    s.activeTools.set('t2', {
      toolId: 't2',
      name: 'second',
      args: '',
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

  test('rule is suppressed when modal is up (modal owns its own structure)', () => {
    const s = startedSession();
    s.modal = {
      promptId: 'p1',
      flavor: 'permission',
      message: 'Run command',
      details: ['rm -rf /'],
      selected: 'no',
    };
    const out = composeLive(s, caps, 0);
    // No rule line equal to a full-cols dash/em-rule.
    const ruleU = expectedRule(caps.cols, true);
    const ruleA = expectedRule(caps.cols, false);
    expect(out.includes(ruleU)).toBe(false);
    expect(out.includes(ruleA)).toBe(false);
    // No `> ` input either; modal renders instead.
    expect(out.includes('> ')).toBe(false);
  });
});

describe('composeCursor', () => {
  test('null when modal is up (modal owns the cursor)', () => {
    const s = startedSession();
    s.modal = {
      promptId: 'p1',
      flavor: 'permission',
      message: 'm',
      details: [],
      selected: 'no',
    };
    expect(composeCursor(s, caps, 5)).toBeNull();
  });

  test('empty input → cursor at last row, col=2 (after `> ` prefix)', () => {
    // Pre-session: lines = [rule, '> ']. lineCount = 2.
    const s = createInitialState();
    expect(composeCursor(s, caps, 2)).toEqual({ row: 1, col: 2 });
  });

  test('single-line input mid-buffer → col reflects offset within line', () => {
    const s = startedSession();
    s.input.value = 'hello world';
    s.input.cursor = 5; // between hello and space
    // After session start: lines = [status, rule, '> hello world']. lineCount = 3.
    // Cursor sits on the input line (row 2), col = 2 (prefix) + 5 = 7.
    expect(composeCursor(s, caps, 3)).toEqual({ row: 2, col: 7 });
  });

  test('cursor at end of single-line input', () => {
    const s = startedSession();
    s.input.value = 'abc';
    s.input.cursor = 3;
    expect(composeCursor(s, caps, 3)).toEqual({ row: 2, col: 5 }); // 2 prefix + 3
  });

  test('multi-line input → cursor on the line containing the offset', () => {
    const s = startedSession();
    s.input.value = 'first\nsecond\nthird';
    // Cursor inside "second" at offset 9 (after "first\nsec").
    s.input.cursor = 9;
    // lines = [status, rule, '> first', '  second', '  third']. lineCount = 5.
    // Input occupies rows 2,3,4. Cursor is on the 2nd input line (row 3).
    // Within "second", offset is 3 (s,e,c|ond → after 'sec'). Visual col = 2 + 3 = 5.
    expect(composeCursor(s, caps, 5)).toEqual({ row: 3, col: 5 });
  });

  test('cursor at start of buffer (offset 0) is at first input line, col=2', () => {
    const s = startedSession();
    s.input.value = 'hello';
    s.input.cursor = 0;
    expect(composeCursor(s, caps, 3)).toEqual({ row: 2, col: 2 });
  });

  test('cursor at start of a continuation line maps to col=2 of that row', () => {
    const s = startedSession();
    s.input.value = 'a\nb';
    s.input.cursor = 2; // right after the newline, before 'b'
    // lines = [status, rule, '> a', '  b']. lineCount = 4.
    expect(composeCursor(s, caps, 4)).toEqual({ row: 3, col: 2 });
  });

  test('col clamps to caps.cols-1 when buffer is wider than the terminal', () => {
    const narrow: Capabilities = { ...caps, cols: 10 };
    const s = startedSession();
    s.input.value = 'a'.repeat(50);
    s.input.cursor = 50; // far past the right edge
    // Without clamping, col would be 52 (2 prefix + 50 offset). The
    // terminal would clamp visually OR auto-wrap to the next row,
    // breaking eraseLive's row math. composeCursor floors at cols-1.
    const cur = composeCursor(s, narrow, 3);
    expect(cur).not.toBeNull();
    expect(cur?.col).toBe(narrow.cols - 1);
  });

  test('col clamp does not mangle short inputs that already fit', () => {
    const narrow: Capabilities = { ...caps, cols: 20 };
    const s = startedSession();
    s.input.value = 'short';
    s.input.cursor = 5;
    expect(composeCursor(s, narrow, 3)).toEqual({ row: 2, col: 7 });
  });
});
