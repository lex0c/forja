export const migration031CritiqueRuns = {
  id: 31,
  name: '031-critique-runs',
  // AGENTIC_CLI.md §5.4 line 552 / ORCHESTRATION.md §6 — audit
  // table for self-critique pass invocations. The harness loop
  // emits `critique_started` / `critique_finished` lifecycle
  // events for live observers (TUI, NDJSON), but those are
  // ephemeral; this row captures the per-step decision for
  // post-hoc analysis (which steps got flagged, which decisions
  // the operator made, threshold tuning data).
  //
  // Schema rationale:
  // - id (TEXT PK). UUID per critique invocation. Lets future
  //   eval / regression tooling correlate a specific row in
  //   `critique_runs` back to the lifecycle event stream.
  // - session_id (TEXT NOT NULL FK). The session this critique
  //   ran inside. FK to sessions(id) — when a session is purged,
  //   its critique rows go with it.
  // - step_n (INTEGER NOT NULL). Step counter at the moment the
  //   gate fired. Pairs with `messages.seq` to point at the
  //   provider turn the critique reviewed (the persist of that
  //   turn happens AFTER this row only when decision is
  //   ignore/no_modal — for redo/abort the assistant message
  //   never lands, but the audit row still does).
  // - mode (TEXT). Effective mode for this run — `on_writes` or
  //   `always`. `off` never reaches this point (gate is
  //   short-circuited). CHECK pins the vocabulary.
  // - strategy (TEXT). Engine outcome — `llm` (call ran, output
  //   parsed), `skipped` (overhead exceeded / not applicable),
  //   `failed` (parse / stream error). CHECK pins.
  // - decision (TEXT). Operator answer when the modal opened, or
  //   `no_modal` when issues were below threshold / strategy was
  //   skipped|failed. CHECK pins.
  // - code (TEXT NOT NULL). Spec line 552 audit code:
  //   `critique.warning_shown` — issues crossed threshold AND
  //   modal opened (regardless of the operator's answer).
  //   `critique.warning_ignored` — operator chose ignore.
  //   `critique.warning_redo` — operator chose redo.
  //   `critique.warning_abort` — operator chose abort or cancel.
  //   `critique.skipped` — engine returned skipped.
  //   `critique.failed` — engine returned failed.
  //   `critique.clean` — engine ran, no issues over threshold.
  //   Free-form TEXT (no CHECK) so future codes don't require a
  //   migration; eval covers the closed set.
  // - raw_count (INTEGER). Total issues the critic emitted.
  // - filtered_count (INTEGER). Issues that crossed the threshold.
  // - overall_confidence (REAL). 0..1.
  // - duration_ms (INTEGER NOT NULL). Wall-clock for the engine
  //   call (engine entry → return). Excludes modal time.
  // - cost_usd (REAL NOT NULL). Critic call's billed cost.
  // - tool_plan_writes (INTEGER 0/1). True iff the proposed step
  //   would invoke at least one writes:true tool. Drives the
  //   modal's framing AND lets analytics distinguish text-only
  //   end-of-step critiques from tool-plan critiques.
  // - reason (TEXT). Engine's `reason` field when set
  //   (overhead_exceeded, parse_failed, markers_missing, etc).
  //   Null when strategy=llm with no anomaly to report.
  // - prompt_version (TEXT NOT NULL). Pinned so a future prompt
  //   revision can be replayed against older rows without
  //   guessing which prompt produced which decisions.
  // - threshold (REAL NOT NULL). The threshold in effect at the
  //   call. Lets threshold-tuning analyses replay a different
  //   threshold against rawIssues confidence values without
  //   re-billing.
  // - created_at (INTEGER NOT NULL). Epoch ms.
  //
  // Indexes:
  // - (session_id, step_n) supports the dominant query: "show me
  //   all critique runs for this session, in order".
  // - (created_at DESC) for cross-session audit listings.
  sql: `
    CREATE TABLE critique_runs (
      id                  TEXT PRIMARY KEY,
      session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      step_n              INTEGER NOT NULL,
      mode                TEXT NOT NULL
                            CHECK (mode IN ('on_writes', 'always')),
      strategy            TEXT NOT NULL
                            CHECK (strategy IN ('llm', 'skipped', 'failed')),
      decision            TEXT NOT NULL
                            CHECK (decision IN
                              ('ignore', 'redo', 'abort', 'cancel', 'no_modal')),
      code                TEXT NOT NULL,
      raw_count           INTEGER NOT NULL DEFAULT 0,
      filtered_count      INTEGER NOT NULL DEFAULT 0,
      overall_confidence  REAL NOT NULL DEFAULT 0,
      duration_ms         INTEGER NOT NULL,
      cost_usd            REAL NOT NULL,
      tool_plan_writes    INTEGER NOT NULL DEFAULT 0
                            CHECK (tool_plan_writes IN (0, 1)),
      reason              TEXT,
      prompt_version      TEXT NOT NULL,
      threshold           REAL NOT NULL,
      created_at          INTEGER NOT NULL
    );

    CREATE INDEX idx_critique_runs_session_step
      ON critique_runs(session_id, step_n);
    CREATE INDEX idx_critique_runs_created
      ON critique_runs(created_at DESC);
  `,
} as const;
