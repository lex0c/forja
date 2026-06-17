import { describe, expect, test } from 'bun:test';
import { COGNITIVE_VERB_POOL } from '../../../src/tui/render/spinner-verbs.ts';
import { renderThinkingChip } from '../../../src/tui/render/thinking-chip.ts';
import type { Capabilities } from '../../../src/tui/term.ts';

const caps: Capabilities = {
  isTTY: true,
  cols: 80,
  rows: 24,
  color: 'none',
  unicode: true,
};
const ascii: Capabilities = { ...caps, unicode: false };

// Helper: build a thinking-state object with the messageId
// provided. Tests that don't care about which verb gets picked
// pass an arbitrary id; tests that exercise the verb pool pin
// specific ids and expected pool entries.
const thinking = (
  overrides: Partial<{ startedAt: number; messageId: string; text: string }> = {},
) => ({
  startedAt: 0,
  messageId: 'm1',
  text: '',
  ...overrides,
});

// Match "<word>… [..." — the chip's verb sits before the elapsed
// counter. Used by tests that don't pin a specific verb but do
// need to assert the chip rendered SOME verb from the pool.
const verbPattern = /(\w+)…\s*\[/;

describe('renderThinkingChip', () => {
  test('renders a cognitive verb from the pool with elapsed time', () => {
    const out = renderThinkingChip(thinking({ startedAt: 0 }), caps, 8200);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('[8.2s]');
    const match = out[0]?.match(verbPattern);
    expect(match).not.toBeNull();
    expect(COGNITIVE_VERB_POOL).toContain(match?.[1] ?? '');
  });

  test('verb is stable for the same messageId across consecutive renders', () => {
    // Within a turn the spinner ticks every ~150ms — re-rendering
    // with the same state must produce the same verb so the chip
    // doesn't flicker between "Modeling" and "Synthesizing".
    const a = renderThinkingChip(thinking({ messageId: 'msg_01ABC' }), caps, 1000);
    const b = renderThinkingChip(thinking({ messageId: 'msg_01ABC' }), caps, 5000);
    const verbA = a[0]?.match(verbPattern)?.[1];
    const verbB = b[0]?.match(verbPattern)?.[1];
    expect(verbA).toBe(verbB ?? '');
  });

  test('does NOT show a token counter (extended thinking has no usable per-token signal mid-pass)', () => {
    // Anthropic emits cumulative usage at message_stop, not during
    // thinking_delta. Inventing a count here would mislead the
    // operator about progress; pin the absence so a future
    // refactor that adds a counter has to come with an explicit
    // design decision and a corresponding signal source.
    const out = renderThinkingChip(thinking({ startedAt: 0 }), caps, 8200);
    expect(out[0]).not.toContain('tokens');
    expect(out[0]).not.toContain('↑');
    expect(out[0]).not.toContain('^');
  });

  test('sub-second elapsed renders in ms', () => {
    const out = renderThinkingChip(thinking({ startedAt: 100 }), caps, 450);
    expect(out[0]).toContain('[350ms]');
  });

  test('negative elapsed (clock skew) clamps to 0ms', () => {
    // Same clamp as assistant-chip — keeps the unit consistent
    // across both family chips so a clock-skew tick doesn't
    // make the counter visually jump units.
    const out = renderThinkingChip(thinking({ startedAt: 5000 }), caps, 1000);
    expect(out[0]).toContain('[0ms]');
  });

  test('ASCII fallback works (spinner falls back, no unicode arrow needed)', () => {
    // Thinking chip has no `↑`/`^` glyph by design (no token
    // counter), so the ascii path differs from assistant-chip
    // only in the spinner glyph. Pin that the chip renders
    // cleanly under unicode=false anyway.
    const out = renderThinkingChip(thinking({ startedAt: 0 }), ascii, 1200);
    expect(out[0]).toContain('[1.2s]');
    const match = out[0]?.match(verbPattern);
    expect(COGNITIVE_VERB_POOL).toContain(match?.[1] ?? '');
  });
});
