// /cost — show cumulative cost, steps, and turns for this REPL run.
//
// Cost is DB-derived (computeUsageStats over the REPL's session tree),
// the SAME source as /stats and the footer — so the three never disagree.
// That makes the cost tree-wide (incl. `task_*` subagents) and
// resume-correct, unlike the in-memory `ctx.cumulative.costUsd` running
// total it used to read (parent-self only, reset on resume).
//
// steps/turns still come from `ctx.cumulative` — they are REPL-loop
// counters the usage aggregator doesn't track. A leading `~` marks the
// cost as a lower bound when a turn reported no usage (usage_complete=0).
//
// Output shape:
//   cumulative: $X · N steps · M turns

import { computeUsageStats } from '../../../storage/index.ts';
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
    const s = computeUsageStats(ctx.db, ctx.replSessionIds());
    const lb = s.usageComplete ? '' : '~';
    const notes: string[] = [
      `cumulative: ${lb}${formatCost(s.costUsd)} · ${c.steps} steps · ${c.turns} turns`,
    ];
    return { kind: 'ok', notes };
  },
};
