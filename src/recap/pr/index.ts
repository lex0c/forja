// Public entry points for the `pr` renderer. The deterministic
// path (renderPrDeterministic) and the LLM path (renderPrViaLlm,
// added in the next slice) are kept in separate modules; this
// barrel re-exports both so callers don't need to know which one
// they got — the slash command just picks based on flags and the
// fallback contract.

export { projectPrDeterministic } from './deterministic.ts';
export {
  PR_LIMITS,
  PR_RENDER_V1_JSON_SCHEMA,
  PR_SCHEMA_VERSION,
  type PrChange,
  type PrRenderV1,
  type PrSchemaVersion,
  type PrTestPlanItem,
  type PrTestPlanStatus,
  validatePrRenderV1,
} from './schema.ts';
export { renderPrFromStructured } from './template.ts';

import type { RenderOptions } from '../format.ts';
import type { RecapIntermediate } from '../types.ts';
import { projectPrDeterministic } from './deterministic.ts';
import { renderPrFromStructured } from './template.ts';

// Convenience: deterministic projection + template in one call.
// The slash command's `--no-llm-render` path uses this directly;
// the LLM path uses the two pieces separately.
export const renderPrDeterministic = (
  intermediate: RecapIntermediate,
  options: RenderOptions = {},
): string => renderPrFromStructured(projectPrDeterministic(intermediate), options);
