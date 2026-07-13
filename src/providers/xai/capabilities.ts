import type { ProviderCapabilities } from '../types.ts';

// Curated catalog of xAI (Grok) models reachable via the NATIVE xAI API
// (https://api.x.ai/v1) — an OpenAI-compatible Chat Completions surface with a
// flat `reasoning_effort` field and `reasoning_content` deltas. Distinct from
// the OpenRouter route (`openrouter/x-ai/grok-*`), which reaches Grok through
// the aggregator with OpenRouter's nested `reasoning` object + reasoning-detail
// replay; this family talks to api.x.ai directly with `XAI_API_KEY`.
//
// Only the flagship is seeded. The operator extends this set by adding any
// other `xai/<model>` entry to model_providers.json with its own capabilities
// (the catalog-file loader accepts a per-entry override).
//
// Costs are DOLLARS PER MILLION tokens (the engine in cost.ts divides usage by
// 1e6; the `cost_per_1k_*` field name is legacy). Values verified against
// x.ai/api + docs.x.ai (2026-07-13): grok-4.5 is $2 in / $6 out per 1M, with a
// 4× cached-read discount ($0.5) applied to the automatic prompt cache.
//
// `context_window` is grok-4.5's served window (500K). `output_max_tokens` is
// the conventional 32K agentic cap — a CEILING clamped by the window room per
// request and used as the default `max_tokens` when a playbook omits one, NOT
// the model's theoretical completion ceiling. Same convention as the OpenRouter
// seed.
//
// Reasoning: grok-4.5 accepts `reasoning_effort` (low/medium/high, default
// high) and reasoning CANNOT be disabled — so `supports_reasoning_effort` is
// true, and the adapter maps the agnostic effort onto low/medium/high (xhigh/
// max clamp to high; there is no `none`). The prompt cache is automatic
// (server-side, discounted read, NO explicit breakpoints — like OpenAI, unlike
// Anthropic/Qwen), so the adapter targets no cache_control markers.

const XAI_BASE = {
  tools: 'native',
  // Automatic server-side prompt cache: a discounted cached-read rate that the
  // adapter captures from `usage.prompt_tokens_details.cached_tokens`. There is
  // NO explicit breakpoint API (`cache_explicit_breakpoints` stays unset), so
  // the adapter sends a flat system string and never emits cache_control.
  cache: 'server_5min',
  // Grok 4.x is multimodal upstream; this adapter is text-only for now.
  vision: false,
  streaming: true,
  // generateConstrained uses forced tool-calling (like the OpenAI adapter), so
  // the constrained surface is `tools`, not the model's `response_format`.
  constrained: 'tools',
  prompt_template_dialect: 'openai_chat',
} as const satisfies Partial<ProviderCapabilities>;

export const XAI_CAPS: Record<string, ProviderCapabilities> = {
  // grok-4.5 — xAI's flagship for coding/agentic work (xAI's own default
  // recommendation: "for everything else, including code, use Grok 4.5").
  // 500K context; reasoning WITH effort levels (low/medium/high, default high,
  // cannot be disabled); automatic prompt cache.
  'grok-4.5': {
    ...XAI_BASE,
    context_window: 500_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    recommended_max_tools_per_step: 12,
    cost_per_1k_input: 2.0,
    cost_per_1k_output: 6.0,
    cost_per_1k_cached_input: 0.5,
    notes: [
      'xAI Grok 4.5 (native api.x.ai); 500K context; reasoning effort low/medium/high (default high, cannot be disabled); automatic prompt cache; multimodal upstream (adapter text-only)',
    ],
  },
};

export const XAI_MODEL_NAMES = Object.keys(XAI_CAPS);
