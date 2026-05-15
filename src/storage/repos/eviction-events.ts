// eviction_events repo — typed lifecycle transitions per
// EVICTION.md §3-§5, §10.1. Schema in migration 046-eviction-
// events.ts.
//
// Public surface:
//
//   isLegalTransition(from, to, motivo) → { ok } | { ok: false, reason }
//   appendEvictionEvent(db, input)        → EvictionEvent
//   getLastEvictionForObject(db, ...)     → EvictionEvent | null
//   listEvictableInWindow(db, nowMs)      → EvictionEvent[]
//   detectTriggerThrashing(db, sinceMs)   → ThrashingRow[]
//
// Plus constants for the closed enums (SUBSTRATES / STATES /
// MOTIVOS / OUTCOMES / ACTORS) and a structured
// IllegalTransitionError class.
//
// Distinct from other audit repos in this tree:
//
//   - failure_events (041) chains rows per-session via SHA-256 of
//     the prior `this_chain_hash`. Eviction events do NOT chain.
//     EVICTION.md does not call for tamper-evidence; each
//     substrate owner is the trust anchor (memory owns its
//     frontmatter / file presence; policy owns its row). Adding
//     a chain later is an ALTER, not a redesign.
//
//   - outcome_signals (042) is derived-audit: every row's
//     correctness derives from a referenced approvals_log/failure_
//     events row. Eviction is primary-audit: rows record the
//     transition itself, not a derivation of one. Same shape
//     pattern (PERSISTED_COLUMNS / valuesForInsert / SELECT_ALL)
//     but no derived-audit caveats.

import type { SQLQueryBindings } from 'bun:sqlite';
import { redactSecrets } from '../../memory/index.ts';
import { scrubFreeformText } from '../../telemetry/scrubbing.ts';
import type { DB } from '../db.ts';

// ─── enums + types ───────────────────────────────────────────────────

export const SUBSTRATES = ['memory', 'policy', 'candidate', 'slot_item'] as const;
export type EvictionSubstrate = (typeof SUBSTRATES)[number];

export const STATES = [
  'proposed',
  'active',
  'shadow',
  'quarantined',
  'invalidated',
  'evicted',
  'purged',
] as const;
export type EvictionState = (typeof STATES)[number];

export const MOTIVOS = [
  'irrelevant',
  'conflict',
  'shift',
  'low_roi',
  'quota',
  'expired',
  'user_purge',
  'security',
] as const;
export type EvictionMotivo = (typeof MOTIVOS)[number];

export const OUTCOMES = [
  'applied',
  'blocked_by_protection',
  'blocked_by_hook',
  'trigger_fired_no_action',
] as const;
export type EvictionOutcome = (typeof OUTCOMES)[number];

export const ACTORS = ['loop_cold', 'compaction', 'user', 'hook', 'startup_probe'] as const;
export type EvictionActor = (typeof ACTORS)[number];

// ─── state machine ───────────────────────────────────────────────────

// Transitions table per EVICTION §4.1. Map: from-state → to-state →
// allowed motivos. `'any'` means the from→to pair has no motivo
// restriction (admission gate, restore from evicted, etc.). An
// absent key means the transition is illegal.
//
// Same-state transitions (from === to) are ALWAYS allowed at the
// type level — they represent `trigger_fired_no_action` /
// `blocked_by_*` outcomes where the trigger fired but the state
// didn't actually change. The validator handles that branch
// before consulting this table.
//
// `* → purged` from §4.1 last row applies to {active, shadow,
// quarantined, invalidated, evicted} all gated on `user_purge` or
// `security`. Encoded explicitly per from-state instead of a
// wildcard so a future state addition has to be considered
// (no silent inheritance into purged).
const LEGAL_TRANSITIONS: Record<
  EvictionState,
  Partial<Record<EvictionState, EvictionMotivo[] | 'any'>>
