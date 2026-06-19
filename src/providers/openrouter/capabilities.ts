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
// Values (context_window, output_max_tokens, pricing, tools/reasoning) were
// curated from the live `GET https://openrouter.ai/api/v1/models` payload
// (2026-06-19) — `context_length`, `top_provider.max_completion_tokens`,
// `pricing.{prompt,completion,input_cache_read}` (×1000 → $/1k tokens), and the
// `supported_parameters[]` capability oracle (`tools`, `reasoning`). Prices on
// OpenRouter vary by the served upstream provider; these are the headline rates
// and a starting point for cost accounting, not a contract.
//
// `context_window` is the SERVED window (`top_provider.context_length` — what the
// default-routed provider actually serves), which equals the model max when they
// agree but is smaller for some models (e.g. deepseek-r1: 64K served vs a 163K
// headline). The adapter sends `transforms: []` (middle-out OFF), so the Forja
// context engine must budget against what a provider really serves — otherwise a
// large prompt 4xxs instead of being compressed. Same honesty premise as the
// Ollama served-window fix. An operator who pins a larger-context provider can
// raise it per-entry in model_providers.json.

const OPENROUTER_BASE = {
  tools: 'native',
  // Cache is captured from the response usage when a provider serves it; only
  // models with an automatic server-side cache + a read discount declare it
  // here. Explicit cache_control breakpoints (Anthropic/Qwen style) are a
  // future slice — not wired yet, so those models declare `cache: false`.
  cache: false,
  // The adapter is text-only for now; vision-capable models still send text.
  vision: false,
  streaming: true,
  // generateConstrained uses forced tool-calling (like the OpenAI adapter), so
  // the constrained surface is `tools`, not the model's `response_format`.
  constrained: 'tools',
} as const satisfies Partial<ProviderCapabilities>;

export const OPENROUTER_CAPS: Record<string, ProviderCapabilities> = {
  // DeepSeek V3.2 — strong general/coding, thinking-capable, automatic cache
  // (read pricing not exposed per-endpoint, so cache stays off here).
  'deepseek/deepseek-v3.2': {
    ...OPENROUTER_BASE,
    context_window: 128_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    recommended_max_tools_per_step: 6,
    cost_per_1k_input: 0.0002288,
    cost_per_1k_output: 0.0003432,
    notes: ['DeepSeek V3.2; general+coding; thinking-capable; served window 128K'],
  },
  // DeepSeek R1 — reasoning model; lower output ceiling (provider cap 16k).
  'deepseek/deepseek-r1': {
    ...OPENROUTER_BASE,
    context_window: 64_000,
    output_max_tokens: 16_000,
    supports_reasoning_effort: true,
    recommended_max_tools_per_step: 5,
    cost_per_1k_input: 0.0007,
    cost_per_1k_output: 0.0025,
    notes: [
      'DeepSeek R1; reasoning; served window 64K (headline 163K is not what the default provider serves); output capped at 16k',
    ],
  },
  // Qwen3 Coder Plus — agentic coding, 1M context, native tools (no thinking).
  // Explicit cache available upstream but not wired (cache: false for now).
  'qwen/qwen3-coder-plus': {
    ...OPENROUTER_BASE,
    context_window: 1_000_000,
    output_max_tokens: 32_768,
    recommended_max_tools_per_step: 6,
    cost_per_1k_input: 0.00065,
    cost_per_1k_output: 0.00325,
    notes: ['Qwen3 Coder Plus; agentic coding; 1M context'],
  },
  // xAI Grok 4.3 — 1M context, reasoning, automatic prompt cache (read discount).
  'x-ai/grok-4.3': {
    ...OPENROUTER_BASE,
    cache: 'server_5min',
    context_window: 1_000_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    recommended_max_tools_per_step: 8,
    cost_per_1k_input: 0.00125,
    cost_per_1k_output: 0.0025,
    cost_per_1k_cached_input: 0.0002,
    notes: ['xAI Grok 4.3; 1M context; reasoning; automatic prompt cache'],
  },
  // Z.ai GLM-4.6 — strong coding + reasoning, automatic prompt cache.
  'z-ai/glm-4.6': {
    ...OPENROUTER_BASE,
    cache: 'server_5min',
    context_window: 202_752,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    recommended_max_tools_per_step: 6,
    cost_per_1k_input: 0.00043,
    cost_per_1k_output: 0.00174,
    cost_per_1k_cached_input: 0.00008,
    notes: ['Z.ai GLM-4.6; coding + reasoning; automatic prompt cache'],
  },
  // Moonshot Kimi K2 Thinking — 256K context, reasoning + tools.
  'moonshotai/kimi-k2-thinking': {
    ...OPENROUTER_BASE,
    context_window: 262_144,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    recommended_max_tools_per_step: 6,
    cost_per_1k_input: 0.0006,
    cost_per_1k_output: 0.0025,
    notes: ['Moonshot Kimi K2 Thinking; 256K context; reasoning + tools'],
  },
  // Meta Llama 3.3 70B Instruct — general-purpose, 128K, native tools.
  'meta-llama/llama-3.3-70b-instruct': {
    ...OPENROUTER_BASE,
    context_window: 131_072,
    output_max_tokens: 16_384,
    recommended_max_tools_per_step: 4,
    cost_per_1k_input: 0.0001,
    cost_per_1k_output: 0.00032,
    notes: ['Meta Llama 3.3 70B Instruct; general-purpose; 128K; tools'],
  },
};

export const OPENROUTER_MODEL_NAMES = Object.keys(OPENROUTER_CAPS);
