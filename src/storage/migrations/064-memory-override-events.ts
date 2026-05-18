// memory_override_events — substrate for the S3 `user_override_repeated`
// detector (MEMORY.md §11.x, spec §6.5.2).
//
// ────────────────────────────────────────────────────────────────────
// WHAT THIS TABLE TRACKS
//
// Per-event log of operator actions that countermand model behavior
// derived from a memory. The threshold detector (S3.4) polls this
// table at step boundaries and dispatches the LLM-judge subagent
// when one memory accumulates the spec's threshold (3 events in
// 24h, see `MEMORY_OVERRIDE_THRESHOLD_*` constants). Below threshold:
// zero LLM cost. The deterministic counter is the cheap pre-flight;
// the LLM judges whether the memory was actually misguiding the
// model.
//
// Three signal kinds per spec:
//
// - `memory_write_rejected`: operator rejected the inferred-write
//   modal for a memory. Signal of "model proposed a memory the
//   operator didn't want", which suggests the upstream memory(s)
//   the model was reasoning from are leading it in the wrong
//   direction (spec §6.5.2 footnote: collinear, not causal — the
//   LLM-judge is the discriminator).
//
// - `permission_denied`: operator denied a `permission ask` for a
//   tool whose causal chain points at this memory via
//   memory_provenance (the exposure trail anchors which memories
//   were visible at the tool call). Signal of "model wanted to do
//   X based on context that included memory Y, operator refused".
//
// - `edit_reverted`: model edited file X via edit_file/write_file,
//   then within K turns the same file was rewritten with content
//   substantially closer to the pre-edit state. Stub today
//   (signal collector deferred to S3.2 follow-up); the schema
//   accepts the kind so a future detector lands without an
//   ALTER TABLE.
//
// ────────────────────────────────────────────────────────────────────
// SCHEMA
//
// - `id` (TEXT PRIMARY KEY). UUID. Same shape as memory_provenance,
//   memory_governance_proposals.
//
// - `session_id` (TEXT NULL REFERENCES sessions(id) ON DELETE
//   SET NULL). The session the override happened in. SET NULL on
//   session purge preserves the cross-session threshold counter:
//   "memory X has accumulated 3 overrides in 24h" must survive a
//   purged session that contained one of the events.
//
// - `memory_scope` (TEXT NOT NULL CHECK). Closed enum.
//
// - `memory_name` (TEXT NOT NULL). Memory name within its scope.
//
// - `signal` (TEXT NOT NULL CHECK). The kind of override observed.
//
// - `tool_call_id` (TEXT NULL REFERENCES tool_calls(id) ON DELETE
//   SET NULL). For `permission_denied` and `edit_reverted`, the
//   causal tool call. NULL for `memory_write_rejected` (the modal
//   is upstream of any tool dispatch). SET NULL on tool_calls
//   purge preserves the threshold counter — the override event is
//   the audit; its causal pointer is best-effort.
//
// - `details` (TEXT NULL). Optional JSON for signal-specific
//   context — e.g. the denied tool name, the reverted path, the
//   rejected memory's proposed name. Detector code OWNS the per-
//   signal contract; the repo doesn't interpret.
//
// - `created_at` (INTEGER NOT NULL CHECK > 0). Epoch ms when the
//   override happened. Drives the sliding-window counter cutoff
//   and the retention sweep.
//
// ────────────────────────────────────────────────────────────────────
// INDEXES
//
// - `(memory_scope, memory_name, created_at DESC)` — backs the
//   sliding-window counter "how many overrides hit this memory in
//   the last 24h?". Single seek covers the threshold query.
//
// - `(created_at)` — retention sweep ("rows older than 90d") and
//   the scheduler's "events since last poll" query.
//
// ────────────────────────────────────────────────────────────────────
// LIFECYCLE
//
// Append-only. Boot-time GC sweep (S3.4 follow-up) deletes rows
// older than 90d. The 90d window matches `memory_provenance`
// retention: the override events feed governance proposals which
// reference back to the exposure trail; symmetric retention keeps
// cross-table forensics joinable for the full window.
//
// ────────────────────────────────────────────────────────────────────
// WHY A SEPARATE TABLE (vs reusing memory_events)
//
// `memory_events` is the operator-visible action log keyed on the
// memory itself (created/edited/refused/etc). An override event is
// a SEPARATE signal type — it doesn't describe what happened to
// the memory, it describes a downstream rejection of behavior the
// memory contributed to. Conflating the two would force the slash
// surface (`/memory audit`) to filter for the detector's internal
// signal kinds, which it has no reason to know about. Separate
// table = clean separation: detector substrate vs operator audit.

export const migration064MemoryOverrideEvents = {
  id: 64,
  name: '064-memory-override-events',
  sql: `
    CREATE TABLE memory_override_events (
      id            TEXT PRIMARY KEY,
      session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      memory_scope  TEXT NOT NULL
                      CHECK (memory_scope IN ('user','project_shared','project_local')),
      memory_name   TEXT NOT NULL,
      signal        TEXT NOT NULL
                      CHECK (signal IN (
                        'memory_write_rejected',
                        'permission_denied',
                        'edit_reverted'
                      )),
      tool_call_id  TEXT REFERENCES tool_calls(id) ON DELETE SET NULL,
      details       TEXT,
      created_at    INTEGER NOT NULL CHECK (created_at > 0)
    );

    CREATE INDEX idx_moe_counter
      ON memory_override_events(memory_scope, memory_name, created_at DESC);

    CREATE INDEX idx_moe_retention
      ON memory_override_events(created_at);
  `,
} as const;
