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

// Pricing values are dollars-per-million tokens, sourced from Anthropic's
// public pricing page (verified 2026-04-28). Field names still say
// `cost_per_1k_*` for legacy reasons — see docs/TODO.md for the rename.
//
// Cache rates follow Anthropic's 5-minute ephemeral cache tiering:
//   - cache write: 1.25× input
//   - cache read:  0.10× input
// Without declaring `cost_per_1k_cache_write`, `computeCost` falls back to
// the raw input rate and undercounts cache-creation turns by 25%; without
// `cost_per_1k_cached_input`, it overcounts cache reads 10×.
export const ANTHROPIC_CAPS: Record<string, ProviderCapabilities> = {
  'claude-opus-4-7': {
    ...ANTHROPIC_BASE,
    cost_per_1k_input: 5.0,
    cost_per_1k_output: 25.0,
    cost_per_1k_cached_input: 0.5,
    cost_per_1k_cache_write: 6.25,
    // Opus 4.7 deprecated the `temperature` parameter (and `top_p`
    // in tandem) at the Messages API: passing either returns HTTP
    // 400. Adapter strips both before send when this is false.
    // TOKEN_TUNING §9's canonical sampling values still apply to
    // every other Claude 4.x model — only this entry opts out.
    supports_sampling: false,
    notes: ['frontier model; best for security-audit and deliberate reasoning workflows'],
  },
  'claude-sonnet-4-6': {
    ...ANTHROPIC_BASE,
    cost_per_1k_input: 3.0,
    cost_per_1k_output: 15.0,
    cost_per_1k_cached_input: 0.3,
    cost_per_1k_cache_write: 3.75,
    notes: ['default model; balanced quality/cost'],
  },
  'claude-haiku-4-5': {
    ...ANTHROPIC_BASE,
    cost_per_1k_input: 1.0,
    cost_per_1k_output: 5.0,
    cost_per_1k_cached_input: 0.1,
    cost_per_1k_cache_write: 1.25,
    notes: ['cheap and fast; default for compaction and one-shot prompts'],
  },
};

export const ANTHROPIC_MODEL_NAMES = Object.keys(ANTHROPIC_CAPS);
