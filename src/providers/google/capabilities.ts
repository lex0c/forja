import type { ProviderCapabilities } from '../types.ts';

// Shared baseline for current Gemini 2.5 models.
const GOOGLE_BASE = {
  tools: 'native',
  // Gemini context caching is opt-in and durable (≥ 5min, configurable TTL).
  cache: 'server_persistent',
  vision: true,
  streaming: true,
  constrained: 'tools',
  recommended_max_tools_per_step: 12,
  // All current Gemini 2.5 models accept the numeric thinking-budget
  // surface that the agnostic `effort` maps onto (`thinkingConfig.
  // thinkingBudget`). A future non-thinking Gemini would override
  // this to false per-model.
  supports_reasoning_effort: true,
} as const satisfies Partial<ProviderCapabilities>;

// Costs are illustrative; pricing should live in dynamic config (see
// PROVIDERS.md §5). Numbers below match the unit convention used elsewhere
// in the registry — they are not committed real Gemini prices.
export const GOOGLE_CAPS: Record<string, ProviderCapabilities> = {
  'gemini-2.5-pro': {
    ...GOOGLE_BASE,
    context_window: 2_000_000,
    output_max_tokens: 65_536,
    cost_per_1k_input: 1.25,
    cost_per_1k_output: 10.0,
    notes: ['frontier reasoning; very large context window'],
  },
  'gemini-2.5-flash': {
    ...GOOGLE_BASE,
    context_window: 1_000_000,
    output_max_tokens: 65_536,
    cost_per_1k_input: 0.3,
    cost_per_1k_output: 2.5,
    notes: ['default Google option; balanced quality/cost'],
  },
  'gemini-2.5-flash-lite': {
    ...GOOGLE_BASE,
    context_window: 1_000_000,
    output_max_tokens: 65_536,
    cost_per_1k_input: 0.075,
    cost_per_1k_output: 0.3,
    notes: ['cheapest Gemini; high-throughput one-shots'],
  },
};

export const GOOGLE_MODEL_NAMES = Object.keys(GOOGLE_CAPS);
