// /budget — read or set run budget caps.
//
// Read-only form (`/budget`) shows every cap. Mutation forms:
//   /budget steps <N>           — set maxSteps (positive integer)
//   /budget cost <USD>          — set maxCostUsd (positive number,
//                                  or `none`/`off` to clear the cap)
//   /budget parallel-tools <N>  — set maxConcurrentToolCalls (1..16)
//   /budget subagents <N>       — set maxConcurrentSubagents (1..8)
//   /budget relevance <on|off>  — toggle the compaction relevance pre-pass
//                                  (default on; off keeps every tool_result
//                                  verbatim until the billed LLM fold). The
//                                  in-session twin of `[budget]
//                                  compaction_relevance` in config.toml.
//
// Other caps (maxWallClockMs, maxToolErrors) aren't user-tunable
// from the slash surface today — they're tied to the harness's
// internal safety budget rather than operator UX. If a future need
// surfaces, extend the dispatch table below.
//
// Mutation lands in baseConfig.budget; takes effect on the NEXT
// turn (current turn already snapshot its budget at startTurn).
// Note in the confirmation makes timing explicit, matching the
// next-turn mutation convention (/model).

import {
  effectiveBudget,
  MAX_CONCURRENT_SUBAGENTS_CAP,
  MAX_CONCURRENT_TOOL_CALLS_CAP,
  type RunBudget,
} from '../../../harness/types.ts';
import { formatCost, formatMs, withRunningCue } from '../format.ts';
import type { SlashCommand, SlashContext, SlashResult } from '../types.ts';

// Single source for the subcommand set. `usage` (error messages) and the
// command's inline `argHint` both derive from this, so a new subcommand
// can't leave the two naming different sets.
const BUDGET_SUBCOMMANDS = ['steps', 'cost', 'parallel-tools', 'subagents', 'relevance'] as const;
const BUDGET_USAGE_FORMS: Record<(typeof BUDGET_SUBCOMMANDS)[number], string> = {
  steps: 'steps <N>',
  cost: 'cost <USD|none>',
  'parallel-tools': 'parallel-tools <N>',
  subagents: 'subagents <N>',
  relevance: 'relevance <on|off>',
};
const usage = `/budget [${BUDGET_SUBCOMMANDS.map((s) => BUDGET_USAGE_FORMS[s]).join(' | ')}]`;

const showAll = (ctx: SlashContext): SlashResult => {
  // Resolve through the SAME layered helper the loop uses so `/budget`
  // shows the EFFECTIVE caps — including any `/effort` preset — not
  // just the raw explicit overrides (defaults < effort preset <
  // explicit /budget). `effectiveBudget` also carries the cost
  // opt-out: an explicit `maxCostUsd: undefined` (from `/budget cost
  // off`) propagates through the spread and renders "no cap", while
  // an absent key falls back to the DEFAULT_BUDGET cap.
  const r = effectiveBudget(ctx.baseConfig.budget, ctx.baseConfig.effort);
  return {
    kind: 'ok',
    notes: [
      `max steps: ${r.maxSteps}`,
      `max wall-clock: ${formatMs(r.maxWallClockMs)}`,
      `max tool errors: ${r.maxToolErrors}`,
      `max cost: ${r.maxCostUsd !== undefined ? formatCost(r.maxCostUsd) : 'no cap'}`,
      `max parallel tools: ${r.maxConcurrentToolCalls} (cap ${MAX_CONCURRENT_TOOL_CALLS_CAP})`,
      `max concurrent subagents: ${r.maxConcurrentSubagents} (cap ${MAX_CONCURRENT_SUBAGENTS_CAP})`,
      `compaction relevance pre-pass: ${r.compactionRelevance ? 'on' : 'off'}`,
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

export const budgetCommand: SlashCommand = {
  name: 'budget',
  description: 'show or set budget caps',
  argHint: BUDGET_SUBCOMMANDS.join('|'),
  exec: async (args, ctx) => {
    if (args.length === 0) return showAll(ctx);
    const sub = (args[0] ?? '').toLowerCase();
    // `/budget` is the operator's EXPLICIT-override surface: a cap
    // mutation always RECORDS the value (pinning it — explicit beats
    // the `/effort` preset in `effectiveBudget`, so a later `/effort`
    // can't silently move it), and the "already (no change)" note fires
    // only when the RAW explicit override is already that value. So the
    // idempotency check compares the raw field — NOT `?? DEFAULT_BUDGET`
    // and NOT the effort-adjusted effective. Comparing against the
    // raw-absent DEFAULT fallback was the bug: under `/effort low`
    // (subagents preset 1) `/budget subagents 3` matched DEFAULT 3,
    // reported "already 3", and never wrote — leaving the cap at 1.

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
      // Idempotency: re-stating the existing explicit override is a
      // no-op ("already"); any other value writes (pins). Compare the
      // raw override field (see the dispatch-top note).
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
      const current = ctx.baseConfig.budget?.maxConcurrentToolCalls;
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
      const current = ctx.baseConfig.budget?.maxConcurrentSubagents;
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

    if (sub === 'relevance') {
      if (args.length !== 2) {
        return { kind: 'error', message: `/budget relevance: expected on|off. usage: ${usage}` };
      }
      const raw = (args[1] ?? '').toLowerCase();
      const value =
        raw === 'on' || raw === 'true' ? true : raw === 'off' || raw === 'false' ? false : null;
      if (value === null) {
        return { kind: 'error', message: `/budget relevance: '${args[1]}' is not on|off` };
      }
      // Compare the raw override (see the dispatch-top note): default-ON is not
      // an explicit override, so `relevance on` still pins it.
      const current = ctx.baseConfig.budget?.compactionRelevance;
      if (current === value) {
        return {
          kind: 'ok',
          notes: [`compaction relevance pre-pass already ${value ? 'on' : 'off'} (no change)`],
        };
      }
      writeBudget(ctx, { compactionRelevance: value });
      return {
        kind: 'ok',
        notes: withRunningCue(ctx, [
          `compaction relevance pre-pass: ${value ? 'on' : 'off'} — takes effect on the next turn`,
        ]),
      };
    }

    return { kind: 'error', message: `/budget: unknown subcommand '${sub}'. usage: ${usage}` };
  },
};
