// outcomes — operational outcomes cross-substrate (FEEDBACK_ADAPTATION
// §3.1). Per AUDIT.md §1, this is the canonical table for tier 1-5
// outcomes keyed by `action_signature` + `scope_kind`. Distinct from
// `outcome_signals` (PERMISSION_ENGINE §6.3.2): the latter is per-
// permission derived audit keyed to `approvals_log.seq`; THIS is the
// generic operational surface that feeds the loop frio adaptation
// engine.
//
// Coexistence with `outcome_signals` is declared in AUDIT.md §1.1.1:
// no dual-write. Caller emits to one OR the other; cross-dimensional
// queries do explicit JOIN via session_id / tool_call_id.
//
// Schema rationale (per-column):
//
// - `id` (TEXT PRIMARY KEY). UUID v4. Matches memory_events /
//   eviction_events / outcome_signals shape — globally unique
//   surviving cross-install DB copies. Spec §3.1 says INTEGER PK
//   but every other audit table in this repo uses TEXT UUIDs;
//   conformance with project pattern overrides the spec letter
//   (anglicization-style adaptation).
//
// - `session_id` (TEXT NOT NULL FK ON DELETE CASCADE). Outcomes
//   without a session are nonsensical — every tool_call lives
//   inside one. CASCADE because outcomes are derived audit:
//   when the session is purged, its outcomes go with it. Distinct
//   from memory_events / eviction_events (SET NULL) because those
//   carry forensic intent across session boundaries; outcomes are
//   per-session operational signals that feed loop frio, which
//   re-aggregates from the survivors.
//
// - `tool_call_id` (TEXT NOT NULL FK ON DELETE CASCADE). Every
//   outcome maps to exactly one tool_call. Spec §3.1 says INTEGER
//   but tool_calls.id is TEXT (001-initial.ts); FK type must match.
//
// - `action_signature` (TEXT NOT NULL). Per §4.2: L1 'alias:from:to',
//   L2 'flag:tool:flag:value', L3 'recipe:id', L4 'strategy:id:scope'.
//   Stored as opaque string; parsed by callers. Naming convention is
//   load-bearing — sem ela aggregation cruza signatures não
//   relacionadas.
//
// - `tier` (INTEGER NOT NULL CHECK 1-5). §2 tiers: 1 determinístico,
//   2 estrutural, 3 humano explícito, 4 humano implícito, 5 long
//   horizon. CHECK admits 1-5 only.
//
// - `result` (TEXT NOT NULL CHECK). 'success' | 'failure' | 'partial'
//   | 'ambiguous'. Spec §3.1.
//
// - `evidence_json` (TEXT). Per-tier payload. Tier 1: exit code,
//   stderr summary. Tier 2: diff stats. Tier 3: approval seq + actor.
//   Tier 4: revert detail. Tier 5: long-horizon metric. Sensitivity
//   medium per AUDIT.md §1 → redact before persist (caller's
//   responsibility; the existing scrub patterns apply).
//
// - `scope_kind` (TEXT NOT NULL CHECK). 'global' | 'language' |
//   'repo' | 'user' | 'session'. §3.1 / §6.
//
// - `scope_id` (TEXT NOT NULL). Identifier inside the scope's
//   namespace: 'global' uses literal 'global'; 'language' uses the
//   language id ('typescript', 'python'); 'repo' uses repo path
//   hash; 'user' uses user id (per-machine identifier); 'session'
//   uses session_id. Caller picks; the repo just stores.
//
// - `recorded_at` (INTEGER NOT NULL). Epoch ms, Date.now()-shaped.
//
// Indices per §3.1: (action_signature, scope_kind, scope_id) for
// the loop frio aggregator's primary read path. Plus session_id
// for "what happened in this session?" cross-cuts and recorded_at
// for time-windowed queries.

export const migration049Outcomes = {
  id: 49,
  name: '049-outcomes',
  sql: `
    CREATE TABLE outcomes (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      tool_call_id    TEXT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
      action_signature TEXT NOT NULL,
      tier            INTEGER NOT NULL CHECK (tier IN (1, 2, 3, 4, 5)),
      result          TEXT NOT NULL
                        CHECK (result IN ('success', 'failure', 'partial', 'ambiguous')),
      evidence_json   TEXT,
      scope_kind      TEXT NOT NULL
                        CHECK (scope_kind IN ('global', 'language', 'repo', 'user', 'session')),
      scope_id        TEXT NOT NULL,
      recorded_at     INTEGER NOT NULL
    );

    CREATE INDEX idx_outcomes_action_scope
      ON outcomes(action_signature, scope_kind, scope_id);

    CREATE INDEX idx_outcomes_session
      ON outcomes(session_id, recorded_at);

    CREATE INDEX idx_outcomes_recorded
      ON outcomes(recorded_at);
  `,
} as const;
