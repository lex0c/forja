export type {
  ConfirmCritiqueRequest,
  CritiqueAnswer,
  CritiqueConfig,
  CritiqueInput,
  CritiqueIssue,
  CritiqueMode,
  CritiqueOutput,
  CritiqueResult,
  CritiqueRunOptions,
  CritiqueSeverity,
  CritiqueStrategy,
  CritiqueToolPlanEntry,
} from './types.ts';
export { DEFAULT_CRITIQUE_CONFIG } from './types.ts';

export { runCritique } from './engine.ts';

export {
  buildCritiqueInput,
  buildCritiqueToolPlan,
  renderCritiqueHint,
  shouldCritique,
  toolPlanHasWrites,
} from './integration.ts';

export {
  loadCritiqueConfig,
  projectConfigPath,
  userConfigPath,
} from './config-loader.ts';
export type { LoadCritiqueConfigInput, LoadedCritiqueConfig } from './config-loader.ts';

export {
  CRITIQUE_MARKER_CLOSE,
  CRITIQUE_MARKER_OPEN,
  CRITIQUE_PROMPT_VERSION_V1,
  CRITIQUE_SYSTEM_PROMPT_V1,
  DEFAULT_CRITIQUE_PROMPT_VERSION,
  renderCritiqueUserMessage,
  stripPriorCritique,
} from './prompt.ts';