> = {
  proposed: {
    active: 'any',
    evicted: ['irrelevant', 'low_roi'],
    purged: ['user_purge', 'security'],
  },
  active: {
    shadow: ['shift'],
    quarantined: ['conflict', 'low_roi'],
    invalidated: ['shift', 'security'],
    purged: ['user_purge', 'security'],
  },
  shadow: {
    active: 'any',
    quarantined: ['conflict'],
    purged: ['user_purge', 'security'],
  },
  quarantined: {
    active: 'any',
    evicted: ['low_roi', 'conflict'],
    invalidated: ['shift'],
    purged: ['user_purge', 'security'],
  },
  invalidated: {
    evicted: ['shift'],
    purged: ['user_purge', 'security'],
  },
  evicted: {
    active: 'any',
    purged: ['expired', 'user_purge', 'security'],
  },
  // `purged` is terminal. No outgoing transitions; forensic data
  // (eviction_events metadata) is what survives.
  purged: {},
};

export interface LegalCheckOk {
  ok: true;
}
export interface LegalCheckFail {
  ok: false;
  reason: string;
}
export type LegalCheck = LegalCheckOk | LegalCheckFail;

// Validate a (from, to, motivo) tuple against the state machine.
// Pure: no DB access, no side effects. Callers use it before
// appendEvictionEvent to surface structured errors; the
// repo-side append will re-run the same check as defense-in-
// depth — a caller that bypasses this helper still can't INSERT
// an illegal row.
//
// Same-state pseudo-transitions (from === to) represent
// `trigger_fired_no_action` / `blocked_by_*` outcomes — the
// trigger fired with a real motivo but the state didn't move.
// Motivo MUST still be valid for some real transition out of
// `from`, otherwise forensic queries land semantic garbage
// (e.g., a `from=active to=active motivo=expired` row implies
// an expired-trigger that the active state machine doesn't
// admit). Without this guard, callers could record motivo
// /trigger combinations the substrate never actually supports.
export const isLegalTransition = (
  from: EvictionState,
  to: EvictionState,
  motivo: EvictionMotivo,
): LegalCheck => {
  if (from === to) {
    const transitionsOut = LEGAL_TRANSITIONS[from];
    for (const allowed of Object.values(transitionsOut)) {
      if (allowed === 'any') return { ok: true };
      if (allowed?.includes(motivo)) return { ok: true };
    }
    return {
      ok: false,
      reason: `illegal motivo '${motivo}' for same-state ${from} (no real transition out of ${from} admits this motivo)`,
    };
  }
  const allowed = LEGAL_TRANSITIONS[from][to];
  if (allowed === undefined) {
    return { ok: false, reason: `illegal transition: ${from} → ${to}` };
  }
  if (allowed === 'any') return { ok: true };
  if (!allowed.includes(motivo)) {
    return {
      ok: false,
      reason: `illegal motivo '${motivo}' for ${from} → ${to} (expected one of: ${allowed.join(', ')})`,
    };
  }
  return { ok: true };
};

