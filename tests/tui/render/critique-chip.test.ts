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
    // Verb under color-none: the shimmer is inert there, so the
    // label is a contiguous substring (under color it splits
    // per-char as the highlight slides).
    const plain = renderCritiqueChip(critique({ toolPlanWrites: false }), caps, 1500);
    expect(plain).toHaveLength(1);
    expect(plain[0]).toContain('Reviewing output');
    expect(plain[0]).toContain('[1.5s]');
    // Palette under color: the warn token is present.
    const colored = renderCritiqueChip(critique({ toolPlanWrites: false }), ansiCaps, 1500);
    expect(colored[0]).toContain('\x1b[33m');
  });

  test('writes-step plan critique uses "Reviewing tool plan" + error palette', () => {
    expect(renderCritiqueChip(critique({ toolPlanWrites: true }), caps, 800)[0]).toContain(
      'Reviewing tool plan',
    );
    expect(renderCritiqueChip(critique({ toolPlanWrites: false }), caps, 800)[0]).toContain(
      'Reviewing output',
    );
    // Base palette under color: writes = error/red, text-only = warn/yellow.
    expect(renderCritiqueChip(critique({ toolPlanWrites: true }), ansiCaps, 800)[0]).toContain(
      '\x1b[31m',
    );
    expect(renderCritiqueChip(critique({ toolPlanWrites: false }), ansiCaps, 800)[0]).toContain(
      '\x1b[33m',
    );
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
