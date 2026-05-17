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

// Who emitted the eviction event. Forensic queries filter on this
// column to answer "did the operator drive this, or did the system
// auto-evict?" The protection-gate bypass (memory/protections.ts)
// uses `actor === 'user'` as the authorization signal — user-driven
// transitions skip cooldown/TTL guards because the operator's
// command IS the consent. New actors require auditing every caller
// of `checkProtectionGates` before adding (silent inheritance of
// the user bypass into a non-user actor would defeat the gate).
//
// Roster:
//   - loop_cold:      adaptation pipeline (loop frio §3.2)
//   - compaction:     context-engine slot reclaiming
//   - user:           operator command — protection-gate bypass
//   - hook:           hook fire that produced a refusal row
//   - startup_probe:  boot-time consistency sweep
export const ACTORS = ['loop_cold', 'compaction', 'user', 'hook', 'startup_probe'] as const;
export type EvictionActor = (typeof ACTORS)[number];

// ─── canonical trigger names ─────────────────────────────────────────
//
// Trigger strings live in `eviction_events.trigger` (TEXT) and in
// `memory_events.details.trigger` (JSONB). They distinguish operator
// commands from auto-detector firings in forensic queries —
// `/memory audit --trigger operator` matches `OPERATOR_DRIVEN_TRIGGER`;
// `--trigger detector` matches every entry in `DETECTOR_TRIGGERS`.
//
// Single source of truth so the slash command's filter set, the slash
// command's quarantine emit path, and the future Slices 2-5 detector
// implementations all agree on the same strings. A new detector lands
// here AND in its emit site; a typo in either fails forensics
// silently (visible only when the operator runs `--trigger detector`
// and notices the missing row).

// String emitted by every manual transition driven from a slash
// command (`/memory quarantine`, `/memory delete`). Distinguishes
// operator action from detector firings (which use the names below).
export const OPERATOR_DRIVEN_TRIGGER = 'operator_driven';

// The 4 auto-detector triggers spec'd in MEMORY.md §6.5.2 +
// EVICTION.md §5.1. Slices 2-5 of feat/memory-lifecycle-detectors
// emit these; the `/memory audit --trigger detector` semantic
// shortcut matches against this set. Adding a new memory-side
// detector MUST extend this set (build does not fail otherwise —
// the operator just won't see the new rows under the shortcut).
export const DETECTOR_TRIGGERS = [
  'verify_failed',
  'user_override_repeated',
  'conflict_detected',
  'trust_revoked',
] as const;
export type DetectorTrigger = (typeof DETECTOR_TRIGGERS)[number];

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

// ─── evidence_json schema validation (EVICTION §6.1) ────────────────
//
// Each motivo declares an evidence shape; the repo validates the
// caller's payload against the shape at INSERT time. Owners (memory
// triggers, policy detectors, slot compaction) construct the
// evidence upstream and call appendEvictionEvent with the full
// payload — the repo's job is to ensure the SHAPE is correct so
// forensic queries (`SELECT evidence_json->>'$.shift_score' FROM
// eviction_events`) don't have to defend against missing-field
// surprises.
//
// What this gate is NOT: the THRESHOLD gate (§6.1's "evidence
// abaixo do gate ⇒ trigger_fired_no_action"). Threshold checks are
// the upstream owner's job — the detector that observed
// `usage_count === 0 over N=20 queries` constructs the evidence
// AFTER passing its own gate. The repo trusts that contract.
//
// What this gate IS: structural validation. Required fields
// present, types correct. A trigger detector that forgot to pass
// `tokens_consumed` for a low_roi eviction is a bug at the source;
// the audit row should never land with that shape because forensic
// queries would mis-fire silently.
//
// Operator-driven paths (`/memory delete`, `/memory restore`, boot
// GC) use closest-fit motivos that don't really represent the
// trigger semantics — they're documented spec deviations. They
// pass a structurally-valid evidence payload with a
// `_operator_driven: true` marker so consumers filtering for
// "real" trigger evidence can exclude them. Spec amendment to
// admit `user_purge`/`expired` motivos on these transitions
// would obviate the marker. Until then, the marker is the bridge.

