import type { ProviderCapabilities } from '../types.ts';

// Shared baseline for current OpenAI chat models.
const OPENAI_BASE = {
  tools: 'native',
  // OpenAI has automatic prefix-cache (probabilistic, not user-controllable).
  // We declare `client_only` to be honest: there is no server-side cache the
  // adapter can target the way Anthropic's breakpoints do.
  cache: 'client_only',
  vision: true,
  streaming: true,
  // OpenAI offers tools, json_mode, and json_schema. Tools is the strongest
  // native option for our use cases; declared as such.
  constrained: 'tools',
  prompt_template_dialect: 'openai_chat',
  recommended_max_tools_per_step: 12,
} as const satisfies Partial<ProviderCapabilities>;

// Costs follow PROVIDERS.md §5 verbatim where it lists OpenAI rows; pricing
// should ultimately live in dynamic config.
export const OPENAI_CAPS: Record<string, ProviderCapabilities> = {
  // Current-generation reasoning models. Pricing is per-MILLION tokens
  // (the `cost_per_1k_*` names are legacy — see Anthropic caps note). OpenAI
  // has no cache-WRITE premium (automatic prefix caching is free to write),
  // so only `cost_per_1k_cached_input` (the discounted read) is set; the
  // write rate is intentionally absent. These accept `reasoning_effort`, so
  // `supports_reasoning_effort` is true (the adapter gates the param on it),
  // and `supports_sampling: false` because reasoning models reject
  // temperature/top_p. Model ids, the 1,050,000 context window, and the 128K
  // output cap are verified against developers.openai.com/api/docs/models
  // (gpt-5.5 / gpt-5.4; gpt-5.4-mini inherits the family context window).
  // CAVEAT (live-verified 2026-06-08): on Chat Completions these reasoning
  // models 400 on the tools+reasoning_effort COMBINATION ("use /v1/responses
  // instead") — Forja's agentic loop always sends both, so gpt-5.x needs the
  // Responses API path (task #19). gpt-4o (non-reasoning) is unaffected.
  'gpt-5.5': {
    ...OPENAI_BASE,
    context_window: 1_050_000,
    output_max_tokens: 128_000,
    cost_per_1k_input: 5.0,
    cost_per_1k_output: 30.0,
    cost_per_1k_cached_input: 0.5,
    supports_reasoning_effort: true,
    // Reasoning models reject temperature/top_p (HTTP 400) — adapter strips.
    supports_sampling: false,
    notes: ['frontier reasoning model for coding and professional work'],
  },
  'gpt-5.4': {
    ...OPENAI_BASE,
    context_window: 1_050_000,
    output_max_tokens: 128_000,
    cost_per_1k_input: 2.5,
    cost_per_1k_output: 15.0,
    cost_per_1k_cached_input: 0.25,
    supports_reasoning_effort: true,
    supports_sampling: false,
    notes: ['cost-efficient reasoning model for coding and professional work'],
  },
  'gpt-5.4-mini': {
    ...OPENAI_BASE,
    context_window: 1_050_000,
    output_max_tokens: 128_000,
    cost_per_1k_input: 0.75,
    cost_per_1k_output: 4.5,
    cost_per_1k_cached_input: 0.075,
    supports_reasoning_effort: true,
    supports_sampling: false,
    notes: ['most capable mini; coding, computer use, and subagents'],
  },
  // Codex family — agentic-coding-optimized, Responses-API only (no Chat
  // Completions surface). 400K context / 128K output, reasoning
  // low/medium/high/xhigh. Verified against developers.openai.com/api/docs/
  // models/gpt-5.3-codex (knowledge cutoff 2025-08-31).
  'gpt-5.3-codex': {
    ...OPENAI_BASE,
    context_window: 400_000,
    output_max_tokens: 128_000,
    cost_per_1k_input: 1.75,
    cost_per_1k_output: 14,
    cost_per_1k_cached_input: 0.175,
    supports_reasoning_effort: true,
    supports_sampling: false,
    notes: ['agentic coding; Responses API only'],
  },
  'gpt-4o': {
    ...OPENAI_BASE,
    context_window: 128_000,
    output_max_tokens: 16_384,
    cost_per_1k_input: 2.5,
    cost_per_1k_output: 10.0,
    notes: ['multimodal flagship; no controllable cache'],
  },
  'gpt-4o-mini': {
    ...OPENAI_BASE,
    context_window: 128_000,
    output_max_tokens: 16_384,
    cost_per_1k_input: 0.15,
    cost_per_1k_output: 0.6,
    notes: ['cheap; default for compaction and one-shots'],
  },
};

export const OPENAI_MODEL_NAMES = Object.keys(OPENAI_CAPS);
