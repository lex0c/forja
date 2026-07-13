// Agnostic reasoning-effort surface (TOKEN_TUNING.md §4). The
// harness / playbook / slash layer speaks ONE vocabulary —
// `ProviderEffort` (low|medium|high|max, defined in ./types.ts) —
// and every adapter translates it locally in a few lines:
//
//   - a provider with a NATIVE named effort level maps 1:1
//     (Anthropic `output_config.effort`, OpenAI `reasoning.effort`,
//     a future Gemini 3+ `thinkingConfig.thinkingLevel`);
//   - a provider whose ONLY knob is a token count reads the
//     canonical ladder below (Gemini 2.5, local llama.cpp).
//
// Adding a provider is a small translation function, never a
// special case — that is the whole point of routing every adapter
// through this module.

import type { ProviderEffort } from './types.ts';

// Canonical thinking-token budget per effort level, for providers
// whose only reasoning knob is a numeric budget. Kept deliberately
// CONSERVATIVE so a single ladder is safe across every numeric
// provider we ship today without per-model branching: the smallest
// thinking ceiling among them is Gemini 2.5 Flash (24_576), so
// `max` pins exactly there and the lower rungs step down from it.
// (This is intentionally NOT the larger TOKEN_TUNING §4.1
// budget_tokens ladder — that one targeted Anthropic's old
// `budget_tokens` surface, which now uses the NATIVE effort level
// instead and never reads this table.) Adapters still clamp to the
// request's `max_tokens` before sending; the API rejects a budget
// >= max_tokens.
export const EFFORT_THINKING_BUDGET: Record<ProviderEffort, number> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 20_480,
  max: 24_576,
};

// OpenAI's `reasoning.effort` vocabulary is none|minimal|low|medium|
// high|xhigh. `xhigh` is OpenAI's TOP level, so both the Forja `xhigh`
// (1:1) and `max` (no OpenAI counterpart above xhigh) map onto it.
// low/medium/high are 1:1.
export const OPENAI_REASONING_EFFORT: Record<ProviderEffort, 'low' | 'medium' | 'high' | 'xhigh'> =
  {
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'xhigh',
  };

// xAI Grok's `reasoning_effort` (Chat Completions, a FLAT field like OpenAI's
// chat path) accepts low|medium|high only — there is no `none`/`xhigh`, and on
// grok-4.5 reasoning cannot be disabled at all. `high` is the model default and
// its top level, so both the Forja `xhigh` and `max` clamp down onto `high`;
// low/medium/high are 1:1. Centralized here so the whole effort-translation
// surface stays in one file.
export const XAI_REASONING_EFFORT: Record<ProviderEffort, 'low' | 'medium' | 'high'> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};

// Anthropic's native `output_config.effort` maps 1:1 with the agnostic ladder
// EXCEPT `xhigh`, which only Opus 4.7/4.8 expose; on every other model a request
// for `xhigh` 400s, so clamp it down to `high`. Centralized here (beside the
// OpenAI table) so the whole effort-translation surface lives in one file and
// the clamp is unit-testable as a pure mapping, not buried in request assembly.
export const anthropicEffort = (effort: ProviderEffort, supportsXhigh: boolean): ProviderEffort =>
  effort === 'xhigh' && !supportsXhigh ? 'high' : effort;

// Smallest thinking budget worth sending. Numeric-budget providers
// reject (or silently no-op) a budget below their model minimum —
// Gemini 2.5 Pro requires >= 128 — so when the per-call headroom
// would force a value below this floor we omit the thinking block
// entirely rather than send a sub-minimum that 400s or wastes a slot.
export const MIN_THINKING_BUDGET = 128;

// Resolve the numeric thinking budget for a provider whose surface
// is a token count, clamped BOTH ways: strictly below the request's
// output ceiling (the APIs 400 when budget >= max_tokens) and at or
// above MIN_THINKING_BUDGET. Returns undefined when the headroom
// can't satisfy the floor — the caller then omits the block. When
// the ceiling clears the floor, the result is guaranteed >= the
// floor (every ladder rung is >= 2048 > MIN_THINKING_BUDGET).
export const effortThinkingBudget = (
  effort: ProviderEffort,
  maxTokens: number,
): number | undefined => {
  const ceiling = maxTokens - 1;
  if (ceiling < MIN_THINKING_BUDGET) return undefined;
  return Math.min(EFFORT_THINKING_BUDGET[effort], ceiling);
};
