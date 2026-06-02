// Shared formatters for slash command output.
//
// Cost format degrades with magnitude (4 decimals < $1, 3 < $100,
// 2 ≥ $100) — same shape as the footer's right column for a
// consistent reading experience across every place the operator
// sees a dollar figure.

import type { SlashContext } from './types.ts';

// Append the "current turn already snapshot its config" cue when a
// turn is in flight, so an operator mutating a next-turn config knob
// mid-turn isn't misled into thinking it applies to the running
// prompt (the harness reads its config once at startTurn). Shared by
// every next-turn mutation command (/model, /budget, /effort) so the
// exact wording can't drift between them.
export const withRunningCue = (ctx: SlashContext, notes: string[]): string[] =>
  ctx.isRunning()
    ? [
        ...notes,
        '(current turn already snapshot its config; new value applies starting next prompt)',
      ]
    : notes;

export const formatCost = (usd: number): string => {
  if (usd >= 100) return `$${usd.toFixed(2)}`;
  if (usd >= 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
};

export const formatMs = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}min`;
};
