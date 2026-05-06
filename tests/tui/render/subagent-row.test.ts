import { describe, expect, test } from 'bun:test';
import { type SubagentRowState, renderSubagentRows } from '../../../src/tui/render/subagent-row.ts';
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
  progress: '',
  startedAt: 0,
  liveCostUsd: 0,
  ...overrides,
});

describe('renderSubagentRows', () => {
  test('empty map returns [] (composer drops the section entirely)', () => {
    expect(renderSubagentRows(new Map(), caps, 1000)).toEqual([]);
  });

  test('renders header + one row per active subagent', () => {
    const map = new Map<string, SubagentRowState>([
      ['a', sub({ subagentId: 'a', name: 'explore', progress: 'step 1', startedAt: 0 })],
      ['b', sub({ subagentId: 'b', name: 'audit', progress: 'running grep', startedAt: 0 })],
    ]);
    const out = renderSubagentRows(map, caps, 1000);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('Subagents');
    expect(out[1]).toContain('task explore');
    expect(out[1]).toContain('step 1');
    expect(out[2]).toContain('task audit');
    expect(out[2]).toContain('running grep');
  });

  test('uses goal fallback while progress is empty (booting state)', () => {
    const map = new Map<string, SubagentRowState>([
      ['a', sub({ progress: '', goal: 'find the README' })],
    ]);
    const out = renderSubagentRows(map, caps, 1);
    expect(out[1]).toContain('booting');
    expect(out[1]).toContain('find the README');
  });

  test('uses ASCII glyph when caps.unicode is false', () => {
    const map = new Map<string, SubagentRowState>([['a', sub()]]);
    const out = renderSubagentRows(map, ascii, 1000);
    // unicode glyph ▸ is replaced with `>`. The frame margin
    // adds two leading spaces.
    expect(out[1]?.startsWith('  > ')).toBe(true);
  });

  test('truncates long progress to MAX_DETAIL with ellipsis', () => {
    const longProgress = 'x'.repeat(200);
    const map = new Map<string, SubagentRowState>([['a', sub({ progress: longProgress })]]);
    const out = renderSubagentRows(map, caps, 1000);
    expect(out[1]?.includes('…')).toBe(true);
    // Overall row length should be bounded by the truncation cap
    // plus glyph + name + chrome.
    expect((out[1]?.length ?? 0) < longProgress.length + 50).toBe(true);
  });

  test('elapsed renders as a duration token (sub-second / seconds / minutes)', () => {
    const map = new Map<string, SubagentRowState>([['a', sub({ progress: 'p', startedAt: 0 })]]);
    expect(renderSubagentRows(map, caps, 500)[1]).toContain('500ms');
    expect(renderSubagentRows(map, caps, 12_000)[1]).toContain('12s');
    expect(renderSubagentRows(map, caps, 75_000)[1]).toContain('1m15s');
  });

  test('cost chip surfaces $X.XXXX when liveCostUsd > 0 (D232)', () => {
    const map = new Map<string, SubagentRowState>([
      ['a', sub({ progress: 'step 3', liveCostUsd: 0.0184 })],
    ]);
    const out = renderSubagentRows(map, caps, 1000);
    expect(out[1]).toContain('$0.0184');
  });

  test('cost chip is suppressed at zero (test fixtures / free-tier)', () => {
    const map = new Map<string, SubagentRowState>([
      ['a', sub({ progress: 'step 3', liveCostUsd: 0 })],
    ]);
    const out = renderSubagentRows(map, caps, 1000);
    expect(out[1]).not.toContain('$0');
    expect(out[1]).not.toContain('$');
  });
});
