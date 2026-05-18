import type { MemoryGovernanceFixture } from './types.ts';

// S11 happy path through dispatcher → operator DEFERS via
// `deferProposal` with 14 additional days. The proposal stays
// pending but gains a `deferred_until` extension capped by the 90d
// horizon (migration 062). Memory state unchanged. Pins the "I'll
// decide later, don't expire this on me" operator path that keeps
// proposals out of the 30d TTL sweep without forcing a binary
// approve/reject choice.
export const fixture: MemoryGovernanceFixture = {
  name: '06-s11-operator-defer',
  description:
    'S11 contradicted-high-conf → operator defer 14d → proposal pending with deferred_until extended',
  detector: 'verify-semantic',
  setup: {
    memory: {
      scope: 'project_local',
      name: 'deferred-review-claim',
      description: 'claim that needs more time to investigate',
      type: 'project',
      source: 'user_explicit',
      body: 'Operator wants to investigate before committing to a verdict.',
    },
    repoFiles: {
      'src/deferred.ts': 'export const d = 0;\n',
    },
  },
  subagentOutput:
    'verdict: contradicted\n' +
    'confidence: 0.85\n' +
    'claim_extracted: "investigation pending"\n' +
    'ground_truth_observed: "needs more eyes"\n' +
    'evidence_paths:\n' +
    '  - src/deferred.ts\n',
  operator: {
    decision: 'defer',
    deferDays: 14,
  },
  expected: {
    attempts: 1,
    proposalsAfterDispatch: 1,
    // Defer doesn't change `status`; it only extends `deferred_until`.
    proposalStatusAfterDispatch: 'pending',
    finalMemoryState: 'active',
    eventActions: [],
  },
};
