export { projectChangelogDeterministic } from './deterministic.ts';
export {
  CHANGELOG_CATEGORIES,
  CHANGELOG_LIMITS,
  CHANGELOG_RENDER_V1_JSON_SCHEMA,
  CHANGELOG_SCHEMA_VERSION,
  type ChangelogCategory,
  type ChangelogEntry,
  type ChangelogRenderV1,
  type ChangelogSchemaVersion,
  validateChangelogRenderV1,
} from './schema.ts';
export { renderChangelogFromStructured } from './template.ts';

import type { RenderOptions } from '../format.ts';
import type { RecapIntermediate } from '../types.ts';
import { projectChangelogDeterministic } from './deterministic.ts';
import { renderChangelogFromStructured } from './template.ts';

export const renderChangelogDeterministic = (
  intermediate: RecapIntermediate,
  options: RenderOptions = {},
): string => renderChangelogFromStructured(projectChangelogDeterministic(intermediate), options);
