// Operator-owned model catalog — registry construction (SDK-bound).
//
// This is the heavy half of the catalog: it wires each catalog entry to
// its provider adapter (and thus imports the provider SDKs). The
// SDK-free file I/O + validation lives in catalog-io.ts so `forja init`
// can materialize the seed without pulling the SDKs.
//
// Running `forja init` is mandatory: `loadModelRegistry` THROWS an
// actionable error when the file is absent/corrupt rather than silently
// falling back to the seed — so a model the operator removed stays
// removed, and a typo can't boot a half-right catalog unnoticed.
//
// Families stay fixed in code (one adapter each). The file registers
// MODELS within those families — it cannot define a new adapter.

import { type CreateAnthropicProviderOptions, createAnthropicProvider } from './anthropic/index.ts';
import { loadModelProvidersFile } from './catalog-io.ts';
import { type CreateGoogleProviderOptions, createGoogleProvider } from './google/index.ts';
import { type CreateOllamaProviderOptions, createOllamaProvider } from './ollama/index.ts';
import { type CreateOpenAIProviderOptions, createOpenAIProvider } from './openai/index.ts';
import { type ModelRegistry, createRegistry } from './registry.ts';
import { CANONICAL_MODEL_PROVIDERS } from './seed-catalog.ts';
import type { ModelProviderEntry, Provider } from './types.ts';

// Build the lazily-evaluated provider factory for an entry. The API key
// is read from the named env var INSIDE the closure (lazy), so only the
// model actually selected pays the "key required" check — and the
// adapter's own env fallback still applies when `api_key_env` is omitted
// or the var is unset.
//
// Honors caller-supplied `opts` (spread LAST, so the caller wins): the
// registry's `factory(opts?)` contract is a passthrough seam — tests
// inject `{ apiKey }` to instantiate a cloud entry without a real env
// key, and `/model` etc. could inject a client. Entry-derived options
// (capabilities / api_key_env / base_url) are the defaults beneath it.
const entryToFactory =
  (entry: ModelProviderEntry): ((opts?: unknown) => Provider) =>
  (opts?: unknown): Provider => {
    const apiKey = entry.api_key_env !== undefined ? process.env[entry.api_key_env] : undefined;
    const hasKey = apiKey !== undefined && apiKey.length > 0;
    const baseURL = entry.base_url;
    // A configured `api_key_env` is AUTHORITATIVE. If it is set but the
    // named env var is unset/empty, FAIL — do NOT leave apiKey out and
    // let the adapter fall back to its own default vendor env
    // (OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY). With a
    // custom `base_url`, that fallback would ship the operator's real
    // vendor key to a third-party (OpenAI-/Anthropic-compatible)
    // endpoint. A caller that supplies an explicit apiKey/client via the
    // `opts` passthrough seam (tests, programmatic callers) overrides
    // this — only the unconfigured production path is refused. The
    // message carries "API key required" so the recap stub-fallback gate
    // (run.ts) still recognizes it as a missing-key degrade.
    const o = (opts ?? {}) as { apiKey?: unknown; client?: unknown };
    const callerSuppliedKey =
      (typeof o.apiKey === 'string' && o.apiKey.length > 0) || o.client !== undefined;
    if (entry.api_key_env !== undefined && !hasKey && !callerSuppliedKey) {
      throw new Error(
        `model ${entry.id}: API key required — the configured api_key_env '${entry.api_key_env}' is unset or empty. Set it, or remove api_key_env to use the adapter's default. Refusing the default-vendor-key fallback so a configured base_url can't receive the wrong key.`,
      );
    }
    const provider: Provider = ((): Provider => {
      switch (entry.family) {
        case 'anthropic':
          return createAnthropicProvider(entry.model_name, {
            capabilities: entry.capabilities,
            ...(hasKey ? { apiKey } : {}),
            ...(baseURL !== undefined ? { baseURL } : {}),
            ...((opts as CreateAnthropicProviderOptions | undefined) ?? {}),
          });
        case 'openai':
          return createOpenAIProvider(entry.model_name, {
            capabilities: entry.capabilities,
            ...(hasKey ? { apiKey } : {}),
            ...(baseURL !== undefined ? { baseURL } : {}),
            ...((opts as CreateOpenAIProviderOptions | undefined) ?? {}),
          });
        case 'google':
          return createGoogleProvider(entry.model_name, {
            capabilities: entry.capabilities,
            ...(hasKey ? { apiKey } : {}),
            ...((opts as CreateGoogleProviderOptions | undefined) ?? {}),
          });
        case 'ollama':
          return createOllamaProvider(entry.model_name, {
            capabilities: entry.capabilities,
            ...(baseURL !== undefined ? { baseUrl: baseURL } : {}),
            // Map api_key_env → bearer header so Ollama Cloud / a guarded
            // host authenticates; local Ollama (no key) omits it.
            ...(hasKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
            ...((opts as CreateOllamaProviderOptions | undefined) ?? {}),
          });
        default:
          // Unreachable: the loader rejects unsupported families before an
          // entry reaches here. Kept as an exhaustiveness guard.
          throw new Error(`unsupported family in catalog entry: ${entry.family}`);
      }
    })();
    // Provenance: stamp the source catalog entry on the provider so the
    // subagent spawn path can snapshot it (Provider.catalogEntry) instead
    // of having a spawned child re-read a possibly-edited catalog file.
    return { ...provider, catalogEntry: entry };
  };

// Construct a registry from validated entries. Assumes unique ids (the
// loader dedupes; the seed is unique by construction) — `register`
// throws on a duplicate, which would be an internal bug here.
export const buildRegistryFromEntries = (
  entries: ReadonlyArray<ModelProviderEntry>,
): ModelRegistry => {
  const reg = createRegistry();
  for (const entry of entries) {
    reg.register({
      id: entry.id,
      family: entry.family,
      modelName: entry.model_name,
      capabilities: entry.capabilities,
      factory: entryToFactory(entry),
    });
  }
  return reg;
};

// Seed-backed registry — NOT used in production resolution (that goes
// through `loadModelRegistry` + the on-disk file). Kept for tests and
// programmatic seams that must not depend on an installed catalog file.
export const createDefaultRegistry = (): ModelRegistry =>
  buildRegistryFromEntries(CANONICAL_MODEL_PROVIDERS);

// Production entry point: build the registry from the operator-owned
// file. THROWS when the file is absent/corrupt — `forja init` is
// mandatory. Returns warnings (malformed/duplicate entries) for the
// caller to surface (boot banner / stderr).
export const loadModelRegistry = (
  env: NodeJS.ProcessEnv = process.env,
): { registry: ModelRegistry; warnings: string[] } => {
  const result = loadModelProvidersFile(env);
  if (!result.ok) throw new Error(result.error);
  return { registry: buildRegistryFromEntries(result.entries), warnings: result.warnings };
};
