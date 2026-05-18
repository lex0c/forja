import type { MemoryScope, MemoryState } from '../../../src/memory/types.ts';

// Per-fixture shape consumed by `tests/memory/eval-fixtures.test.ts`.
//
// The fixture pre-renders the subagent's verdict output so the
// dispatcher sees deterministic input regardless of network / model
// availability. The runner stubs `spawnSubagentFn` to yield this
// string verbatim, then drives the rest of the pipeline (dispatcher
// → proposal → operator decision → state machine → audit pair) and
// asserts the resulting DB + filesystem state matches `expected`.

export type DetectorKind = 'verify-semantic' | 'verify-conflict' | 'verify-override';

export type MemoryType = 'project' | 'reference' | 'feedback' | 'user';
export type MemorySource = 'user_explicit' | 'inferred' | 'imported';

// One memory the fixture seeds onto disk + into the registry before
// the dispatcher runs.
export interface FixtureMemory {
  scope: MemoryScope;
  name: string;
  description: string;
  type: MemoryType;
  source: MemorySource;
  state?: MemoryState;
  body: string;
}

export interface MemoryFixtureSetup {
  // The memory the detector targets. For verify-conflict fixtures,
  // this is one of the pair; the other lives in `pairWith`.
  memory: FixtureMemory;
  // Pair memory for verify-conflict fixtures only.
  pairWith?: FixtureMemory;
  // For verify-override fixtures: how many override-events to seed
  // pointing at `memory` so the S3 threshold gate trips.
  overrideEventCount?: number;
  // Repo files seeded under the eval workdir before the dispatcher
  // runs. Used to satisfy the verify-semantic hallucination guard
  // (every `evidence_paths` entry the subagent output cites must
  // exist on disk) and to let verify-semantic-style fixtures match
  // a realistic ground-truth observation. Keys are relative paths
  // under cwd; values are the file body.
  repoFiles?: Record<string, string>;
}

export type OperatorDecision = 'approve' | 'reject' | 'defer';

export interface OperatorAction {
  decision: OperatorDecision;
  // Optional reason surfaced on the governance row + audit.
  reason?: string;
  // Defer extends `deferred_until` by N days from `created_at`.
  // Required when decision === 'defer'.
  deferDays?: number;
}

// Possible dispatcher outcomes the runner branches on. Defaults to
// 'completed' when omitted — the happy-path verdict produced a
// proposal (or attempt-only when the verdict says so).
export type DispatcherOutcome = 'completed' | 'skipped' | 'malformed' | 'spawn_failed';

// Assertions evaluated post-pipeline. Missing fields are not
// asserted — keep the fixture's intent narrow.
export interface MemoryFixtureExpected {
  // Dispatcher phase.
  dispatcherOutcome?: DispatcherOutcome;
  // When dispatcherOutcome !== 'completed', substring the
  // outcome.reason must contain. Helpful for pinning the EXACT path
  // the dispatcher refused on (`stale_snapshot` vs `dedup_hit` vs
  // `injection_detected`).
  dispatcherReasonContains?: string;
  attempts: number;
  proposalsAfterDispatch: number;
  proposalStatusAfterDispatch?: 'pending' | 'rejected' | 'expired' | 'applied';
  // Operator-decision phase (only checked when `operator` is set).
  applyOutcome?: 'applied' | 'rejected' | 'not_found' | 'already_decided';
  // After the decision: final state on the targeted memory's
  // frontmatter on disk + reflected in registry peek.
  finalMemoryState?: MemoryState;
  // Ordered list of `memory_events.action` rows attributable to
  // this fixture's run. Use this to pin audit-row presence (e.g.,
  // `['quarantined']` after a verify_failed approve).
  eventActions?: readonly string[];
  // The eviction_events outcome string expected after the decision
  // (only meaningful when the decision triggered a state transition).
  evictionOutcome?: 'applied' | 'blocked_by_protection' | 'blocked_by_hook';
  // The eviction_events trigger string that must match for the
  // detector's narrative to be true (`verify_failed` / `conflict_detected`
  // / `user_override_repeated`).
  evictionTrigger?: string;
}

export interface MemoryGovernanceFixture {
  // Stable identifier — must match the file basename so the runner's
  // per-fixture diagnostics carry the right name.
  name: string;
  description: string;
  detector: DetectorKind;
  setup: MemoryFixtureSetup;
  // Verbatim subagent output — the YAML body of the subagent's
  // structured response (no markers; the dispatcher parses the raw
  // body). Captured at fixture-write time and frozen.
  subagentOutput: string;
  // Optional operator action after the dispatcher persists. Omit
  // for fixtures that only pin dispatch behavior.
  operator?: OperatorAction;
  expected: MemoryFixtureExpected;
}
