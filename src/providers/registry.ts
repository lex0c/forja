import { registerAnthropicModels } from './anthropic/register.ts';
import { registerGoogleModels } from './google/register.ts';
import { registerOpenAIModels } from './openai/register.ts';
import type { Provider, ProviderCapabilities, ProviderFamily } from './types.ts';

export interface ModelEntry {
  // Canonical fully-qualified id, e.g., "anthropic/claude-sonnet-4-6".
  id: string;
  family: ProviderFamily;
  // What the underlying SDK sees, e.g., "claude-sonnet-4-6".
  modelName: string;
  capabilities: ProviderCapabilities;
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

// Default registry for M1: Anthropic + Google + OpenAI. Adding a new family
// is one new register*Models import + one call below; the rest lives in
// the adapter folder.
export const createDefaultRegistry = (): ModelRegistry => {
  const reg = createRegistry();
  registerAnthropicModels(reg);
  registerGoogleModels(reg);
  registerOpenAIModels(reg);
  return reg;
};
