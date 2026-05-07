export const migration025SubagentRunsSampling = {
  id: 25,
  name: '025-subagent-runs-sampling',
  // Per-playbook sampling override (`PLAYBOOKS.md` §1.1). The
  // loader normalizes the YAML `sampling` block into a typed
  // `SamplingOverride` (slice 1); `runSubagent` snapshots it into
  // this column at spawn so the subprocess child applies the same
  // values the parent validated.
  //
  // Same drift-prevention story as `policy_snapshot` (015),
  // `hooks_snapshot` (020), and `tool_restrictions` (024): the
  // parent committed the values at spawn, the child runs against
  // exactly that contract. A live edit to the .md between spawn
  // and child startup cannot relax / tighten the model's
  // generation parameters mid-run.
  //
  // Storage as TEXT (JSON-serialized SamplingOverride). NULL =
  // no snapshot taken (legacy row, definition without `sampling`
  // block) — child uses provider defaults. `'{}'` = snapshot
  // exists but no overrides — same runtime effect as NULL but
  // distinguishable in audit. Non-empty object = field-by-field
  // override map.
  sql: `
    ALTER TABLE subagent_runs
      ADD COLUMN sampling TEXT;
  `,
} as const;
