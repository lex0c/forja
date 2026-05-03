import { describe, expect, test } from 'bun:test';
import { renderAssistantChip } from '../../../src/tui/render/assistant-chip.ts';
import type { PendingAssistant } from '../../../src/tui/state.ts';
import type { Capabilities } from '../../../src/tui/term.ts';

const caps: Capabilities = {
  isTTY: true,
  cols: 80,
  rows: 24,
  color: 'none',
  unicode: true,
};
const ascii: Capabilities = { ...caps, unicode: false };

const pending = (overrides: Partial<PendingAssistant> = {}): PendingAssistant => ({
  messageId: 'm1',
  text: '',
  startedAt: 0,
  inputTokens: null,
  outputTokens: null,
  cacheRead: null,
  cacheCreation: null,
  ...overrides,
});

describe('renderAssistantChip', () => {
  test('no usage event yet → counter is duration only', () => {
    const out = renderAssistantChip(pending({ startedAt: 0 }), caps, 8200);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Generating…');
    expect(out[0]).toContain('(8.2s)');
    // No tokens clause until assistant:usage lands.
    expect(out[0]).not.toContain('tokens');
    expect(out[0]).not.toContain('↑');
  });

  test('usage merged → counter shows tokens with ↑ glyph', () => {
    const out = renderAssistantChip(pending({ startedAt: 0, outputTokens: 234 }), caps, 8200);
    expect(out[0]).toContain('Generating…');
    expect(out[0]).toContain('(8.2s · ↑ 234 tokens)');
  });

  test('sub-second elapsed renders in ms', () => {
    const out = renderAssistantChip(pending({ startedAt: 100 }), caps, 450);
    expect(out[0]).toContain('(350ms)');
  });

  test('ASCII fallback uses ^ instead of ↑', () => {
    const out = renderAssistantChip(pending({ startedAt: 0, outputTokens: 50 }), ascii, 1200);
    expect(out[0]).toContain('^ 50 tokens');
    expect(out[0]).not.toContain('↑');
  });

  test('outputTokens of 0 still renders the tokens clause (provider said zero, not unknown)', () => {
    // null = "no usage event yet"; 0 = "usage event arrived, output is zero".
    // The distinction matters for honesty: a tool-only turn that ended
    // with zero output tokens should still show the counter.
    const out = renderAssistantChip(pending({ startedAt: 0, outputTokens: 0 }), caps, 1200);
    expect(out[0]).toContain('↑ 0 tokens');
  });

  test('negative elapsed (clock went backwards) clamps to 0ms', () => {
    // Defensive: not expected in production, but renderer shouldn't
    // emit "(-3s · ↑ ...)" if a buggy producer sets startedAt > now.
    // Clamps to 0ms (not 0s) so the unit stays consistent with the
    // sub-second positive branch — a single skew tick shouldn't make
    // the counter visually jump units.
    const out = renderAssistantChip(pending({ startedAt: 5000 }), caps, 1000);
    expect(out[0]).toContain('(0ms)');
  });
});
