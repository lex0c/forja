import type { ProviderCapabilities } from '../types.ts';

// Shared baseline for current Gemini 2.5 / 3.x text models.
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

// Pricing per-MILLION tokens (the `cost_per_1k_*` names are legacy — see the
// Anthropic caps note). Text-generation models only; image / TTS / live-audio
// variants are out of scope for the chat adapter. Tiered models (Pro: one
// rate ≤200k tokens, a higher rate above) are encoded at the BASE (≤200k)
// tier — Forja's single-rate cost model doesn't express the breakpoint, so
// huge-prompt turns are slightly under-counted (noted, not modeled).
// `max_thinking_budget` ceilings mirror the 2.5 siblings (24576 flash / 32768
// pro); the agnostic effort ladder tops out at 24576 anyway, so these never
// drive a budget over a real cap.
export const GOOGLE_CAPS: Record<string, ProviderCapabilities> = {
  'gemini-3.5-flash': {
    ...GOOGLE_BASE,
    context_window: 1_000_000,
    output_max_tokens: 65_536,
    max_thinking_budget: 24_576,
    cost_per_1k_input: 1.5,
    cost_per_1k_output: 9.0,
    cost_per_1k_cached_input: 0.15,
    notes: ['frontier flash; fast with strong search/grounding'],
  },
  'gemini-3.1-pro-preview': {
    ...GOOGLE_BASE,
    context_window: 1_000_000,
    output_max_tokens: 65_536,
    max_thinking_budget: 32_768,
    // ≤200k tier; >200k is $4 in / $18 out / $0.40 cache (not modeled).
    cost_per_1k_input: 2.0,
    cost_per_1k_output: 12.0,
    cost_per_1k_cached_input: 0.2,
    notes: ['frontier multimodal/agentic; preview'],
  },
  'gemini-3.1-flash-lite': {
    ...GOOGLE_BASE,
    context_window: 1_000_000,
    output_max_tokens: 65_536,
    max_thinking_budget: 24_576,
    cost_per_1k_input: 0.25,
    cost_per_1k_output: 1.5,
    cost_per_1k_cached_input: 0.025,
    notes: ['cheapest 3.x; high-volume agentic / translation'],
  },
  'gemini-3-flash-preview': {
    ...GOOGLE_BASE,
    context_window: 1_000_000,
    output_max_tokens: 65_536,
    max_thinking_budget: 24_576,
    cost_per_1k_input: 0.5,
    cost_per_1k_output: 3.0,
    cost_per_1k_cached_input: 0.05,
    notes: ['fast 3.x flash; preview'],
  },
  'gemini-2.5-pro': {
    ...GOOGLE_BASE,
    // 1M (1,048,576), NOT 2M — that was Gemini 1.5 Pro. Verified on
    // ai.google.dev. An inflated window makes compaction trigger past the
    // real limit and the request 400s before the harness can fold.
    context_window: 1_000_000,
    output_max_tokens: 65_536,
    // Gemini 2.5 Pro caps thinkingBudget at 32768; >cap → HTTP 400.
    max_thinking_budget: 32_768,
    // ≤200k tier; >200k is $2.50 in / $15 out / $0.25 cache (not modeled).
    cost_per_1k_input: 1.25,
    cost_per_1k_output: 10.0,
    cost_per_1k_cached_input: 0.125,
    notes: ['frontier reasoning; 1M context'],
  },
  'gemini-2.5-flash': {
    ...GOOGLE_BASE,
    context_window: 1_000_000,
    output_max_tokens: 65_536,
    // Gemini 2.5 Flash caps thinkingBudget at 24576; >cap → HTTP 400.
    max_thinking_budget: 24_576,
    cost_per_1k_input: 0.3,
    cost_per_1k_output: 2.5,
    cost_per_1k_cached_input: 0.03,
    notes: ['balanced quality/cost'],
  },
  'gemini-2.5-flash-lite': {
    ...GOOGLE_BASE,
    context_window: 1_000_000,
    output_max_tokens: 65_536,
    // Gemini 2.5 Flash-Lite caps thinkingBudget at 24576; >cap → 400.
    max_thinking_budget: 24_576,
    cost_per_1k_input: 0.1,
    cost_per_1k_output: 0.4,
    cost_per_1k_cached_input: 0.01,
    notes: ['cheapest 2.5; high-throughput one-shots'],
  },
};

export const GOOGLE_MODEL_NAMES = Object.keys(GOOGLE_CAPS);
