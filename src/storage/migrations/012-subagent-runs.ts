export const migration012SubagentRuns = {
  id: 12,
  name: '012-subagent-runs',
  // M3 / Step 4.1 audit fix (option A in the discussion). Subagent
  // definitions live in `.md` files on disk; the harness loads them
  // at bootstrap and uses systemPrompt + tools to shape the child
  // run, but neither field is persisted into messages or sessions.
  // Result: if the author edits `~/.config/agent/agents/explore.md`
  // (or rotates the file out entirely) after a child has run,
  // there is NO way to reconstruct what definition the child was
  // executing under.
  //
  // This table closes that gap with one row per subagent spawn. We
  // capture the parsed fields the harness actually used (NOT the
  // raw .md, which would carry frontmatter+body weight) plus a
  // sha256 of the original file content for cross-run identity.
  // Any future "explain past behavior" forensic query has the
  // exact systemPrompt + toolset + budget the child ran under,
  // independent of what the .md file currently looks like.
  //
  // - session_id (PK) is also a FK back to sessions; ON DELETE
  //   CASCADE because the snapshot belongs to the child's audit
  //   trail. Deleting the child session deletes its snapshot.
  //   We deliberately do NOT cascade through parent_session_id —
  //   a parent purge that ON DELETE SET NULL's the child still
  //   keeps the child + its snapshot intact.
  // - tools_whitelist is a JSON array; storing as TEXT keeps the
  //   schema dumb and the consumers parse on read. Same shape as
  //   `messages.content` which also stores JSON in TEXT.
  // - budget_max_wall_ms is nullable to mirror the optional
  //   field in SubagentBudget; the loader rejects 0 / negative
  //   values, so any value present here is positive.
  //
  // Index on (name, captured_at DESC) supports two forensic
  // queries: "show me every run of `explore` in the last week"
  // (drift detection across definition edits) and "what was the
  // most recent run of subagent X" (regression triage).
  //
  // `captured_at` lags `sessions.started_at` by the run's wall-
  // clock duration — the snapshot lands AFTER `runAgent` returns,
  // not at session creation. Forensic queries that filter by
  // run-start time should join against `sessions.started_at`;
  // queries that filter by audit-trail time use this column.
  sql: `
    CREATE TABLE subagent_runs (
      session_id            TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      name                  TEXT NOT NULL,
      scope                 TEXT NOT NULL CHECK (scope IN ('user','project')),
      source_path           TEXT NOT NULL,
      source_sha256         TEXT NOT NULL,
      system_prompt         TEXT NOT NULL,
      tools_whitelist       TEXT NOT NULL,
      budget_max_steps      INTEGER NOT NULL,
      budget_max_cost_usd   REAL NOT NULL,
      budget_max_wall_ms    INTEGER,
      captured_at           INTEGER NOT NULL
    );

    CREATE INDEX idx_subagent_runs_name_captured
      ON subagent_runs(name, captured_at DESC);
  `,
} as const;
