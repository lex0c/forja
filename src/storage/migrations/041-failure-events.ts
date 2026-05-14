// failure_events — classified failures per FAILURE_MODES.md §19
// and AUDIT.md §1 (medium sensitivity, 365d retention, redact
// details). Slice 130 closes the R5 P0-1 gap: spec named the
// table since v2 but it never materialized; failures went to
// stderr + audit chain ad-hoc, with no structured query surface.
//
// Distinct from `approvals_log` (migration 034): that table
// records DECISIONS (allow/deny/confirm) for tool calls. This
// table records FAILURES — bootstrap errors, sandbox-tool loss,
// storage lock contention, provider timeouts (deferred), parser
// errors (deferred), MCP transport breaks (deferred). The two
// link via `payload.approval_seq` when the failure is downstream
// of a decision — forward-compat hook for slice 131
// (outcome_signals + score calibration v2.1 per spec §6.3.2).
//
// Chain hash per AUDIT.md §4.2: per-session chain, NOT global.
// First row of a session: `prev = SHA256(session_id)`. Subsequent
// rows: `prev = previous row's this_chain_hash`. Tamper detection
// is session-scoped; corruption in one session's chain doesn't
// affect another. Pre-session failures (bootstrap-tier) use
// session_id = 'bootstrap' literal — same chain rules apply with
// a stable sentinel rather than NULL (NULL would orphan the row
// from chain walking; the sentinel keeps the genesis derivation
// deterministic).
//
// install_id intentionally NOT a column: session-scoped chain
// means the forge surface is small (at worst a misattributed
// row, never a broken chain elsewhere). Pre-session attribution
// goes via timestamp + 'bootstrap' session_id; that's enough
// for the audit query interface. Adding install_id later via
// ALTER is trivial if cross-install DB sharing ever becomes
// common (today it's niche).
//
// `classe` enum is CHECK-constrained at the DB layer. Adding a
// new top-level class = ALTER TABLE, forcing an explicit PR
// against this migration's successor. Same defensive pattern
// approvals_log uses on `decision`. The 10-element vocabulary
// covers every subsystem mentioned in FAILURE_MODES.md plus
// `compliance` for redaction / retention events (AUDIT.md §1.7).
//
// `recovery_action` is free TEXT — values like 'retried_3x',
// 'retried_5x', 'fallback_to_anthropic_haiku' would explode any
// CHECK list. Convention enforced at the writer layer via a TS
// const set in src/failures/codes.ts; DB stays append-friendly.
//
// `code` is the granular `<classe>.<subtipo>.<detalhe>` taxonomy
// (e.g. `sandbox.tool_unavailable`, `storage.lock_contention`).
// Format-validated at the writer layer (no SQL CHECK — regex
// in SQLite would inflate every INSERT). Slice 130 ships 3
// codes; the rest land when their owning subsystem gets a
// wiring slice.
//
// `user_visible` flags whether the operator saw a stderr/banner
// for this event. Useful for forensics queries — "did we ever
// surface this kind of degradation to the user, or did it
// silently retry?". Stored as INTEGER 0/1 (sqlite convention),
// CHECK enforces.
//
// `payload_json` carries event-specific context, scrubbed before
// persist via src/failures/scrub.ts (telemetry/scrubbing regexes
// applied recursively + 8 KiB cap with truncation marker). Keys
// are vocabulary (operator-controlled), values may carry
// path / URL / token fragments and need the scrub pass.
//
// Indices follow AUDIT.md §10.1 specification: code-prefixed for
// "show me all storage.lock_contention failures in the last 7
// days", session-prefixed for forensics bundle dumping a single
// session's failure stream.

export const migration041FailureEvents = {
  id: 41,
  name: '041-failure-events',
  sql: `
    CREATE TABLE failure_events (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL,
      step_id         TEXT,
      code            TEXT NOT NULL,
      classe          TEXT NOT NULL
                        CHECK (classe IN (
                          'provider','tool','sandbox','permission','subagent',
                          'parse','mcp','storage','bootstrap','compliance'
                        )),
      recovery_action TEXT NOT NULL,
      user_visible    INTEGER NOT NULL CHECK (user_visible IN (0, 1)),
      payload_json    TEXT,
      created_at      INTEGER NOT NULL,
      prev_chain_hash TEXT NOT NULL,
      this_chain_hash TEXT NOT NULL UNIQUE
    );

    CREATE INDEX idx_failure_events_code    ON failure_events(code, created_at DESC);
    CREATE INDEX idx_failure_events_session ON failure_events(session_id, created_at DESC);
  `,
} as const;
