// /cost — show cumulative cost, steps, and turns for this REPL run.
//
// Reads from ctx.cumulative which the REPL updates on every
// session_finished (totals) and critique_finished (critique
// subset). Cost format mirrors the footer (shared via `format.ts`).
//
// Output shape:
//   cumulative: $X · N steps · M turns
//   └─ critique: $Y         # only when self-critique ran at least once
//
// The critique line is omitted when the operator hasn't enabled
// the gate (mode='off') so the default-mode output stays a single
// line — adding a "$0 critique" line for every run would be noise.
// ORCHESTRATION.md §6.3 calls for the breakdown explicitly so
// operators can tune mode/threshold based on the spend split.

import { formatCost } from '../format.ts';
import type { SlashCommand } from '../types.ts';

export const costCommand: SlashCommand = {
  name: 'cost',
  description: 'show cumulative cost / steps / turns for this REPL session',
  exec: async (args, ctx) => {
    if (args.length > 0) {
      return { kind: 'error', message: '/cost: takes no arguments' };
    }
    const c = ctx.cumulative;
    const notes: string[] = [
      `cumulative: ${formatCost(c.costUsd)} · ${c.steps} steps · ${c.turns} turns`,
    ];
    if (c.critiqueCostUsd > 0) {
      notes.push(`└─ critique: ${formatCost(c.critiqueCostUsd)}`);
    }
    return { kind: 'ok', notes };
  },
};
