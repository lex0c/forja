export const migration014SubagentOutputs = {
  id: 14,
  name: '014-subagent-outputs',
  // IPC schema. Subagent execution runs in a separate Bun
  // subprocess (spec AGENTIC_CLI §11:1030 — "mesmo binário,
  // processo separado, comunicação via SQLite (write-only do
  // filho, read-only do pai)"). The child writes its structured
  // output and a periodic heartbeat into this table; the parent
  // reads. No bidirectional channel — the only inputs the child
  // needs are the definition (loaded from disk) and the user
  // prompt (passed via the session row).
  //
  // Schema rationale:
  // - session_id (PK + FK CASCADE). 1:1 with sessions — each
  //   subprocess subagent has exactly one outputs row, the row
  //   never outlives the session row. PK = session_id is the
  //   simplest contract; an auto-increment id would be one more
  //   join with no payoff. Mirrors the shape `subagent_runs` and
  //   `subagent_worktrees` already use.
  // - payload (TEXT, nullable). JSON-serialized result envelope
  //   the child publishes when it finishes (status, reason, cost,
  //   final output text, audit fields). Stored as TEXT under the
  //   same convention `messages.content` and
  //   `subagent_runs.tools_whitelist` use — keeps the schema dumb
  //   and the consumers parse on read. NULL while the child is
  //   still running (no terminal output yet); becomes non-NULL on
  //   the child's last write before exit.
  // - last_heartbeat (INTEGER, nullable, epoch ms). The child
  //   writes this every ~1s while active; the parent polls and
  //   declares `subagent.timeout` per FAILURE_MODES §7.3 when
  //   the gap exceeds the wall-clock budget. NULL means the child
  //   has never published a heartbeat (the row was created but
  //   the subprocess hasn't started yet, or the spawn failed).
  // - created_at / updated_at (INTEGER, epoch ms). Audit stamps —
  //   created_at on INSERT, updated_at on every UPDATE. The
  //   delta between them tells operators how long a subagent ran
  //   for; pairing updated_at with last_heartbeat distinguishes
  //   "live but quiet" (still running, hasn't bumped heartbeat
  //   recently) from "actually crashed" (no UPDATE in a long time).
  //
  // We deliberately do NOT add a `status` column. Subagent
  // lifecycle status already lives on `sessions.status` (active /
  // done / failed) — duplicating it here invites the two columns
  // to drift. Forensic queries that want "still running" join
  // sessions on session_id and filter sessions.status.
  //
  // Index on (last_heartbeat ASC) WHERE NOT NULL: the parent's
  // timeout poller wants "rows with the oldest heartbeat" to
  // surface stuck children quickly; the partial form skips the
  // never-heartbeated rows (which are either pre-spawn or
  // spawn-failed and don't need timeout treatment).
  //
  // No index on `updated_at` today. If a future query shape
  // like "every row updated more than X ago" appears — e.g., a
  // janitor that prunes stale outputs whose owning sessions
  // already finished — add a partial index in a follow-up
  // migration. The column is on the row by
  // design so future audit queries can use it; only the index
  // is deferred to "first real query".
  //
  // CASCADE on session_id mirrors subagent_runs/worktrees:
  // deleting the child session drops the outputs row. Parent
  // purge that ON DELETE SET NULL's `parent_session_id` keeps
  // the child + its outputs intact.
  sql: `
    CREATE TABLE subagent_outputs (
      session_id      TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      payload         TEXT,
      last_heartbeat  INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    CREATE INDEX idx_subagent_outputs_heartbeat
      ON subagent_outputs(last_heartbeat ASC)
      WHERE last_heartbeat IS NOT NULL;
  `,
} as const;
