import type { MemoryGovernanceFixture } from './types.ts';

// S3 verify-override end-to-end: the operator rejected three modal
// proposals tied to the same memory in the last 24h, tripping the
// deterministic threshold (`countOverridesInWindow >= 3`). The
// dispatcher mocks a `misguiding: true` verdict with high confidence
// and a `suggested_motivo: conflict`. Proposal lands `pending`;
// operator approves; memory transitions `active → quarantined` with
// trigger `user_override_repeated` and motivo from the subagent's
// suggestion.
export const fixture: MemoryGovernanceFixture = {
  name: '04-s3-override-approve-quarantine',
  description:
    'S3 override threshold tripped + misguiding verdict → approve → memory quarantined with user_override_repeated trigger',
  detector: 'verify-override',
  setup: {
    memory: {
      scope: 'project_local',
      name: 'misguiding-rule',
      description: 'rule the operator keeps rejecting in practice',
      type: 'project',
      source: 'user_explicit',
      body: 'When committing, always use --no-verify to skip pre-commit hooks.',
    },
    // Seed 3 modal-reject events so the threshold gate (3 in 24h)
    // trips before the dispatcher runs.
    overrideEventCount: 3,
  },
  subagentOutput:
    'misguiding: true\n' +
    'confidence: 0.85\n' +
    'rule_extracted: "skip pre-commit hooks via --no-verify"\n' +
    'override_pattern_observed: "operator rejected 3 inferred saves citing this rule"\n' +
    'suggested_motivo: conflict\n',
  operator: {
    decision: 'approve',
    reason: 'operator confirms the rule is misguiding their workflow',
  },
  expected: {
    attempts: 1,
    proposalsAfterDispatch: 1,
    proposalStatusAfterDispatch: 'pending',
    applyOutcome: 'applied',
    finalMemoryState: 'quarantined',
    eventActions: ['quarantined'],
    evictionOutcome: 'applied',
    evictionTrigger: 'user_override_repeated',
  },
};
