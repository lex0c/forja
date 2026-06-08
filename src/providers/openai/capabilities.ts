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
  // `supports_reasoning_effort` is true (the adapter gates the param on it).
  // Context/output ceilings are conservative placeholders pending PROVIDERS.md
  // confirmation; the pricing is authoritative.
  'gpt-5.5': {
    ...OPENAI_BASE,
    context_window: 400_000,
    output_max_tokens: 128_000,
    cost_per_1k_input: 5.0,
    cost_per_1k_output: 30.0,
    cost_per_1k_cached_input: 0.5,
    supports_reasoning_effort: true,
    notes: ['frontier reasoning model for coding and professional work'],
  },
  'gpt-5.4': {
    ...OPENAI_BASE,
    context_window: 400_000,
    output_max_tokens: 128_000,
    cost_per_1k_input: 2.5,
    cost_per_1k_output: 15.0,
    cost_per_1k_cached_input: 0.25,
    supports_reasoning_effort: true,
    notes: ['cost-efficient reasoning model for coding and professional work'],
  },
  'gpt-5.4-mini': {
    ...OPENAI_BASE,
    context_window: 400_000,
    output_max_tokens: 128_000,
    cost_per_1k_input: 0.75,
    cost_per_1k_output: 4.5,
    cost_per_1k_cached_input: 0.075,
    supports_reasoning_effort: true,
    notes: ['most capable mini; coding, computer use, and subagents'],
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