// Required fields per motivo, per §6.1. Each entry lists the field
// names + the value-shape predicate. A `_operator_driven: true`
// marker bypasses ALL required-field checks (operator paths don't
// have measurable triggers — the operator's command IS the
// evidence). This is structural validation; spec §6.1 threshold
// numbers (N=20 for irrelevant, N=30 for low_roi) are the
// upstream owner's responsibility.
type FieldPredicate = (value: unknown) => boolean;

const isNumber: FieldPredicate = (v) => typeof v === 'number' && Number.isFinite(v);
const isString: FieldPredicate = (v) => typeof v === 'string' && v.length > 0;
const isAnyShape: FieldPredicate = () => true;

interface EvidenceSchema {
  // One or more "required fields" sets. Validation passes if AT
  // LEAST ONE set is satisfied. `conflict` uses this — either the
  // `{winner_id, loser_id, conflict_kind}` shape (detected
  // conflict) OR the `{failures}` shape (failure burst).
  oneOf: { required: Record<string, FieldPredicate> }[];
}

// Per EVICTION §6.1 evidence schemas. Each motivo declares the
// minimum shape its upstream trigger must produce. Empty `oneOf`
// (e.g. `quota` — see below) means caller can pass any shape,
// useful when the trigger evidence is owner-specific and the
// repo doesn't have a meaningful invariant to check.
const EVIDENCE_SCHEMAS: Record<EvictionMotivo, EvidenceSchema> = {
  irrelevant: {
    // usage_count over N consultas, both numeric. Upstream gate is
    // usage_rate === 0 with N >= 20 (§6.1).
    oneOf: [{ required: { usage_count: isNumber, sample_size: isNumber } }],
  },
  conflict: {
    // Either a detected pair-conflict OR a failure-burst.
    oneOf: [
      {
        required: {
          winner_id: isString,
          loser_id: isString,
          conflict_kind: isString,
        },
      },
      { required: { failures: isNumber } },
    ],
  },
  shift: {
    // Binary shift score above threshold (§6.1 — shift_score > 0.3
    // is the upstream owner's gate; we just require the field).
    oneOf: [{ required: { shift_score: isNumber } }],
  },
  low_roi: {
    // Tokens × load-bearing × ratio. Upstream gate is ROI <
    // threshold with N >= 30 (§6.1 + §6.5).
    oneOf: [
      {
        required: {
          tokens_consumed: isNumber,
          load_bearing_count: isNumber,
          ratio: isNumber,
        },
      },
    ],
  },
  quota: {
    // Budget vs cost. Upstream gate is item_cost > slot_budget.
    oneOf: [{ required: { slot_budget: isNumber, item_cost: isNumber } }],
  },
  expired: {
    // `expires < now()` per §6.1. The frontmatter value is the
    // evidence — repo preserves the operator-set date so audit
    // forensics can answer "what was the original lifetime?".
    oneOf: [{ required: { expires: isString } }],
  },
  user_purge: {
    // N=1 operator command. Spec doesn't declare a structured
    // shape — the eviction IS the evidence. Accept any payload
    // (including empty `{}`) by listing a no-op required set.
    oneOf: [{ required: {} }],
  },
  security: {
    // Hook block OR pattern match. trigger_source field
    // distinguishes the two sources downstream.
    oneOf: [{ required: { trigger_source: isString } }],
  },
};

// Special marker that bypasses required-field checks. Used by
// operator-driven paths that emit closest-fit motivos (`/memory
// delete` uses low_roi; gcExpiredMemories uses low_roi). The
// marker tells the validator "this is a closest-fit; the real
// evidence is the operator command, recorded in the trigger
// field instead". Spec amendment to admit user_purge/expired on
// the right transitions would obviate this.
const OPERATOR_DRIVEN_MARKER = '_operator_driven';

