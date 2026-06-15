// outcome_signals — derived signals linking permission approvals
// to observed outcomes, per PERMISSION_ENGINE.md §6.3.2's
// calibration plan. Slice 131 materializes the
// `(score, decision_humano, outcome)` triples that the spec lists
// as input to logistic regression for v2.1 weight derivation.
//
// Distinct from `approvals_log` (slice 34: decisions) and
// `failure_events` (slice 130: classified failures): this table
// records the JUDGMENT that an earlier approval led to a "bad"
// or "good" outcome — inferred from proxies the system already
// observes:
//
//   - `tool_error`           — tool execution failed after the
//                              decision authorized it. Weak (0.30):
//                              tool errors are often benign.
//   - `failure_event`        — a failure_events row downstream of
//                              this approval (linked via slice 130's
//                              `payload.approval_seq` convention).
//                              Medium (0.50): system-level issue,
//                              not necessarily causal.
//   - `checkpoint_reverted`  — operator ran `--undo` past this
//                              approval. Strong (0.90): explicit
//                              human judgment that the change
//                              should not have happened.
//   - `session_aborted`     — session ended with abort/crash within
//                              the approval's recent window. Weak
//                              (0.20): many reasons to abort.
//
// Aggregator (src/outcomes/aggregator.ts) walks the signals for an
// approval seq and produces a composite outcome score via
// max-wins: the most damning evidence anchors the composite.
// Threshold 0.5 maps to `harmful` for spec §6.3.2's binary label.
//
// SLICE 131 FIXUP #1: removed `REFERENCES approvals_log(seq)
// ON DELETE CASCADE`. Slice 35's chain-rotation path runs
// `DELETE FROM approvals_log WHERE install_id = ?` after copying
// to `approvals_log_archived`. With the cascade in place, every
// outcome_signal ever recorded would vanish at rotation time —
// exactly when calibration value peaks (rotation typically
// follows a security incident). Without the cascade, signals
// outlive their parent approvals_log row; the calibration
// script must join against BOTH `approvals_log` and
// `approvals_log_archived` to recover the full `(score, decision,
// outcome)` triple, but the SIGNAL data survives intact.
//
// SLICE 131 FIXUP #1: added `install_id TEXT NOT NULL`. With the
// FK gone, the per-install attribution that the FK implicitly
// carried is now an explicit column. The sink reads this from
// the approvals_log row at emit time so the dual-write across
// `outcome_signals` and `approvals_log_archived` stays correlatable
// post-rotation. Also enables cross-install integrity queries
// (`SELECT install_id, COUNT(*) FROM outcome_signals GROUP BY
// install_id`) without the join.
//
// FK existence is still validated at INSERT time in the sink
// (`getApprovalsLogBySeq` check), so a bogus `approval_seq` is
// rejected loudly. The DB no longer enforces it across the
// row's lifetime, accepting that signals can outlive their
// parent (the intended invariant post-rotation).
//
// `signal_weight` is REAL with CHECK [0.0, 1.0]. Per-kind defaults
// live in the writer layer (src/outcomes/sink.ts); callers can
// override per row for calibration sweeps. The CHECK pins the
// invariant at the DB layer so a future writer typo can't ship
// out-of-range weights silently.
//
// `ttl_expires_at` is per-row, not table-wide. Default 365 days
// (AUDIT.md §1.2) but `checkpoint_reverted` deserves longer
// retention (strong calibration signal) so the sink overrides
// per kind. GC sweep (deferred slice) reads this column when
// `forja gc` materializes.
//
// Indices: lookup by approval_seq (the primary aggregator query
// path), lookup by install_id (post-rotation aggregation), and
// by kind+detected_at for trend queries ("how many
// checkpoint_reverted signals in the last 30 days?").

export const migration042OutcomeSignals = {
  id: 42,
  name: '042-outcome-signals',
  sql: `
    CREATE TABLE outcome_signals (
      id              TEXT PRIMARY KEY,
      approval_seq    INTEGER NOT NULL,
      install_id      TEXT NOT NULL,
      signal_kind     TEXT NOT NULL
                        CHECK (signal_kind IN (
                          'tool_error',
                          'failure_event',
                          'checkpoint_reverted',
                          'session_aborted'
                        )),
      signal_weight   REAL NOT NULL CHECK (signal_weight >= 0.0 AND signal_weight <= 1.0),
      payload_json    TEXT,
      observed_at     INTEGER NOT NULL,
      detected_at     INTEGER NOT NULL,
      ttl_expires_at  INTEGER NOT NULL
    );

    CREATE INDEX idx_outcome_signals_approval ON outcome_signals(approval_seq);
    CREATE INDEX idx_outcome_signals_install  ON outcome_signals(install_id);
    CREATE INDEX idx_outcome_signals_kind     ON outcome_signals(signal_kind, detected_at DESC);
  `,
} as const;
