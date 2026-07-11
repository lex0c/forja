import type { MemoryGovernanceFixture } from './types.ts';

// S11 contradicted verdict BELOW the 0.7 confidence floor. The
// dispatcher still records the attempt + lands the proposal so the
// forensic surface is complete (`/memory governance list --status
// rejected` surfaces low-confidence verdicts), but the proposal
// auto-rejects with `decided_by: system:low_confidence` before any
// operator ever sees it. No operator action; final memory state
// stays `active`. Pins the auto-archive path that prevents the
// operator queue from filling with sub-threshold noise.
export const fixture: MemoryGovernanceFixture = {
  name: '02-s11-contradicted-low-conf-auto-reject',
  description:
    'S11 contradicted-low-conf (0.5) → attempt + proposal auto-rejected with system:low_confidence',
  detector: 'verify-semantic',
  setup: {
    memory: {
      scope: 'project_local',
      name: 'noisy-claim',
      description: 'a noisy unverified claim',
      type: 'project',
      source: 'user_explicit',
      body: 'Some shaky claim about the build setup.',
    },
    repoFiles: {
      'src/build.ts': 'export const build = () => 0;\n',
    },
  },
  subagentOutput:
    'verdict: contradicted\n' +
    'confidence: 0.5\n' +
    'claim_extracted: "build setup detail"\n' +
    'ground_truth_observed: "different in src/build.ts"\n' +
    'evidence_paths:\n' +
    '  - src/build.ts\n',
  expected: {
    attempts: 1,
    proposalsAfterDispatch: 1,
    // The proposal lands but flips to rejected synchronously within
    // the dispatcher's transaction — by the time we list, status is
    // already `rejected`.
    proposalStatusAfterDispatch: 'rejected',
  },
};
