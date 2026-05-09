export { projectTerseDeterministic } from './deterministic.ts';
export { renderTerseFromStructured } from './template.ts';
export {
  TERSE_LIMITS,
  TERSE_RENDER_V1_JSON_SCHEMA,
  TERSE_SCHEMA_VERSION,
  type TerseRenderV1,
  type TerseSchemaVersion,
  validateTerseRenderV1,
} from './schema.ts';

import type { RenderOptions } from '../format.ts';
import type { RecapIntermediate } from '../types.ts';
import { projectTerseDeterministic } from './deterministic.ts';
import { renderTerseFromStructured } from './template.ts';

export const renderTerseDeterministic = (
  intermediate: RecapIntermediate,
  options: RenderOptions = {},
): string => renderTerseFromStructured(projectTerseDeterministic(intermediate), options);
