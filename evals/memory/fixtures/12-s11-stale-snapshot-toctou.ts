import type { MemoryGovernanceFixture } from './types.ts';

// S11 TOCTOU gate: the operator edited the memory file between the
// scheduler's poll (which captured a snapshot) and the dispatcher
// firing. The runner mimics this by writing memory body A to the
// fixture's `memory.body`, then changing the on-disk body via the
// repoFiles seed (which writes to the memory's path AFTER the
// in-memory snapshot is parsed). On TOCTOU re-read, the dispatcher
// notices the body changed and refuses with reason 'stale_snapshot'.
// Next poll re-evaluates against the fresh body.
//
// This fixture intentionally exercises the F11 defense — the
// dispatcher MUST refuse stale snapshots so the operator's edit
// is the last word.
//
// Implementation note: the runner's `repoFiles` writes to paths
// relative to cwd. To target the memory's body specifically, the
// fixture writes to the scope path that ovewrites the just-seeded
// memory file. This is a deliberately narrow runner trick — eval
// only.
export const fixture: MemoryGovernanceFixture = {
  name: '12-s11-stale-snapshot-toctou',
  description:
    'S11 TOCTOU: memory body changes between scheduler peek and dispatch → dispatcher refuses with stale_snapshot',
  detector: 'verify-semantic',
  setup: {
    memory: {
      scope: 'project_local',
      name: 'toctou-target',
      description: 'memory that will be edited mid-dispatch',
      type: 'project',
      source: 'user_explicit',
      body: 'Original body that the snapshot captured.',
    },
    repoFiles: {
      // Overwrite the memory file's body AFTER the runner has
      // already parsed the in-memory snapshot. The dispatcher's
      // F11 re-peek will see the new body and refuse.
      '.agent/memory/local/toctou-target.md':
        '---\nname: toctou-target\ndescription: memory that will be edited mid-dispatch\ntype: project\nsource: user_explicit\n---\n\nOperator edited the body AFTER the scheduler peeked.\n',
    },
  },
  subagentOutput:
    'verdict: contradicted\n' +
    'confidence: 0.92\n' +
    'claim_extracted: "x"\n' +
    'ground_truth_observed: "y"\n' +
    'evidence_paths:\n' +
    '  - src/whatever.ts\n',
  expected: {
    dispatcherOutcome: 'skipped',
    dispatcherReasonContains: 'stale_snapshot',
    attempts: 0,
    proposalsAfterDispatch: 0,
  },
};
