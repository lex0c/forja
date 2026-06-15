export const migration017SessionsAbortCause = {
  id: 17,
  name: '017-sessions-abort-cause',
  // Persist the abort discriminator.
  //
  // The harness already produces `HarnessResult.abortCause` ('soft' /
  // 'hard') when `reason === 'aborted'`, but that field died at the
  // process boundary — `completeSession` never wrote it. Audit /
  // telemetry / replay queries (`forja --session <id>`) couldn't
  // distinguish "operator nudged once" from "operator escalated".
  // This column closes the gap.
  //
  // Schema rationale:
  //
  // - abort_cause (TEXT, nullable, CHECK). Two values that match
  //   the in-memory discriminator: 'soft' and 'hard'. NULL for
  //   sessions that ended via any other path (done, maxSteps,
  //   maxCostUsd, error, etc.) — the value is meaningless when the
  //   session didn't exit through abort. CHECK enforces the same
  //   vocabulary the harness produces, so an external INSERT (e.g.
  //   restoring from backup) can't sneak in 'maybe' or 'cooperative'.
  //
  // - No index. The hot read path is "give me this session row by
  //   id" — a covering UNIQUE on `id` already exists from migration
  //   001. Filter-by-cause queries (e.g. "show me all hard aborts in
  //   the last week") would land in a separate analytics index when
  //   that workflow surfaces; today they're rare enough that a full
  //   scan is fine.
  //
  // Backwards compat: existing rows get NULL. The harness's `finish()`
  // helper writes the column as a no-op for non-aborted sessions and
  // as the in-memory cause for aborted ones, so the schema and the
  // runtime stay aligned without a backfill step.
  sql: `
    ALTER TABLE sessions ADD COLUMN abort_cause TEXT
      CHECK (abort_cause IS NULL OR abort_cause IN ('soft', 'hard'));
  `,
} as const;
