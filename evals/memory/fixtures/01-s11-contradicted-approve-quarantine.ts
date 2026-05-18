import type { MemoryGovernanceFixture } from './types.ts';

// S11 verify-semantic end-to-end: the subagent reads a factual
// memory claiming X, observes ¬X in the repo, and emits a
// contradicted verdict with high confidence. The dispatcher records
// the attempt and lands a pending quarantine proposal through the
// S8 governance substrate. The operator approves via the same
// `applyProposal` entry point `/memory governance approve` uses.
// The apply path runs the five gates (confidence, staleness, kind,
// state-machine, hook), delegates to `transitionMemoryState`, which
// rewrites the memory's frontmatter from `active` to `quarantined`,
// emits an `eviction_events.outcome='applied'` row with
// `trigger='verify_failed'`, and a paired `memory_events.action='quarantined'`.
//
// This pins the longest cross-component path in the memory
// subsystem: dispatcher → governance repo → apply path → protection
// gates → state machine → file rewrite → audit pair.
export const fixture: MemoryGovernanceFixture = {
  name: '01-s11-contradicted-approve-quarantine',
  description:
    'S11 verify-semantic contradicted-high-conf → operator approve → memory quarantined with verify_failed trigger',
  detector: 'verify-semantic',
  setup: {
    memory: {
      scope: 'project_local',
      name: 'memory-layout-claim',
      description: 'memories live in .agent/memory/',
      type: 'project',
      source: 'user_explicit',
      body: 'Forja memories live under `.agent/memory/` in the repo root.',
    },
    // The verify-semantic dispatcher's F8 hallucination guard
    // refuses contradicted verdicts whose evidence_paths don't
    // exist on disk. Seed the file the verdict cites so the guard
    // accepts the verdict.
    repoFiles: {
      'src/x.ts': 'export const x = 1;\n',
    },
  },
  subagentOutput:
    'verdict: contradicted\n' +
    'confidence: 0.92\n' +
    'claim_extracted: "memories live in .agent/memory/"\n' +
    'ground_truth_observed: "actual layout differs per src/x.ts"\n' +
    'evidence_paths:\n' +
    '  - src/x.ts\n',
  operator: {
    decision: 'approve',
    reason: 'verified against current source layout',
  },
  expected: {
    attempts: 1,
    proposalsAfterDispatch: 1,
    proposalStatusAfterDispatch: 'pending',
    applyOutcome: 'applied',
    finalMemoryState: 'quarantined',
    eventActions: ['quarantined'],
    evictionOutcome: 'applied',
    evictionTrigger: 'verify_failed',
  },
};
