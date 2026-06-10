import type { ModelRegistry } from './registry.ts';
import type { Provider } from './types.ts';

// Single encoding of "resolve a model id to a Provider via the
// registry, fail-soft" — the lookup + instantiate dance with its two
// distinct failure modes (`unknown` id vs the factory throwing, most
// commonly a missing API key). Callers format/handle the result
// their own way: bootstrap throws, `/model` returns an error result,
// `/recap --model` warns and falls back. Keeping the mechanism here
// stops those sites from drifting on the lookup/instantiate shape.
//
// NOTE: `/model` deliberately does NOT use this — it interleaves an
// idempotency check (`id === current`) between lookup and factory,
// and the combined helper would instantiate even on the no-op path.
export type ResolveProviderResult =
  | { ok: true; provider: Provider }
  | { ok: false; kind: 'unknown'; id: string; knownIds: string[] }
  | { ok: false; kind: 'factory-error'; id: string; message: string };

export const resolveProviderFromId = (
  registry: ModelRegistry,
  id: string,
): ResolveProviderResult => {
  const entry = registry.get(id);
  if (entry === null) {
    return { ok: false, kind: 'unknown', id, knownIds: registry.list().map((e) => e.id) };
  }
  try {
    return { ok: true, provider: entry.factory() };
  } catch (e) {
    return {
      ok: false,
      kind: 'factory-error',
      id,
      message: e instanceof Error ? e.message : String(e),
    };
  }
};
