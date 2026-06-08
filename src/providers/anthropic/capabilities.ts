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
// Cache rates follow Anthropic's cache tiering:
//   - cache write (5-min): 1.25× input
//   - cache write (1-hour): 2× input  (cost_per_1k_cache_write_1h)
//   - cache read:           0.10× input  (both TTLs)
// Without declaring `cost_per_1k_cache_write`, `computeCost` falls back to
// the raw input rate and undercounts cache-creation turns by 25%; without
// `cost_per_1k_cached_input`, it overcounts cache reads 10×. The 1h rate is
// only billed when the operator opts into the 1-hour TTL (FORJA_ANTHROPIC_
// CACHE_TTL=1h); the adapter swaps it into the effective write rate then.
export const ANTHROPIC_CAPS: Record<string, ProviderCapabilities> = {
  'claude-opus-4-7': {
    ...ANTHROPIC_BASE,
    cost_per_1k_input: 5.0,
    cost_per_1k_output: 25.0,
    cost_per_1k_cached_input: 0.5,
    cost_per_1k_cache_write: 6.25,
    cost_per_1k_cache_write_1h: 10.0,
    // Opus 4.7 deprecated the `temperature` parameter (and `top_p`
    // in tandem) at the Messages API: passing either returns HTTP
    // 400. Adapter strips both before send when this is false.
    // TOKEN_TUNING §9's canonical sampling values still apply to
    // every other Claude 4.x model — only this entry opts out.
    supports_sampling: false,
    // Opus 4.7 made adaptive thinking the ONLY thinking mode:
    // manual `thinking:{type:'enabled',budget_tokens}` returns HTTP
    // 400. Adapter routes thinking through `type:'adaptive'` and
    // drops the budget when this is true (see `anthropicThinkingParam`).
    supports_adaptive_thinking: true,
    // Accepts `output_config.effort` (low|medium|high|xhigh|max).
    supports_reasoning_effort: true,
    notes: ['frontier model; best for security-audit and deliberate reasoning workflows'],
  },
  'claude-sonnet-4-6': {
    ...ANTHROPIC_BASE,
    cost_per_1k_input: 3.0,
    cost_per_1k_output: 15.0,
    cost_per_1k_cached_input: 0.3,
    cost_per_1k_cache_write: 3.75,
    cost_per_1k_cache_write_1h: 6.0,
    // Sonnet 4.6 uses adaptive thinking (manual enabled+budget is
    // deprecated). Route thinking through `type:'adaptive'`.
    supports_adaptive_thinking: true,
    // Accepts `output_config.effort` (low|medium|high|xhigh|max).
    supports_reasoning_effort: true,
    notes: ['default model; balanced quality/cost'],
  },
  'claude-haiku-4-5': {
    ...ANTHROPIC_BASE,
    cost_per_1k_input: 1.0,
    cost_per_1k_output: 5.0,
    cost_per_1k_cached_input: 0.1,
    cost_per_1k_cache_write: 1.25,
    cost_per_1k_cache_write_1h: 2.0,
    notes: ['cheap and fast; default for compaction and one-shot prompts'],
  },
};

export const ANTHROPIC_MODEL_NAMES = Object.keys(ANTHROPIC_CAPS);
