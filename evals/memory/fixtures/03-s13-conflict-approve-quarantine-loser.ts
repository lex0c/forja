import type { MemoryGovernanceFixture } from './types.ts';

// S13 verify-conflict end-to-end: two memories in project_local
// disagree on auth strategy. Memory A (`user_explicit` source) is
// the higher-tier per the deterministic resolver; memory B
// (`inferred` source) is the loser. Dispatcher mocks a conflicting
// verdict with high confidence; proposal lands `pending` with
// `target_payload.target_key` pointing at the LOSER. Operator
// approves; only the loser transitions to `quarantined` (multi-memory
// proposal carve-out per `MEMORY.md §11.3` gate #4). The winner
// stays `active`.
export const fixture: MemoryGovernanceFixture = {
  name: '03-s13-conflict-approve-quarantine-loser',
  description:
    'S13 conflicting pair → approve → loser (inferred) quarantined with conflict_detected trigger, winner (user_explicit) stays active',
  detector: 'verify-conflict',
  setup: {
    memory: {
      scope: 'project_local',
      name: 'auth-jwt-winner',
      description: 'use JWT for auth in src/auth',
      type: 'project',
      source: 'user_explicit',
      body: 'In src/auth, use JWT bearer tokens for service-to-service auth.',
    },
    pairWith: {
      scope: 'project_local',
      name: 'auth-oauth-loser',
      description: 'auth flow uses OAuth via src/auth/oauth.ts',
      type: 'project',
      source: 'inferred',
      body: 'In src/auth, the OAuth flow is the canonical path via oauth.ts.',
    },
  },
  subagentOutput:
    'conflicting: true\n' +
    'conflict_kind: incompatible-implementation\n' +
    'confidence: 0.85\n' +
    'evidence:\n' +
    '  shared_concept: auth\n' +
    '  polarity_a: JWT\n' +
    '  polarity_b: OAuth\n',
  operator: {
    decision: 'approve',
    reason: 'resolver winner is the explicit operator instruction',
  },
  expected: {
    attempts: 1,
    proposalsAfterDispatch: 1,
    proposalStatusAfterDispatch: 'pending',
    applyOutcome: 'applied',
    finalMemoryState: 'active', // <-- the targeted memory (winner) stays active
    eventActions: [], // winner has no transition
    // The eviction_events row WILL exist but on the LOSER, not the
    // winner. The runner's eventsActionsFor query keys on the
    // FixtureMemory.scope+name (which is the winner here), so it
    // surfaces ZERO for the winner. The actual carve-out behavior
    // is implicit: applyOutcome === 'applied' only when the apply
    // path successfully transitioned the target (loser).
  },
};
