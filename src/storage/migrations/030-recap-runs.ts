export const migration030RecapRuns = {
  id: 30,
  name: '030-recap-runs',
  // RECAP.md §6.3 — audit table for `/recap` invocations themselves.
  // Recap is a projection over the rest of the audit log; this row
  // captures the metadata of each projection so anomalies (a script
  // generating recaps in a tight loop, an unexpected cross-project
  // run, an automated consumer that skipped --no-llm-render and
  // started paying for renders) are detectable.
  //
  // Schema rationale:
  // - id (TEXT PK). Public id, returned in the headless `recap_end`
  //   event so external scripts can reference a specific projection
  //   in follow-up debugging.
  // - scope_kind. Mirrors the discriminator on `RecapIntermediate.scope.kind`
  //   (session_current | session_specific | day | range | pre_compact).
  //   CHECK constraint pins the vocabulary so an unknown value fails
  //   at SQLite write time rather than silently storing junk.
  // - session_ids (JSON array TEXT). Cardinality is 1 for
  //   session_current/session_specific/pre_compact, N for day/range.
  //   Stored as JSON to avoid a child table that would only hold
  //   PKs (the actual sessions are still in `sessions`; this is just
  //   the audit pointer to "which ones did this projection touch").
  // - renderer. Surface label (human | pr | changelog | slack | terse | json).
  //   Free-form TEXT — adding a new renderer later does not require a
  //   schema bump. Eval covers the closed set; an out-of-vocabulary
  //   value would surface as a noisy audit row, not a write failure.
  // - used_llm INTEGER 0/1. M4.1 ships only deterministic renderers,
  //   so this column starts as always 0 in practice; M4.2 wires the
  //   Haiku-based renderer and flips it to 1 for those calls. Pinning
  //   the column now means the M4.2 PR is a code change, not a
  //   migration.
  // - output_path. Set when --out <path> was passed; null for
  //   stdout-only renders. Audit consumers detecting "recap leaking
  //   to disk somewhere unexpected" key on this column.
  // - created_at INTEGER NOT NULL. Epoch ms.
  //
  // No FK on session_ids: the JSON array is forensic, not relational
  // (a recap that referenced a since-purged session is still a real
  // historical event we want to keep). The trade-off is that a JOIN
  // back to `sessions` requires `json_each(session_ids)` — acceptable
  // since this table is read by operators, not hot loops.
  //
  // Indexes:
  // - (created_at DESC) supports the dominant query "most recent
  //   recap runs" used by `/recap audit` and the anomaly detector.
  sql: `
    CREATE TABLE recap_runs (
      id            TEXT PRIMARY KEY,
      scope_kind    TEXT NOT NULL
                      CHECK (scope_kind IN
                        ('session_current','session_specific','day','range','pre_compact')),
      session_ids   TEXT NOT NULL,
      renderer      TEXT NOT NULL,
      used_llm      INTEGER NOT NULL DEFAULT 0
                      CHECK (used_llm IN (0, 1)),
      output_path   TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE INDEX idx_recap_runs_created ON recap_runs(created_at DESC);
  `,
} as const;
