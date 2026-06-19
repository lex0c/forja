import type { ProviderCapabilities } from '../types.ts';

// Curated catalog of recommended OpenRouter models for agentic coding.
// OpenRouter is an OpenAI-compatible aggregator; we seed models that are NOT
// reachable as a first-class Forja family (no anthropic/openai/google here —
// those have their own adapters). The operator extends this set by adding any
// other `openrouter/<vendor>/<model>` entry to model_providers.json with its own
// capabilities (the catalog-file loader accepts a per-entry override).
//
// Keyed by the EXACT OpenRouter model id (the `openrouter/<id>` tail), which is
// itself `<vendor>/<model>` — so the registry id carries two slashes
// (`openrouter/deepseek/deepseek-v3.2`). That is fine: `family` is a separate
// field and resolution keys off the whole id, never `split('/')`.
//
// Values were curated from the live `GET https://openrouter.ai/api/v1/models`
// payload (2026-06-19). Costs are **dollars per MILLION tokens** (the engine in
// cost.ts divides usage by 1e6; the `cost_per_1k_*` field name is legacy) =
// `pricing.{prompt,completion,...}` (which is $/token) × 1e6. Prices vary by the
// served upstream provider; these are the headline rates, not a contract.
//
// `context_window` is the SERVED window (`top_provider.context_length` — what the
// default-routed provider actually serves), which equals the model max when they
// agree but is smaller for some models (e.g. deepseek-r1: 64K served vs a 163K
// headline). The adapter sends `transforms: []` (middle-out OFF), so the Forja
// context engine must budget against what a provider really serves — otherwise a
// large prompt 4xxs instead of being compressed. Same honesty premise as the
// Ollama served-window fix. An operator who pins a larger-context provider can
// raise it per-entry in model_providers.json.
//
// Reasoning: `supports_reasoning_effort` means the model accepts `reasoning.effort`
// (per-model `reasoning.supported_efforts` in /api/v1/models) — only Grok here.
// The DeepSeek/GLM/Kimi thinking models expose the generic `reasoning` param but
// NO effort levels, so they declare `supports_reasoning` (replay-eligible; the
// adapter toggles them via `reasoning.enabled`, never an effort the model rejects).

const OPENROUTER_BASE = {
  tools: 'native',
  // Cache is captured from the response usage when a provider serves it; only
  // models with an automatic server-side cache + a read discount declare it
  // here. Explicit cache_control breakpoints (Anthropic/Qwen style) are gated by
  // `cache_explicit_breakpoints`; models without server-side cache stay `false`.
  cache: false,
  // The adapter is text-only for now; vision-capable models still send text.
  vision: false,
  streaming: true,
  // generateConstrained uses forced tool-calling (like the OpenAI adapter), so
  // the constrained surface is `tools`, not the model's `response_format`.
  constrained: 'tools',
} as const satisfies Partial<ProviderCapabilities>;

export const OPENROUTER_CAPS: Record<string, ProviderCapabilities> = {
  // DeepSeek V3.2 — strong general/coding, thinking-capable (no effort levels).
  'deepseek/deepseek-v3.2': {
    ...OPENROUTER_BASE,
    context_window: 128_000,
    output_max_tokens: 32_768,
    supports_reasoning: true,
    recommended_max_tools_per_step: 6,
    cost_per_1k_input: 0.2288,
    cost_per_1k_output: 0.3432,
    notes: ['DeepSeek V3.2; general+coding; thinking via reasoning.enabled; served window 128K'],
  },
  // DeepSeek R1 — mandatory-reasoning model (no effort levels); output cap 16k.
  'deepseek/deepseek-r1': {
    ...OPENROUTER_BASE,
    context_window: 64_000,
    output_max_tokens: 16_000,
    supports_reasoning: true,
    recommended_max_tools_per_step: 5,
    cost_per_1k_input: 0.7,
    cost_per_1k_output: 2.5,
    notes: [
      'DeepSeek R1; reasoning (mandatory, no effort levels); served window 64K (headline 163K is not what the default provider serves); output capped at 16k',
    ],
  },
  // Qwen3 Coder Plus — agentic coding, 1M context, native tools (no thinking).
  'qwen/qwen3-coder-plus': {
    ...OPENROUTER_BASE,
    // Alibaba/Qwen needs explicit cache_control breakpoints (not automatic).
    cache: 'server_5min',
    context_window: 1_000_000,
    output_max_tokens: 32_768,
    recommended_max_tools_per_step: 6,
    cost_per_1k_input: 0.65,
    cost_per_1k_output: 3.25,
    cost_per_1k_cached_input: 0.13,
    cost_per_1k_cache_write: 0.8125,
    cache_explicit_breakpoints: true,
    notes: ['Qwen3 Coder Plus; agentic coding; 1M context; explicit prompt-cache breakpoints'],
  },
  // xAI Grok 4.3 — 1M context, reasoning WITH effort levels, automatic cache.
  'x-ai/grok-4.3': {
    ...OPENROUTER_BASE,
    cache: 'server_5min',
    context_window: 1_000_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    recommended_max_tools_per_step: 8,
    cost_per_1k_input: 1.25,
    cost_per_1k_output: 2.5,
    cost_per_1k_cached_input: 0.2,
    notes: ['xAI Grok 4.3; 1M context; reasoning (effort levels); automatic prompt cache'],
  },
  // Z.ai GLM-4.6 — strong coding + reasoning (no effort levels), automatic cache.
  'z-ai/glm-4.6': {
    ...OPENROUTER_BASE,
    cache: 'server_5min',
    context_window: 202_752,
    output_max_tokens: 32_768,
    supports_reasoning: true,
    recommended_max_tools_per_step: 6,
    cost_per_1k_input: 0.43,
    cost_per_1k_output: 1.74,
    cost_per_1k_cached_input: 0.08,
    notes: ['Z.ai GLM-4.6; coding + reasoning (via reasoning.enabled); automatic prompt cache'],
  },
  // Moonshot Kimi K2 Thinking — 256K context, mandatory reasoning (no effort), tools.
  'moonshotai/kimi-k2-thinking': {
    ...OPENROUTER_BASE,
    context_window: 262_144,
    output_max_tokens: 32_768,
    supports_reasoning: true,
    recommended_max_tools_per_step: 6,
    cost_per_1k_input: 0.6,
    cost_per_1k_output: 2.5,
    notes: ['Moonshot Kimi K2 Thinking; 256K context; reasoning (mandatory, no effort) + tools'],
  },
  // Meta Llama 3.3 70B Instruct — general-purpose, 128K, native tools (no reasoning).
  'meta-llama/llama-3.3-70b-instruct': {
    ...OPENROUTER_BASE,
    context_window: 131_072,
    output_max_tokens: 16_384,
    recommended_max_tools_per_step: 4,
    cost_per_1k_input: 0.1,
    cost_per_1k_output: 0.32,
    notes: ['Meta Llama 3.3 70B Instruct; general-purpose; 128K; tools'],
  },
};

export const OPENROUTER_MODEL_NAMES = Object.keys(OPENROUTER_CAPS);
