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
import {
  type CreateOpenRouterProviderOptions,
  createOpenRouterProvider,
} from './openrouter/index.ts';
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
    // A configured `api_key_env` IS the model's key source — the cloud
    // adapters have no env fallback of their own; the catalog is the only
    // source. If it is set but the named var is unset/empty, fail HERE
    // with a diagnostic that names the variable, instead of passing no key
    // and letting the adapter throw a generic "API key required". A caller
    // that supplies an explicit apiKey/client via the `opts` passthrough
    // seam (tests, programmatic callers) overrides this. The message
    // carries "API key required" so the recap stub-fallback gate (run.ts)
    // still recognizes it as a missing-key degrade.
    const o = (opts ?? {}) as { apiKey?: unknown; client?: unknown };
    // A `{ client }` override means the caller supplies auth via an SDK client — but only
    // the SDK families (anthropic / openai / google / openrouter) consume one. Ollama
    // authenticates with a bearer header derived from apiKey/env and IGNORES a client
    // (CreateOllamaProviderOptions has no client field), so a client override must NOT
    // satisfy the guard for an Ollama entry — that would instantiate a key-requiring cloud
    // model with no Authorization header instead of failing with the missing-key diagnostic.
    const clientSatisfies = o.client !== undefined && entry.family !== 'ollama';
    const callerSuppliedKey =
      (typeof o.apiKey === 'string' && o.apiKey.length > 0) || clientSatisfies;
    if (entry.api_key_env !== undefined && !hasKey && !callerSuppliedKey) {
      throw new Error(
        `model ${entry.id}: API key required — the configured api_key_env '${entry.api_key_env}' is unset or empty. Set that variable, or edit the entry's api_key_env to one that is set (e.g. GEMINI_API_KEY for Google). The catalog is the only key source; the adapters have no env fallback.`,
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
        case 'ollama': {
          // Ollama authenticates via an Authorization header, not an SDK apiKey
          // field (CreateOllamaProviderOptions has none). Resolve the bearer from
          // a caller-injected `opts.apiKey` — which satisfies the missing-key guard
          // above — OR the env key, so an injected key actually authenticates
          // instead of bypassing the guard into an unauthenticated cloud client.
          // Caller's key wins over env, mirroring the other adapters' opts override.
          const bearer =
            typeof o.apiKey === 'string' && o.apiKey.length > 0
              ? o.apiKey
              : hasKey
                ? apiKey
                : undefined;
          return createOllamaProvider(entry.model_name, {
            capabilities: entry.capabilities,
            ...(baseURL !== undefined ? { baseUrl: baseURL } : {}),
            // Per-entry num_ctx bypasses the DEFAULT_OLLAMA_NUM_CTX cap so a
            // cloud entry serves its real window; a later explicit `opts.numCtx`
            // (programmatic caller) still wins via the trailing spread.
            ...(entry.num_ctx !== undefined ? { numCtx: entry.num_ctx } : {}),
            // Map the resolved key → bearer header so Ollama Cloud / a guarded
            // host authenticates; local Ollama (no key) omits it. An explicit
            // `opts.headers` still wins via the trailing spread.
            ...(bearer !== undefined ? { headers: { Authorization: `Bearer ${bearer}` } } : {}),
            ...((opts as CreateOllamaProviderOptions | undefined) ?? {}),
          });
        }
        case 'openrouter':
          return createOpenRouterProvider(entry.model_name, {
            capabilities: entry.capabilities,
            ...(hasKey ? { apiKey } : {}),
            ...(baseURL !== undefined ? { baseURL } : {}),
            ...((opts as CreateOpenRouterProviderOptions | undefined) ?? {}),
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
      ...(entry.api_key_env !== undefined ? { apiKeyEnv: entry.api_key_env } : {}),
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

// A ModelRegistry that DEFERS `loadModelRegistry()` to first use and degrades to
// an empty registry on failure (reporting via `onLoadError`). For the subagent-
// child boot of a task-capable coordinator: eagerly reading the catalog there
// would couple the coordinator's startup to catalog health — a file rotated or
// corrupted between the parent's bootstrap and this child's start would THROW
// and crash the whole coordinator, breaking even plain nested task chains that
// never declare a grandchild `model`. With this, the read happens only when a
// nested override / credential-forward actually consults the registry, and a
// corrupt catalog refuses just the affected override (as an unknown model)
// instead of taking down the coordinator. Cached after the first attempt
// (success OR degraded) so repeated lookups in the same process don't re-read.
export const lazyModelRegistry = (
  onLoadError: (message: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): ModelRegistry => {
  let cached: ModelRegistry | null = null;
  const ensure = (): ModelRegistry => {
    if (cached === null) {
      try {
        cached = loadModelRegistry(env).registry;
      } catch (e) {
        onLoadError(e instanceof Error ? e.message : String(e));
        cached = createRegistry();
      }
    }
    return cached;
  };
  return {
    register: (entry) => ensure().register(entry),
    get: (id) => ensure().get(id),
    has: (id) => ensure().has(id),
    list: () => ensure().list(),
  };
};
