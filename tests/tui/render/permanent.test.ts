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

    test('nested (parentId set): no leading blank + |_ glyph + indented sub-content', () => {
      // Slice 2: chips with parentId render under their owner
      // (today: a subagent run). The leading blank that separates
      // top-level chips drops — a burst of nested chips reads as
      // one visual block under the parent rather than gap-
      // separated siblings. The chip glyph swaps from `·` to `|_`
      // and the sub-content connector indents to stay aligned
      // with the nested chip head.
      const out = formatPermanent(
        {
          kind: 'tool-end',
          name: 'read_file',
          verb: 'Read file',
          subject: '/foo.ts',
          status: 'done',
          durationMs: 200,
          parentId: 'sub-abc',
        },
        unicode,
      );
      expect(out).toHaveLength(2);
      // Indent (2sp) between frame padding and the |_ glyph; subject
      // line keeps the same indent so the connector lines up under
      // the nested head.
      expect(out[0]).toBe(pad('  |_ Read file in 200ms'));
      expect(out[1]).toBe(pad('  └─ /foo.ts'));
    });

    test('nested chip in ASCII mode also uses |_ (consistent in both unicode and ascii)', () => {
      // The nest glyph is the same string in unicode and ascii —
      // `|_` reads as "branch from above" regardless of capability.
      // Pinned so a future "fancy unicode arrow" refactor doesn't
      // diverge the two paths and break the ASCII fallback.
      const out = formatPermanent(
        {
          kind: 'tool-end',
          name: 'echo',
          verb: 'Executed',
          subject: 'hi',
          status: 'done',
          durationMs: 5,
          parentId: 'sub-x',
        },
        ascii,
      );
      expect(out[0]).toBe(pad('  |_ Executed in 5ms'));
    });

    test('nested chip with no subject emits ONLY the head line (no orphan connector)', () => {
      const out = formatPermanent(
        {
          kind: 'tool-end',
          name: 'todo_write',
          verb: 'Updated todos',
          subject: null,
          status: 'done',
          durationMs: 5,
          parentId: 'sub-y',
        },
        unicode,
      );
      expect(out).toEqual([pad('  |_ Updated todos in 5ms')]);
    });

    test('nested error chip keeps the error palette + |_ glyph', () => {
      // Status palette is independent of nesting — a nested tool
      // that failed still reads as red.
      const out = formatPermanent(
        {
          kind: 'tool-end',
          name: 'bash',
          verb: 'Executed',
          subject: null,
          status: 'error',
          durationMs: 5,
          parentId: 'sub-z',
        },
        colored,
      );
      // Painted output starts with SGR red (palette 'error'). Just
      // assert the visible substring — exact escape codes are
      // verified elsewhere; the load-bearing thing here is that the
      // glyph is `|_` with the indent under the painted segment.
      expect(out[0]).toContain('|_ Failed in 5ms');
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

    test('error with summary appends reason as `subject: summary`', () => {
      const out = formatPermanent(
        {
          kind: 'tool-end',
          name: 'read_file',
          verb: 'Read file',
          subject: '/proj/missing.txt',
          status: 'error',
          durationMs: 2,
          summary: 'ENOENT: no such file or directory',
        },
        unicode,
      );
      expect(out[1]).toContain('Failed in 2ms');
      expect(out[2]).toBe(pad('└─ /proj/missing.txt: ENOENT: no such file or directory'));
    });

    test('error with summary but no subject falls back to summary alone', () => {
      // todo_write has no vocab subject. An error there should still
      // surface the cause on the connector instead of dropping it.
      const out = formatPermanent(
        {
          kind: 'tool-end',
          name: 'todo_write',
          verb: 'Updated todos',
          subject: null,
          status: 'error',
          durationMs: 1,
          summary: 'todo list serialization failed',
        },
        unicode,
      );
      expect(out[1]).toContain('Failed in 1ms');
      expect(out[2]).toBe(pad('└─ todo list serialization failed'));
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

  describe('tool-end-batch (slice 3 — coalesced summary chip)', () => {
    test('top-level batch: blank + chip head with count + |_ continuations per subject', () => {
      const out = formatPermanent(
        {
          kind: 'tool-end-batch',
          name: 'read_file',
          verb: 'Read 3 files',
          count: 3,
          totalDurationMs: 4500,
          subjects: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
          status: 'done',
        },
        unicode,
      );
      // Layout: blank, head, then 3 |_ continuation lines.
      // Duration crosses 1s threshold → formatted as `4.5s`.
      expect(out).toEqual([
        pad(''),
        pad('· Read 3 files in 4.5s'),
        pad('  |_ src/a.ts'),
        pad('  |_ src/b.ts'),
        pad('  |_ src/c.ts'),
      ]);
    });

    test('nested batch: no leading blank + |_ glyph head + double-indent continuations', () => {
      // When the batch itself is nested under a subagent (parentId
      // set), the head uses `|_` and the continuations indent ONE
      // step deeper so the visual hierarchy reads "subagent >
      // batch summary > child detail".
      const out = formatPermanent(
        {
          kind: 'tool-end-batch',
          name: 'read_file',
          verb: 'Read 3 files',
          count: 3,
          totalDurationMs: 6000,
          subjects: ['/sub/a.ts', '/sub/b.ts', '/sub/c.ts'],
          status: 'done',
          parentId: 'sub-abc',
        },
        unicode,
      );
      expect(out).toEqual([
        pad('  |_ Read 3 files in 6.0s'),
        pad('    |_ /sub/a.ts'),
        pad('    |_ /sub/b.ts'),
        pad('    |_ /sub/c.ts'),
      ]);
    });

    test('error status: head uses error palette + verb overridden to Failed', () => {
      const out = formatPermanent(
        {
          kind: 'tool-end-batch',
          name: 'read_file',
          verb: 'Read 3 files',
          count: 3,
          totalDurationMs: 100,
          subjects: ['a', 'b', 'c'],
          status: 'error',
        },
        colored,
      );
      // Verb override mirrors the single-chip behavior: error
      // statuses always read "Failed" regardless of the producer's
      // headline. Operator gets a uniform error verb across single
      // and batch chips.
      expect(out[1]).toContain('Failed in 100ms');
    });

    test('empty subjects array still emits the head (no orphan |_ lines)', () => {
      // Defensive: a tool that has no vocab subject extractor (all
      // children produced null subjects, all filtered upstream) can
      // still surface as a batch chip — count carries the signal.
      const out = formatPermanent(
        {
          kind: 'tool-end-batch',
          name: 'echo',
          verb: 'Echoed ×3',
          count: 3,
          totalDurationMs: 30,
          subjects: [],
          status: 'done',
        },
        unicode,
      );
      expect(out).toEqual([pad(''), pad('· Echoed ×3 in 30ms')]);
    });

    test('ASCII mode: |_ continuations work without unicode', () => {
      // The nest glyph is intentionally identical in unicode and
      // ASCII so the affordance survives the no-unicode fallback.
      const out = formatPermanent(
        {
          kind: 'tool-end-batch',
          name: 'read_file',
          verb: 'Read 2 files',
          count: 2,
          totalDurationMs: 200,
          subjects: ['a.ts', 'b.ts'],
          status: 'done',
        },
        ascii,
      );
      // ASCII chip glyph is `*`; continuations still `|_`.
      expect(out[1]).toBe(pad('* Read 2 files in 200ms'));
      expect(out[2]).toBe(pad('  |_ a.ts'));
      expect(out[3]).toBe(pad('  |_ b.ts'));
    });
  });

  test('error and warn are wrapped in SGR escapes when color enabled', () => {
    const errored = formatPermanent({ kind: 'error', message: 'down' }, colored);
    expect(errored[0]).toBe(pad(''));
    expect(errored[1]).toBe(pad(`${CSI}31merror: down${CSI}0m`));
    const warned = formatPermanent({ kind: 'warn', message: 'high' }, colored);
    expect(warned[0]).toBe(pad(''));
    expect(warned[1]).toBe(pad(`${CSI}33mwarn: high${CSI}0m`));
  });

  test('recap-terse: bold "recap:" prefix + secondary across the line (RECAP §3.3)', () => {
    // Color path: `recap:` is wrapped in `${CSI}90m${CSI}1m...${CSI}0m`
    // (secondary + bold via paintMulti — single trailing reset).
    // Body is wrapped in `${CSI}90m...${CSI}0m`. Two separate
    // SGR runs with a single reset each, concatenated.
    const out = formatPermanent({ kind: 'recap-terse', message: 'fix the bug.' }, colored);
    expect(out[0]).toBe(pad(''));
    expect(out[1]).toBe(pad(`${CSI}90m${CSI}1mrecap:${CSI}0m${CSI}90m fix the bug.${CSI}0m`));
  });

  test('recap-terse: plain text when color disabled', () => {
    const out = formatPermanent({ kind: 'recap-terse', message: 'fix the bug.' }, ascii);
    expect(out).toEqual([pad(''), pad('recap: fix the bug.')]);
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
          costUsd: 0,
        },
        unicode,
      );
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('· task explore Done');
      expect(out[0]).toContain('README at /repo/README.md');
      expect(out[0]).toContain('5s');
    });

    test('error shape uses Error verb and red SGR when colored', () => {
      // Renamed from "Failed" to "Error" — the verb mapping
      // distinguishes status types (Done / Aborted / Exhausted /
      // Error) so the operator can read the cause at a glance.
      // "Failed" remains the last-resort fallback for unknown
      // status combos.
      const out = formatPermanent(
        {
          kind: 'subagent_summary',
          ts: 1,
          subagentId: 'c1',
          name: 'audit',
          status: 'error',
          summary: 'crashed',
          durationMs: 12,
          costUsd: 0,
        },
        colored,
      );
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('Error');
      // 31 = red SGR (paint(error, ...) goes through this code).
      expect(out[0]).toContain(`${CSI}31m`);
    });

    test('exhausted + maxCostUsd renders cost cap label with $X', () => {
      const out = formatPermanent(
        {
          kind: 'subagent_summary',
          ts: 1,
          subagentId: 'c1',
          name: 'explain',
          status: 'exhausted',
          reason: 'maxCostUsd',
          summary: 'budget exceeded',
          durationMs: 96_000,
          costUsd: 0.6,
        },
        unicode,
      );
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('Exhausted (cost cap, $0.60)');
    });

    test('cost rendering rounds half-up at IEEE-754 edges (0.585 → $0.59)', () => {
      // (0.585).toFixed(2) returns "0.58" in V8 / JavaScriptCore
      // because 0.585 has an inexact IEEE-754 representation
      // that rounds DOWN under toFixed's banker-style behavior.
      // Anthropic pricing produces values right at this kind of
      // edge — operator would see "$0.58 cost cap" when the run
      // actually hit $0.59. Pin the half-up Math.round-based
      // formatter so the displayed amount matches the cap that
      // fired.
      const out = formatPermanent(
        {
          kind: 'subagent_summary',
          ts: 1,
          subagentId: 'c1',
          name: 'explain',
          status: 'exhausted',
          reason: 'maxCostUsd',
          summary: '',
          durationMs: 96_000,
          costUsd: 0.585,
        },
        unicode,
      );
      expect(out[0]).toContain('Exhausted (cost cap, $0.59)');
      expect(out[0]).not.toContain('$0.58');
    });

    test('interrupted + aborted renders Aborted verb', () => {
      const out = formatPermanent(
        {
          kind: 'subagent_summary',
          ts: 1,
          subagentId: 'c1',
          name: 'explain',
          status: 'interrupted',
          reason: 'aborted',
          summary: '',
          durationMs: 1500,
          costUsd: 0.02,
        },
        unicode,
      );
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('Aborted');
    });

    test('exhausted + maxSteps renders step cap label', () => {
      const out = formatPermanent(
        {
          kind: 'subagent_summary',
          ts: 1,
          subagentId: 'c1',
          name: 'refactor',
          status: 'exhausted',
          reason: 'maxSteps',
          summary: 'step cap reached',
          durationMs: 5000,
          costUsd: 0.42,
        },
        unicode,
      );
      expect(out[0]).toContain('Exhausted (step cap)');
    });

    test('error + stepStalled renders "Error (no progress)"', () => {
      // Step-stall watchdog fired — provider stream went silent
      // for the full stallMs budget. Operator sees a specific
      // cause label instead of a generic "Error" or worse,
      // "Failed". Pin the verb so a regression that drops the
      // stepStalled branch from the verb mapping shows up here.
      const out = formatPermanent(
        {
          kind: 'subagent_summary',
          ts: 1,
          subagentId: 'c1',
          name: 'explain',
          status: 'error',
          reason: 'stepStalled',
          summary: 'step stalled (no provider events for 90000ms)',
          durationMs: 90_000,
          costUsd: 0.02,
        },
        unicode,
      );
      expect(out[0]).toContain('Error (no progress)');
    });

    test('interrupted + maxWallClockMs renders Timed out', () => {
      const out = formatPermanent(
        {
          kind: 'subagent_summary',
          ts: 1,
          subagentId: 'c1',
          name: 'audit',
          status: 'interrupted',
          reason: 'maxWallClockMs',
          summary: '',
          durationMs: 600_000,
          costUsd: 0,
        },
        unicode,
      );
      expect(out[0]).toContain('Timed out');
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
          costUsd: 0,
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
          costUsd: 0,
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
          costUsd: 0,
        },
        unicode,
      );
      expect(out[0]).toContain('Done in 100ms');
      expect(out[0]).not.toContain('Done  in');
    });
  });

  describe('info (UI.md §6.1 — plain by default, secondary tone opt-in)', () => {
    test('default tone: message is plain (no SGR) even when colored', () => {
      const out = formatPermanent({ kind: 'info', message: 'help text here' }, colored);
      // [leading blank, message]. The message row carries no SGR —
      // info isn't an alert; coloring it would collide with warn.
      expect(out).toHaveLength(2);
      expect(out[1]).toContain('help text here');
      expect(out[1]).not.toContain(CSI);
    });

    test("tone 'plain' is identical to omitting tone", () => {
      const plain = formatPermanent({ kind: 'info', message: 'x' }, colored);
      const explicit = formatPermanent({ kind: 'info', message: 'x', tone: 'plain' }, colored);
      expect(explicit).toEqual(plain);
    });

    test("tone 'secondary' paints the message in the grey meta channel (SGR 90)", () => {
      const out = formatPermanent(
        {
          kind: 'info',
          message: '— resumed 2 prior turns (history above; new turns below) —',
          tone: 'secondary',
        },
        colored,
      );
      expect(out).toHaveLength(2);
      expect(out[1]).toContain(`${CSI}90m`);
      expect(out[1]).toContain('resumed 2 prior turns');
    });

    test("tone 'secondary' emits no SGR when color is disabled", () => {
      const out = formatPermanent({ kind: 'info', message: 'anchor', tone: 'secondary' }, ascii);
      // paint() no-ops under color: 'none' — the line is plain text.
      expect(out[1]).toBe(pad('anchor'));
    });
  });
});
