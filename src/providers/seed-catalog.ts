// Embedded model-catalog seed. The operator-owned
// `~/.config/forja/model_providers.json` is the runtime source of
// truth (AGENTIC_CLI §14.2); this literal is ONLY what `forja init`
// materializes into that file on a fresh install, and what
// `forja init --force=model_providers` re-syncs from. It is NOT read
// at runtime to resolve a model — resolution always goes through the
// file (src/providers/catalog-file.ts). The one exception is
// `createDefaultRegistry()`, a seed-backed registry kept for tests and
// programmatic seams that must not depend on an on-disk file.
//
// Derived from the per-family `*_CAPS` constants so there is a SINGLE
// source for the shipped capabilities — bumping a price/window in
// `<family>/capabilities.ts` flows into both the seed and the
// (legacy) register* path without a second edit.

import { ANTHROPIC_CAPS } from './anthropic/capabilities.ts';
import { GOOGLE_CAPS } from './google/capabilities.ts';
import { OLLAMA_CAPS, OLLAMA_CLOUD_CAPS } from './ollama/capabilities.ts';
import { OPENAI_CAPS } from './openai/capabilities.ts';
import { OPENROUTER_CAPS } from './openrouter/capabilities.ts';
import type { ModelProviderEntry, ProviderCapabilities, ProviderFamily } from './types.ts';

const fromCaps = (
  family: ProviderFamily,
  caps: Record<string, ProviderCapabilities>,
  apiKeyEnv?: string,
): ModelProviderEntry[] =>
  Object.entries(caps).map(([modelName, capabilities]) => ({
    id: `${family}/${modelName}`,
    family,
    model_name: modelName,
    // Build conditionally: exactOptionalPropertyTypes rejects an
    // explicit `undefined` for the optional `api_key_env`.
    ...(apiKeyEnv !== undefined ? { api_key_env: apiKeyEnv } : {}),
    capabilities,
  }));

// Curated Ollama Cloud (ollama.com) tier. Unlike the LOCAL Ollama seed, these
// carry `base_url` + `api_key_env` + `num_ctx` so a fresh install reaches the
// cloud tier without manual catalog edits. `num_ctx` is derived PER MODEL from
// its own `context_window` (a remote host has no local VRAM to clamp, so it
// serves the full declared window) — NOT a flat value that truncates the
// larger-context models early. OLLAMA_API_KEY is required at factory time (a
// clear "API key required" diagnostic fires if unset).
const OLLAMA_CLOUD: ReadonlyArray<ModelProviderEntry> = Object.entries(OLLAMA_CLOUD_CAPS).map(
  ([modelName, capabilities]): ModelProviderEntry => ({
    id: `ollama/${modelName}`,
    family: 'ollama',
    model_name: modelName,
    base_url: 'https://ollama.com',
    api_key_env: 'OLLAMA_API_KEY',
    num_ctx: capabilities.context_window,
    capabilities,
  }),
);

// Order mirrors the historical registration order (anthropic, google, ollama,
// openai) so the seeded file's diff is stable. The LOCAL Ollama tier carries no
// `api_key_env` (local inference needs no key); the CLOUD tier above DOES
// (OLLAMA_API_KEY → bearer). Google seeds `GOOGLE_API_KEY`; there is NO env
// fallback, so an operator who instead uses GEMINI_API_KEY edits the entry's
// api_key_env to GEMINI_API_KEY (the file is the authoritative source).
export const CANONICAL_MODEL_PROVIDERS: ReadonlyArray<ModelProviderEntry> = [
  ...fromCaps('anthropic', ANTHROPIC_CAPS, 'ANTHROPIC_API_KEY'),
  ...fromCaps('google', GOOGLE_CAPS, 'GOOGLE_API_KEY'),
  ...fromCaps('ollama', OLLAMA_CAPS),
  ...OLLAMA_CLOUD,
  ...fromCaps('openai', OPENAI_CAPS, 'OPENAI_API_KEY'),
  // OpenRouter carries no env fallback either — the catalog's api_key_env
  // (OPENROUTER_API_KEY) is the sole key source, mapped to a bearer header.
  ...fromCaps('openrouter', OPENROUTER_CAPS, 'OPENROUTER_API_KEY'),
];
