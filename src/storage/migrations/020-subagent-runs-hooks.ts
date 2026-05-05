export const migration020SubagentRunsHooks = {
  id: 20,
  name: '020-subagent-runs-hooks',
  // Mirror of migration 015 (policy_snapshot) for the hooks
  // subsystem. Closes the same drift window: subprocess subagents
  // re-resolved their hook chain from disk at startup, so a human
  // edit to `hooks.toml` between parent spawn and child startup
  // (race window: ms to seconds, longer if child has slow init)
  // could land the child running under a different chain than the
  // parent had validated. Worst cases:
  //
  //   - Operator removes a `locked: true` enterprise PreToolUse
  //     hook AFTER the parent locked it in but BEFORE the child
  //     re-resolves. Child runs without the protection the
  //     parent thought was in place.
  //   - Operator adds a new failClosed hook that the parent
  //     never saw. Child blocks on a tool the parent freely
  //     used in the same logical run — diverging audit shape.
  //
  // Fix: snapshot the parent's resolved hook chain into
  // `subagent_runs.hooks_snapshot` at spawn time. Child reads
  // from the snapshot in the SAME way it already reads
  // `policy_snapshot`. Disk re-resolve becomes the legacy
  // fallback (older rows or programmatic callers that omitted
  // the snapshot) — and on that path the runtime emits a
  // stderr warning so the operator knows the snapshot path
  // didn't engage.
  //
  // Storage as TEXT (JSON-serialized HookSpec[]). Same
  // convention `tools_whitelist` / `policy_snapshot` use.
  // NOT NULL with empty-array default '[]' so pre-migration
  // rows parse to "no hooks" rather than crashing the audit
  // listing — child falls through to disk re-resolve in that
  // case, preserving the behavior callers had before this
  // migration.
  sql: `
    ALTER TABLE subagent_runs
      ADD COLUMN hooks_snapshot TEXT NOT NULL DEFAULT '[]';
  `,
} as const;
