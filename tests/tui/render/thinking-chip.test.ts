import { describe, expect, test } from 'bun:test';
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

describe('renderThinkingChip', () => {
  test('renders the Thinking… label with elapsed time', () => {
    const out = renderThinkingChip({ startedAt: 0 }, caps, 8200);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Thinking…');
    expect(out[0]).toContain('(8.2s)');
  });

  test('does NOT show a token counter (extended thinking has no usable per-token signal mid-pass)', () => {
    // Anthropic emits cumulative usage at message_stop, not during
    // thinking_delta. Inventing a count here would mislead the
    // operator about progress; pin the absence so a future
    // refactor that adds a counter has to come with an explicit
    // design decision and a corresponding signal source.
    const out = renderThinkingChip({ startedAt: 0 }, caps, 8200);
    expect(out[0]).not.toContain('tokens');
    expect(out[0]).not.toContain('↑');
    expect(out[0]).not.toContain('^');
  });

  test('sub-second elapsed renders in ms', () => {
    const out = renderThinkingChip({ startedAt: 100 }, caps, 450);
    expect(out[0]).toContain('(350ms)');
  });

  test('negative elapsed (clock skew) clamps to 0ms', () => {
    // Same clamp as assistant-chip — keeps the unit consistent
    // across both family chips so a clock-skew tick doesn't
    // make the counter visually jump units.
    const out = renderThinkingChip({ startedAt: 5000 }, caps, 1000);
    expect(out[0]).toContain('(0ms)');
  });

  test('ASCII fallback works (spinner falls back, no unicode arrow needed)', () => {
    // Thinking chip has no `↑`/`^` glyph by design (no token
    // counter), so the ascii path differs from assistant-chip
    // only in the spinner glyph. Pin that the chip renders
    // cleanly under unicode=false anyway.
    const out = renderThinkingChip({ startedAt: 0 }, ascii, 1200);
    expect(out[0]).toContain('Thinking…');
    expect(out[0]).toContain('(1.2s)');
  });
});
