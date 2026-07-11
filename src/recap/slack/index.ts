export { projectSlackDeterministic } from './deterministic.ts';
export {
  SLACK_LIMITS,
  SLACK_RENDER_V1_JSON_SCHEMA,
  SLACK_SCHEMA_VERSION,
  type SlackRenderV1,
  type SlackSchemaVersion,
  validateSlackRenderV1,
} from './schema.ts';
export { renderSlackFromStructured } from './template.ts';

import type { RenderOptions } from '../format.ts';
import type { RecapIntermediate } from '../types.ts';
import { projectSlackDeterministic } from './deterministic.ts';
import { renderSlackFromStructured } from './template.ts';

export const renderSlackDeterministic = (
  intermediate: RecapIntermediate,
  options: RenderOptions = {},
): string => renderSlackFromStructured(projectSlackDeterministic(intermediate), options);
