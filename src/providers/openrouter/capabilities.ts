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
// (`openrouter/deepseek/deepseek-v4-flash`). That is fine: `family` is a separate
// field and resolution keys off the whole id, never `split('/')`.
//
// Values were curated from the live `GET https://openrouter.ai/api/v1/models`
// payload (2026-07-11), refreshed to the generation that actually dominates
// OpenRouter usage (DeepSeek V4, MiniMax M3, GLM 5.2, Kimi K2.6, Qwen 3.6,
// Grok 4.5). Costs are **dollars per MILLION tokens** (the engine in cost.ts
// divides usage by 1e6; the `cost_per_1k_*` field name is legacy) =
// `pricing.{prompt,completion,input_cache_read,input_cache_write}` (which is
// $/token) × 1e6. Prices vary by the served upstream provider; these are the
// headline rates, not a contract.
//
// `context_window` is the SERVED window (`top_provider.context_length` — what the
// default-routed provider actually serves), which equals the model max when they
// agree but is smaller for some models. The adapter sends `transforms: []`
// (middle-out OFF), so the Forja context engine must budget against what a
// provider really serves — otherwise a large prompt 4xxs instead of being
// compressed. Same honesty premise as the Ollama served-window fix. An operator
// who pins a larger-context provider can raise it per-entry in model_providers.json.
//
// `output_max_tokens` is the conventional 32K agentic cap, NOT each model's
// theoretical completion ceiling (v4 flash/pro allow 384K). It is a CEILING —
// clamped by the window room per request (compaction.ts) and used as the default
// `max_tokens` when a playbook omits one — never a reservation, so keeping it
// sane avoids a request defaulting to a 384K completion budget.
//
// Reasoning: `supports_reasoning_effort` means the model accepts `reasoning.effort`
// (per-model `reasoning_effort` in /api/v1/models `supported_parameters`) — the
// current generation exposes it widely (deepseek v4 flash/pro, glm-5.2, grok-4.5,
// tencent/hy3). Models that expose the generic `reasoning` param but NO effort
// levels (minimax-m3, kimi-k2.6, qwen3.6-plus) declare `supports_reasoning`
// (replay-eligible; the adapter toggles them via `reasoning.enabled`, never an
// effort the model rejects).

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
  // DeepSeek V4 Flash — frontier-class agentic coding at minimal cost (79% on
  // SWE-bench Verified); effort-capable, automatic prompt cache.
  'deepseek/deepseek-v4-flash': {
    ...OPENROUTER_BASE,
    cache: 'server_5min',
    context_window: 1_024_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    recommended_max_tools_per_step: 8,
    cost_per_1k_input: 0.077,
    cost_per_1k_output: 0.154,
    cost_per_1k_cached_input: 0.0154,
    notes: [
      'DeepSeek V4 Flash; frontier agentic coding, cheap; reasoning (effort levels); served window 1.024M; automatic prompt cache',
    ],
  },
  // DeepSeek V4 Pro — the higher-quality V4 tier; effort-capable, automatic cache.
  'deepseek/deepseek-v4-pro': {
    ...OPENROUTER_BASE,
    cache: 'server_5min',
    context_window: 1_024_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    recommended_max_tools_per_step: 8,
    cost_per_1k_input: 0.348,
    cost_per_1k_output: 0.696,
    cost_per_1k_cached_input: 0.029,
    notes: [
      'DeepSeek V4 Pro; strong general+coding; reasoning (effort levels); served window 1.024M; automatic prompt cache',
    ],
  },
  // MiniMax M3 — top OpenRouter usage; multimodal (adapter sends text only);
  // reasoning WITHOUT effort levels (toggle), automatic cache.
  'minimax/minimax-m3': {
    ...OPENROUTER_BASE,
    cache: 'server_5min',
    context_window: 1_000_000,
    output_max_tokens: 32_768,
    supports_reasoning: true,
    recommended_max_tools_per_step: 6,
    cost_per_1k_input: 0.3,
    cost_per_1k_output: 1.2,
    cost_per_1k_cached_input: 0.06,
    notes: [
      'MiniMax M3; top usage; multimodal upstream (adapter text-only); thinking via reasoning.enabled; 1M context; automatic prompt cache',
    ],
  },
  // Z.ai GLM-5.2 — #1 open-weight on the Intelligence Index; strong repo-scale
  // agentic work. Effort-capable, automatic cache.
  'z-ai/glm-5.2': {
    ...OPENROUTER_BASE,
    cache: 'server_5min',
    context_window: 1_024_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    recommended_max_tools_per_step: 8,
    cost_per_1k_input: 0.35,
    cost_per_1k_output: 1.1,
    cost_per_1k_cached_input: 0.065,
    notes: [
      'Z.ai GLM-5.2; #1 open-weight (Intelligence Index); repo-scale agentic; reasoning (effort levels); served window 1.024M; automatic prompt cache',
    ],
  },
  // Moonshot Kimi K2.6 — 256K context, reasoning WITHOUT effort levels, tools,
  // automatic cache.
  'moonshotai/kimi-k2.6': {
    ...OPENROUTER_BASE,
    cache: 'server_5min',
    context_window: 262_144,
    output_max_tokens: 32_768,
    supports_reasoning: true,
    recommended_max_tools_per_step: 6,
    cost_per_1k_input: 0.66,
    cost_per_1k_output: 3.41,
    cost_per_1k_cached_input: 0.15,
    notes: [
      'Moonshot Kimi K2.6; 256K context; thinking via reasoning.enabled + tools; automatic prompt cache',
    ],
  },
  // Qwen3.6 Plus — 1M context, reasoning WITHOUT effort levels (toggle). Alibaba
  // needs EXPLICIT cache_control breakpoints (not automatic); the endpoint prices
  // cache writes (input_cache_write) and exposes no separate cached-read rate.
  'qwen/qwen3.6-plus': {
    ...OPENROUTER_BASE,
    cache: 'server_5min',
    context_window: 1_000_000,
    output_max_tokens: 32_768,
    supports_reasoning: true,
    recommended_max_tools_per_step: 6,
    cost_per_1k_input: 0.325,
    cost_per_1k_output: 1.95,
    cost_per_1k_cache_write: 0.40625,
    cache_explicit_breakpoints: true,
    notes: [
      'Qwen3.6 Plus; agentic + reasoning (via reasoning.enabled); 1M context; explicit prompt-cache breakpoints (Alibaba-style)',
    ],
  },
  // xAI Grok 4.5 — 500K context, reasoning WITH effort levels, automatic cache.
  'x-ai/grok-4.5': {
    ...OPENROUTER_BASE,
    cache: 'server_5min',
    context_window: 500_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    recommended_max_tools_per_step: 8,
    cost_per_1k_input: 2.0,
    cost_per_1k_output: 6.0,
    cost_per_1k_cached_input: 0.5,
    notes: ['xAI Grok 4.5; 500K context; reasoning (effort levels); automatic prompt cache'],
  },
  // Tencent HY3 (free tier) — 256K context, effort-capable, no server-side cache
  // discount. Free routes are HEAVILY rate-limited on OpenRouter; treat as a
  // fallback/eval model, not a throughput workhorse.
  'tencent/hy3:free': {
    ...OPENROUTER_BASE,
    context_window: 262_144,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    recommended_max_tools_per_step: 6,
    cost_per_1k_input: 0,
    cost_per_1k_output: 0,
    notes: [
      'Tencent HY3 (free tier); 256K context; reasoning (effort levels); free but heavily rate-limited — fallback/eval use',
    ],
  },
  // NVIDIA Nemotron 3 Ultra (free tier) — hybrid Transformer-Mamba MoE (550B
  // total / 55B active), 1M served context; built for long-running agentic
  // workflows (agent orchestration, coding agents, deep research). Reasoning
  // WITH effort levels + native tools. Free route is heavily rate-limited, and
  // the free endpoint carries provider-side data collection — treat as
  // fallback/eval, not a throughput workhorse.
  'nvidia/nemotron-3-ultra-550b-a55b:free': {
    ...OPENROUTER_BASE,
    context_window: 1_000_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    recommended_max_tools_per_step: 8,
    cost_per_1k_input: 0,
    cost_per_1k_output: 0,
    notes: [
      'NVIDIA Nemotron 3 Ultra (free tier); 550B MoE (55B active); 1M served context; agentic/coding; reasoning (effort levels) + native tools; free but heavily rate-limited + free-endpoint data collection — fallback/eval use',
    ],
  },
  // OpenAI gpt-oss-20b (free tier) — open-weight 21B MoE (3.6B active), 131K
  // context; native tools + configurable reasoning effort. Small/efficient; the
  // free route is heavily rate-limited.
  'openai/gpt-oss-20b:free': {
    ...OPENROUTER_BASE,
    context_window: 131_072,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    recommended_max_tools_per_step: 6,
    cost_per_1k_input: 0,
    cost_per_1k_output: 0,
    notes: [
      'OpenAI gpt-oss-20b (free tier); open-weight 21B MoE (3.6B active); 131K context; native tools + reasoning (effort levels); free but heavily rate-limited — fallback/eval use',
    ],
  },
};

export const OPENROUTER_MODEL_NAMES = Object.keys(OPENROUTER_CAPS);
