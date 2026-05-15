// policies repo (FEEDBACK_ADAPTATION §3.2 + §6).
//
// State machine + CRUD for adaptation policies. Loop frio inserts
// rows with state='proposed'; humans / loop frio transition through
// the state graph; scope resolver reads at tool-dispatch time.
//
// State machine (per spec §3.2 pipeline + §7.1 invalidação):
//
//   proposed    → active        (operator promotion)
//   proposed    → invalidated   (loop frio re-eval reversed evidence)
//   active      → shadow        (distribution shift §7.3)
//   active      → quarantined   (failure burst / 3× override §7.1)
//   active      → invalidated   (stack change / tool removed §7.1)
//   shadow      → active        (scope stabilized + posterior reconfirmed)
//   shadow      → quarantined   (shadow diverged from default in N runs)
//   quarantined → active        (new evidence restored confidence)
//   quarantined → invalidated   (shift confirmed during quarantine)
//
// Public surface:
//
//   createPolicy(db, input)                      → Policy
//   transitionPolicy(db, id, toState, motivo?)   → Policy | null
//   getPolicy(db, id)                            → Policy | null
//   listPoliciesByActionSignature(...)           → Policy[]
//   listPoliciesByState(db, state)               → Policy[]
//   listPolicyHistory(db, id)                    → Policy[]   (parent chain)
//
// State transitions go through `transitionPolicy` for the legal-
// transition check; bypassing the helper would land an illegal
// state shift only caught by callers reading the row back.

import type { SQLQueryBindings } from 'bun:sqlite';
import type { DB } from '../db.ts';
import type { ScopeKind } from './outcomes.ts';

// ─── state machine ───────────────────────────────────────────────────

export const POLICY_STATES = [
  'proposed',
  'active',
  'shadow',
  'quarantined',
  'invalidated',
] as const;
export type PolicyState = (typeof POLICY_STATES)[number];

// Legal (from, to) transitions per spec §3.2 + §7.1. Same shape the
// eviction state machine uses (LEGAL_TRANSITIONS in eviction-events).
// `'any'` means caller-side gate (e.g., manual operator action);
// state-machine validation doesn't restrict the path. Empty `{}` on
// `invalidated` marks it terminal.
const LEGAL_POLICY_TRANSITIONS: Record<PolicyState, PolicyState[]> = {
  proposed: ['active', 'invalidated'],
  active: ['shadow', 'quarantined', 'invalidated'],
  shadow: ['active', 'quarantined', 'invalidated'],
  quarantined: ['active', 'invalidated'],
  invalidated: [], // terminal — forensic only; re-promotion starts fresh
};

export const isLegalPolicyTransition = (from: PolicyState, to: PolicyState): boolean => {
  if (from === to) return false; // same-state transitions are operator bugs, not pseudo
  return LEGAL_POLICY_TRANSITIONS[from].includes(to);
};

export class IllegalPolicyTransitionError extends Error {
  readonly from: PolicyState;
  readonly to: PolicyState;
  constructor(from: PolicyState, to: PolicyState) {
    super(`policies: illegal transition ${from} → ${to}`);
    this.name = 'IllegalPolicyTransitionError';
    this.from = from;
    this.to = to;
  }
}

// ─── row + input shapes ──────────────────────────────────────────────

export interface Policy {
  id: string;
  parentId: string | null;
  scopeKind: ScopeKind;
  scopeId: string;
  actionSignature: string;
  actionJson: string;
  state: PolicyState;
  ciLow: number | null;
  ciHigh: number | null;
  n: number;
  motivo: string | null;
  diffJson: string | null;
  recordedAt: number;
}

interface PolicyRow {
  id: string;
  parent_id: string | null;
  scope_kind: ScopeKind;
  scope_id: string;
  action_signature: string;
  action_json: string;
  state: PolicyState;
  ci_low: number | null;
  ci_high: number | null;
  n: number;
  motivo: string | null;
  diff_json: string | null;
  recorded_at: number;
}

const PERSISTED_COLUMNS = [
  'id',
  'parent_id',
  'scope_kind',
  'scope_id',
  'action_signature',
  'action_json',
  'state',
  'ci_low',
  'ci_high',
  'n',
  'motivo',
  'diff_json',
  'recorded_at',
] as const;

const PLACEHOLDERS = PERSISTED_COLUMNS.map(() => '?').join(', ');
const COLUMN_LIST = PERSISTED_COLUMNS.join(', ');
const INSERT_SQL = `INSERT INTO policies (${COLUMN_LIST}) VALUES (${PLACEHOLDERS})`;

const SELECT_ALL = `SELECT id, parent_id, scope_kind, scope_id, action_signature,
       action_json, state, ci_low, ci_high, n, motivo, diff_json, recorded_at
  FROM policies`;

const fromRow = (row: PolicyRow): Policy => ({
  id: row.id,
  parentId: row.parent_id,
  scopeKind: row.scope_kind,
  scopeId: row.scope_id,
  actionSignature: row.action_signature,
  actionJson: row.action_json,
  state: row.state,
  ciLow: row.ci_low,
  ciHigh: row.ci_high,
  n: row.n,
  motivo: row.motivo,
  diffJson: row.diff_json,
  recordedAt: row.recorded_at,
});

