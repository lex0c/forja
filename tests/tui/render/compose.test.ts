import { describe, expect, test } from 'bun:test';
import { composeLive } from '../../../src/tui/render/compose.ts';
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
