// Honest cost rendering for an UNMETERED tier (e.g. Ollama Cloud): cost is not
// tracked per token, so computeCost returns 0 — but that is "untracked", NOT
// "$0 / free". Every human-facing cost display routes its unmetered check + label
// through here so the surfaces stay consistent (and a new surface can't silently
// reintroduce the "$0 reads as free" bug). The ranking CSV is the one exception:
// it emits a blank cell instead of a label (machine-readable column).

import type { ModelRegistry } from './registry.ts';
import type { Provider } from './types.ts';

export const UNMETERED_LABEL = 'unmetered';

// Live surface — the current run's provider is in hand.
export const isUnmetered = (provider: Pick<Provider, 'capabilities'>): boolean =>
  provider.capabilities.unmetered === true;

// Historical surface — only a stored model id is available; resolve it against the
// CURRENT catalog. Unknown model (dropped from the catalog) ⇒ treated as metered
// (fall back to the recorded cost), which is no worse than before.
export const isUnmeteredModel = (registry: ModelRegistry, modelId: string): boolean =>
  registry.get(modelId)?.capabilities.unmetered === true;

// The shared cost cell: an unmetered model renders the label; otherwise the
// surface's own dollar formatting (precision varies per surface), with the
// project-wide `~` lower-bound marker when usage was incomplete.
export const formatCostCell = (
  unmetered: boolean,
  usageComplete: boolean,
  formatDollars: (usd: number) => string,
  usd: number,
): string => (unmetered ? UNMETERED_LABEL : `${usageComplete ? '' : '~'}${formatDollars(usd)}`);
