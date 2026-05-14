// Grant vocabulary — single source of truth shared by the
// permission engine (which CONSUMES grants in `engine.check`) and
// the storage layer (which PERSISTS them via the grants repo).
//
// This module imports NOTHING from either side, breaking the
// otherwise-circular dependency between engine and storage. The
// `GrantRow` shape (full DB-row form) lives in
// `src/storage/repos/grants.ts` because it bundles persistence-
// only columns (`granted_at`, `revoked_at`, `revoked_reason`) the
// engine never consults; `GrantSnapshot` here is the minimal
// subset the `EngineOptions.grants.listActive` contract must
// return.

export type GrantScopeKind = 'pattern' | 'capability';

export type GrantGrantedBy = 'user' | 'enterprise' | 'project';

// Resolver's certainty about its emitted capabilities. Single
// source of truth shared by `RiskScoreConfidence` (engine input)
// and `ApprovalLogConfidence` (persisted column); both historical
// names live on as type aliases in their respective modules so
// existing imports keep compiling.
export type Confidence = 'high' | 'medium' | 'low';

// Minimal subset of `GrantRow` the engine consumes on every
// `check()`. Storage's `GrantRow` is `GrantSnapshot &
// { install_id, granted_at, granted_by, granted_reason, revoked_at,
// revoked_reason }` — the extra columns persist for audit / revoke
// flows but never enter the matching path. Keeping the snapshot
// type narrow:
//   - lets unit tests build a one-grant fixture without authoring
//     the audit columns (which require valid timestamps and a
//     `granted_by` literal that the engine doesn't even check),
//   - and prevents the engine from accidentally depending on a
//     storage-only column, which would invert the current
//     engine→types→storage layer order.
export interface GrantSnapshot {
  id: string;
  scope_kind: GrantScopeKind;
  scope_value: string;
  capability: string;
  expires_at: number;
}
