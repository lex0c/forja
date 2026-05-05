import { describe, expect, test } from 'bun:test';
import { formatPermanent } from '../../../src/tui/render/permanent.ts';
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

// Frame margin (UI.md §6.3): every permanent kind emits 2sp-padded
// lines. Helper makes the expected strings readable without inlining
// the prefix everywhere.
const pad = (s: string): string => `  ${s}`;

describe('formatPermanent', () => {
  // session-header was removed (UI.md §3.2): emitting a UUID-bearing
  // header per turn just clutters scrollback. The kind is gone from
  // PermanentItem entirely; producer (state.ts session:start) emits
  // an empty permanent array. No render coverage needed.

  describe('session-footer (turn-end marker, UI.md §3.2)', () => {
    // Spec change: session-footer renders as a blank line + verb +
    // wall-clock duration (`Cogitated for 1m23s`, `Aborted after 12s`,
    // etc). Both lines respect the §6.3 frame margin. When `durationMs`
    // is absent (legacy / replay), falls back to short form.

    test('done with duration → `Cogitated for X`', () => {
      // 8.2s: 8200ms ≈ 8s rounded.
      expect(
        formatPermanent({ kind: 'session-footer', reason: 'done', durationMs: 8200 }, ascii),
      ).toEqual([pad(''), pad('Cogitated for 8s')]);
    });

    test('done with sub-second duration → `Cogitated for Xms`', () => {
      expect(
        formatPermanent({ kind: 'session-footer', reason: 'done', durationMs: 450 }, ascii),
      ).toEqual([pad(''), pad('Cogitated for 450ms')]);
    });

    test('done with multi-minute duration → `Cogitated for XmYs`', () => {
      // 13m21s = 801000ms.
      expect(
        formatPermanent({ kind: 'session-footer', reason: 'done', durationMs: 801000 }, ascii),
      ).toEqual([pad(''), pad('Cogitated for 13m21s')]);
    });

    test('done with exact-minute duration drops the seconds clause', () => {
      // 2m exactly = 120000ms.
      expect(
        formatPermanent({ kind: 'session-footer', reason: 'done', durationMs: 120000 }, ascii),
      ).toEqual([pad(''), pad('Cogitated for 2m')]);
    });

    test('done WITHOUT duration → short `Cogitated.` fallback', () => {
      expect(formatPermanent({ kind: 'session-footer', reason: 'done' }, ascii)).toEqual([
        pad(''),
        pad('Cogitated.'),
      ]);
    });

    test('aborted (soft) with duration → `Aborted (soft) after X`', () => {
      expect(
        formatPermanent(
          { kind: 'session-footer', reason: 'aborted', abortCause: 'soft', durationMs: 12000 },
          ascii,
        ),
      ).toEqual([pad(''), pad('Aborted (soft) after 12s')]);
    });

    test('aborted (hard) with duration → `Aborted (hard) after X`', () => {
      expect(
        formatPermanent(
          { kind: 'session-footer', reason: 'aborted', abortCause: 'hard', durationMs: 12000 },
          ascii,
        ),
      ).toEqual([pad(''), pad('Aborted (hard) after 12s')]);
    });

    test('aborted without cause WITH duration → `Aborted after X` (no parens)', () => {
      expect(
        formatPermanent({ kind: 'session-footer', reason: 'aborted', durationMs: 5000 }, ascii),
      ).toEqual([pad(''), pad('Aborted after 5s')]);
    });

    test('aborted WITHOUT duration → short `Aborted.` fallback', () => {
      expect(formatPermanent({ kind: 'session-footer', reason: 'aborted' }, ascii)).toEqual([
        pad(''),
        pad('Aborted.'),
      ]);
    });

    test('error with duration → `Failed after X`', () => {
      expect(
        formatPermanent({ kind: 'session-footer', reason: 'error', durationMs: 8000 }, ascii),
      ).toEqual([pad(''), pad('Failed after 8s')]);
    });

    test('maxSteps with duration → `Stopped (max steps) after X`', () => {
      expect(
        formatPermanent({ kind: 'session-footer', reason: 'maxSteps', durationMs: 60000 }, ascii),
      ).toEqual([pad(''), pad('Stopped (max steps) after 1m')]);
    });

    test('maxCostUsd with duration → `Stopped (max cost) after X`', () => {
      expect(
        formatPermanent({ kind: 'session-footer', reason: 'maxCostUsd', durationMs: 60000 }, ascii),
      ).toEqual([pad(''), pad('Stopped (max cost) after 1m')]);
    });

    test('abortCause on a non-abort reason is dropped (defensive)', () => {
      // Producer guarantees abortCause is only set when
      // reason==='aborted', but the renderer doesn't trust that —
      // a stray cause on `done` shouldn't leak into the output.
      expect(
        formatPermanent(
          { kind: 'session-footer', reason: 'done', abortCause: 'soft', durationMs: 1000 },
          ascii,
        ),
      ).toEqual([pad(''), pad('Cogitated for 1s')]);
    });

    test('unknown reason capitalizes + duration (graceful unknown)', () => {
      // If a future producer emits a reason this renderer doesn't
      // know, capitalize and append duration. Without duration, fall
      // back to `Capitalized.` so the marker stays grammatical.
      expect(
        formatPermanent(
          { kind: 'session-footer', reason: 'somethingNew', durationMs: 3000 },
          ascii,
        ),
      ).toEqual([pad(''), pad('SomethingNew after 3s')]);
      expect(formatPermanent({ kind: 'session-footer', reason: 'somethingNew' }, ascii)).toEqual([
        pad(''),
        pad('SomethingNew.'),
      ]);
    });
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
      // Each line padded with the §6.3 frame margin (2sp). Blank
      // separators get padded too — `'  '` still reads as blank.
      expect(formatPermanent(baseBanner, unicode)).toEqual([
        pad('forja v0.1.0'),
        pad(''),
        pad('anthropic/claude-sonnet-4-6 · 200,000 ctx · max 4096 out'),
        pad('/home/lex/forja'),
        pad(''),
        pad('subagents: 2 · ✓ checkpoints'),
      ]);
    });

    test('version already prefixed with v is not double-prefixed', () => {
      const out = formatPermanent({ ...baseBanner, version: 'v2.3.4' }, unicode);
      expect(out[0]).toBe(pad('forja v2.3.4'));
    });

    test('falls back to ASCII glyphs (* for ✓, - for ·) when unicode disabled', () => {
      const out = formatPermanent(baseBanner, ascii);
      expect(out[2]).toBe(pad('anthropic/claude-sonnet-4-6 - 200,000 ctx - max 4096 out'));
      expect(out[5]).toBe(pad('subagents: 2 - * checkpoints'));
    });

    test('omits env block entirely when env is empty (no trailing blank line)', () => {
      const out = formatPermanent({ ...baseBanner, env: [] }, ascii);
      // title + blank + model + cwd. Banner ends after identity block.
      expect(out).toEqual([
        pad('forja v0.1.0'),
        pad(''),
        pad('anthropic/claude-sonnet-4-6 - 200,000 ctx - max 4096 out'),
        pad('/home/lex/forja'),
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
      expect(out[5]).toBe(pad('✓ memory (14)'));
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
        pad('policy: project (5 rules) · subagents: 2 · ✓ checkpoints · ✓ memory (14)'),
      );
    });

    test('applies bold to title, dim to identity, success to flags, dim to meta when color enabled', () => {
      const out = formatPermanent(baseBanner, colored);
      // 0: title (bold), 1: blank, 2-3: identity (dim), 4: blank, 5: env mix
      expect(out[0]).toContain(`${CSI}1m`);
      expect(out[1]).toBe(pad(''));
      expect(out[2]).toContain(`${CSI}2m`);
      expect(out[3]).toContain(`${CSI}2m`);
      expect(out[4]).toBe(pad(''));
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
    // a color (works under NO_COLOR). Each line is padded internally
    // to `cols - 2` (frame margin §6.3) before reversal so the bar
    // runs from col 2 to col cols-1. The 2sp prefix is OUTSIDE the
    // SGR 7 wrap (normal-bg space, not inverse) so the bar starts
    // visibly at col 2, aligned with the rest of the padded content.
    //
    // Leading blank line per UI.md §6.3 — separates each turn from
    // the previous one (Done. → blank → > prompt). out[0] is the
    // blank (just the frame margin); out[1..] are the inverse bars.
    const REVERSE_OPEN = '\x1b[7m';
    const RESET = '\x1b[0m';
    // Line shape: '  ' (frame margin) + REVERSE_OPEN + content + RESET.
    // Helper strips the wrap to inspect the inner padded content.
    const innerOf = (line: string): string =>
      line.slice('  '.length + REVERSE_OPEN.length, -RESET.length);

    test('emits leading blank + reversed (cols-2)-padded content', () => {
      const out = formatPermanent({ kind: 'user-submit', text: 'hi' }, ascii);
      expect(out).toHaveLength(2);
      expect(out[0]).toBe(pad(''));
      const line = out[1] ?? '';
      expect(line.startsWith(`  ${REVERSE_OPEN}`)).toBe(true);
      expect(line.endsWith(RESET)).toBe(true);
      expect(innerOf(line)).toBe('> hi'.padEnd(ascii.cols - 2));
    });

    test('multi-line submit: blank + first line with `>`, continuations with `  `', () => {
      const out = formatPermanent({ kind: 'user-submit', text: 'first\nsecond\nthird' }, ascii);
      expect(out).toHaveLength(4);
      expect(out[0]).toBe(pad(''));
      const inners = out.slice(1).map(innerOf);
      expect(inners).toEqual([
        '> first'.padEnd(ascii.cols - 2),
        '  second'.padEnd(ascii.cols - 2),
        '  third'.padEnd(ascii.cols - 2),
      ]);
      // Each bar line independently wrapped in frame margin + SGR 7 + reset.
      for (const l of out.slice(1)) {
        expect(l.startsWith(`  ${REVERSE_OPEN}`)).toBe(true);
        expect(l.endsWith(RESET)).toBe(true);
      }
    });

    test('reverse is emitted even when caps.color is "none" (attribute, not color)', () => {
      // ascii uses color: 'none'. Reverse must still emit per spec.
      const out = formatPermanent({ kind: 'user-submit', text: 'x' }, ascii);
      expect((out[1] ?? '').includes(REVERSE_OPEN)).toBe(true);
    });

    test('text wider than caps.cols is not padded (negative pad clamps to 0)', () => {
      const narrow: Capabilities = { ...ascii, cols: 5 };
      const out = formatPermanent({ kind: 'user-submit', text: 'a long input' }, narrow);
      // Inner content keeps the original text without truncation;
      // truncation is the renderer's job (truncateToWidth).
      expect(innerOf(out[1] ?? '')).toBe('> a long input');
    });
  });

  // Assistant kind emits just the AI prose, prepended with a blank
  // line (UI.md §6.3). The legacy `· Generated N tokens in Xs` chip
  // header was removed — duration lives in the turn-end marker
  // (`Cogitated for Xs`) and tokens live in the footer's right
  // column. The chip header was duplicating both signals.

  test('assistant emits blank + text lines (single-line)', () => {
    const out = formatPermanent(
      { kind: 'assistant', text: 'hello', durationMs: 8200, outputTokens: 234 },
      ascii,
    );
    // Blank + text. Chip header gone — durationMs / outputTokens
    // come through but render path ignores them.
    expect(out).toEqual([pad(''), pad('hello')]);
  });

  test('assistant emits blank + each text line (multi-line)', () => {
    expect(
      formatPermanent(
        { kind: 'assistant', text: 'line1\nline2', durationMs: 1000, outputTokens: 50 },
        ascii,
      ),
    ).toEqual([pad(''), pad('line1'), pad('line2')]);
  });

  test('assistant with empty text emits nothing (regardless of metadata)', () => {
    // Tool-only turn: the model produced tool_use blocks but no
    // prose. Cost is in the footer + tool-end chips already; no
    // need for a permanent chip-only line in scrollback.
    expect(
      formatPermanent({ kind: 'assistant', text: '', durationMs: 8200, outputTokens: 234 }, ascii),
    ).toEqual([]);
    expect(
      formatPermanent({ kind: 'assistant', text: '', durationMs: null, outputTokens: null }, ascii),
    ).toEqual([]);
  });

  test('assistant with trailing newline emits an explicit empty trailing line', () => {
    // Documents current behavior: text with a trailing `\n` becomes
    // [content, ''] after split. Provider streams typically don't end
    // with a newline; if a future producer does, we may want to filter.
    expect(
      formatPermanent(
        { kind: 'assistant', text: 'foo\n', durationMs: null, outputTokens: null },
        ascii,
      ),
    ).toEqual([pad(''), pad('foo'), pad('')]);
  });

  test('assistant ignores durationMs/outputTokens (chip header removed)', () => {
    // Before the spec change a turn with metadata produced a
    // `· Generated N tokens in Xs` header above the text. Pin the
    // contract that the header is gone — if a future refactor
    // brings it back, this test catches it.
    const out = formatPermanent(
      { kind: 'assistant', text: 'hi', durationMs: 8200, outputTokens: 234 },
      ascii,
    );
    expect(out.join('\n')).not.toContain('Generated');
    expect(out.join('\n')).not.toContain('tokens');
    expect(out.join('\n')).not.toContain('8.2s');
  });

  describe('tool-end (operation chip + sub-content, UI.md §4.10.5/§4.10.7)', () => {
    // Tool-end prepends a leading blank (UI.md §6.3) — each tool
    // finalization is its own "session" block. out[0] is the blank,
    // out[1] is the chip head, out[2] (when present) is the
    // sub-content connector. Sub-content stays tight under the
    // chip — it's the chip's "subsession", not a sibling block.

    test('done status: blank + chip head + sub-content', () => {
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
      expect(out).toHaveLength(3);
      expect(out[0]).toBe(pad(''));
      expect(out[1]).toBe(pad('· Read file in 850ms'));
      expect(out[2]).toBe(pad('└─ /foo.ts'));
    });

    test('done status with no subject emits blank + chip head only', () => {
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
      expect(out).toEqual([pad(''), pad('· Updated todos in 50ms')]);
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
      expect(out[0]).toBe(pad(''));
      expect(out[1]).toContain('Failed in 200ms');
      expect(out[1]).not.toContain('Executed');
      expect(out[2]).toBe(pad('└─ rm -rf /tmp/x'));
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
      expect(out[1]).toContain('Denied in 1ms');
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
      expect(out[2]).toBe(pad('└─ matches deny rule bash.rm.rf'));
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
      expect(out).toHaveLength(3);
      expect(out[2]).toBe(pad('└─ 3 items added'));
    });

    test('chip glyph is `·` under Unicode, `*` under ASCII (after frame margin)', () => {
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
      // Glyph sits at column 2 (after the 2sp frame margin) on the
      // chip head row (out[1] — out[0] is the leading blank).
      expect(u[1]?.charAt(2)).toBe('·');
      expect(a[1]?.charAt(2)).toBe('*');
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
      expect(u[2]).toBe(pad('└─ /x'));
      expect(a[2]).toBe(pad('\\- /x'));
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
      expect(fast[1]).toContain('850ms');
      expect(slow[1]).toContain('1.2s');
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
      expect(out[1]).toContain(`${CSI}31m`);
    });

    test('done status applies dim palette SGR to chip head when color enabled', () => {
      const out = formatPermanent(
        { kind: 'tool-end', name: 'r', verb: 'Read', subject: null, status: 'done', durationMs: 1 },
        colored,
      );
      expect(out[1]).toContain(`${CSI}2m`);
    });
  });

  // error / warn / info also prepend a leading blank — each is a
  // top-level "session" block deserving its own breathing space.

  test('error and warn pass through as plain text when color disabled', () => {
    expect(formatPermanent({ kind: 'error', message: 'down' }, ascii)).toEqual([
      pad(''),
      pad('error: down'),
    ]);
    expect(formatPermanent({ kind: 'warn', message: 'high' }, ascii)).toEqual([
      pad(''),
      pad('warn: high'),
    ]);
  });

  test('error and warn are wrapped in SGR escapes when color enabled', () => {
    const errored = formatPermanent({ kind: 'error', message: 'down' }, colored);
    expect(errored[0]).toBe(pad(''));
    expect(errored[1]).toBe(pad(`${CSI}31merror: down${CSI}0m`));
    const warned = formatPermanent({ kind: 'warn', message: 'high' }, colored);
    expect(warned[0]).toBe(pad(''));
    expect(warned[1]).toBe(pad(`${CSI}33mwarn: high${CSI}0m`));
  });

  describe('subagent_summary (S2 of subagent IPC)', () => {
    test('done shape includes name + summary + duration', () => {
      const out = formatPermanent(
        {
          kind: 'subagent_summary',
          ts: 1,
          subagentId: 'c1',
          name: 'explore',
          status: 'done',
          summary: 'README at /repo/README.md',
          durationMs: 5_000,
        },
        unicode,
      );
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('· task explore Done');
      expect(out[0]).toContain('README at /repo/README.md');
      expect(out[0]).toContain('5s');
    });

    test('error shape uses Failed verb and red SGR when colored', () => {
      const out = formatPermanent(
        {
          kind: 'subagent_summary',
          ts: 1,
          subagentId: 'c1',
          name: 'audit',
          status: 'error',
          summary: 'aborted',
          durationMs: 12,
        },
        colored,
      );
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('Failed');
      // 31 = red SGR (paint(error, ...) goes through this code).
      expect(out[0]).toContain(`${CSI}31m`);
    });

    test('uses ASCII glyph when caps.unicode is false', () => {
      const out = formatPermanent(
        {
          kind: 'subagent_summary',
          ts: 1,
          subagentId: 'c1',
          name: 'r',
          status: 'done',
          summary: 'ok',
          durationMs: 100,
        },
        ascii,
      );
      // The padFrame helper prepends '  '; CHIP_FINAL_GLYPH ASCII
      // is `*` so the line should begin with `  *`.
      expect(out[0]?.startsWith('  *')).toBe(true);
    });

    test('truncates summary >80 chars with ellipsis', () => {
      const long = 'x'.repeat(200);
      const out = formatPermanent(
        {
          kind: 'subagent_summary',
          ts: 1,
          subagentId: 'c1',
          name: 'r',
          status: 'done',
          summary: long,
          durationMs: 100,
        },
        unicode,
      );
      expect(out[0]?.includes('…')).toBe(true);
      // The truncated summary plus chrome should still be a single line.
      expect(out).toHaveLength(1);
    });

    test('empty summary produces a clean line without double-space', () => {
      const out = formatPermanent(
        {
          kind: 'subagent_summary',
          ts: 1,
          subagentId: 'c1',
          name: 'r',
          status: 'done',
          summary: '',
          durationMs: 100,
        },
        unicode,
      );
      expect(out[0]).toContain('Done in 100ms');
      expect(out[0]).not.toContain('Done  in');
    });
  });
});
