export const migration013SubagentWorktrees = {
  id: 13,
  name: '013-subagent-worktrees',
  // M3 / Step 4.2a — worktree audit trail. When a subagent declares
  // `isolation: worktree` (spec §11.2) the harness creates a git
  // worktree for the child run before invoking the loop. Without
  // persistence, a parent process crash (or even a clean exit) leaves
  // the operator with a worktree on disk and no record of which
  // session owned it — `agent worktree gc` (Step 4.2d) needs the
  // audit row to know what is safe to remove and what is still
  // attached to a live or paused session.
  //
  // One row per worktree-isolated subagent run. The session_id
  // is the natural primary key (each session gets at most one
  // worktree; the worktree never outlives the session row).
  //
  // - session_id (PK + FK CASCADE) — deleting the session row
  //   drops its worktree audit. Mirrors `subagent_runs` from
  //   migration 012.
  // - path / branch — what the harness actually created on disk;
  //   the operator command resolves them later.
  // - status CHECK active/preserved/cleaned: 'active' on insert
  //   (worktree exists, child still running), 'cleaned' once the
  //   post-run cleanup removed it (clean tree → branch deleted),
  //   'preserved' when the child wrote and the worktree was left
  //   on disk for the parent to inspect.
  // - created_at / cleaned_at — timestamps (epoch ms). cleaned_at
  //   stays NULL while status='active'; gets stamped on the
  //   transition to 'cleaned' or 'preserved'.
  //
  // Index on `status` so the GC sweep (4.2d) can find every
  // 'active' row that has no live process attached, without
  // scanning the whole table.
  sql: `
    CREATE TABLE subagent_worktrees (
      session_id   TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      path         TEXT NOT NULL,
      branch       TEXT NOT NULL,
      status       TEXT NOT NULL CHECK (status IN ('active','preserved','cleaned')),
      created_at   INTEGER NOT NULL,
      cleaned_at   INTEGER
    );

    CREATE INDEX idx_subagent_worktrees_status
      ON subagent_worktrees(status);
  `,
} as const;
