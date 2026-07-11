// Public surface of the failure_events subsystem (slice 130).
// Spec: FAILURE_MODES.md §19, AUDIT.md §1, §4.2, §10.1.

export {
  BOOTSTRAP_SESSION_ID,
  CODE_VOCABULARY,
  FAILURE_CLASSES,
  type FailureClass,
  isFailureCode,
  isFailureCodeFormat,
  isRecoveryAction,
} from './codes.ts';

export { scrubFailurePayload, type ScrubResult } from './scrub.ts';

export {
  createNoopFailureSink,
  createSqliteFailureSink,
  type EmitFailureEventInput,
  type EmittedFailureRow,
  type FailureEventSink,
  type VerifyFailureChainResult,
} from './sink.ts';

// Read primitives re-exported from the repo for callers that need
// to query failure history directly (forensics bundle, /failures
// slash command future). Keeps the canonical name + shape behind
// the public boundary.
export {
  countFailuresByCodeSince,
  countFailureEvents,
  type FailureEventRow,
  listFailureEventsByCode,
  listFailureEventsBySession,
} from '../storage/repos/failure-events.ts';
