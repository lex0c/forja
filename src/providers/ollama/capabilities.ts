import type { ProviderCapabilities } from '../types.ts';

// Curated catalog of recommended Ollama models for agentic coding (PROVIDERS §6).
// Every entry declares `tools: 'native'` — the hard requirement to enter the
// catalog. No dynamic resolution: `--model ollama/<name>` resolves against these
// static entries, exactly like the other providers.
//
// `context_window` is the model's CAPACITY (catalog ceiling). Ollama serves a low
// default num_ctx (~2–4K) and truncates silently above it, so the adapter sends an
// explicit `options.num_ctx` (see messages.ts) — capped at DEFAULT_OLLAMA_NUM_CTX
// to keep the KV cache off OOM. The factory then re-exposes that SERVED window as
// the provider's `context_window` (index.ts), so the harness budgets against what
// the daemon actually processes; the value here is the ceiling that cap clamps to.
// `output_max_tokens` is a practical generation ceiling — Ollama imposes no hard
// cap (num_predict controls it); thinking-capable models get more headroom for
// reasoning tokens.

const OLLAMA_BASE = {
  tools: 'native',
  // Ollama exposes no server-side prompt cache the adapter can target.
  cache: false,
  vision: false,
  streaming: true,
  // `format` accepts "json" and a full JSON Schema object.
  constrained: 'json_mode',
  // Local inference is $0 (PROVIDERS §5).
  cost_per_1k_input: 0,
  cost_per_1k_output: 0,
  // No prompt_template_dialect on purpose: /api/chat applies the model's own
  // chat template, so the adapter never assembles a dialect.
} as const satisfies Partial<ProviderCapabilities>;

// Thinking-capable families (qwen3, gpt-oss). The adapter maps `effort` →
// `think: boolean` when this is set; gpt-oss's low/medium/high levels are F3.
const OLLAMA_THINKING_BASE = {
  ...OLLAMA_BASE,
  supports_reasoning_effort: true,
} as const satisfies Partial<ProviderCapabilities>;

const K32 = 32_768;
const K40 = 40_960;
const K128 = 131_072;
const K256 = 262_144;

// Keyed by the exact Ollama model name (the `ollama/<name>` tail).
export const OLLAMA_CAPS: Record<string, ProviderCapabilities> = {
  // Qwen2.5-Coder — code-specific, 32K, tools native. The classic local
  // cost/benefit sweet spot across 7b/14b (the 32b dense moved to cloud).
  'qwen2.5-coder:7b': {
    ...OLLAMA_BASE,
    context_window: K32,
    output_max_tokens: 8_192,
    recommended_max_tools_per_step: 3,
    notes: ['code-specific Qwen; light tier; set num_ctx for the full 32K'],
  },
  'qwen2.5-coder:14b': {
    ...OLLAMA_BASE,
    context_window: K32,
    output_max_tokens: 8_192,
    recommended_max_tools_per_step: 4,
    notes: ['code-specific Qwen; sweet-spot coder'],
  },
  // Qwen3 — general dense, tools + thinking. 40K on 8b/14b.
  'qwen3:8b': {
    ...OLLAMA_THINKING_BASE,
    context_window: K40,
    output_max_tokens: 16_384,
    recommended_max_tools_per_step: 3,
    notes: ['general dense; tools + thinking; light tier'],
  },
  'qwen3:14b': {
    ...OLLAMA_THINKING_BASE,
    context_window: K40,
    output_max_tokens: 16_384,
    recommended_max_tools_per_step: 4,
    notes: ['general dense; tools + thinking'],
  },
  // Llama 3.1 8B — general-purpose, 128K, tools. Strong light option.
  'llama3.1:8b': {
    ...OLLAMA_BASE,
    context_window: K128,
    output_max_tokens: 8_192,
    recommended_max_tools_per_step: 3,
    notes: ['Meta general-purpose; 128K; light tier'],
  },
  // Mistral NeMo 12B — 128K, tools.
  'mistral-nemo:12b': {
    ...OLLAMA_BASE,
    context_window: K128,
    output_max_tokens: 8_192,
    recommended_max_tools_per_step: 4,
    notes: ['12B, 128K context; tools'],
  },
  // gpt-oss 20B — OpenAI open-weights, reasoning + agentic, 128K.
  'gpt-oss:20b': {
    ...OLLAMA_THINKING_BASE,
    context_window: K128,
    output_max_tokens: 16_384,
    recommended_max_tools_per_step: 5,
    notes: ['OpenAI open-weights; reasoning + agentic; think levels are F3'],
  },
};

export const OLLAMA_MODEL_NAMES = Object.keys(OLLAMA_CAPS);

// Curated Ollama Cloud (ollama.com) tier. Kept SEPARATE from OLLAMA_CAPS (the
// local tier) because these are served remotely: seed-catalog.ts attaches
// `base_url` + `api_key_env` + `num_ctx` to each, which the local capability map
// can't express. context_window is the model's CAPACITY; seed-catalog.ts derives
// the served `num_ctx` from it PER MODEL (a remote host has no local VRAM to
// clamp) — NOT a flat value that truncates the larger-context models early.
export const OLLAMA_CLOUD_CAPS: Record<string, ProviderCapabilities> = {
  // GLM-5.2 — strong agentic coding over long trajectories; thinking-capable.
  // The host serves up to 1M tokens, but the served window is capped at 256K here
  // (a 1M KV cache is impractical and far past any coding session) — an operator
  // can raise num_ctx in their own catalog to go higher.
  'glm-5.2': {
    ...OLLAMA_THINKING_BASE,
    context_window: K256,
    output_max_tokens: 16_384,
    recommended_max_tools_per_step: 6,
    notes: ['Ollama Cloud; GLM-5.2; strong agentic coding (long trajectories); High Usage tier'],
  },
  // Qwen3-Coder 480B MoE — agentic coding; non-thinking.
  'qwen3-coder:480b': {
    ...OLLAMA_BASE,
    context_window: K256,
    output_max_tokens: 16_384,
    recommended_max_tools_per_step: 6,
    notes: ['Ollama Cloud; qwen3-coder 480B MoE; agentic coding'],
  },
  // Qwen3-Coder-Next 80B MoE (3B active) — fast agentic coding; non-thinking.
  'qwen3-coder-next': {
    ...OLLAMA_BASE,
    context_window: K256,
    output_max_tokens: 16_384,
    recommended_max_tools_per_step: 6,
    notes: ['Ollama Cloud; Qwen3-Coder-Next 80B MoE (3B active); fast agentic coding'],
  },
  // Devstral 2 123B — Mistral, built for coding agents. Real capacity 256K
  // (ollama.com /api/show), not the 128K the seed previously declared.
  'devstral-2:123b': {
    ...OLLAMA_BASE,
    context_window: K256,
    output_max_tokens: 16_384,
    recommended_max_tools_per_step: 6,
    notes: ['Ollama Cloud; Devstral 2 123B; coding agents'],
  },
};

export const OLLAMA_CLOUD_MODEL_NAMES = Object.keys(OLLAMA_CLOUD_CAPS);
