export const migration022CostProgressEvents = {
  id: 22,
  name: '022-cost-progress-events',
  // Persistence layer for the cost-update IPC stream (spec
  // ORCHESTRATION.md §3.5, audit fix #2). Each child subagent
  // emits a `cost_update` HarnessEvent every time its
  // `totalCostUsd` advances (turn settle, compaction, partial
  // provider-error charge). The parent's IPC observer
  // consumes these to drive the cost-cap watchdog and the
  // reservation tracker, but the events themselves were
  // discarded after consumption — only the final settled cost
  // landed in `subagent_handles.settled_payload.costUsd`.
  //
  // Postmortem queries asking "what was the cumulative spend
  // of handle X at minute 3 of the run?" had no data to work
  // with: the curve over time was lost. This migration
  // captures the full stream so audit consumers can
  // reconstruct it, distinguish slow-burn drains from
  // sudden spikes, and correlate spend bursts with operator-
  // visible events (turn IDs, hook fires, cancel signals).
  //
  // Schema:
  //   - `id` autoincrement so retrieval-by-time within a
  //     handle is deterministic even when `recorded_at` ties
  //     (multiple cost_updates from the same turn settle hit
  //     within the same ms tick under fast providers).
  //   - `handle_id` FK to `subagent_handles` with CASCADE: a
  //     handle row purged via the parent session cascade
  //     reaps its cost stream too. No orphan rows.
  //   - `parent_session_id` denormalized (also from
  //     `subagent_handles`) so whole-session queries don't
  //     have to join through the handle row. The same FK
  //     CASCADE on sessions backs the denormalization — both
  //     point at the same parent and get reaped together.
  //   - `delta` is the latest charge alone (the value emitted
  //     by the child); `cumulative` is the child's running
  //     self-cost AT THAT POINT. Storing both lets queries
  //     pick: "show every charge above $X" needs delta;
  //     "plot the curve" needs cumulative; "verify the
  //     monotonic invariant" cross-checks both.
  //   - `recorded_at` is the parent's wall-clock at receive
  //     time, NOT the child's emit time. For a low-latency
  //     IPC pipe these match within microseconds; for a
  //     queued/buffered transport they could differ. We use
  //     receive time because it's authoritative on the
  //     parent's timeline (the only timeline that matters
  //     for budget watchdog correlation). Child timestamps,
  //     if needed, are recoverable from the child session's
  //     own audit rows.
  //
  // Indexes:
  //   - `(handle_id, recorded_at)` for per-handle reconstruction.
  //   - `(parent_session_id, recorded_at)` for whole-session
  //     reconstruction without joining through handles.
  sql: `
    CREATE TABLE cost_progress_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handle_id TEXT NOT NULL REFERENCES subagent_handles(handle_id) ON DELETE CASCADE,
      parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      delta REAL NOT NULL,
      cumulative REAL NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX idx_cost_progress_handle
      ON cost_progress_events(handle_id, recorded_at);
    CREATE INDEX idx_cost_progress_parent
      ON cost_progress_events(parent_session_id, recorded_at);
  `,
} as const;
