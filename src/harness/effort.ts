// Operational effort profile — the "harness effort" axis
// (TOKEN_TUNING.md §4, ORCHESTRATION.md §11). A single abstract
// level — `ForjaEffort` — drives TWO things at once:
//
//   1. `providerEffort` → the model's internal reasoning depth,
//      translated per-adapter (`src/providers/effort.ts`).
//   2. operational budget caps → how much WORK the harness is
//      willing to do (steps, parallel subagents, tolerated tool
//      errors), projected onto the existing `RunBudget`.
//
// This mirrors the operator design tenet: provider effort controls
// the model's internal depth; harness effort controls the amount of
// operational work — Forja sets BOTH from one knob.
//
// Profiles deliberately project onto fields `RunBudget` ALREADY
// owns — no parallel budget, one source of truth. Verification
// (running tests, self-review) is intentionally NOT a profile
// field: in Forja that is a playbook/hook concern (a PostToolUse
// gate, or ORCHESTRATION §6 self-critique), not inline scheduler
// logic. A higher effort level points at a stronger verification
// POLICY; it never calls tests from inside the loop.

import type { ProviderEffort } from '../providers/types.ts';

// Same four levels as ProviderEffort. Kept as an alias (not a
// re-declared union) so the abstraction has exactly one definition.
export type ForjaEffort = ProviderEffort;

export const FORJA_EFFORT_LEVELS: readonly ForjaEffort[] = ['low', 'medium', 'high', 'max'];

export interface EffortProfile {
  // Reasoning-depth level handed to the provider adapter. Same
  // vocabulary as ForjaEffort today (1:1), kept as a distinct field
  // so the two axes can diverge later (e.g. a future `max` that
  // does deep operational work while capping provider spend).
  providerEffort: ProviderEffort;
  // Runaway-loop BACKSTOP (`RunBudget.maxSteps`). Forja's real
  // engagement gate is cost; maxSteps only bounds pathological
  // loops, so even `low` keeps genuine headroom rather than cutting
  // legitimate multi-step work short.
  maxSteps: number;
  // `RunBudget.maxConcurrentSubagents` (hard cap 8). `low` collapses
  // to 1 (serial-but-with-handles via task_async); higher levels
  // widen fan-out.
  maxConcurrentSubagents: number;
  // `RunBudget.maxToolErrors` — tool failures tolerated before the
  // run aborts. Lower effort gives up sooner.
  maxToolErrors: number;
}

// Starting-point values, tunable per eval (principle 4). They scale
// around DEFAULT_BUDGET (maxSteps 200, maxToolErrors 5,
// maxConcurrentSubagents 3): `high` ~= the default, `low` tightens,
// `max` expands.
export const EFFORT_PROFILES: Record<ForjaEffort, EffortProfile> = {
  low: { providerEffort: 'low', maxSteps: 60, maxConcurrentSubagents: 1, maxToolErrors: 3 },
  medium: { providerEffort: 'medium', maxSteps: 120, maxConcurrentSubagents: 2, maxToolErrors: 5 },
  high: { providerEffort: 'high', maxSteps: 200, maxConcurrentSubagents: 4, maxToolErrors: 8 },
  max: { providerEffort: 'max', maxSteps: 400, maxConcurrentSubagents: 8, maxToolErrors: 12 },
};

// The `RunBudget`-shaped patch a profile projects. Typed as a plain
// object (not `Partial<RunBudget>`) on purpose: importing `RunBudget`
// from `harness/types.ts` would create a types <-> effort import
// cycle. The field names ARE asserted to be assignable to
// `Partial<RunBudget>` in tests, so a future rename of a RunBudget
// field is caught there.
export const effortBudgetPatch = (
  level: ForjaEffort,
): { maxSteps: number; maxConcurrentSubagents: number; maxToolErrors: number } => {
  const p = EFFORT_PROFILES[level];
  return {
    maxSteps: p.maxSteps,
    maxConcurrentSubagents: p.maxConcurrentSubagents,
    maxToolErrors: p.maxToolErrors,
  };
};

// Provider reasoning-effort level to forward for a given config
// level. Thin wrapper so call sites (the loop, tests) don't reach
// into EFFORT_PROFILES shape directly.
export const providerEffortFor = (level: ForjaEffort): ProviderEffort =>
  EFFORT_PROFILES[level].providerEffort;

// The provider reasoning-effort a request (or a subagent spawn)
// should carry. An explicit `providerEffort` wins — that is what an
// inherited subagent config carries (the parent forwards only the
// reasoning axis, NOT its operational caps) — otherwise it derives
// from the operator's `effort` level. Undefined ⇒ no provider-effort
// surface (the provider applies its own default). One helper for both
// the loop's request assembly and the subagent spawn sites so the
// inheritance rule lives in exactly one place.
export const resolveProviderEffort = (config: {
  effort?: ForjaEffort;
  providerEffort?: ProviderEffort;
}): ProviderEffort | undefined =>
  config.providerEffort ??
  (config.effort !== undefined ? providerEffortFor(config.effort) : undefined);
