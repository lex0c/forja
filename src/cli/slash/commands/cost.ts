// /cost — show cumulative cost, steps, and turns for this REPL run.
//
// Reads from ctx.cumulative which the REPL updates on every
// session_finished (totals). Cost format mirrors the footer (shared
// via `format.ts`).
//
// Output shape:
//   cumulative: $X · N steps · M turns

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
    return { kind: 'ok', notes };
  },
};
