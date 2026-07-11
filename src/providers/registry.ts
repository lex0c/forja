import type { Provider, ProviderCapabilities, ProviderFamily } from './types.ts';

export interface ModelEntry {
  // Canonical fully-qualified id, e.g., "anthropic/claude-sonnet-4-6".
  id: string;
  family: ProviderFamily;
  // What the underlying SDK sees, e.g., "claude-sonnet-4-6".
  modelName: string;
  capabilities: ProviderCapabilities;
  // The env var holding this model's API key (catalog `api_key_env`), when
  // custom (non-built-in). Surfaced on the entry so a spawn boundary can
  // preserve every catalog model's credential var through scrubEnv — a
  // coordinator subagent may resolve a grandchild playbook's model override,
  // whose credential must survive the child boundary. Undefined for built-in
  // families (their var rides PROVIDER_API_KEY_VARS) and bare registrations.
  apiKeyEnv?: string;
  // Factory accepts `unknown` at the registry boundary so the registry
  // doesn't need to learn about every family's option type. Each adapter
  // narrows internally with a structural cast. The trade-off: callers who
  // want compile-time safety on options should import the adapter's
  // `create<X>Provider` directly instead of going through `entry.factory`.
  factory: (opts?: unknown) => Provider;
}

export interface ModelRegistry {
  register(entry: ModelEntry): void;
  get(id: string): ModelEntry | null;
  list(): ModelEntry[];
  has(id: string): boolean;
}

export const createRegistry = (): ModelRegistry => {
  const map = new Map<string, ModelEntry>();
  return {
    register(entry) {
      if (map.has(entry.id)) {
        throw new Error(`model ${entry.id} already registered`);
      }
      map.set(entry.id, entry);
    },
    get(id) {
      return map.get(id) ?? null;
    },
    list() {
      return Array.from(map.values());
    },
    has(id) {
      return map.has(id);
    },
  };
};

// The runtime catalog is no longer built here from hardcoded
// `register*Models` — it is loaded from the operator-owned
// `model_providers.json` (src/providers/catalog-file.ts). The
// seed-backed `createDefaultRegistry` (kept for tests) and the
// production `loadModelRegistry` both live there.
