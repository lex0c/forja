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

  test('session-footer with abortCause appends the discriminator (1.g.3)', () => {
    expect(
      formatPermanent({ kind: 'session-footer', reason: 'aborted', abortCause: 'soft' }, ascii),
    ).toEqual(['── session end · aborted (soft) ──']);
    expect(
      formatPermanent({ kind: 'session-footer', reason: 'aborted', abortCause: 'hard' }, ascii),
    ).toEqual(['── session end · aborted (hard) ──']);
  });

  test('session-footer abortCause on a non-abort reason is dropped (defensive)', () => {
    // Producer guarantees abortCause is only set when reason==='aborted',
    // but the renderer doesn't trust that — a mis-routed combination
    // shouldn't render misleading text like `done (soft)`.
    expect(
      formatPermanent({ kind: 'session-footer', reason: 'done', abortCause: 'soft' }, ascii),
    ).toEqual(['── session end · done ──']);
  });

  describe('session-banner (UI.md §4.10.9 — 3 blocks)', () => {
    const baseBanner = {
      kind: 'session-banner' as const,
      app: 'forja',
      version: '0.1.0',
      model: 'anthropic/claude-sonnet-4-6',
      contextWindow: 200000,
      maxOutputTokens: 4096,
      cwd: '/home/lex/forja',
      env: [
        { kind: 'meta' as const, key: 'subagents', value: '2' },
        { kind: 'flag' as const, name: 'checkpoints' },
      ],
    };

    test('emits 6 lines: title / blank / model+cwd (2) / blank / env (Unicode)', () => {
      expect(formatPermanent(baseBanner, unicode)).toEqual([
        'forja v0.1.0',
        '',
        'anthropic/claude-sonnet-4-6 · 200,000 ctx · max 4096 out',
        '/home/lex/forja',
        '',
        'subagents: 2 · ✓ checkpoints',
      ]);
    });

    test('version already prefixed with v is not double-prefixed', () => {
      const out = formatPermanent({ ...baseBanner, version: 'v2.3.4' }, unicode);
      expect(out[0]).toBe('forja v2.3.4');
    });

    test('falls back to ASCII glyphs (* for ✓, - for ·) when unicode disabled', () => {
      const out = formatPermanent(baseBanner, ascii);
      expect(out[2]).toBe('anthropic/claude-sonnet-4-6 - 200,000 ctx - max 4096 out');
      expect(out[5]).toBe('subagents: 2 - * checkpoints');
    });

    test('omits env block entirely when env is empty (no trailing blank line)', () => {
      const out = formatPermanent({ ...baseBanner, env: [] }, ascii);
      // title + blank + model + cwd. Banner ends after identity block.
      expect(out).toEqual([
        'forja v0.1.0',
        '',
        'anthropic/claude-sonnet-4-6 - 200,000 ctx - max 4096 out',
        '/home/lex/forja',
      ]);
    });

    test('flag with count renders as ✓ name (count)', () => {
      const out = formatPermanent(
        {
          ...baseBanner,
          env: [{ kind: 'flag' as const, name: 'memory', count: 14 }],
        },
        unicode,
      );
      expect(out[5]).toBe('✓ memory (14)');
    });

    test('mixes flag + meta entries joined by dim · separator', () => {
      const out = formatPermanent(
        {
          ...baseBanner,
          env: [
            { kind: 'meta' as const, key: 'policy', value: 'project (5 rules)' },
            { kind: 'meta' as const, key: 'subagents', value: '2' },
            { kind: 'flag' as const, name: 'checkpoints' },
            { kind: 'flag' as const, name: 'memory', count: 14 },
          ],
        },
        unicode,
      );
      expect(out[5]).toBe(
        'policy: project (5 rules) · subagents: 2 · ✓ checkpoints · ✓ memory (14)',
      );
    });

    test('applies bold to title, dim to identity, success to flags, dim to meta when color enabled', () => {
      const out = formatPermanent(baseBanner, colored);
      // 0: title (bold), 1: blank, 2-3: identity (dim), 4: blank, 5: env mix
      expect(out[0]).toContain(`${CSI}1m`);
      expect(out[1]).toBe('');
      expect(out[2]).toContain(`${CSI}2m`);
      expect(out[3]).toContain(`${CSI}2m`);
      expect(out[4]).toBe('');
      // env line: meta entry dim, flag entry success.
      expect(out[5]).toContain(`${CSI}2m`); // dim runs (meta + separator)
      expect(out[5]).toContain(`${CSI}32m`); // success run (flag)
    });

    test('emits no SGR (other than the empty blank lines) when color disabled', () => {
      const out = formatPermanent(baseBanner, unicode);
      for (const line of out) expect(line).not.toContain(CSI);
    });

    test('formats large context window with locale-aware thousands separator', () => {
      const out = formatPermanent({ ...baseBanner, contextWindow: 1_000_000 }, ascii);
      expect(out[2]).toContain('1,000,000 ctx');
    });
  });

  describe('user-submit (inverse bar, UI.md §4.10.8)', () => {
    // SGR 7 (reverse) emits unconditionally — it's an attribute, not
    // a color (works under NO_COLOR). Each line is padded to caps.cols
    // before reversal so the bar extends edge-to-edge.
    const REVERSE_OPEN = '\x1b[7m';
    const RESET = '\x1b[0m';

    test('single-line submit pads to caps.cols and wraps the line in SGR 7', () => {
      const out = formatPermanent({ kind: 'user-submit', text: 'hi' }, ascii);
      expect(out).toHaveLength(1);
      const line = out[0] ?? '';
      expect(line.startsWith(REVERSE_OPEN)).toBe(true);
      expect(line.endsWith(RESET)).toBe(true);
      // Strip SGR to inspect the padded content.
      const inner = line.slice(REVERSE_OPEN.length, -RESET.length);
      expect(inner).toBe('> hi'.padEnd(ascii.cols));
    });

    test('multi-line submit applies > on first line, two-space continuation, full-width bar each', () => {
      const out = formatPermanent({ kind: 'user-submit', text: 'first\nsecond\nthird' }, ascii);
      expect(out).toHaveLength(3);
      const inners = out.map((l) => l.slice(REVERSE_OPEN.length, -RESET.length));
      expect(inners).toEqual([
        '> first'.padEnd(ascii.cols),
        '  second'.padEnd(ascii.cols),
        '  third'.padEnd(ascii.cols),
      ]);
      // Each line independently wrapped in SGR 7 + reset (so terminal
      // resize / re-flow doesn't strand inverse state across lines).
      for (const l of out) {
        expect(l.startsWith(REVERSE_OPEN)).toBe(true);
        expect(l.endsWith(RESET)).toBe(true);
      }
    });

    test('reverse is emitted even when caps.color is "none" (attribute, not color)', () => {
      // ascii uses color: 'none'. Reverse must still emit per spec.
      const out = formatPermanent({ kind: 'user-submit', text: 'x' }, ascii);
      expect((out[0] ?? '').includes(REVERSE_OPEN)).toBe(true);
    });

    test('text wider than caps.cols is not padded (negative pad clamps to 0)', () => {
      const narrow: Capabilities = { ...ascii, cols: 5 };
      const out = formatPermanent({ kind: 'user-submit', text: 'a long input' }, narrow);
      // Inner content keeps the original text without truncation;
      // truncation is the renderer's job (truncateToWidth).
      const inner = (out[0] ?? '').slice(REVERSE_OPEN.length, -RESET.length);
      expect(inner).toBe('> a long input');
    });
  });

  test('assistant without duration/tokens just splits text (legacy/replay path)', () => {
    expect(
      formatPermanent(
        { kind: 'assistant', text: 'line1\nline2', durationMs: null, outputTokens: null },
        ascii,
      ),
    ).toEqual(['line1', 'line2']);
  });

  test('assistant with empty text + chip metadata emits header only (tool-only turn)', () => {
    // A turn that streamed tool_use blocks but no prose still spent
    // output tokens — operator should see the cost signal as a chip
    // line. Header alone, no text lines.
    expect(
      formatPermanent({ kind: 'assistant', text: '', durationMs: 8200, outputTokens: 234 }, ascii),
    ).toEqual(['* Generated 234 tokens in 8.2s']);
  });

  test('assistant with empty text + no metadata emits nothing (degenerate guard)', () => {
    expect(
      formatPermanent({ kind: 'assistant', text: '', durationMs: null, outputTokens: null }, ascii),
    ).toEqual([]);
  });

  test('assistant with trailing newline emits an explicit empty trailing line', () => {
    // Documents current behavior: text with a trailing `\n` becomes
    // [content, ''] after split. Provider streams typically don't end
    // with a newline; if a future producer does, we may want to filter
    // (matching `appendPreview` for tool deltas). Locking the behavior
    // makes that future change visible.
    expect(
      formatPermanent(
        { kind: 'assistant', text: 'foo\n', durationMs: null, outputTokens: null },
        ascii,
      ),
    ).toEqual(['foo', '']);
  });

  test('assistant with duration + tokens emits chip header above text (UI.md §4.10.5)', () => {
    const out = formatPermanent(
      { kind: 'assistant', text: 'hello', durationMs: 8200, outputTokens: 234 },
      ascii,
    );
    // Header + text. ASCII glyph for the chip is `*`.
    expect(out).toHaveLength(2);
    expect(out[0]).toBe('* Generated 234 tokens in 8.2s');
    expect(out[1]).toBe('hello');
  });

  test('assistant with duration only (no usage) drops the token clause', () => {
    const out = formatPermanent(
      { kind: 'assistant', text: 'hi', durationMs: 450, outputTokens: null },
      ascii,
    );
    // Sub-second duration renders in ms.
    expect(out[0]).toBe('* Generated in 450ms');
    expect(out[1]).toBe('hi');
  });

  test('assistant with tokens only (no duration) drops the duration clause', () => {
    const out = formatPermanent(
      { kind: 'assistant', text: 'hi', durationMs: null, outputTokens: 50 },
      ascii,
    );
    expect(out[0]).toBe('* Generated 50 tokens');
    expect(out[1]).toBe('hi');
  });

  describe('tool-end (operation chip + sub-content, UI.md §4.10.5/§4.10.7)', () => {
    test('done status uses the per-tool finalVerb plus duration', () => {
      const out = formatPermanent(
        {
          kind: 'tool-end',
          name: 'read_file',
          verb: 'Read file',
          subject: '/foo.ts',
          status: 'done',
          durationMs: 850,
        },
        unicode,
      );
      // Chip head: `· Read file in 850ms`. Sub-content: `└─ /foo.ts`.
      expect(out).toHaveLength(2);
      expect(out[0]).toBe('· Read file in 850ms');
      expect(out[1]).toBe('└─ /foo.ts');
    });

    test('done status with no subject emits only the chip head (no connector line)', () => {
      const out = formatPermanent(
        {
          kind: 'tool-end',
          name: 'todo_write',
          verb: 'Updated todos',
          subject: null,
          status: 'done',
          durationMs: 50,
        },
        unicode,
      );
      expect(out).toEqual(['· Updated todos in 50ms']);
    });

    test('error status overrides verb to "Failed" regardless of vocab', () => {
      const out = formatPermanent(
        {
          kind: 'tool-end',
          name: 'bash',
          verb: 'Executed',
          subject: 'rm -rf /tmp/x',
          status: 'error',
          durationMs: 200,
        },
        unicode,
      );
      expect(out[0]).toContain('Failed in 200ms');
      expect(out[0]).not.toContain('Executed');
      expect(out[1]).toBe('└─ rm -rf /tmp/x');
    });

    test('denied status overrides verb to "Denied"', () => {
      const out = formatPermanent(
        {
          kind: 'tool-end',
          name: 'bash',
          verb: 'Executed',
          subject: 'rm -rf /',
          status: 'denied',
          durationMs: 1,
        },
        unicode,
      );
      expect(out[0]).toContain('Denied in 1ms');
    });

    test('denied status with summary surfaces the policy reason as sub-content', () => {
      const out = formatPermanent(
        {
          kind: 'tool-end',
          name: 'bash',
          verb: 'Executed',
          subject: 'rm -rf /',
          status: 'denied',
          durationMs: 1,
          summary: 'matches deny rule bash.rm.rf',
        },
        unicode,
      );
      // Summary takes precedence over subject for denied (the
      // operator wants the reason, not the rejected command echo).
      expect(out[1]).toBe('└─ matches deny rule bash.rm.rf');
    });

    test('summary fills in for sub-content when subject is null', () => {
      const out = formatPermanent(
        {
          kind: 'tool-end',
          name: 'todo_write',
          verb: 'Updated todos',
          subject: null,
          status: 'done',
          durationMs: 10,
          summary: '3 items added',
        },
        unicode,
      );
      expect(out).toHaveLength(2);
      expect(out[1]).toBe('└─ 3 items added');
    });

    test('chip glyph is `·` under Unicode, `*` under ASCII', () => {
      const u = formatPermanent(
        {
          kind: 'tool-end',
          name: 'r',
          verb: 'Read file',
          subject: null,
          status: 'done',
          durationMs: 1,
        },
        unicode,
      );
      const a = formatPermanent(
        {
          kind: 'tool-end',
          name: 'r',
          verb: 'Read file',
          subject: null,
          status: 'done',
          durationMs: 1,
        },
        ascii,
      );
      expect(u[0]?.charAt(0)).toBe('·');
      expect(a[0]?.charAt(0)).toBe('*');
    });

    test('connector is `└─ ` under Unicode, `\\- ` under ASCII', () => {
      const u = formatPermanent(
        {
          kind: 'tool-end',
          name: 'r',
          verb: 'Read file',
          subject: '/x',
          status: 'done',
          durationMs: 1,
        },
        unicode,
      );
      const a = formatPermanent(
        {
          kind: 'tool-end',
          name: 'r',
          verb: 'Read file',
          subject: '/x',
          status: 'done',
          durationMs: 1,
        },
        ascii,
      );
      expect(u[1]).toBe('└─ /x');
      expect(a[1]).toBe('\\- /x');
    });

    test('duration uses ms below 1s, s above', () => {
      const fast = formatPermanent(
        {
          kind: 'tool-end',
          name: 'r',
          verb: 'Read',
          subject: null,
          status: 'done',
          durationMs: 850,
        },
        ascii,
      );
      const slow = formatPermanent(
        {
          kind: 'tool-end',
          name: 'r',
          verb: 'Read',
          subject: null,
          status: 'done',
          durationMs: 1234,
        },
        ascii,
      );
      expect(fast[0]).toContain('850ms');
      expect(slow[0]).toContain('1.2s');
    });

    test('error status applies error palette SGR to chip head when color enabled', () => {
      const out = formatPermanent(
        {
          kind: 'tool-end',
          name: 'bash',
          verb: 'Executed',
          subject: null,
          status: 'error',
          durationMs: 1,
        },
        colored,
      );
      expect(out[0]).toContain(`${CSI}31m`);
    });

    test('done status applies dim palette SGR to chip head when color enabled', () => {
      const out = formatPermanent(
        { kind: 'tool-end', name: 'r', verb: 'Read', subject: null, status: 'done', durationMs: 1 },
        colored,
      );
      expect(out[0]).toContain(`${CSI}2m`);
    });
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
