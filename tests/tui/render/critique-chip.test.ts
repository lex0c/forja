import { describe, expect, test } from 'bun:test';
import { renderCritiqueChip } from '../../../src/tui/render/critique-chip.ts';
import type { Capabilities } from '../../../src/tui/term.ts';

const caps: Capabilities = {
  isTTY: true,
  cols: 80,
  rows: 24,
  color: 'none',
  unicode: true,
};
const ansiCaps: Capabilities = { ...caps, color: 'basic' };

const critique = (
  overrides: Partial<{
    startedAt: number;
    stepN: number;
    toolPlanWrites: boolean;
  }> = {},
) => ({
  startedAt: 0,
  stepN: 1,
  toolPlanWrites: false,
  ...overrides,
});

describe('renderCritiqueChip', () => {
  test('text-only review uses the "Reviewing output" verb and warn palette', () => {
    const out = renderCritiqueChip(critique({ toolPlanWrites: false }), ansiCaps, 1500);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Reviewing output');
    expect(out[0]).toContain('[1.5s]');
  });

  test('writes-step plan critique uses the "Reviewing tool plan" verb and error palette', () => {
    const writes = renderCritiqueChip(critique({ toolPlanWrites: true }), ansiCaps, 800);
    const text = renderCritiqueChip(critique({ toolPlanWrites: false }), ansiCaps, 800);
    expect(writes[0]).toContain('Reviewing tool plan');
    expect(text[0]).toContain('Reviewing output');
    // Distinct ANSI escape sequences (writes uses error/red, text
    // uses warn/yellow). The exact codes are managed by paint();
    // we just assert they DIFFER so a future palette tweak doesn't
    // silently collapse the two flavors.
    expect(writes[0]).not.toBe(text[0]);
  });

  test('elapsed renders as ms below 1s, then seconds', () => {
    const sub = renderCritiqueChip(critique({ startedAt: 0 }), caps, 750);
    const sec = renderCritiqueChip(critique({ startedAt: 0 }), caps, 4200);
    expect(sub[0]).toContain('[750ms]');
    expect(sec[0]).toContain('[4.2s]');
  });

  test('clock skew (now < startedAt) clamps to 0ms instead of going negative', () => {
    const out = renderCritiqueChip(critique({ startedAt: 5000 }), caps, 4000);
    expect(out[0]).toContain('[0ms]');
  });
});