interface EvidenceValidation {
  ok: boolean;
  // When !ok, the list of which oneOf-set failed and why. Empty
  // when ok or when caller used the operator marker bypass.
  failures: { setIndex: number; missingOrInvalid: string[] }[];
}

// Validate evidence shape per motivo schema. Returns { ok: true }
// when at least one `oneOf` required set is satisfied (or when
// the operator marker is set). Returns { ok: false } with
// per-set failure detail so the thrown error message can be
// specific.
const validateEvidenceShape = (motivo: EvictionMotivo, evidence: unknown): EvidenceValidation => {
  // Operator-driven bypass — the closest-fit motivo doesn't have
  // its canonical evidence to validate against.
  if (
    evidence !== null &&
    typeof evidence === 'object' &&
    (evidence as Record<string, unknown>)[OPERATOR_DRIVEN_MARKER] === true
  ) {
    return { ok: true, failures: [] };
  }
  const schema = EVIDENCE_SCHEMAS[motivo];
  // Non-object evidence (string, number, null, array) fails
  // structurally — the JSON must be an object.
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return {
      ok: false,
      failures: schema.oneOf.map((_set, i) => ({
        setIndex: i,
        missingOrInvalid: ['<root>: evidence must be a JSON object'],
      })),
    };
  }
  const obj = evidence as Record<string, unknown>;
  const setFailures: { setIndex: number; missingOrInvalid: string[] }[] = [];
  for (let i = 0; i < schema.oneOf.length; i++) {
    const set = schema.oneOf[i];
    if (set === undefined) continue;
    const missing: string[] = [];
    for (const [field, predicate] of Object.entries(set.required)) {
      if (predicate === isAnyShape) continue;
      if (!Object.hasOwn(obj, field) || !predicate(obj[field])) {
        missing.push(field);
      }
    }
    if (missing.length === 0) return { ok: true, failures: [] };
    setFailures.push({ setIndex: i, missingOrInvalid: missing });
  }
  return { ok: false, failures: setFailures };
};

// Re-export marker for callers that pass closest-fit motivos.
export const OPERATOR_DRIVEN_EVIDENCE_MARKER = OPERATOR_DRIVEN_MARKER;
export { EVIDENCE_SCHEMAS };

// Pre-flight evidence validation for callers that want to refuse
// invalid input BEFORE side-effects (disk writes, hook fires).
// Mirror of the in-repo check appendEvictionEvent runs at INSERT
// time. Pure: no DB, no throw. Returns { ok: true } when the
// evidence shape satisfies §6.1 schema for `motivo`, or
// { ok: false, reason } with a structured failure message.
//
// Use case: `transitionMemoryState` calls this BEFORE
// `applyTransition` so a malformed evidence payload doesn't
// produce file/index mutations that the audit row would never
// witness. Repo-side validation stays as defense-in-depth (a
// caller that bypasses this helper still can't INSERT an invalid
// row).
export interface PreflightEvidenceResult {
  ok: boolean;
  reason: string | null;
}

