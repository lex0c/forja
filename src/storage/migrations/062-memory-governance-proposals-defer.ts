// memory_governance_proposals — operator-driven defer (MEMORY.md
// §11.3 / TODO #5 follow-up).
//
// ────────────────────────────────────────────────────────────────────
// WHY
//
// Pre-defer the proposal TTL was hardcoded 30d from `created_at`. An
// operator who needed to research a detector's evidence (e.g. a
// quarantine for a memory whose contradiction depends on a still-
// open RFC) had two options: rush the decision before the TTL sweep
// expired the row, or let it expire and pay the detector re-emit
// cost on the next exposure. Neither is healthy operator agency.
//
// Defer adds a per-proposal extension to the expiry horizon:
//   `/memory governance defer <id> <days>`
// updates `deferred_until` and the next bootstrap-time TTL sweep
// honors it instead of `created_at + 30d`.
//
// ────────────────────────────────────────────────────────────────────
// SCHEMA
//
// - `deferred_until` (INTEGER, nullable). Effective expiry timestamp
//   when set; NULL means "use the default TTL" (`created_at + 30d`).
//   Repo's `expirePendingProposals` switches from
//     `WHERE created_at < cutoff`
//   to
//     `WHERE COALESCE(deferred_until, created_at + ttlMs) < nowMs`
//   so the same sweep handles both deferred and non-deferred rows.
//
// - `defer_count` (INTEGER NOT NULL DEFAULT 0). Number of defer
//   operations applied so far. Audit signal: many defers on the
//   same proposal is a smell ("operator is dithering"); zero defers
//   is the default. NOT used as a cap — the horizon cap below is
//   the operative limit. Surfaced on `/memory governance show`.
//
// ────────────────────────────────────────────────────────────────────
// HORIZON CAP
//
// `deferProposal` enforces `deferred_until <= created_at +
// MAX_GOVERNANCE_PROPOSAL_DEFER_HORIZON_MS` (90d). This caps the
// total runway from creation; without it an operator could
// indefinitely defer and turn a propose-not-mutate substrate into
// eternal pending. The cap is enforced at the repo layer (returns
// `horizon_exceeded`) so slash + future API surfaces share the same
// guardrail.
//
// Choice of 90d: matches `memory_provenance` retention and gives
// roughly 3× the default TTL — enough operator slack for a slow
// review cycle without letting a proposal outlive the detector
// context that generated it.
//
// ────────────────────────────────────────────────────────────────────
// APPEND-ONLY MIGRATION
//
// SQLite ALTER TABLE is the only safe edit on a landed schema. Both
// columns are nullable / default-valued so existing rows back-fill
// trivially. No data migration needed.

export const migration062MemoryGovernanceProposalsDefer = {
  id: 62,
  name: '062-memory-governance-proposals-defer',
  sql: `
    ALTER TABLE memory_governance_proposals
      ADD COLUMN deferred_until INTEGER;

    ALTER TABLE memory_governance_proposals
      ADD COLUMN defer_count INTEGER NOT NULL DEFAULT 0;
  `,
} as const;
