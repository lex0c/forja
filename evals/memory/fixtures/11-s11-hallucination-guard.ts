import type { MemoryGovernanceFixture } from './types.ts';

// S11 hallucination guard (F8): a contradicted verdict cites
// `evidence_paths` that don't exist on disk. The dispatcher refuses
// the verdict as `malformed` BEFORE recording any attempt — this
// prevents a subagent that fabricates filenames from poisoning the
// dedup cache or queuing operator-facing proposals. Defense against
// LLM hallucination in the subagent's output, not against
// adversarial input.
//
// Crucially, no `repoFiles` are seeded — the cited evidence path
// does not exist.
export const fixture: MemoryGovernanceFixture = {
  name: '11-s11-hallucination-guard',
  description:
    'S11 contradicted verdict cites nonexistent evidence_paths → dispatcher refuses as malformed, no attempt, no proposal',
  detector: 'verify-semantic',
  setup: {
    memory: {
      scope: 'project_local',
      name: 'hallucinated-target',
      description: 'memory that a hallucinating subagent might attack',
      type: 'project',
      source: 'user_explicit',
      body: 'Some legitimate memory body.',
    },
  },
  subagentOutput:
    'verdict: contradicted\n' +
    'confidence: 0.92\n' +
    'claim_extracted: "legitimate"\n' +
    'ground_truth_observed: "fabricated rebuttal"\n' +
    'evidence_paths:\n' +
    '  - src/this-file-does-not-exist.ts\n',
  expected: {
    dispatcherOutcome: 'malformed',
    dispatcherReasonContains: 'src/this-file-does-not-exist.ts',
    attempts: 0,
    proposalsAfterDispatch: 0,
  },
};
