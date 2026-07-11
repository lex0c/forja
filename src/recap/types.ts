// Schema for the recap projection (RECAP.md §3). The intermediate is
// what the projection function emits and what every renderer (human,
// json, pr, changelog, slack, terse) consumes.
//
// All fields are ALWAYS PRESENT — empty arrays / empty strings are the
// honest representation of "no rows found". An absent field would
// violate the schema contract that audit consumers depend on (§3
// closing line: "Ausência viola schema").
//
// `schema_version` is bumped when the shape changes. Renderers and
// downstream consumers (auto-rehydrate per RECAP.md §3.2, headless
// JSON output per §9) pin against this so a producer/consumer
// version skew surfaces explicitly instead of silently drifting.

export const RECAP_SCHEMA_VERSION = 'v1' as const;

export type RecapScopeKind =
  | 'session_current'
  | 'session_specific'
  | 'day'
  | 'range'
  | 'pre_compact';

export interface RecapScope {
  kind: RecapScopeKind;
  sessionIds: string[];
  // Set when scope is day / range. For other kinds, both bounds are
  // 0 (the projection does not invent timestamps for single-session
  // scopes, but the field is always present to keep the shape
  // schema-bound).
  range: { start: number; end: number };
}

export interface RecapCompleteness {
  // True iff at least one session in scope is in a non-terminal
  // state at projection time (status ∈ {running}). Renderer surfaces
  // this prominently (§4.1) so the operator does not act on partial
  // data.
  incomplete: boolean;
  incompleteSessions: string[];
  incompleteReason: string;
}

export interface RecapGoal {
  text: string;
  // Step (`messages.id`) the goal text was extracted from. Empty
  // string when the projection had no source — e.g., a pre_compact
  // recap of a session that never received a user turn yet.
  sourceStepId: string;
}

// Mirrors the SQL canonical from STATE_MACHINE.md §2.3.1. The
// `goal_stack` table does not exist yet (M3+ work); the projection
// emits `[]` for now and will populate this once the table lands.
// Schema is fixed today so consumers can pin against it.
export interface RecapGoalStackEntry {
  text: string;
  status: 'active' | 'suspended' | 'done' | 'abandoned';
  pushedBy: string;
  decidedBy: string;
  popReason: string;
  durationMs: number;
  parentIdx: number;
}

// Mirrors the SQL canonical from CONTEXT_TUNING.md §12.4.2. The
// `context_pins` table does not exist yet; emitted as `[]` until it
// lands.
export interface RecapPinnedContext {
  kind: 'constraint' | 'workflow' | 'invariant' | 'reminder';
  text: string;
  createdBy: string;
}

export interface RecapDecision {
  stepId: string;
  what: string;
  why: string;
  decidedBy: 'user' | 'policy' | 'hook';
}

export interface RecapFileRead {
  path: string;
  count: number;
}

export interface RecapFileWrite {
  path: string;
  linesAdded: number;
  linesRemoved: number;
  // 1-line summary of the diff. Deterministic projection emits an
  // empty string here; M4.2's LLM renderer fills it via Haiku under
  // schema enforcement.
  semanticSummary: string;
}

export interface RecapCommandRun {
  command: string;
  exitCode: number;
  durationMs: number;
}

export interface RecapWebFetch {
  url: string;
  cached: boolean;
}

export interface RecapSubagentSpawn {
  name: string;
  status: string;
  outputSummary: string;
}

export interface RecapActions {
  filesRead: RecapFileRead[];
  filesWritten: RecapFileWrite[];
  commandsRun: RecapCommandRun[];
  webFetches: RecapWebFetch[];
  subagentsSpawned: RecapSubagentSpawn[];
}

export interface RecapTestRun {
  command: string;
  passed: boolean;
  durationMs: number;
}

export interface RecapCheckpointRef {
  id: string;
  stepId: string;
  filesAffected: number;
}

export interface RecapArtifact {
  kind: string;
  pathOrRef: string;
}

export interface RecapOutcomes {
  testsRun: RecapTestRun[];
  checkpoints: RecapCheckpointRef[];
  artifacts: RecapArtifact[];
}

export interface RecapTimelineEvent {
  ts: number;
  event: string;
  detail: string;
}

export interface RecapCosts {
  tokens: { in: number; out: number; cached: number };
  usd: number;
  durationMs: number;
  // Empty string when the scope spans multiple sessions on different
  // models (day / range). A projection over a single session always
  // has a model.
  model: string;
  cacheHitRatio: number;
}

export interface RecapError {
  code: string;
  recovered: boolean;
  summary: string;
}

export interface RecapNotDone {
  what: string;
  reason: string;
}

export interface RecapMemoryProposed {
  name: string;
  scope: string;
  accepted: boolean;
}

export interface RecapIntermediate {
  schemaVersion: typeof RECAP_SCHEMA_VERSION;
  generatedAt: number;
  scope: RecapScope;
  completeness: RecapCompleteness;
  goal: RecapGoal;
  goalStack: RecapGoalStackEntry[];
  decisions: RecapDecision[];
  pinnedContext: RecapPinnedContext[];
  actions: RecapActions;
  outcomes: RecapOutcomes;
  timeline: RecapTimelineEvent[];
  costs: RecapCosts;
  errors: RecapError[];
  notDone: RecapNotDone[];
  unresolvedQuestions: string[];
  memoryProposed: RecapMemoryProposed[];
}
