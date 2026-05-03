// /budget — read or set run budget caps.
//
// Read-only form (`/budget`) shows all four caps. Mutation forms:
//   /budget steps <N>      — set maxSteps (positive integer)
//   /budget cost <USD>     — set maxCostUsd (positive number, or
//                            `none`/`off` to clear the cap)
//
// Other caps (maxWallClockMs, maxToolErrors) aren't user-tunable
// from the slash surface today — they're tied to the harness's
// internal safety budget rather than operator UX. If a future need
// surfaces, extend the dispatch table below.
//
// Mutation lands in baseConfig.budget; takes effect on the NEXT
// turn (current turn already snapshot its budget at startTurn).
// Note in the confirmation makes timing explicit, matching /plan.

import { DEFAULT_BUDGET, type RunBudget } from '../../../harness/types.ts';
import { formatCost, formatMs } from '../format.ts';
import type { SlashCommand, SlashContext, SlashResult } from '../types.ts';

const usage = '/budget [steps <N> | cost <USD|none>]';

const showAll = (ctx: SlashContext): SlashResult => {
  const b = ctx.baseConfig.budget ?? {};
  return {
    kind: 'ok',
    notes: [
      `max steps: ${b.maxSteps ?? DEFAULT_BUDGET.maxSteps}`,
      `max wall-clock: ${formatMs(b.maxWallClockMs ?? DEFAULT_BUDGET.maxWallClockMs)}`,
      `max tool errors: ${b.maxToolErrors ?? DEFAULT_BUDGET.maxToolErrors}`,
      `max cost: ${b.maxCostUsd !== undefined ? formatCost(b.maxCostUsd) : 'no cap'}`,
    ],
  };
};

// Parse a positive integer for `steps`. Rejects negatives, zero,
// non-finite, and non-integer values explicitly so a typo doesn't
// silently NaN the budget. (Returning NaN here would propagate into
// `steps >= maxSteps` as `false`, effectively disabling the cap.)
const parsePositiveInt = (raw: string): number | null => {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Parse a positive USD value for `cost`. Accepts decimal forms
// (`5`, `5.0`, `0.5`). Rejects negatives, NaN, and infinite. Zero
// is allowed and means "no spend permitted" — the harness enforces
// it the same as any other positive cap.
const parsePositiveDecimal = (raw: string): number | null => {
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

// Mutate baseConfig.budget in place, allocating the budget object
// if absent. Spread/merge ensures unrelated cap fields stay intact.
const writeBudget = (ctx: SlashContext, patch: Partial<RunBudget>): void => {
  const current = ctx.baseConfig.budget ?? {};
  ctx.baseConfig.budget = { ...current, ...patch };
};

// Append the "current turn already snapshot" cue when a turn is
// running. Mirrors /plan's behavior so an operator mutating mid-
// turn doesn't assume the in-flight prompt sees the new value.
const withRunningCue = (ctx: SlashContext, notes: string[]): string[] => {
  if (!ctx.isRunning()) return notes;
  return [
    ...notes,
    '(current turn already snapshot its config; new value applies starting next prompt)',
  ];
};

export const budgetCommand: SlashCommand = {
  name: 'budget',
  description: 'show or set budget caps',
  exec: async (args, ctx) => {
    if (args.length === 0) return showAll(ctx);
    const sub = (args[0] ?? '').toLowerCase();

    if (sub === 'steps') {
      if (args.length !== 2) {
        return { kind: 'error', message: `/budget steps: expected one value. usage: ${usage}` };
      }
      const raw = args[1] ?? '';
      const n = parsePositiveInt(raw);
      if (n === null) {
        return {
          kind: 'error',
          message: `/budget steps: '${raw}' is not a positive integer`,
        };
      }
      // Idempotency: matching /plan's behavior, a no-op mutation
      // returns "already" without the next-turn cue. Avoids
      // misleading the operator into thinking they changed something.
      const current = ctx.baseConfig.budget?.maxSteps;
      if (current === n) {
        return {
          kind: 'ok',
          notes: [`max steps already ${n} (no change)`],
        };
      }
      writeBudget(ctx, { maxSteps: n });
      return {
        kind: 'ok',
        notes: withRunningCue(ctx, [`max steps: ${n} — takes effect on the next turn`]),
      };
    }

    if (sub === 'cost') {
      if (args.length !== 2) {
        return { kind: 'error', message: `/budget cost: expected one value. usage: ${usage}` };
      }
      const raw = args[1] ?? '';
      const lowered = raw.toLowerCase();
      if (lowered === 'none' || lowered === 'off') {
        // Clear the cap entirely. The harness treats undefined as
        // "no spend cap" (per RunBudget docstring); absent vs
        // undefined are equivalent at runtime today (loop checks
        // `=== undefined`). Deleting the key keeps the config
        // shape identical to the boot-time absence — cosmetic
        // today, future-proof for diff tools / serializers.
        const current = ctx.baseConfig.budget ?? {};
        if (current.maxCostUsd === undefined) {
          return { kind: 'ok', notes: ['max cost already uncapped (no change)'] };
        }
        const { maxCostUsd: _drop, ...rest } = current;
        ctx.baseConfig.budget = rest;
        return {
          kind: 'ok',
          notes: withRunningCue(ctx, ['max cost: no cap — takes effect on the next turn']),
        };
      }
      const usd = parsePositiveDecimal(raw);
      if (usd === null) {
        return {
          kind: 'error',
          message: `/budget cost: '${raw}' is not a positive number (or 'none')`,
        };
      }
      const currentCost = ctx.baseConfig.budget?.maxCostUsd;
      if (currentCost === usd) {
        return {
          kind: 'ok',
          notes: [`max cost already ${formatCost(usd)} (no change)`],
        };
      }
      writeBudget(ctx, { maxCostUsd: usd });
      return {
        kind: 'ok',
        notes: withRunningCue(ctx, [
          `max cost: ${formatCost(usd)} — takes effect on the next turn`,
        ]),
      };
    }

    return { kind: 'error', message: `/budget: unknown subcommand '${sub}'. usage: ${usage}` };
  },
};
