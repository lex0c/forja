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
// CURRENT catalog. Unknown model (dropped from the catalog) ⇒ treated as metered (fall
// back to the recorded cost), no worse than before. Caveat: a REPL session's stored model
// is the one at createSession time; a `/model` switch mid-session does NOT update it, so
// this can mislabel a session that switched metering — which is why `formatCostCell` never
// lets the label replace a nonzero recorded total, and why historical surfaces should
// prefer `isSessionUnmetered` (per-turn provenance) when the session's models are known.
export const isUnmeteredModel = (registry: ModelRegistry, modelId: string): boolean =>
  registry.get(modelId)?.capabilities.unmetered === true;

// Is a session's recorded cost untracked? unmetered=true ONLY when EVERY model it billed on
// is unmetered — a session that used any metered model carries real recorded spend and is
// NOT unmetered (even if it also used an unmetered one), so the dollars are never mislabeled
// away as "unmetered". `models` is the session's EFFECTIVE models (from
// `effectiveSessionModels`, which folds the `sessions.model` fallback in ONE place); the
// `length > 0` guard keeps an empty set (a misuse — effective models are never empty) from
// reading as vacuously unmetered.
export const isSessionUnmetered = (registry: ModelRegistry, models: string[]): boolean =>
  models.length > 0 && models.every((m) => isUnmeteredModel(registry, m));

// The shared cost cell. The "unmetered" label renders ONLY when the recorded cost is
// exactly 0 — the label means "$0 is untracked, not free", which is meaningful only when
// there is no recorded dollar spend. A NONZERO total always wins: a historical session
// whose row model resolves as unmetered (the model at createSession time) but that later
// switched via `/model` to a metered one carries real recorded spend in `usd`, which the
// label would otherwise hide. Otherwise: the surface's own dollar formatting, with the
// project-wide `~` lower-bound marker when usage was incomplete.
export const formatCostCell = (
  unmetered: boolean,
  usageComplete: boolean,
  formatDollars: (usd: number) => string,
  usd: number,
): string =>
  unmetered && usd === 0 ? UNMETERED_LABEL : `${usageComplete ? '' : '~'}${formatDollars(usd)}`;
