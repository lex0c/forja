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
