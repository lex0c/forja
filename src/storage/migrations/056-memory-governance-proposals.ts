// memory_governance_proposals — substrate for the propose-not-mutate
// path documented in MEMORY.md §11.3 (Phase 2 / S8). Detectors emit
// proposals; operators approve; the apply path delegates to
// `transitionMemoryState`. No detector ever mutates memory state
// directly — this table is the gate.
//
// ────────────────────────────────────────────────────────────────────
// WHY A SEPARATE TABLE (vs reusing memory_events / eviction_events)
//
// `memory_events` is the audit channel for events that DID happen
// ('created', 'quarantined', 'restored'). `eviction_events` is the
// audit pair for state-machine transitions. Neither answers "an
// LLM-judge subagent proposed a quarantine and the operator hasn't
// decided yet". A pending proposal is a piece of MUTABLE state with
// a lifecycle of its own (pending → applied/rejected/expired) that
// doesn't fit either append-only audit shape.
//
// ────────────────────────────────────────────────────────────────────
// SCHEMA
//
// - `id` (TEXT PRIMARY KEY). UUID v4 from `crypto.randomUUID()`.
//   Same convention as memory_events / eviction_events.
//
// - `session_id` (TEXT, nullable, FK ON DELETE SET NULL). The
//   session the detector was running in when it proposed. NULL when
//   the proposal predates a session (boot-time consistency pass) or
//   the session was purged after the proposal landed. Same SET NULL
//   posture as memory_events / eviction_events — the proposal trail
//   outlives its session for forensics.
//
// - `kind` (TEXT NOT NULL CHECK). Six kinds enumerated by spec
//   MEMORY.md §11.3 / TODO S8.1:
//     - `quarantine`   — transition a memory active/restored → quarantined
//     - `restore`      — quarantined/evicted → active
//     - `demote`       — shared → local (file move; deferred apply)
//     - `merge`        — merge N memories into one (file rewrite; deferred apply)
//     - `consolidate`  — like merge but driven by similarity (deferred apply)
//     - `expire`       — set/update `expires` frontmatter field
//   S8 itself implements `quarantine`, `restore`, `expire` in the
//   apply path; the other three are accepted at the substrate (so a
//   future S10 / S15 detector can persist them) but the apply path
//   refuses them with `unimplemented_kind`. The CHECK enumerates all
//   six so the data schema is forward-compatible without an ALTER.
//
// - `source_memory_keys` (TEXT NOT NULL). JSON array of
//   `{scope, name}` objects. One-element for single-memory proposals
//   (quarantine, restore, expire); multi-element for merge /
//   consolidate (the inputs being combined). Canonical JSON written
//   by the repo (sorted by scope then name) so the fingerprint
//   computation is deterministic.
//
//   Index-by-memory queries (`listProposalsForMemory(scope, name)`)
//   are served by the auxiliary table `memory_governance_proposal_
//   keys` (below) rather than JSON LIKE'ing into this column. The
//   JSON column is the canonical source of truth; the auxiliary
//   table is a derived index populated by the repo at INSERT.
//
// - `target_payload` (TEXT, nullable). JSON, kind-specific:
//     - `quarantine` / `restore`: NULL (target state is implicit in kind)
//     - `expire`: `{expires: "YYYY-MM-DD"}` — the new value
//     - `merge` / `consolidate`: `{body: "...", frontmatter: {...}}` —
//       the resulting memory's content
//   Schema validation happens at apply time, not INSERT time. INSERT
//   accepts opaque JSON so a forward-compatible detector can land
//   richer payloads before the apply path supports them.
//
// - `confidence` (REAL, nullable, CHECK 0..1). LLM-judge verdict
//   confidence. NULL for operator-authored proposals (operator IS
//   the authority — no confidence number applies). The apply path's
//   confidence gate (S8/T8.3) uses `confidence < SEMANTIC_VERIFY_
//   MIN_CONFIDENCE` as a rejection trigger; NULL bypasses the gate.
//
// - `evidence` (TEXT NOT NULL). JSON, kind-specific. Stores
//   detector-provided evidence (LLM verdict, override counts,
//   subagent_run_id, etc.). Must be valid JSON (the repo validates
//   on INSERT); schema beyond that is detector-specific.
//
// - `status` (TEXT NOT NULL DEFAULT 'pending' CHECK). Four-state
//   lifecycle:
//     - `pending`  — awaiting operator decision
//     - `applied`  — operator approved; transition fired
//     - `rejected` — operator rejected OR auto-rejected (low
//                    confidence, stale snapshots, schema invalid)
//     - `expired`  — TTL sweep moved a pending proposal past 30d
//   Default 'pending' so the typical INSERT path doesn't carry it.
//
// - `proposed_by` (TEXT NOT NULL). Origin label. Convention:
//     - `subagent:<name>`     — LLM detector subagent (`subagent:verify-semantic`)
//     - `operator:<id>`       — manual operator proposal (rare; reserved)
//     - `detector:<name>`     — deterministic detector (`detector:user_override_repeated`)
//   Audit distinguishes auto vs manual proposals via this field.
//
// - `proposal_fingerprint` (TEXT NOT NULL). SHA-256 hex over
//   `JSON.stringify({kind, source_memory_keys: sorted([...]),
//   evidence_essence})`. UNIQUE partial index `WHERE status =
//   'pending'` enforces "one pending proposal per fingerprint" —
//   two detectors running in parallel can't enqueue the same
//   proposal twice. The collision is silent (existing pending row
//   keeps its identity; new INSERT is a no-op). Applied / rejected /
//   expired rows can share a fingerprint with a pending row (and
//   with each other) — detector quality measurement needs the
//   history. `evidence_essence` is a detector-provided string (e.g.
//   the LLM's `claim_extracted`); detectors that don't supply it
//   get JSON.stringify(evidence) as the default essence.
//
// - `source_memory_snapshots` (TEXT NOT NULL). JSON array of
//   `{scope, name, content_hash}` captured at proposal creation
//   time. The apply path (T8.3) verifies each entry against
//   `hashMemoryContent(serializeMemoryFile(...))` of the CURRENT
//   memory file; any drift → proposal rejected with `decided_by =
//   'system:stale_evidence'`. Closes the propose-not-mutate gap
//   where an operator approves days later against a memory body
//   that was edited since the detector saw it.
//
// - `decided_reason` (TEXT, nullable). Free-text explanation of the
//   decision. Operator-supplied for manual reject/approve;
//   system-supplied for auto-reject (low_confidence,
//   stale_evidence, unimplemented_kind). NULL while pending.
//
// - `created_at` (INTEGER NOT NULL CHECK > 0). Epoch ms when the
//   detector emitted. Drives the 30d TTL sweep.
//
// - `decided_at` (INTEGER, nullable, CHECK > 0). Epoch ms when
//   status transitioned away from 'pending'. NULL while pending.
//
// - `decided_by` (TEXT, nullable). Who/what decided:
//     - `operator:<id>`         — manual via /memory governance approve|reject
//     - `system:low_confidence` — auto-reject (confidence < threshold)
//     - `system:stale_evidence` — auto-reject (source_memory_snapshots drifted)
//     - `system:unimplemented_kind` — auto-reject (apply path doesn't support kind)
//     - `system:ttl`            — auto-expire after 30d
//     - `system:schema_invalid` — auto-reject (target_payload schema bad)
//     - `system:state_change`   — auto-reject (memory state changed since proposal)
//   NULL while pending.
//
// ────────────────────────────────────────────────────────────────────
// AUXILIARY TABLE: memory_governance_proposal_keys
//
// One row per (proposal, memory) pair, derived from
// `source_memory_keys`. Populated by the repo on INSERT (same
// transaction). FK CASCADE on `proposal_id` so DELETE of the
// parent (rare — proposals are append-only) drops the index rows.
//
// Exists because querying "give me all pending proposals that
// reference memory X" via JSON LIKE on `source_memory_keys` is
// fragile (whitespace, escape quoting, key ordering). The
// auxiliary table makes it a normal indexed lookup.
//
// ────────────────────────────────────────────────────────────────────
// INDICES
//
// - `idx_mgp_pending_fingerprint` UNIQUE WHERE status='pending':
//   enforces the at-most-one-pending-per-fingerprint invariant.
//   Partial so applied/rejected/expired don't compete for the
//   fingerprint slot (they're historical, can coexist).
//
// - `idx_mgp_status_created` (status, created_at DESC):
//   serves `listPendingProposals` (status='pending' ORDER BY
//   created_at DESC) and `expirePendingProposals` (status='pending'
//   AND created_at < cutoff). Covering index — no row fetch.
//
// - `idx_mgp_session_created` (session_id, created_at DESC):
//   session-scoped listing for the /memory governance list slash
//   when filtered to current session.
//
// - `idx_mgp_keys_memory` on memory_governance_proposal_keys
//   (memory_scope, memory_name): drives `listProposalsForMemory`.

