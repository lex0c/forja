// outcomes repo (FEEDBACK_ADAPTATION §3.1).
//
// Generic operational outcome storage keyed by `action_signature` +
// `scope_kind`. Feeds the loop frio adaptation engine (§3.2). Distinct
// from `outcome_signals` (PERMISSION_ENGINE §6.3.2) — coexistence
// declared in AUDIT.md §1.1.1. Caller emits to one OR the other,
// never both.
//
// Public surface:
//
//   createOutcome(db, input)             → Outcome
//   listOutcomesByActionSignature(...)   → Outcome[]   (loop frio read)
//   listOutcomesBySession(db, sid)       → Outcome[]
//   countOutcomesByActionSignature(...)  → number      (accumulation trigger)
//   getLatestOutcomeForSignature(...)    → Outcome | null
//
// Shape mirrors memory_events / eviction_events pattern:
// PERSISTED_COLUMNS + valuesForInsert + SELECT_ALL + fromRow.
// Same idiom across audit-shaped repos keeps reading them
// predictable.

import type { SQLQueryBindings } from 'bun:sqlite';
import { redactSecrets } from '../../memory/index.ts';
import { scrubFreeformText } from '../../telemetry/scrubbing.ts';
import type { DB } from '../db.ts';

// ─── evidence_json scrub (AUDIT.md §1 medium sensitivity) ────────────
//
// outcomes.evidence_json carries tool errors, exit codes, duration,
// occasionally tool stderr fragments. AUDIT.md §1 declares the column
// medium-sensitivity with required redaction — operator paths,
// hostnames, accidentally-leaked tokens in tracebacks need to be
// scrubbed before persistence (90d retention default).
//
// Two-pass scrub mirrors eviction_events.ts (same sensitivity tier):
//   - scrubFreeformText: paths, hosts, IPs, URLs, SSH refs
//   - redactSecrets: credential-shaped patterns
//
// Order doesn't matter — disjoint vocabularies — but both are needed
// because they cover different threat surfaces.

const CYCLE_SENTINEL = '__forja_cycle__';

const scrubString = (s: string): string => redactSecrets(scrubFreeformText(s));

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

const scrubEvidenceJson = (raw: string | null): string | null => {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON: replace with a marker carrying the scrubbed
    // raw text. Same shape as eviction-events' fallback.
    return JSON.stringify({ _scrubbed_invalid_json: scrubString(raw) });
  }
  return JSON.stringify(scrubStringsRecursive(parsed, new WeakSet()));
};

// ─── enums + types ───────────────────────────────────────────────────

export const OUTCOME_TIERS = [1, 2, 3, 4, 5] as const;
export type OutcomeTier = (typeof OUTCOME_TIERS)[number];

export const OUTCOME_RESULTS = ['success', 'failure', 'partial', 'ambiguous'] as const;
export type OutcomeResult = (typeof OUTCOME_RESULTS)[number];

