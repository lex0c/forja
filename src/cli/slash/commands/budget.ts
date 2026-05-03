// /budget — show current budget caps (read-only in this slice).
//
// Mutation (`/budget steps 100`, `/budget cost 5.0`) is a separate
// slice. This command surfaces the four caps the harness enforces:
// maxSteps, maxWallClockMs, maxToolErrors, maxCostUsd.

import { DEFAULT_BUDGET } from '../../../harness/types.ts';
import { formatCost, formatMs } from '../format.ts';
import type { SlashCommand } from '../types.ts';

export const budgetCommand: SlashCommand = {
  name: 'budget',
  description: 'show current run budget caps (read-only)',
  exec: async (args, _ctx) => {
    if (args.length > 0) {
      return {
        kind: 'error',
        message: '/budget: changing the budget mid-session is not supported yet (read-only)',
      };
    }
    const b = _ctx.baseConfig.budget ?? {};
    const lines = [
      `max steps: ${b.maxSteps ?? DEFAULT_BUDGET.maxSteps}`,
      `max wall-clock: ${formatMs(b.maxWallClockMs ?? DEFAULT_BUDGET.maxWallClockMs)}`,
      `max tool errors: ${b.maxToolErrors ?? DEFAULT_BUDGET.maxToolErrors}`,
      `max cost: ${b.maxCostUsd !== undefined ? formatCost(b.maxCostUsd) : 'no cap'}`,
    ];
    return { kind: 'ok', notes: lines };
  },
};
