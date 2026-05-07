export const migration024SubagentRunsToolRestrictions = {
  id: 24,
  name: '024-subagent-runs-tool-restrictions',
  // Per-playbook tool_restrictions (`PLAYBOOKS.md` §1.1). The
  // loader normalizes the YAML allow/deny shape (slice 1) into a
  // canonical `ToolRestrictions` map, and `runSubagent` snapshots
  // it into this column at spawn time. Subprocess children read
  // it back and apply pre-flight gates on their tool dispatch
  // (see `src/subagents/restrictions.ts`).
  //
  // Same drift-prevention story as `policy_snapshot` (015) and
  // `hooks_snapshot` (020): the parent loaded the .md, validated
  // the rule shape, and committed it; the child must run against
  // exactly that contract regardless of what the on-disk .md looks
  // like by the time the child boots. Live edits to playbook
  // files between parent spawn and child startup race otherwise.
  //
  // Storage as TEXT (JSON-serialized ToolRestrictions). NULL is
  // the absent state — distinct from `'{}'` (the playbook
  // declared an empty restrictions block, which the loader
  // could in principle produce for a deliberately-zeroed
  // override). NULL ⇒ no restrictions to apply, the wrap-around
  // factory becomes a passthrough. `'{}'` ⇒ rule map exists but
  // is empty, also passthrough — but distinguishable in audit
  // for "did the author MEAN this" questions. The runtime
  // collapses both to passthrough; the column distinction is
  // for the operator looking at `subagent_runs` rows.
  sql: `
    ALTER TABLE subagent_runs
      ADD COLUMN tool_restrictions TEXT;
  `,
} as const;
