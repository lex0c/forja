// /cost — show cumulative cost, steps, and turns for this REPL run.
//
// Reads from ctx.cumulative which the REPL updates on every
// session_finished (totals) and critique_finished (critique
// subset). Cost format mirrors the footer (shared via `format.ts`).
//
// Output shape:
//   cumulative: $X · N steps · M turns
//   └─ critique: $Y · K runs    # only when self-critique ran at least once
//
// The critique line is gated on `critiqueRuns > 0`, NOT on
// `critiqueCostUsd > 0`. A zero cost with non-zero runs is a
// real shape — provider didn't emit usage telemetry for the
// critic call, or every critique resolved as `strategy=skipped`
// — and silently dropping the line in those cases would tell
// the operator "critique never ran" when it actually fired
// repeatedly. The runs count makes the cost honest: $0 next to
// `3 runs` is unambiguous (critique fired 3 times with no
// measurable spend); the same `$0` alone would be
// indistinguishable from `mode='off'`. ORCHESTRATION.md §6.3
// calls for this breakdown explicitly so operators can tune
// mode/threshold based on both the spend split AND the firing
// frequency.

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
    if (c.critiqueRuns > 0) {
      const runLabel = c.critiqueRuns === 1 ? 'run' : 'runs';
      notes.push(`└─ critique: ${formatCost(c.critiqueCostUsd)} · ${c.critiqueRuns} ${runLabel}`);
    }
    return { kind: 'ok', notes };
  },
};
