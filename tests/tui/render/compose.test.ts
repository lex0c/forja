import { describe, expect, test } from 'bun:test';
import { composeLive } from '../../../src/tui/render/compose.ts';
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

describe('composeLive layout', () => {
  test('pre-session: only the input box', () => {
    const out = composeLive(createInitialState(), caps, 0);
    expect(out).toEqual(['> ']);
  });

  test('after session start: status line above input', () => {
    const out = composeLive(startedSession(), caps, 0);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('forja');
    expect(out[1]).toBe('> ');
  });

  test('active tool card sits ABOVE status line + input', () => {
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
    // [tool head, status line, input]
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('bash');
    expect(out[0]).toContain('ls');
    expect(out[1]).toContain('forja');
    expect(out[2]).toBe('> ');
  });

  test('multi-line input keeps input at the bottom', () => {
    const s = startedSession();
    s.input.value = 'a\nb';
    const out = composeLive(s, caps, 0);
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
});
