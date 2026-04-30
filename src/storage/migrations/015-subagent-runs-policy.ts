export const migration015SubagentRunsPolicy = {
  id: 15,
  name: '015-subagent-runs-policy',
  // M3 / Step 4.2b.ii.a follow-up — policy drift defense.
  //
  // The 4.2b.ii.a subprocess flow had the child re-resolve
  // `.agent/permissions.yaml` (+ enterprise + user layers) at
  // its own startup. If a human edited any of those files
  // between parent spawn and child startup (race window: ~ms
  // to seconds), the child ran under different policy than the
  // parent had validated and intended. Worst case: a tool the
  // parent confirmed was allowed surfaces as denied (or vice
  // versa) inside the same logical run.
  //
  // Fix: snapshot the parent's resolved Policy at spawn time
  // onto this column; the child reads + builds its engine
  // directly from the snapshot, never touching disk policy
  // files. The drift window collapses to "parent's own
  // validation, then sealed."
  //
  // Storage as TEXT (JSON-serialized) under the same convention
  // `tools_whitelist` already uses on this table — schema stays
  // dumb, the parent serializes on insert, the child parses on
  // read.
  //
  // NOT NULL with empty-object default '{}'. Pre-migration
  // rows (any subagent_runs from before this migration runs)
  // would otherwise be inaccessible to the new child path
  // because parsing '' would yield null. The default lets the
  // child fall through to `defaults.mode='strict'` semantics,
  // which is the safest possible interpretation of "missing
  // policy snapshot" — strict denies everything by default,
  // so a child running on an old row sees a tightly locked
  // surface rather than an unrestricted one.
  sql: `
    ALTER TABLE subagent_runs
      ADD COLUMN policy_snapshot TEXT NOT NULL DEFAULT '{}';
  `,
} as const;