export const preflightValidateEvidence = (
  motivo: EvictionMotivo,
  evidenceJson: string,
): PreflightEvidenceResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(evidenceJson);
  } catch {
    // Malformed JSON is the scrub layer's concern — let it through
    // so the audit row can land with a `_scrubbed_invalid_json`
    // marker. Same exemption appendEvictionEvent applies.
    return { ok: true, reason: null };
  }
  const v = validateEvidenceShape(motivo, parsed);
  if (v.ok) return { ok: true, reason: null };
  const sets = v.failures
    .map((f) => `set #${f.setIndex} (missing/invalid: ${f.missingOrInvalid.join(', ')})`)
    .join('; ');
  return {
    ok: false,
    reason: `evidence shape doesn't satisfy schema for motivo '${motivo}': ${sets}`,
  };
};

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
  // Evidence schema validation (§6.1). Outcomes that don't represent
  // a real transition (`blocked_by_hook`, `blocked_by_protection`,
  // `trigger_fired_no_action`) are exempt — those rows record the
  // attempted gate, not the substrate's evidence. The evidence on
  // those rows is owner-specific bookkeeping (the hook spec ref,
  // the protection name, the trigger source), which would fail
  // structural checks for the proposed motivo.
  //
  // Malformed JSON skips the validator and falls through to
  // scrubEvidenceJson, which replaces the payload with a
  // `_scrubbed_invalid_json` marker so the row still persists.
  // The validator's job is shape conformance per §6.1, not JSON
  // parse correctness — those are separate concerns.
  if (input.outcome === 'applied') {
    let parsedEvidence: unknown;
    let jsonOk = true;
    try {
      parsedEvidence = JSON.parse(input.evidenceJson);
    } catch {
      jsonOk = false;
    }
    if (jsonOk) {
      const validation = validateEvidenceShape(input.motivo, parsedEvidence);
      if (!validation.ok) {
        const sets = validation.failures
          .map((f) => `set #${f.setIndex} (missing/invalid: ${f.missingOrInvalid.join(', ')})`)
          .join('; ');
        throw new InvalidEvictionInputError(
          'evidence_json',
          `evidence shape doesn't satisfy schema for motivo '${input.motivo}': ${sets}`,
        );
      }
    }
  }
  // Non-applied outcome markers. Same-state pseudo-transitions and
  // refusals don't run the §6.1 shape validator (their evidence is
  // owner-specific bookkeeping, not motivo-canonical), but they MUST
  // carry SOME structural marker so forensic queries can distinguish
  // a real probe / hook block from a caller that forgot to set
  // anything. Without a marker, audit rows land empty `{}` payloads
  // with `blocked_by IS NULL` and no upstream cause is recoverable.
  //
  // Markers per outcome:
  //   - blocked_by_protection / blocked_by_hook → `blockedBy` column
  //     non-empty (names the specific guard).
  //   - trigger_fired_no_action → evidence has either `trigger_source`
  //     (string) OR `_operator_driven: true`. The first marks "real
  //     trigger fire without threshold passing"; the second marks an
  //     operator-driven path that doesn't have a canonical trigger
  //     source (e.g., a probe scheduled by `/memory metrics`).
  if (input.outcome === 'blocked_by_protection' || input.outcome === 'blocked_by_hook') {
    if (input.blockedBy === undefined || input.blockedBy === null || input.blockedBy === '') {
      throw new InvalidEvictionInputError(
        'blocked_by',
        `outcome '${input.outcome}' requires a non-empty blocked_by marker`,
      );
    }
  } else if (input.outcome === 'trigger_fired_no_action') {
    let parsedMarker: unknown;
    let markerJsonOk = true;
    try {
      parsedMarker = JSON.parse(input.evidenceJson);
    } catch {
      markerJsonOk = false;
    }
    // Malformed JSON falls through to scrubEvidenceJson which writes
    // a `_scrubbed_invalid_json` marker — that itself acts as a
    // forensic anchor, so we don't refuse here. Same exemption the
    // shape validator above applies.
    if (markerJsonOk) {
      const isObject =
        parsedMarker !== null && typeof parsedMarker === 'object' && !Array.isArray(parsedMarker);
      const hasMarker = (() => {
        if (!isObject) return false;
        const obj = parsedMarker as Record<string, unknown>;
        if (obj[OPERATOR_DRIVEN_MARKER] === true) return true;
        const ts = obj.trigger_source;
        return typeof ts === 'string' && ts.length > 0;
      })();
      if (!hasMarker) {
        throw new InvalidEvictionInputError(
          'evidence_json',
          `outcome 'trigger_fired_no_action' requires evidence with either 'trigger_source' (string) or '${OPERATOR_DRIVEN_MARKER}: true' marker`,
        );
      }
    }
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
//
// `objectScope` is REQUIRED — object_ids are not globally unique
// across scopes (memory names repeat between user / project_local /
// project_shared; policy ids repeat between session / repo / etc.).
// Filtering by scope ensures the lookup answers "what was the last
// event for THIS specific object" instead of "what was the last
// event for any object with this name in any scope".
export const getLastEvictionForObject = (
  db: DB,
  substrate: EvictionSubstrate,
  objectId: string,
  objectScope: string,
): EvictionEvent | null => {
  const row = db
    .query<EvictionEventRow, [EvictionSubstrate, string, string]>(
      `${SELECT_ALL}
        WHERE substrate = ? AND object_id = ? AND object_scope = ?
        ORDER BY recorded_at DESC, rowid DESC
        LIMIT 1`,
    )
    .get(substrate, objectId, objectScope);
  return row !== null ? fromRow(row) : null;
};

// Last APPLIED eviction event for a (substrate, object_id) —
// answers "what state did this actually land in?", filtering out
// `trigger_fired_no_action` / `blocked_by_hook` / `blocked_by_
// protection` rows that recorded an attempted gate without a real
// state change. Distinct from getLastEvictionForObject which
// returns the latest row regardless of outcome.
//
// Use this when the caller cares about the object's CURRENT
// effective state (e.g., the GC sweep deciding whether a purge
// candidate is still authoritative): the most-recent applied row
// IS the current state. A row with outcome='trigger_fired_no_
// action' between the purge candidate and now does NOT mean the
// object moved on — it means a probe trigger fired but evidence
// didn't pass. Using getLastEvictionForObject's bare "latest"
// would mask the purge candidate and storage grows unbounded.
// `objectScope` is REQUIRED — memory names can repeat across
// scopes (`user_role` in user-scope AND in project_local-scope are
// independent objects). Without scope-filtering, a newer applied
// event for the same name in a different scope would shadow the
// purge candidate's scope and skip retention indefinitely.
export const getLastAppliedEvictionForObject = (
  db: DB,
  substrate: EvictionSubstrate,
  objectId: string,
  objectScope: string,
): EvictionEvent | null => {
  const row = db
    .query<EvictionEventRow, [EvictionSubstrate, string, string]>(
      `${SELECT_ALL}
        WHERE substrate = ? AND object_id = ? AND object_scope = ?
          AND outcome = 'applied'
        ORDER BY recorded_at DESC, rowid DESC
        LIMIT 1`,
    )
    .get(substrate, objectId, objectScope);
  return row !== null ? fromRow(row) : null;
};

// All currently-evicted rows whose retention window hasn't yet
// expired ("what could still be restored?"). Backed by
// idx_evict_purge (partial index on purge_at IS NOT NULL).
// Default ordering by recorded_at DESC, rowid DESC (monotonic
// tiebreaker — same rationale as getLastEvictionForObject).
// List recent eviction events by trigger source. Used by the
// `/memory conflicts` slash (S4/T4.4) to surface
// `conflict_detected` pairs forensically. Returns applied
// outcomes only (the pair operator wants to see is the
// quarantine that DID happen, not refused attempts).
//
// Cross-session by design: conflict history is operator-relevant
// forensic data, not session-scoped state. Bounded by `limit`
// (default 50 matches the slice convention from S0).
export const listEvictionEventsByTrigger = (
  db: DB,
  trigger: string,
  limit = 50,
): EvictionEvent[] => {
  const rows = db
    .query<EvictionEventRow, [string, number]>(
      `${SELECT_ALL}
        WHERE trigger = ? AND outcome = 'applied'
        ORDER BY recorded_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(trigger, limit);
  return rows.map(fromRow);
};

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
  // The scoped object's scope (memory: user / project_local /
  // project_shared; policies: session / repo / user / language /
  // global). REQUIRED on the grouping key — object_id is not
  // globally unique across scopes, so a same-name object in two
  // scopes would have its trigger counts merged, producing false
  // thrashing hits and distorted diagnostics.
  objectScope: string;
  trigger: string;
  count: number;
}

// "Trigger fired N times without action" — diagnostic surface for
// EVICTION §10.2. A trigger that keeps firing but never advances
// past the evidence gate is usually a sign of a misconfigured
// threshold or a flapping signal. `minCount` defaults to 5
// (spec query example).
//
// Aggregation key includes `object_scope` so each scoped object is
// evaluated independently — `(memory, foo, user, low_roi_probe)`
// and `(memory, foo, project_local, low_roi_probe)` are two
// thrashing surfaces, not one merged bucket.
export const detectTriggerThrashing = (
  db: DB,
  sinceMs: number,
  minCount = 5,
): TriggerThrashingRow[] => {
  return db
    .query<TriggerThrashingRow, [number, number]>(
      `SELECT substrate, object_id AS objectId, object_scope AS objectScope,
              trigger, COUNT(*) AS count
         FROM eviction_events
        WHERE outcome = 'trigger_fired_no_action' AND recorded_at > ?
        GROUP BY substrate, object_id, object_scope, trigger
        HAVING count >= ?
        ORDER BY count DESC, substrate ASC, object_id ASC, object_scope ASC`,
    )
    .all(sinceMs, minCount);
};

// Count of eviction events. Cheap O(1) when used for tests /
// health checks; not indexed but the table size is bounded by
// retention (365d in AUDIT.md §1.2).
// Most-recent eviction event whose to_state is `quarantined` for
// (substrate, objectId), or null when the object has never been
// quarantined. Used by the quarantine min TTL protection gate
// (EVICTION §6.2) — refuses `quarantined → evicted` until the
// dwell time exceeds the configured minimum (default 7d).
//
// Returns the full event so the gate can compare `actor` and
// `trigger` against the current transition's values: when they
// match, the current eviction is the same decision chain as the
// quarantine (e.g., boot GC's active→quarantined→evicted runs
// both with actor='startup_probe' trigger='expired_at'), and the
// TTL is bypassed. When they differ, the protection applies —
// preventing a different automated process from fast-evicting
// memories someone else just quarantined.
//
// Strictness rationale: only `applied` rows count, not
// `trigger_fired_no_action` or `blocked_by_*` — those don't
// represent actual state changes, so they're not the start of a
// dwell period.
// `objectScope` is REQUIRED — memory names can repeat across
// scopes. Without scope-filtering, the quarantine TTL gate in
// transitionMemoryState would read a quarantine timestamp from a
// different scope sharing the same name, incorrectly blocking a
// valid transition (or incorrectly classifying it as same-chain).
export const getLastQuarantineEvent = (
  db: DB,
  substrate: EvictionSubstrate,
  objectId: string,
  objectScope: string,
): EvictionEvent | null => {
  const row = db
    .query<EvictionEventRow, [EvictionSubstrate, string, string]>(
      `${SELECT_ALL}
        WHERE substrate = ? AND object_id = ? AND object_scope = ?
          AND to_state = 'quarantined' AND outcome = 'applied'
        ORDER BY recorded_at DESC, rowid DESC
        LIMIT 1`,
    )
    .get(substrate, objectId, objectScope);
  return row !== null ? fromRow(row) : null;
};

// Mirror of `getLastQuarantineEvent` for invalidation transitions.
// Used by the `gcStaleInvalidatedMemories` sweep (S5 CRIT/V1) to
// determine when each invalidated memory crossed the 7-day window
// spec'd by EVICTION.md §7.1 + MEMORY.md §6.5.6 for progression
// to `evicted`. Without this, trust_revoked produces invalidated
// rows that stay on disk forever.
export const getLastInvalidationEvent = (
  db: DB,
  substrate: EvictionSubstrate,
  objectId: string,
  objectScope: string,
): EvictionEvent | null => {
  const row = db
    .query<EvictionEventRow, [EvictionSubstrate, string, string]>(
      `${SELECT_ALL}
        WHERE substrate = ? AND object_id = ? AND object_scope = ?
          AND to_state = 'invalidated' AND outcome = 'applied'
        ORDER BY recorded_at DESC, rowid DESC
        LIMIT 1`,
    )
    .get(substrate, objectId, objectScope);
  return row !== null ? fromRow(row) : null;
};

export const countEvictionEvents = (db: DB): number => {
  const row = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM eviction_events').get() as {
    n: number;
  };
  return row.n;
};

export { LEGAL_TRANSITIONS, PERSISTED_COLUMNS };