// Thrown by appendEvictionEvent when isLegalTransition rejected.
// Callers that want to surface "state machine refused" distinctly
// from "DB CHECK violated" pattern-match on this class.
export class IllegalTransitionError extends Error {
  readonly from: EvictionState;
  readonly to: EvictionState;
  readonly motivo: EvictionMotivo;
  constructor(from: EvictionState, to: EvictionState, motivo: EvictionMotivo, reason: string) {
    super(`eviction_events: ${reason}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
    this.motivo = motivo;
  }
}

// Thrown by appendEvictionEvent when the input shape violates a
// non-state-machine invariant (e.g. purgeAt supplied for a
// to_state that isn't 'evicted'). Distinct class from
// IllegalTransitionError so UI/audit consumers can disambiguate
// "state machine refused" from "caller passed an incoherent
// shape".
export class InvalidEvictionInputError extends Error {
  readonly field: string;
  constructor(field: string, reason: string) {
    super(`eviction_events: invalid ${field}: ${reason}`);
    this.name = 'InvalidEvictionInputError';
    this.field = field;
  }
}

// ─── evidence_json sanitizer ─────────────────────────────────────────

// Cycle guard sentinel — symmetric with failures/scrub.ts.
const CYCLE_SENTINEL = '__forja_cycle__';

// Two-pass scrub on a single string: telemetry redactor
// (paths/hosts/IPs/URLs/SSH refs) AND secret-pattern redactor
// (credential shapes from memory/scanner.ts). Order doesn't
// matter — neither pass produces output that the other matches —
// but both are needed because they cover disjoint vocabularies.
const scrubString = (s: string): string => redactSecrets(scrubFreeformText(s));

// Walk the object tree applying scrubString to every string
// value. Keys are vocabulary (operator doesn't control them — see
// EVICTION §6.1's per-motivo evidence schema), so they pass
// through untouched. Same shape as scrubFailurePayload in
// src/failures/scrub.ts; lifted into a per-repo helper here
// because adding a full sink wrapper for one repo would be
// premature surface.
const scrubStringsRecursive = (value: unknown, seen: WeakSet<object>): unknown => {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return CYCLE_SENTINEL;
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => scrubStringsRecursive(v, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = scrubStringsRecursive(v, seen);
  }
  return out;
};

// AUDIT.md §1 declares eviction_events.evidence_json as
// medium-sensitivity with required redaction. Owners (memory,
// policy, etc.) pass operator-bearing strings — paths, identifier
// fragments, hostnames in shift fingerprints, occasionally token
// fragments in security-purge evidence. Without scrub, those
// land verbatim and live 365d.
//
// We parse the JSON, walk every string value through the
// telemetry-grade redactor (scrubFreeformText), and re-serialize.
// Malformed JSON is treated as opaque text and replaced with a
// marker object so the row still persists (forensics needs the
// transition recorded; the un-parseable payload is the warning).
//
// No size cap here — EVICTION §6.1 declares small per-motivo
// schemas (tokens/load_bearing_count/ratio for low_roi;
// fingerprint hashes for shift). A future writer that violates
// the schema by dumping unbounded text gets a "bug at the
// source" outcome; the audit row itself isn't the place to
// truncate.
const scrubEvidenceJson = (raw: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return JSON.stringify({ _scrubbed_invalid_json: scrubString(raw) });
  }
  const scrubbed = scrubStringsRecursive(parsed, new WeakSet());
  return JSON.stringify(scrubbed);
};

// ─── row + input shapes ──────────────────────────────────────────────

export interface EvictionEvent {
  id: string;
  parentId: string | null;
  substrate: EvictionSubstrate;
  objectId: string;
  objectScope: string;
  fromState: EvictionState;
  toState: EvictionState;
  trigger: string;
  motivo: EvictionMotivo;
  evidenceJson: string;
  outcome: EvictionOutcome;
  blockedBy: string | null;
  actor: EvictionActor;
  sessionId: string | null;
  dependentsJson: string | null;
  recordedAt: number;
  purgeAt: number | null;
}

interface EvictionEventRow {
  id: string;
  parent_id: string | null;
  substrate: EvictionSubstrate;
  object_id: string;
  object_scope: string;
  from_state: EvictionState;
  to_state: EvictionState;
  trigger: string;
  motivo: EvictionMotivo;
  evidence_json: string;
  outcome: EvictionOutcome;
  blocked_by: string | null;
  actor: EvictionActor;
  session_id: string | null;
  dependents_json: string | null;
  recorded_at: number;
  purge_at: number | null;
}

const PERSISTED_COLUMNS = [
  'id',
  'parent_id',
  'substrate',
  'object_id',
  'object_scope',
  'from_state',
  'to_state',
  'trigger',
  'motivo',
  'evidence_json',
  'outcome',
  'blocked_by',
  'actor',
  'session_id',
  'dependents_json',
  'recorded_at',
  'purge_at',
] as const;

const PLACEHOLDERS = PERSISTED_COLUMNS.map(() => '?').join(', ');
const COLUMN_LIST = PERSISTED_COLUMNS.join(', ');
const INSERT_SQL = `INSERT INTO eviction_events (${COLUMN_LIST}) VALUES (${PLACEHOLDERS})`;

const SELECT_ALL = `SELECT id, parent_id, substrate, object_id, object_scope,
       from_state, to_state, trigger, motivo, evidence_json,
       outcome, blocked_by, actor, session_id, dependents_json,
       recorded_at, purge_at
  FROM eviction_events`;

const fromRow = (row: EvictionEventRow): EvictionEvent => ({
  id: row.id,
  parentId: row.parent_id,
  substrate: row.substrate,
  objectId: row.object_id,
  objectScope: row.object_scope,
  fromState: row.from_state,
  toState: row.to_state,
  trigger: row.trigger,
  motivo: row.motivo,
  evidenceJson: row.evidence_json,
  outcome: row.outcome,
  blockedBy: row.blocked_by,
  actor: row.actor,
  sessionId: row.session_id,
  dependentsJson: row.dependents_json,
  recordedAt: row.recorded_at,
  purgeAt: row.purge_at,
});

const valuesForInsert = (row: EvictionEventRow): SQLQueryBindings[] =>
  PERSISTED_COLUMNS.map((col) => {
    const v = (row as unknown as Record<string, unknown>)[col];
    return (v ?? null) as SQLQueryBindings;
  });

export interface AppendEvictionEventInput {
  substrate: EvictionSubstrate;
  objectId: string;
  objectScope: string;
  fromState: EvictionState;
  toState: EvictionState;
  trigger: string;
  motivo: EvictionMotivo;
  // Already-serialized JSON payload tailored to the motivo per
  // §6.1. Repo doesn't parse — it just persists.
  evidenceJson: string;
  outcome: EvictionOutcome;
  actor: EvictionActor;
  // Optional: deterministic id (replay/import). Defaults to UUID.
  id?: string;
  parentId?: string | null;
  blockedBy?: string | null;
  sessionId?: string | null;
  dependentsJson?: string | null;
  recordedAt?: number;
  // When `toState === 'evicted'`, the timestamp the retention
  // window ends and the row should transition to `purged`.
  // Callers compute per-substrate retention defaults (memory
  // 30d / 7d invalidated, policy 14d) per EVICTION §7.1.
  purgeAt?: number | null;
}

// Validate the (from, to, motivo) tuple and INSERT. Throws
// IllegalTransitionError if the state machine refuses; throws
// InvalidEvictionInputError if `purgeAt` is supplied for a
// `toState` that isn't 'evicted' (the column only carries
// meaning in that case — a non-null value elsewhere is a
// caller-shape bug, surfaced loud).
//
// evidence_json passes through `scrubEvidenceJson` before INSERT
// per AUDIT.md §1 sensitivity = medium + redact. Walks every
// string in the parsed JSON and applies the canonical
// telemetry redactor (paths, hosts, tokens, SSH/URL shapes).
// Malformed JSON gets replaced with a marker object so the row
// still persists.
export const appendEvictionEvent = (db: DB, input: AppendEvictionEventInput): EvictionEvent => {
  const check = isLegalTransition(input.fromState, input.toState, input.motivo);
  if (!check.ok) {
    throw new IllegalTransitionError(input.fromState, input.toState, input.motivo, check.reason);
  }
  if (input.toState !== 'evicted' && input.purgeAt !== undefined && input.purgeAt !== null) {
    throw new InvalidEvictionInputError(
      'purgeAt',
      `only valid when toState === 'evicted' (got toState='${input.toState}')`,
    );
  }
  const id = input.id ?? crypto.randomUUID();
  const recordedAt = input.recordedAt ?? Date.now();
  const purgeAt = input.toState === 'evicted' ? (input.purgeAt ?? null) : null;
  const scrubbedEvidence = scrubEvidenceJson(input.evidenceJson);
  const row: EvictionEventRow = {
    id,
    parent_id: input.parentId ?? null,
    substrate: input.substrate,
    object_id: input.objectId,
    object_scope: input.objectScope,
    from_state: input.fromState,
    to_state: input.toState,
    trigger: input.trigger,
    motivo: input.motivo,
    evidence_json: scrubbedEvidence,
    outcome: input.outcome,
    blocked_by: input.blockedBy ?? null,
    actor: input.actor,
    session_id: input.sessionId ?? null,
    dependents_json: input.dependentsJson ?? null,
    recorded_at: recordedAt,
    purge_at: purgeAt,
  };
  db.query(INSERT_SQL).run(...valuesForInsert(row));
  return fromRow(row);
};

// ─── queries (per §10.2) ─────────────────────────────────────────────

// Last eviction event for a (substrate, object_id) — answers "what
// is the current state, and why did it land there?" without
// scanning the full history. Ordering by recorded_at DESC, then
// rowid DESC as a monotonic tiebreaker when two events share the
// same millisecond timestamp. SQLite assigns rowid monotonically
// per INSERT for rowid tables (this table uses TEXT PRIMARY KEY,
// so it has the hidden rowid); since eviction_events is
// append-only (no DELETEs from the repo surface; retention sweep
// is a future slice), rowid reuse can't happen and the ordering
// is deterministic. Earlier versions used `id DESC` (UUID v4)
// which produced random tiebreaks and surfaced as test flakes.
// Backed by idx_evict_obj.
export const getLastEvictionForObject = (
  db: DB,
  substrate: EvictionSubstrate,
  objectId: string,
): EvictionEvent | null => {
  const row = db
    .query<EvictionEventRow, [EvictionSubstrate, string]>(
      `${SELECT_ALL}
        WHERE substrate = ? AND object_id = ?
        ORDER BY recorded_at DESC, rowid DESC
        LIMIT 1`,
    )
    .get(substrate, objectId);
  return row !== null ? fromRow(row) : null;
};

// All currently-evicted rows whose retention window hasn't yet
// expired ("what could still be restored?"). Backed by
// idx_evict_purge (partial index on purge_at IS NOT NULL).
// Default ordering by recorded_at DESC, rowid DESC (monotonic
// tiebreaker — same rationale as getLastEvictionForObject).
export const listEvictableInWindow = (db: DB, nowMs: number): EvictionEvent[] => {
  const rows = db
    .query<EvictionEventRow, [number]>(
      `${SELECT_ALL}
        WHERE to_state = 'evicted' AND purge_at IS NOT NULL AND purge_at > ?
        ORDER BY recorded_at DESC, rowid DESC`,
    )
    .all(nowMs);
  return rows.map(fromRow);
};

// Rows whose retention window has expired — input to the GC sweep
// that materializes the `evicted → purged` transition. Ordered
// oldest-first so the sweep can batch a fixed prefix; rowid is
// the monotonic tiebreaker when purge_at ties.
export const listEvictedDueForPurge = (db: DB, nowMs: number): EvictionEvent[] => {
  const rows = db
    .query<EvictionEventRow, [number]>(
      `${SELECT_ALL}
        WHERE to_state = 'evicted' AND purge_at IS NOT NULL AND purge_at <= ?
        ORDER BY purge_at ASC, rowid ASC`,
    )
    .all(nowMs);
  return rows.map(fromRow);
};

export interface TriggerThrashingRow {
  substrate: EvictionSubstrate;
  objectId: string;
  trigger: string;
  count: number;
}

// "Trigger fired N times without action" — diagnostic surface for
// EVICTION §10.2. A trigger that keeps firing but never advances
// past the evidence gate is usually a sign of a misconfigured
// threshold or a flapping signal. `minCount` defaults to 5
// (spec query example).
export const detectTriggerThrashing = (
  db: DB,
  sinceMs: number,
  minCount = 5,
): TriggerThrashingRow[] => {
  return db
    .query<TriggerThrashingRow, [number, number]>(
      `SELECT substrate, object_id AS objectId, trigger, COUNT(*) AS count
         FROM eviction_events
        WHERE outcome = 'trigger_fired_no_action' AND recorded_at > ?
        GROUP BY substrate, object_id, trigger
        HAVING count >= ?
        ORDER BY count DESC, substrate ASC, object_id ASC`,
    )
    .all(sinceMs, minCount);
};

// Count of eviction events. Cheap O(1) when used for tests /
// health checks; not indexed but the table size is bounded by
// retention (365d in AUDIT.md §1.2).
export const countEvictionEvents = (db: DB): number => {
  const row = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM eviction_events').get() as {
    n: number;
  };
  return row.n;
};

export { LEGAL_TRANSITIONS, PERSISTED_COLUMNS };
