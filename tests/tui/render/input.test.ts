import { describe, expect, test } from 'bun:test';
import { renderInput } from '../../../src/tui/render/input.ts';
import { CSI, type Capabilities } from '../../../src/tui/term.ts';

const caps: Capabilities = {
  isTTY: true,
  cols: 80,
  rows: 24,
  color: 'none',
  unicode: true,
};
const colored: Capabilities = { ...caps, color: 'basic' };

describe('renderInput', () => {
  test('empty input shows just the prompt prefix', () => {
    expect(renderInput({ value: '', cursor: 0 }, caps)).toEqual(['> ']);
  });

  test('placeholder shows after the prompt on an empty buffer (INBOX §6.1)', () => {
    expect(
      renderInput({ value: '', cursor: 0 }, caps, {
        placeholder: 'Press up to edit queued messages',
      }),
    ).toEqual(['> Press up to edit queued messages']);
  });

  test('placeholder is suppressed once the buffer is non-empty', () => {
    expect(
      renderInput({ value: 'hi', cursor: 2 }, caps, { placeholder: 'Press up to edit' }),
    ).toEqual(['> hi']);
  });

  test('placeholder is painted dim (affordance, not typed content)', () => {
    const out = renderInput({ value: '', cursor: 0 }, colored, { placeholder: 'hint' });
    expect(out).toHaveLength(1);
    expect(out[0]?.startsWith('> ')).toBe(true);
    expect(out[0]).toContain('hint');
    expect(out[0]).toContain(CSI);
  });

  test('slash command token is painted accent (blue); args keep the normal tone', () => {
    // accent = SGR 94. Only the `/effort` token is wrapped; ` high` is
    // emitted plain.
    const out = renderInput({ value: '/effort high', cursor: 12 }, colored);
    expect(out).toEqual([`> ${CSI}94m/effort${CSI}0m high`]);
  });

  test('a bare slash turns blue immediately', () => {
    const out = renderInput({ value: '/', cursor: 1 }, colored);
    expect(out).toEqual([`> ${CSI}94m/${CSI}0m`]);
  });

  test('non-slash input is not colored', () => {
    const out = renderInput({ value: 'hello world', cursor: 11 }, colored);
    expect(out).toEqual(['> hello world']);
  });

  test('slash highlight no-ops under color=none', () => {
    expect(renderInput({ value: '/effort high', cursor: 12 }, caps)).toEqual(['> /effort high']);
  });

  test('dimmed (reverse-search) slash line dims rather than coloring', () => {
    const out = renderInput({ value: '/effort', cursor: 7 }, colored, { dimmed: true });
    // Whole row dim (SGR 2), no accent (94).
    expect(out[0]).toContain(`${CSI}2m`);
    expect(out[0]).not.toContain(`${CSI}94m`);
  });

  test('bash mode: `!` flips the prompt and paints the whole line yellow', () => {
    // warn = SGR 33 (yellow). Prompt glyph becomes `! ` and the entire
    // row (prompt + command) is wrapped. `bash` is decided by the caller
    // (composeLive, idle-gated) and passed in.
    const out = renderInput({ value: '!ls -la', cursor: 7 }, colored, { bash: true });
    expect(out).toEqual([`${CSI}33m! ls -la${CSI}0m`]);
  });

  test('bash mode prompt under color=none keeps the `!` glyph, no SGR', () => {
    expect(renderInput({ value: '!ls', cursor: 3 }, caps, { bash: true })).toEqual(['! ls']);
  });

  test('bash-mode continuation rows use the aligned indent and stay yellow', () => {
    const out = renderInput({ value: '!a\nb', cursor: 4 }, colored, { bash: true });
    expect(out).toEqual([`${CSI}33m! a${CSI}0m`, `${CSI}33m  b${CSI}0m`]);
  });

  test('dimming wins over bash mode (reverse-search owns the palette)', () => {
    const out = renderInput({ value: '!ls', cursor: 3 }, colored, { bash: true, dimmed: true });
    // Dim (SGR 2), not warn (33); prompt stays `> ` since dim shadows bash.
    expect(out[0]).toContain(`${CSI}2m`);
    expect(out[0]).not.toContain(`${CSI}33m`);
    expect(out[0]).toContain('> ');
  });

  test('a `!` buffer without the bash flag is treated as plain content', () => {
    // composeLive does not set `bash` mid-turn (idle gate) — the `!` then
    // renders as a normal gray draft, no prompt flip, no yellow.
    expect(renderInput({ value: '!ls', cursor: 3 }, colored)).toEqual(['> !ls']);
  });

  test('single line gets prompt prefix', () => {
    expect(renderInput({ value: 'hello', cursor: 5 }, caps)).toEqual(['> hello']);
  });

  test('multi-line indents continuation rows by 2 spaces', () => {
    expect(renderInput({ value: 'first\nsecond\nthird', cursor: 0 }, caps)).toEqual([
      '> first',
      '  second',
      '  third',
    ]);
  });

  test('preserves a trailing empty line', () => {
    // User pressed Shift+Enter at the end — there's a trailing newline
    // and we surface it as an empty continuation row so the cursor has
    // somewhere visible to live.
    expect(renderInput({ value: 'abc\n', cursor: 4 }, caps)).toEqual(['> abc', '  ']);
  });

  test('soft-wrap does not split a surrogate pair across rows', () => {
    // Regression: previously `line.slice(pos, pos + innerWidth)` would
    // cut emoji like 😀 (U+1F600 — surrogate pair "😀") in
    // half if the wrap boundary fell between its two code units. The
    // terminal then rendered U+FFFD halves and every column drifted
    // by one for the rest of the line.
    //
    // Build a line whose 1F600 sits exactly at the boundary: with
    // narrow caps cols=10, prompt prefix = 2, innerWidth = 8. Filler
    // of 7 ASCII chars lands the high surrogate at column 8; without
    // the fix the chunk would be `'\uD83D'` (broken) and the next
    // would start with `'\uDE00'` (also broken).
    const narrow: Capabilities = { ...caps, cols: 10 };
    const line = `${'a'.repeat(7)}😀b`;
    const out = renderInput({ value: line, cursor: 0 }, narrow);
    // First sub-row must NOT end with a lone high surrogate.
    expect(out[0]).toBe('> aaaaaaa');
    // Second sub-row carries the full emoji intact.
    expect(out[1]).toBe('  😀b');
  });

  test('dimmed: every row wraps with dim SGR (HISTORY.md §2.2)', () => {
    const out = renderInput({ value: 'first\nsecond', cursor: 0 }, colored, { dimmed: true });
    expect(out).toHaveLength(2);
    // Each row carries the dim CSI escape AND the SGR reset.
    for (const row of out) {
      expect(row).toContain(`${CSI}2m`);
      expect(row).toContain(`${CSI}0m`);
    }
  });

  test('dimmed: under color=none, paint is a no-op (no SGR escapes leak)', () => {
    const out = renderInput({ value: 'x', cursor: 1 }, caps, { dimmed: true });
    expect(out).toEqual(['> x']);
  });

  test('non-dimmed (default) emits no SGR even with color enabled', () => {
    const out = renderInput({ value: 'x', cursor: 1 }, colored);
    expect(out[0]).not.toContain(`${CSI}2m`);
  });

  test('commandGhost trails a fully-typed slash command (cursor at end)', () => {
    const out = renderInput({ value: '/effort', cursor: 7 }, caps, {
      commandGhost: ' [low|medium|high]',
    });
    expect(out).toEqual(['> /effort [low|medium|high]']);
  });

  test('commandGhost is painted secondary (SGR 90); the token keeps its accent', () => {
    const out = renderInput({ value: '/effort', cursor: 7 }, colored, {
      commandGhost: ' [low|medium|high]',
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(`${CSI}94m/effort`); // accent token
    expect(out[0]).toContain(`${CSI}90m`); // secondary ghost
    expect(out[0]).toContain('[low|medium|high]');
  });

  test('commandGhost works after a trailing space (no leading space in the hint)', () => {
    const out = renderInput({ value: '/effort ', cursor: 8 }, caps, {
      commandGhost: '[low|medium|high]',
    });
    expect(out).toEqual(['> /effort [low|medium|high]']);
  });

  test('commandGhost is hidden when the cursor is NOT at the line end', () => {
    // Operator arrowed left — a trailing ghost would sit past the caret.
    const out = renderInput({ value: '/effort', cursor: 3 }, caps, {
      commandGhost: ' [low|medium|high]',
    });
    expect(out).toEqual(['> /effort']);
  });

  test('commandGhost is suppressed under dim (reverse-search owns the palette)', () => {
    const out = renderInput({ value: '/effort', cursor: 7 }, colored, {
      commandGhost: ' [low|medium|high]',
      dimmed: true,
    });
    expect(out[0]).not.toContain('low|medium|high');
  });

  test('commandGhost is dropped rather than wrapped when it overflows the row', () => {
    // cols=10: prompt(2)+/effort(7)=9; the 18-col hint would overflow, so
    // the ghost is dropped (never wrapped onto a second row).
    const narrow: Capabilities = { ...caps, cols: 10 };
    const out = renderInput({ value: '/effort', cursor: 7 }, narrow, {
      commandGhost: ' [low|medium|high]',
    });
    expect(out).toEqual(['> /effort']);
  });

  test('commandGhost is ignored for a non-slash buffer', () => {
    const out = renderInput({ value: 'hello', cursor: 5 }, caps, { commandGhost: ' x' });
    expect(out).toEqual(['> hello']);
  });
});
