import { describe, expect, test } from 'bun:test';
import { formatPermanent } from '../../../src/tui/render/permanent.ts';
import type { PermanentItem } from '../../../src/tui/state.ts';
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

describe('formatPermanent', () => {
  test('session-header renders a single line with sessionId, profile, model', () => {
    const item: PermanentItem = {
      kind: 'session-header',
      sessionId: 's1',
      profile: 'autonomous',
      project: 'forja',
      model: 'opus',
    };
    expect(formatPermanent(item, ascii)).toEqual(['── session s1 · autonomous · opus ──']);
  });

  test('session-footer renders the reason', () => {
    expect(formatPermanent({ kind: 'session-footer', reason: 'done' }, ascii)).toEqual([
      '── session end · done ──',
    ]);
  });

  describe('session-banner', () => {
    const baseBanner = {
      kind: 'session-banner' as const,
      app: 'forja',
      version: '0.1.0',
      model: 'anthropic/claude-sonnet-4-6',
      contextWindow: 200000,
      maxOutputTokens: 4096,
      cwd: '/home/lex/forja',
      env: [
        { key: 'subagents', value: '2' },
        { key: 'checkpoints', value: 'enabled' },
      ],
    };

    test('emits 4 lines (title, model+limits, cwd, env) with Unicode separators', () => {
      expect(formatPermanent(baseBanner, unicode)).toEqual([
        'forja 0.1.0',
        'anthropic/claude-sonnet-4-6 · 200,000 ctx · max 4096 out',
        '/home/lex/forja',
        'subagents: 2 · checkpoints: enabled',
      ]);
    });

    test('falls back to ASCII separator when unicode disabled', () => {
      const out = formatPermanent(baseBanner, ascii);
      expect(out[1]).toBe('anthropic/claude-sonnet-4-6 - 200,000 ctx - max 4096 out');
      expect(out[3]).toBe('subagents: 2 - checkpoints: enabled');
    });

    test('omits env line entirely when env is empty (no placeholder)', () => {
      const out = formatPermanent({ ...baseBanner, env: [] }, ascii);
      expect(out).toHaveLength(3);
      expect(out[0]).toBe('forja 0.1.0');
      expect(out[2]).toBe('/home/lex/forja');
    });

    test('applies bold SGR to title and dim SGR to other lines when color enabled', () => {
      const out = formatPermanent(baseBanner, colored);
      expect(out[0]).toContain(`${CSI}1m`);
      expect(out[1]).toContain(`${CSI}2m`);
      expect(out[2]).toContain(`${CSI}2m`);
      expect(out[3]).toContain(`${CSI}2m`);
    });

    test('emits no SGR when color disabled', () => {
      const out = formatPermanent(baseBanner, unicode);
      for (const line of out) expect(line).not.toContain(CSI);
    });

    test('formats large context window with locale-aware thousands separator', () => {
      const out = formatPermanent({ ...baseBanner, contextWindow: 1_000_000 }, ascii);
      expect(out[1]).toContain('1,000,000 ctx');
    });
  });

  test('user-submit renders > prefix and 2-space continuation indent', () => {
    expect(formatPermanent({ kind: 'user-submit', text: 'first\nsecond\nthird' }, ascii)).toEqual([
      '> first',
      '  second',
      '  third',
    ]);
  });

  test('user-submit with single line emits one prefixed line', () => {
    expect(formatPermanent({ kind: 'user-submit', text: 'hi' }, ascii)).toEqual(['> hi']);
  });

  test('assistant splits text on newlines with no prefix', () => {
    expect(formatPermanent({ kind: 'assistant', text: 'line1\nline2' }, ascii)).toEqual([
      'line1',
      'line2',
    ]);
  });

  test('assistant with empty text emits nothing', () => {
    expect(formatPermanent({ kind: 'assistant', text: '' }, ascii)).toEqual([]);
  });

  test('assistant with trailing newline emits an explicit empty trailing line', () => {
    // Documents current behavior: text with a trailing `\n` becomes
    // [content, ''] after split. Provider streams typically don't end
    // with a newline; if a future producer does, we may want to filter
    // (matching `appendPreview` for tool deltas). Locking the behavior
    // makes that future change visible.
    expect(formatPermanent({ kind: 'assistant', text: 'foo\n' }, ascii)).toEqual(['foo', '']);
  });

  test('tool-end uses ASCII glyphs when unicode disabled', () => {
    const done = formatPermanent(
      { kind: 'tool-end', name: 'bash', args: 'ls', status: 'done', durationMs: 100 },
      ascii,
    );
    const errored = formatPermanent(
      { kind: 'tool-end', name: 'bash', args: 'rm', status: 'error', durationMs: 100 },
      ascii,
    );
    const denied = formatPermanent(
      { kind: 'tool-end', name: 'bash', args: 'rm', status: 'denied', durationMs: 100 },
      ascii,
    );
    expect(done[0]?.charAt(0)).toBe('*');
    expect(errored[0]?.charAt(0)).toBe('x');
    expect(denied[0]?.charAt(0)).toBe('!');
  });

  test('tool-end uses Unicode glyphs when unicode enabled', () => {
    const done = formatPermanent(
      { kind: 'tool-end', name: 'bash', args: 'ls', status: 'done', durationMs: 100 },
      unicode,
    );
    const errored = formatPermanent(
      { kind: 'tool-end', name: 'bash', args: 'rm', status: 'error', durationMs: 100 },
      unicode,
    );
    const denied = formatPermanent(
      { kind: 'tool-end', name: 'bash', args: 'rm', status: 'denied', durationMs: 100 },
      unicode,
    );
    expect(done[0]?.charAt(0)).toBe('✓');
    expect(errored[0]?.charAt(0)).toBe('✗');
    expect(denied[0]?.charAt(0)).toBe('⚠');
  });

  test('tool-end uses ms units below 1s and s units above', () => {
    const fast = formatPermanent(
      { kind: 'tool-end', name: 'r', args: 'a', status: 'done', durationMs: 850 },
      ascii,
    );
    const slow = formatPermanent(
      { kind: 'tool-end', name: 'r', args: 'a', status: 'done', durationMs: 1234 },
      ascii,
    );
    expect(fast[0]).toContain('850ms');
    expect(slow[0]).toContain('1.2s');
  });

  test('tool-end with summary emits a 2-space-indented continuation line', () => {
    const out = formatPermanent(
      {
        kind: 'tool-end',
        name: 'bash',
        args: 'test',
        status: 'done',
        durationMs: 500,
        summary: '47 entries',
      },
      ascii,
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toBe('  47 entries');
  });

  test('tool-end uses ASCII separator when unicode disabled', () => {
    const out = formatPermanent(
      { kind: 'tool-end', name: 'bash', args: 'ls', status: 'done', durationMs: 50 },
      ascii,
    );
    expect(out[0]).toContain(' - ');
  });

  test('error and warn pass through as plain text when color disabled', () => {
    expect(formatPermanent({ kind: 'error', message: 'down' }, ascii)).toEqual(['error: down']);
    expect(formatPermanent({ kind: 'warn', message: 'high' }, ascii)).toEqual(['warn: high']);
  });

  test('error and warn are wrapped in SGR escapes when color enabled', () => {
    const errored = formatPermanent({ kind: 'error', message: 'down' }, colored);
    expect(errored[0]).toBe(`${CSI}31merror: down${CSI}0m`);
    const warned = formatPermanent({ kind: 'warn', message: 'high' }, colored);
    expect(warned[0]).toBe(`${CSI}33mwarn: high${CSI}0m`);
  });
});