const valuesForInsert = (row: PolicyRow): SQLQueryBindings[] =>
  PERSISTED_COLUMNS.map((col) => {
    const v = (row as unknown as Record<string, unknown>)[col];
    return (v ?? null) as SQLQueryBindings;
  });

// ─── write ───────────────────────────────────────────────────────────

export interface CreatePolicyInput {
  scopeKind: ScopeKind;
  scopeId: string;
  actionSignature: string;
  // JSON-encoded action shape per level (L1: {target}, L2: {flag, value},
  // L3: {recipe_id}, L4: {strategy_id}). Repo doesn't validate; emitter
  // is responsible for shape conformance.
  actionJson: string;
  state: PolicyState;
  parentId?: string | null;
  ciLow?: number | null;
  ciHigh?: number | null;
  n?: number;
  motivo?: string | null;
  diffJson?: string | null;
  id?: string;
  recordedAt?: number;
}

// INSERT a policy row. Throws on DB error (CHECK violation, FK
// missing, etc.). No state-transition gate — the caller (proposer /
// promoter) drives state. Use `transitionPolicy` instead when
// changing the state of an existing policy: this function INSERTs
// a NEW row.
export const createPolicy = (db: DB, input: CreatePolicyInput): Policy => {
  const id = input.id ?? crypto.randomUUID();
  const recordedAt = input.recordedAt ?? Date.now();
  const row: PolicyRow = {
    id,
    parent_id: input.parentId ?? null,
    scope_kind: input.scopeKind,
    scope_id: input.scopeId,
    action_signature: input.actionSignature,
    action_json: input.actionJson,
    state: input.state,
    ci_low: input.ciLow ?? null,
    ci_high: input.ciHigh ?? null,
    n: input.n ?? 0,
    motivo: input.motivo ?? null,
    diff_json: input.diffJson ?? null,
    recorded_at: recordedAt,
  };
  db.query(INSERT_SQL).run(...valuesForInsert(row));
  return fromRow(row);
};

// Transition an existing policy through the state machine. Validates
// the (from, to) pair via `isLegalPolicyTransition` and throws
// `IllegalPolicyTransitionError` on refusal. Returns null when the
// policy doesn't exist; returns the updated row on success.
//
// Implementation note: policies are mutable here (UPDATE state +
// motivo + recorded_at) rather than insert-a-new-row like
// eviction_events. Trade-off: forensics needs a chain of state
// transitions per policy; we capture that via `parent_id` chains
// when a transition spawns a derived policy (e.g., active→shadow
// might spawn a shadow-state child). For in-place transitions
// (proposed→active by manual promotion), the audit trail lives in
// `audit_timeline` events, not in repeated policy rows.
export const transitionPolicy = (
  db: DB,
  id: string,
  toState: PolicyState,
  motivo: string | null = null,
  nowMs: number = Date.now(),
): Policy | null => {
  const current = getPolicy(db, id);
  if (current === null) return null;
  if (!isLegalPolicyTransition(current.state, toState)) {
    throw new IllegalPolicyTransitionError(current.state, toState);
  }
  db.query('UPDATE policies SET state = ?, motivo = ?, recorded_at = ? WHERE id = ?').run(
    toState,
    motivo,
    nowMs,
    id,
  );
  return { ...current, state: toState, motivo, recordedAt: nowMs };
};

// ─── reads ───────────────────────────────────────────────────────────

export const getPolicy = (db: DB, id: string): Policy | null => {
  const row = db.query<PolicyRow, [string]>(`${SELECT_ALL} WHERE id = ?`).get(id);
  return row !== null ? fromRow(row) : null;
};

// Every policy for an action_signature in a specific scope, ordered
// most-recent first. Useful for `/agent policy list <signature>`
// inspection.
export const listPoliciesByActionSignature = (
  db: DB,
  actionSignature: string,
  scopeKind: ScopeKind,
  scopeId: string,
): Policy[] => {
  const rows = db
    .query<PolicyRow, [string, ScopeKind, string]>(
      `${SELECT_ALL}
        WHERE action_signature = ? AND scope_kind = ? AND scope_id = ?
        ORDER BY recorded_at DESC, rowid DESC`,
    )
    .all(actionSignature, scopeKind, scopeId);
  return rows.map(fromRow);
};

// All policies in a state — e.g., `state='proposed'` to surface
// pending operator review. Ordered most-recent first.
export const listPoliciesByState = (db: DB, state: PolicyState): Policy[] => {
  const rows = db
    .query<PolicyRow, [PolicyState]>(
      `${SELECT_ALL} WHERE state = ? ORDER BY recorded_at DESC, rowid DESC`,
    )
    .all(state);
  return rows.map(fromRow);
};

// Walk parent_id chain from `id` back to the root. Useful for
// `/agent policy history <id>` to show "where did this come from?".
// Returns the chain ordered oldest-first (root → leaf). Returns
// empty when `id` doesn't exist.
export const listPolicyHistory = (db: DB, id: string): Policy[] => {
  const chain: Policy[] = [];
  let cursor: string | null = id;
  const seen = new Set<string>(); // cycle guard (shouldn't happen, but defensive)
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const row = getPolicy(db, cursor);
    if (row === null) break;
    chain.push(row);
    cursor = row.parentId;
  }
  return chain.reverse();
};

export const countPolicies = (db: DB): number => {
  const row = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM policies').get() as {
    n: number;
  };
  return row.n;
};

export { PERSISTED_COLUMNS };
