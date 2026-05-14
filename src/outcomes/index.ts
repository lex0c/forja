// Public surface of the outcome_signals subsystem (slice 131).
// Spec: PERMISSION_ENGINE.md §6.3.2 calibration plan.

export {
  COMPOSITE_HARMFUL_THRESHOLD,
  DEFAULT_SIGNAL_TTL_DAYS,
  DEFAULT_SIGNAL_WEIGHTS,
  isOutcomeSignalKind,
  OUTCOME_SIGNAL_KINDS,
  type OutcomeSignalKind,
} from './codes.ts';

export { scrubOutcomePayload } from './scrub.ts';

export {
  createNoopOutcomeSink,
  createSqliteOutcomeSink,
  type EmitOutcomeSignalInput,
  type EmittedOutcomeRow,
  type OutcomeSink,
  type OutcomeSignalRow,
} from './sink.ts';

export {
  computeOutcomeForApproval,
  computeOutcomesBatch,
  type OutcomeAggregate,
  type OutcomeLabel,
} from './aggregator.ts';

export {
  extractCalibrationTriples,
  summarizeCalibrationCoverage,
  type CalibrationCoverage,
  type CalibrationTriple,
  type ExtractCalibrationTriplesOptions,
} from './calibration.ts';

// Re-export read primitives so callers depending on the public
// barrel don't have to import from storage/repos directly.
export {
  countOutcomeSignals,
  countSignalsByKindGrouped,
  countSignalsByKindSince,
  listOutcomeSignalsByApproval,
  listOutcomeSignalsByInstall,
} from '../storage/repos/outcome-signals.ts';
