// Top-level render entry points for `RecapIntermediate`. The
// per-renderer implementations live under `src/recap/<name>/`;
// this module is the dispatcher + JSON renderer + thin compat
// re-export of `renderHuman` for legacy callers.
//
// The deterministic surface (counts, files, decisions, etc.) is
// projected from the intermediate by each renderer's
// `deterministic.ts`; LLM-fillable prose lives behind
// `<renderer>/llm.ts` via the shared `renderViaLlm` helper.
//
// Privacy guarantee from RECAP.md §6.2: paths under `$HOME` are
// rewritten to `~/...` and secret-shaped tokens are redacted
// before output. The JSON renderer applies the same redaction
// selectively (free-text fields only — see
// `redactSecretsInIntermediate`).

import { renderChangelogDeterministic } from './changelog/index.ts';
import { redactSecretsInIntermediate } from './format.ts';
import type { RenderOptions } from './format.ts';
import { renderHumanDeterministic } from './human/index.ts';
import { renderPrDeterministic } from './pr/index.ts';
import { renderSlackDeterministic } from './slack/index.ts';
import { renderTerseDeterministic } from './terse/index.ts';
import type { RecapIntermediate } from './types.ts';

export type { RenderOptions } from './format.ts';

export type RecapRenderer = 'human' | 'json' | 'pr' | 'changelog' | 'slack' | 'terse';

export const renderJson = (intermediate: RecapIntermediate): string => {
  // §6.2 — heuristic secret redaction is applied on the JSON
  // surface too, restricted to the well-known free-text fields
  // where leaked secrets actually land. Paths, IDs, numbers, and
  // enum-shaped strings stay intact so downstream tooling
  // (`jq '.actions.files_written'`) keeps working.
  return JSON.stringify(redactSecretsInIntermediate(intermediate), null, 2);
};

// Legacy entry point — slice (c-quick) split the human renderer
// into `src/recap/human/`, but `renderHuman(intermediate, options)`
// stays valid because the slash command, eval runner, and
// existing tests call it. New code should prefer
// `renderHumanDeterministic` (deterministic) or
// `renderHumanViaLlm` (LLM path) directly.
export const renderHuman = (intermediate: RecapIntermediate, options: RenderOptions = {}): string =>
  renderHumanDeterministic(intermediate, options);

export const renderRecap = (
  intermediate: RecapIntermediate,
  renderer: RecapRenderer,
  options: RenderOptions = {},
): string => {
  switch (renderer) {
    case 'json':
      return renderJson(intermediate);
    case 'human':
      return renderHuman(intermediate, options);
    case 'pr':
      return renderPrDeterministic(intermediate, options);
    case 'changelog':
      return renderChangelogDeterministic(intermediate, options);
    case 'slack':
      return renderSlackDeterministic(intermediate, options);
    case 'terse':
      return renderTerseDeterministic(intermediate, options);
  }
};
