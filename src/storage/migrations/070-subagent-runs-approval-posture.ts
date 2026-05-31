// subagent_runs gains `approval_posture` so a spawned subagent inherits
// the parent's Supervised/Autonomous approval posture at spawn time
// (operation-mode feature). The posture lives on the permission engine
// as an EngineOption — it is NOT part of the resolved Policy — so it
// cannot ride `policy_snapshot`; it needs its own snapshot column,
// mirroring the policy / hooks / tool-restrictions drift-prevention
// pattern (the child reads it from this row at startup instead of
// re-deriving it). NULL on legacy rows and on any spawn that predates
// this column; the read path maps NULL → 'supervised' (fail-closed).
//
// A plain ADD COLUMN suffices — no CHECK change on an existing column —
// so unlike migration 058 this needs no table rebuild. The new column's
// CHECK admits NULL (legacy) plus the two posture literals.
export const migration070SubagentRunsApprovalPosture = {
  id: 70,
  name: '070-subagent-runs-approval-posture',
  sql: `
    ALTER TABLE subagent_runs ADD COLUMN approval_posture TEXT
      CHECK (approval_posture IN ('supervised', 'autonomous'));
  `,
} as const;
