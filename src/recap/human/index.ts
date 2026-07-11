export { projectHumanDeterministic } from './deterministic.ts';
export {
  HUMAN_LIMITS,
  HUMAN_RENDER_V1_JSON_SCHEMA,
  HUMAN_SCHEMA_VERSION,
  type HumanRenderV1,
  type HumanSchemaVersion,
  validateHumanRenderV1,
} from './schema.ts';
export { renderHumanFromStructured } from './template.ts';

import type { RenderOptions } from '../format.ts';
import type { RecapIntermediate } from '../types.ts';
import { projectHumanDeterministic } from './deterministic.ts';
import { renderHumanFromStructured } from './template.ts';

export const renderHumanDeterministic = (
  intermediate: RecapIntermediate,
  options: RenderOptions = {},
): string =>
  renderHumanFromStructured(projectHumanDeterministic(intermediate), intermediate, options);
