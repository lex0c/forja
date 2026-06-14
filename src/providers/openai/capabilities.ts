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

// gpt-5.x reasoning models share three traits: they accept `reasoning_effort`,
// REJECT temperature/top_p (HTTP 400 — the adapter strips them), and support
// OpenAI's extended (24h) prompt-cache retention. Hoisted so the set stays in
// one place; the gpt-4o (non-reasoning) entries keep OPENAI_BASE.
const OPENAI_REASONING_BASE = {
  ...OPENAI_BASE,
  supports_reasoning_effort: true,
  supports_sampling: false,
  extended_prompt_cache: true,
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
  // temperature/top_p. Model ids, context windows, and the 128K output cap are
  // verified against developers.openai.com/api/docs/models: gpt-5.5 and gpt-5.4
  // are 1,050,000, but gpt-5.4-mini is 400,000 (it does NOT inherit the family
  // window — an inflated window makes compaction trigger past the real limit
  // and the request 400s at the API boundary before the harness can fold).
  // CAVEAT (live-verified 2026-06-08): on Chat Completions these reasoning
  // models 400 on the tools+reasoning_effort COMBINATION ("use /v1/responses
  // instead") — Forja's agentic loop always sends both, so gpt-5.x needs the
  // Responses API path (task #19). gpt-4o (non-reasoning) is unaffected.
  'gpt-5.5': {
    ...OPENAI_REASONING_BASE,
    context_window: 1_050_000,
    output_max_tokens: 128_000,
    cost_per_1k_input: 5.0,
    cost_per_1k_output: 30.0,
    cost_per_1k_cached_input: 0.5,
    notes: ['frontier reasoning model for coding and professional work'],
  },
  'gpt-5.4': {
    ...OPENAI_REASONING_BASE,
    context_window: 1_050_000,
    output_max_tokens: 128_000,
    cost_per_1k_input: 2.5,
    cost_per_1k_output: 15.0,
    cost_per_1k_cached_input: 0.25,
    notes: ['cost-efficient reasoning model for coding and professional work'],
  },
  'gpt-5.4-mini': {
    ...OPENAI_REASONING_BASE,
    // 400K, NOT the family's 1.05M — verified on the OpenAI model page.
    context_window: 400_000,
    output_max_tokens: 128_000,
    cost_per_1k_input: 0.75,
    cost_per_1k_output: 4.5,
    cost_per_1k_cached_input: 0.075,
    notes: ['most capable mini; coding, computer use, and subagents'],
  },
  // Codex family — agentic-coding-optimized, Responses-API only (no Chat
  // Completions surface). 400K context / 128K output, reasoning
  // low/medium/high/xhigh. Verified against developers.openai.com/api/docs/
  // models/gpt-5.3-codex (knowledge cutoff 2025-08-31).
  'gpt-5.3-codex': {
    ...OPENAI_REASONING_BASE,
    context_window: 400_000,
    output_max_tokens: 128_000,
    cost_per_1k_input: 1.75,
    cost_per_1k_output: 14,
    cost_per_1k_cached_input: 0.175,
    notes: ['agentic coding; Responses API only'],
  },
  // Fastest/cheapest GPT-5-base reasoning model. 400K context / 128K output,
  // reasoning token support. Verified against developers.openai.com/api/docs/
  // models/gpt-5-nano (knowledge cutoff 2024-05-31). NOTE: extended_prompt_cache
  // is overridden OFF — OpenAI's extended-retention list names `gpt-5` and
  // `gpt-5-codex` but NOT the `-nano`/`-mini` sub-variants, so 24h support is
  // unconfirmed for nano; in-memory caching still applies. Flip to true if/when
  // confirmed.
  'gpt-5-nano': {
    ...OPENAI_REASONING_BASE,
    extended_prompt_cache: false,
    context_window: 400_000,
    output_max_tokens: 128_000,
    cost_per_1k_input: 0.05,
    cost_per_1k_output: 0.4,
    cost_per_1k_cached_input: 0.005,
    notes: ['fastest/cheapest GPT-5; summarization and classification'],
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
