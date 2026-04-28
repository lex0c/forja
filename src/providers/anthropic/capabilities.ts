import type { ProviderCapabilities } from '../types.ts';

// Shared baseline for current Anthropic Claude 4.x models.
const ANTHROPIC_BASE = {
  tools: 'native',
  cache: 'server_5min',
  vision: true,
  streaming: true,
  constrained: 'tools',
  prompt_template_dialect: 'claude',
  recommended_max_tools_per_step: 12,
  context_window: 200_000,
  output_max_tokens: 64_000,
} as const satisfies Partial<ProviderCapabilities>;

// Costs come from PROVIDERS.md §5 verbatim. The spec acknowledges these are
// illustrative; real pricing should live in a dynamic config (deferred).
export const ANTHROPIC_CAPS: Record<string, ProviderCapabilities> = {
  'claude-opus-4-7': {
    ...ANTHROPIC_BASE,
    cost_per_1k_input: 15.0,
    cost_per_1k_output: 75.0,
    cost_per_1k_cached_input: 1.5,
    notes: ['frontier model; best for security-audit and deliberate reasoning workflows'],
  },
  'claude-sonnet-4-6': {
    ...ANTHROPIC_BASE,
    cost_per_1k_input: 3.0,
    cost_per_1k_output: 15.0,
    cost_per_1k_cached_input: 0.3,
    notes: ['default for autonomous profile; balanced quality/cost'],
  },
  'claude-haiku-4-5': {
    ...ANTHROPIC_BASE,
    cost_per_1k_input: 0.25,
    cost_per_1k_output: 1.25,
    cost_per_1k_cached_input: 0.025,
    notes: ['cheap and fast; default for compaction and one-shot prompts'],
  },
};

export const ANTHROPIC_MODEL_NAMES = Object.keys(ANTHROPIC_CAPS);