export const migration056MemoryGovernanceProposals = {
  id: 56,
  name: '056-memory-governance-proposals',
  sql: `
    CREATE TABLE memory_governance_proposals (
      id                      TEXT PRIMARY KEY,
      session_id              TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      kind                    TEXT NOT NULL
                                CHECK (kind IN (
                                  'quarantine','restore','demote',
                                  'merge','consolidate','expire'
                                )),
      source_memory_keys      TEXT NOT NULL,
      target_payload          TEXT,
      confidence              REAL
                                CHECK (confidence IS NULL OR
                                       (confidence >= 0 AND confidence <= 1)),
      evidence                TEXT NOT NULL,
      status                  TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','applied','rejected','expired')),
      proposed_by             TEXT NOT NULL,
      proposal_fingerprint    TEXT NOT NULL,
      source_memory_snapshots TEXT NOT NULL,
      decided_reason          TEXT,
      created_at              INTEGER NOT NULL CHECK (created_at > 0),
      decided_at              INTEGER CHECK (decided_at IS NULL OR decided_at > 0),
      decided_by              TEXT
    );

    CREATE UNIQUE INDEX idx_mgp_pending_fingerprint
      ON memory_governance_proposals(proposal_fingerprint)
      WHERE status = 'pending';

    CREATE INDEX idx_mgp_status_created
      ON memory_governance_proposals(status, created_at DESC);

    CREATE INDEX idx_mgp_session_created
      ON memory_governance_proposals(session_id, created_at DESC);

    CREATE TABLE memory_governance_proposal_keys (
      proposal_id  TEXT NOT NULL
                     REFERENCES memory_governance_proposals(id) ON DELETE CASCADE,
      memory_scope TEXT NOT NULL
                     CHECK (memory_scope IN ('user','project_shared','project_local')),
      memory_name  TEXT NOT NULL,
      PRIMARY KEY (proposal_id, memory_scope, memory_name)
    );

    CREATE INDEX idx_mgp_keys_memory
      ON memory_governance_proposal_keys(memory_scope, memory_name);
  `,
} as const;
