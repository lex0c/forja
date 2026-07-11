import { describe, expect, test } from 'bun:test';
import { renderSubagentRows, type SubagentRowState } from '../../../src/tui/render/subagent-row.ts';
import type { Capabilities } from '../../../src/tui/term.ts';

const caps: Capabilities = {
  isTTY: true,
  cols: 80,
  rows: 24,
  color: 'none',
  unicode: true,
};
const ascii: Capabilities = { ...caps, unicode: false };

const sub = (overrides: Partial<SubagentRowState> = {}): SubagentRowState => ({
  subagentId: 'c1',
  name: 'explore',
  goal: 'find the README',
  startedAt: 0,
  liveCostUsd: 0,
  currentTool: '',
  ...overrides,
});

describe('renderSubagentRows', () => {
  test('empty map returns [] (composer drops the section entirely)', () => {
    expect(renderSubagentRows(new Map(), caps, 1000)).toEqual([]);
  });

  test('header + TWO lines per active subagent (line1 identity, line2 tool)', () => {
    const map = new Map<string, SubagentRowState>([
      ['a', sub({ subagentId: 'a', name: 'explore', currentTool: 'read engine.ts' })],
      ['b', sub({ subagentId: 'b', name: 'audit', currentTool: 'grep "x"' })],
    ]);
    const out = renderSubagentRows(map, caps, 1000);
    // header + 2 lines × 2 subagents
    expect(out).toHaveLength(5);
    expect(out[0]).toContain('Subagents');
    expect(out[0]).toContain('2 running');
    // line 1: name; line 2: the in-flight tool
    expect(out[1]).toContain('explore');
    expect(out[2]).toContain('read engine.ts');
    expect(out[3]).toContain('audit');
    expect(out[4]).toContain('grep "x"');
  });

  test('line 1 carries the seed goal/prompt next to the name (persists after the first tool)', () => {
    const map = new Map<string, SubagentRowState>([
      [
        'a',
        sub({ name: 'general-purpose', goal: 'find the README', currentTool: 'read engine.ts' }),
      ],
    ]);
    const out = renderSubagentRows(map, caps, 1000);
    // identity line reads `general-purpose: find the README`, even though a
    // tool is already in flight on line 2.
    expect(out[1]).toContain('general-purpose');
    expect(out[1]).toContain('find the README');
    expect(out[2]).toContain('read engine.ts');
  });

  test('a long goal on line 1 is truncated to fit the frame (leaves room for the 2-col margin)', () => {
    const map = new Map<string, SubagentRowState>([
      ['a', sub({ name: 'explore', goal: `audit ${'y'.repeat(300)}`, currentTool: '' })],
    ]);
    const out = renderSubagentRows(map, caps, 1000); // color: 'none' → length == visual width
    expect(out[1]?.includes('…')).toBe(true);
    // The row line carries no frame margin yet (compose's padFrame adds the
    // leading 2 cols downstream), so the un-framed line must stay within
    // caps.cols - 2 for the painted line to land inside the terminal width.
    expect(out[1]?.length ?? 0).toBeLessThanOrEqual(caps.cols - 2);
  });

  test('header surfaces queued backlog and total cost', () => {
    const map = new Map<string, SubagentRowState>([['a', sub({ liveCostUsd: 0.011 })]]);
    const out = renderSubagentRows(map, caps, 1000, 2);
    expect(out[0]).toContain('1 running');
    expect(out[0]).toContain('2 queued');
    expect(out[0]).toContain('$0.0110');
  });

  test('line 2 shows a bare `starting…` before the first tool (goal rides line 1)', () => {
    const map = new Map<string, SubagentRowState>([
      ['a', sub({ currentTool: '', goal: 'find the README' })],
    ]);
    const out = renderSubagentRows(map, caps, 1);
    // The goal moved to line 1; line 2 is just the booting cue, not the goal.
    expect(out[1]).toContain('find the README');
    expect(out[2]).toContain('starting');
    expect(out[2]).not.toContain('find the README');
  });

  test('ASCII fallback: rotating spinner on line 1, `\\` connector on line 2', () => {
    const map = new Map<string, SubagentRowState>([['a', sub({ currentTool: 'read x' })]]);
    const out = renderSubagentRows(map, ascii, 1000);
    // line 1 begins with the frame margin + a non-space spinner frame.
    expect(/^ {2}[|/\\-] /.test(out[1] as string)).toBe(true);
    // line 2 uses the ASCII tree connector.
    expect(out[2]).toContain('\\ read x');
  });

  test('truncates a long current-tool label with an ellipsis', () => {
    const map = new Map<string, SubagentRowState>([
      ['a', sub({ currentTool: `read ${'x'.repeat(200)}` })],
    ]);
    const out = renderSubagentRows(map, caps, 1000);
    expect(out[2]?.includes('…')).toBe(true);
    expect((out[2]?.length ?? 0) < 250).toBe(true);
  });

  test('elapsed renders on line 1 as a duration token', () => {
    const map = new Map<string, SubagentRowState>([['a', sub({ startedAt: 0 })]]);
    expect(renderSubagentRows(map, caps, 500)[1]).toContain('500ms');
    expect(renderSubagentRows(map, caps, 12_000)[1]).toContain('12s');
    expect(renderSubagentRows(map, caps, 75_000)[1]).toContain('1m15s');
  });

  test('cost chip surfaces $X.XXXX on line 1 when liveCostUsd > 0 (D232)', () => {
    const map = new Map<string, SubagentRowState>([['a', sub({ liveCostUsd: 0.0184 })]]);
    expect(renderSubagentRows(map, caps, 1000)[1]).toContain('$0.0184');
  });

  test('cost chip is suppressed at zero on line 1 (test fixtures / free-tier)', () => {
    const map = new Map<string, SubagentRowState>([['a', sub({ liveCostUsd: 0 })]]);
    const out = renderSubagentRows(map, caps, 1000);
    expect(out[1]).not.toContain('$');
  });
});
