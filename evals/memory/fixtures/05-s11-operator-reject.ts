import type { MemoryGovernanceFixture } from './types.ts';

// S11 happy path through dispatcher (contradicted-high-conf →
// proposal pending), then operator REJECTS via `decideProposal`.
// Mirror of fixture 01 except the operator decision flips the
// proposal to `rejected` without touching the memory's state. Pins
// the operator-veto path: the model proposed but the operator
// disagreed, the memory continues to live and the proposal stays
// auditable.
export const fixture: MemoryGovernanceFixture = {
  name: '05-s11-operator-reject',
  description:
    'S11 contradicted-high-conf → operator reject → proposal status=rejected, memory stays active',
  detector: 'verify-semantic',
  setup: {
    memory: {
      scope: 'project_local',
      name: 'contested-claim',
      description: 'a claim the operator stands by',
      type: 'project',
      source: 'user_explicit',
      body: 'Operator trusts this memory even when the detector disagrees.',
    },
    repoFiles: {
      'src/contested.ts': 'export const c = 0;\n',
    },
  },
  subagentOutput:
    'verdict: contradicted\n' +
    'confidence: 0.85\n' +
    'claim_extracted: "operator stands by"\n' +
    'ground_truth_observed: "detector saw something else"\n' +
    'evidence_paths:\n' +
    '  - src/contested.ts\n',
  operator: {
    decision: 'reject',
    reason: 'operator validated the memory against current source manually',
  },
  expected: {
    attempts: 1,
    proposalsAfterDispatch: 1,
    proposalStatusAfterDispatch: 'pending',
    // After reject: no state transition, memory stays where it was.
    finalMemoryState: 'active',
    // No `memory_events.action` for the memory (no read / no
    // transition); no `eviction_events` (no state transition).
    eventActions: [],
  },
};
