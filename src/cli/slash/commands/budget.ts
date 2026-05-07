// /budget — read or set run budget caps.
//
// Read-only form (`/budget`) shows every cap. Mutation forms:
//   /budget steps <N>           — set maxSteps (positive integer)
//   /budget cost <USD>          — set maxCostUsd (positive number,
//                                  or `none`/`off` to clear the cap)
//   /budget parallel-tools <N>  — set maxConcurrentToolCalls (1..16)
//   /budget subagents <N>       — set maxConcurrentSubagents (1..8)
//
// Other caps (maxWallClockMs, maxToolErrors) aren't user-tunable
// from the slash surface today — they're tied to the harness's
// internal safety budget rather than operator UX. If a future need
// surfaces, extend the dispatch table below.
//
// Mutation lands in baseConfig.budget; takes effect on the NEXT
// turn (current turn already snapshot its budget at startTurn).
// Note in the confirmation makes timing explicit, matching /plan.

import {
  DEFAULT_BUDGET,
  MAX_CONCURRENT_SUBAGENTS_CAP,
  MAX_CONCURRENT_TOOL_CALLS_CAP,
  type RunBudget,
} from '../../../harness/types.ts';
import { formatCost, formatMs } from '../format.ts';
import type { SlashCommand, SlashContext, SlashResult } from '../types.ts';

const usage = '/budget [steps <N> | cost <USD|none> | parallel-tools <N> | subagents <N>]';

const showAll = (ctx: SlashContext): SlashResult => {
  const b = ctx.baseConfig.budget ?? {};
  // Cost has three states (see RunBudget docstring for the full
  // contract): absent → fall back to DEFAULT_BUDGET; explicit
  // undefined → operator opted out, render "no cap"; number →
  // that value. `'maxCostUsd' in b` distinguishes "absent" from
  // "present-as-undefined" since both read as undefined via `?.`.
  const costLine = (() => {
    if (!('maxCostUsd' in b)) {
      const d = DEFAULT_BUDGET.maxCostUsd;
      return `max cost: ${d !== undefined ? formatCost(d) : 'no cap'}`;
    }
    return `max cost: ${b.maxCostUsd !== undefined ? formatCost(b.maxCostUsd) : 'no cap'}`;
  })();
  return {
    kind: 'ok',
    notes: [
      `max steps: ${b.maxSteps ?? DEFAULT_BUDGET.maxSteps}`,
      `max wall-clock: ${formatMs(b.maxWallClockMs ?? DEFAULT_BUDGET.maxWallClockMs)}`,
      `max tool errors: ${b.maxToolErrors ?? DEFAULT_BUDGET.maxToolErrors}`,
      costLine,
      `max parallel tools: ${b.maxConcurrentToolCalls ?? DEFAULT_BUDGET.maxConcurrentToolCalls} (cap ${MAX_CONCURRENT_TOOL_CALLS_CAP})`,
      `max concurrent subagents: ${b.maxConcurrentSubagents ?? DEFAULT_BUDGET.maxConcurrentSubagents} (cap ${MAX_CONCURRENT_SUBAGENTS_CAP})`,
    ],
  };
};

// Parse positive integer with an inclusive upper bound. Used by the
// concurrency caps where the harness clamps anything above the
// hard cap anyway — surfacing the rejection here lets the operator
// understand WHY their value didn't take effect.
const parseBoundedPositiveInt = (raw: string, max: number): number | null => {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 && n <= max ? n : null;
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
        // Operator opt-out from the cost cap. Now that
        // DEFAULT_BUDGET ships a 5 USD default (AGENTIC_CLI.md §5),
        // simply deleting the key would let the merge fall back to
        // the default — silently re-applying a cap the operator
        // just asked to clear. Writing an explicit `undefined`
        // propagates through the spread merge (`{ ...DEFAULT_BUDGET,
        // ...{ maxCostUsd: undefined } }` resolves to `undefined`)
        // and the loop's `=== undefined` gate skips the cost
        // check. The `'maxCostUsd' in current` check keeps the
        // idempotency note honest: re-running `cost off` after the
        // first one is a no-op.
        const current = ctx.baseConfig.budget ?? {};
        if ('maxCostUsd' in current && current.maxCostUsd === undefined) {
          return { kind: 'ok', notes: ['max cost already uncapped (no change)'] };
        }
        ctx.baseConfig.budget = { ...current, maxCostUsd: undefined };
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

    if (sub === 'parallel-tools') {
      if (args.length !== 2) {
        return {
          kind: 'error',
          message: `/budget parallel-tools: expected one value. usage: ${usage}`,
        };
      }
      const raw = args[1] ?? '';
      const n = parseBoundedPositiveInt(raw, MAX_CONCURRENT_TOOL_CALLS_CAP);
      if (n === null) {
        return {
          kind: 'error',
          message: `/budget parallel-tools: '${raw}' is not an integer in [1, ${MAX_CONCURRENT_TOOL_CALLS_CAP}]`,
        };
      }
      const current =
        ctx.baseConfig.budget?.maxConcurrentToolCalls ?? DEFAULT_BUDGET.maxConcurrentToolCalls;
      if (current === n) {
        return { kind: 'ok', notes: [`max parallel tools already ${n} (no change)`] };
      }
      writeBudget(ctx, { maxConcurrentToolCalls: n });
      return {
        kind: 'ok',
        notes: withRunningCue(ctx, [`max parallel tools: ${n} — takes effect on the next turn`]),
      };
    }

    if (sub === 'subagents') {
      if (args.length !== 2) {
        return {
          kind: 'error',
          message: `/budget subagents: expected one value. usage: ${usage}`,
        };
      }
      const raw = args[1] ?? '';
      const n = parseBoundedPositiveInt(raw, MAX_CONCURRENT_SUBAGENTS_CAP);
      if (n === null) {
        return {
          kind: 'error',
          message: `/budget subagents: '${raw}' is not an integer in [1, ${MAX_CONCURRENT_SUBAGENTS_CAP}]`,
        };
      }
      const current =
        ctx.baseConfig.budget?.maxConcurrentSubagents ?? DEFAULT_BUDGET.maxConcurrentSubagents;
      if (current === n) {
        return { kind: 'ok', notes: [`max concurrent subagents already ${n} (no change)`] };
      }
      writeBudget(ctx, { maxConcurrentSubagents: n });
      return {
        kind: 'ok',
        notes: withRunningCue(ctx, [
          `max concurrent subagents: ${n} — takes effect on the next turn`,
        ]),
      };
    }

    return { kind: 'error', message: `/budget: unknown subcommand '${sub}'. usage: ${usage}` };
  },
};