export const SCOPE_KINDS = ['global', 'language', 'repo', 'user', 'session'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export interface Outcome {
  id: string;
  sessionId: string;
  toolCallId: string;
  actionSignature: string;
  tier: OutcomeTier;
  result: OutcomeResult;
  evidenceJson: string | null;
  scopeKind: ScopeKind;
  scopeId: string;
  recordedAt: number;
}

interface OutcomeRow {
  id: string;
  session_id: string;
  tool_call_id: string;
  action_signature: string;
  tier: OutcomeTier;
  result: OutcomeResult;
  evidence_json: string | null;
  scope_kind: ScopeKind;
  scope_id: string;
  recorded_at: number;
}

const PERSISTED_COLUMNS = [
  'id',
  'session_id',
  'tool_call_id',
  'action_signature',
  'tier',
  'result',
  'evidence_json',
  'scope_kind',
  'scope_id',
  'recorded_at',
] as const;

const PLACEHOLDERS = PERSISTED_COLUMNS.map(() => '?').join(', ');
const COLUMN_LIST = PERSISTED_COLUMNS.join(', ');
const INSERT_SQL = `INSERT INTO outcomes (${COLUMN_LIST}) VALUES (${PLACEHOLDERS})`;

const SELECT_ALL = `SELECT id, session_id, tool_call_id, action_signature,
       tier, result, evidence_json, scope_kind, scope_id, recorded_at
  FROM outcomes`;

const fromRow = (row: OutcomeRow): Outcome => ({
  id: row.id,
  sessionId: row.session_id,
  toolCallId: row.tool_call_id,
  actionSignature: row.action_signature,
  tier: row.tier,
  result: row.result,
  evidenceJson: row.evidence_json,
  scopeKind: row.scope_kind,
  scopeId: row.scope_id,
  recordedAt: row.recorded_at,
});

const valuesForInsert = (row: OutcomeRow): SQLQueryBindings[] =>
  PERSISTED_COLUMNS.map((col) => {
    const v = (row as unknown as Record<string, unknown>)[col];
    return (v ?? null) as SQLQueryBindings;
  });

// ─── write ───────────────────────────────────────────────────────────

export interface CreateOutcomeInput {
  sessionId: string;
  toolCallId: string;
  actionSignature: string;
  tier: OutcomeTier;
  result: OutcomeResult;
  evidenceJson?: string | null;
  scopeKind: ScopeKind;
  scopeId: string;
  // Optional: deterministic id (replay/import). Defaults to UUID.
  id?: string;
  recordedAt?: number;
}

// INSERT an outcome row. Throws on DB error (CHECK violation, FK
// missing, etc.) — caller decides whether to surface or swallow.
// Same shape as createMemoryEvent: no validation beyond what the
// DB CHECK enforces; structural correctness is the emitter's
// responsibility.
export const createOutcome = (db: DB, input: CreateOutcomeInput): Outcome => {
  const id = input.id ?? crypto.randomUUID();
  const recordedAt = input.recordedAt ?? Date.now();
  // Scrub before persist (AUDIT.md §1 medium sensitivity). All
  // writers benefit — caller doesn't have to remember to scrub.
  const scrubbedEvidence = scrubEvidenceJson(input.evidenceJson ?? null);
  const row: OutcomeRow = {
    id,
    session_id: input.sessionId,
    tool_call_id: input.toolCallId,
    action_signature: input.actionSignature,
    tier: input.tier,
    result: input.result,
    evidence_json: scrubbedEvidence,
    scope_kind: input.scopeKind,
    scope_id: input.scopeId,
    recorded_at: recordedAt,
  };
  db.query(INSERT_SQL).run(...valuesForInsert(row));
  return fromRow(row);
};

// ─── queries ─────────────────────────────────────────────────────────

// Loop frio's primary read: every outcome for an action_signature
// in a specific scope, ordered most-recent first. The aggregator
// reads in chronological order to compute the Beta posterior
// (success/failure tally over time). Backed by idx_outcomes_action_
// scope.
export const listOutcomesByActionSignature = (
  db: DB,
  actionSignature: string,
  scopeKind: ScopeKind,
  scopeId: string,
  opts: { sinceMs?: number; limit?: number } = {},
): Outcome[] => {
  const sinceMs = opts.sinceMs ?? 0;
  if (opts.limit !== undefined) {
    const rows = db
      .query<OutcomeRow, [string, ScopeKind, string, number, number]>(
        `${SELECT_ALL}
          WHERE action_signature = ? AND scope_kind = ? AND scope_id = ?
            AND recorded_at >= ?
          ORDER BY recorded_at DESC, rowid DESC
          LIMIT ?`,
      )
      .all(actionSignature, scopeKind, scopeId, sinceMs, opts.limit);
    return rows.map(fromRow);
  }
  const rows = db
    .query<OutcomeRow, [string, ScopeKind, string, number]>(
      `${SELECT_ALL}
        WHERE action_signature = ? AND scope_kind = ? AND scope_id = ?
          AND recorded_at >= ?
        ORDER BY recorded_at DESC, rowid DESC`,
    )
    .all(actionSignature, scopeKind, scopeId, sinceMs);
  return rows.map(fromRow);
};

// "What happened in this session?" — debug + recap surface.
// Ordered most-recent first.
export const listOutcomesBySession = (db: DB, sessionId: string): Outcome[] => {
  const rows = db
    .query<OutcomeRow, [string]>(
      `${SELECT_ALL}
        WHERE session_id = ?
        ORDER BY recorded_at DESC, rowid DESC`,
    )
    .all(sessionId);
  return rows.map(fromRow);
};

// Loop frio's accumulation trigger gate. Cheap COUNT to decide
// whether to re-aggregate. Returns the count of outcomes for the
// (action_signature, scope_kind, scope_id) tuple since `sinceMs`
// (defaults to 0 = all-time). Trigger: count >= N (default 10).
export const countOutcomesByActionSignature = (
  db: DB,
  actionSignature: string,
  scopeKind: ScopeKind,
  scopeId: string,
  sinceMs = 0,
): number => {
  const row = db
    .query<{ n: number }, [string, ScopeKind, string, number]>(
      `SELECT COUNT(*) AS n FROM outcomes
        WHERE action_signature = ? AND scope_kind = ? AND scope_id = ?
          AND recorded_at >= ?`,
    )
    .get(actionSignature, scopeKind, scopeId, sinceMs);
  return row?.n ?? 0;
};

// Latest outcome for a signature in a scope — answers "what was the
// last thing we observed for this adaptation unit?". Used by
// dashboards + as a starting point for the loop frio's incremental
// re-aggregation.
export const getLatestOutcomeForSignature = (
  db: DB,
  actionSignature: string,
  scopeKind: ScopeKind,
  scopeId: string,
): Outcome | null => {
  const row = db
    .query<OutcomeRow, [string, ScopeKind, string]>(
      `${SELECT_ALL}
        WHERE action_signature = ? AND scope_kind = ? AND scope_id = ?
        ORDER BY recorded_at DESC, rowid DESC
        LIMIT 1`,
    )
    .get(actionSignature, scopeKind, scopeId);
  return row !== null ? fromRow(row) : null;
};

// Total row count — health check / test surface. Not indexed; bounded
// by retention (90d default per AUDIT.md §1).
export const countOutcomes = (db: DB): number => {
  const row = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM outcomes').get() as {
    n: number;
  };
  return row.n;
};

// ─── pruneOutcomes ─────────────────────────────────────────────────────
//
// Retention sweep for `forja gc` Phase 2 (AGENTIC_CLI §2.1.3, AUDIT
// §1.2). Default retention 90d on `recorded_at`. Cutoff EXCLUSIVE.
//
// Cross-substrate operational outcomes (tier 1-5 + action_signature
// + scope_kind). FK CASCADE with sessions — when Phase 4 lands,
// session deletion will also drop outcomes; this sweep is the
// independent retention path for outcomes that outlive their session.
export const pruneOutcomes = (db: DB, olderThanMs: number): number => {
  if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) {
    throw new Error(
      `pruneOutcomes: olderThanMs must be a positive finite number (got ${olderThanMs})`,
    );
  }
  const result = db.query('DELETE FROM outcomes WHERE recorded_at < ?').run(olderThanMs);
  return Number(result.changes);
};

export { PERSISTED_COLUMNS };
