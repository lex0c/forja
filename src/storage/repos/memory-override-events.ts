// memory_override_events repo (migration 064, S3 / T3.1-T3.3).
//
// Per-event log of operator actions that countermand model behavior
// derived from a memory. Backs the deterministic sliding-window
// counter that gates the S3 `user_override_repeated` LLM-judge
// dispatch (see scheduler in S3.4).
//
// Three signal kinds match spec §6.5.2:
//
//   memory_write_rejected → operator rejected an inferred-write modal.
//                            tool_call_id NULL (modal is upstream of
//                            tool dispatch).
//   permission_denied     → operator denied a `permission ask` for a
//                            tool exposed to this memory.
//                            tool_call_id non-NULL (the denied call).
//   edit_reverted         → model edited file X; pre-edit content
//                            substantially restored within K turns.
//                            tool_call_id non-NULL (the original
//                            edit call). Signal collector lands in
//                            S3.2 follow-up; schema admits the kind
//                            today so the substrate is forward-
//                            compatible.

import type { MemoryScope } from '../../memory/index.ts';
import type { DB } from '../db.ts';

// ─── enums ────────────────────────────────────────────────────────────

export const OVERRIDE_SIGNALS = [
  'memory_write_rejected',
  'permission_denied',
  'edit_reverted',
] as const;
export type OverrideSignal = (typeof OVERRIDE_SIGNALS)[number];

const VALID_SIGNALS: ReadonlySet<OverrideSignal> = new Set(OVERRIDE_SIGNALS);
const VALID_SCOPES: ReadonlySet<MemoryScope> = new Set(['user', 'project_shared', 'project_local']);

// ─── tunables (S3 spec) ───────────────────────────────────────────────

// Threshold: events in window before the detector dispatches the
// LLM judge. Spec §6.5.2: "3 in 24h". The threshold is the cheap
// deterministic gate that costs ONE LLM call when crossed; below
// it, zero LLM cost. Tuning these together moves the false-positive
// vs late-detection trade-off.
export const MEMORY_OVERRIDE_THRESHOLD_COUNT = 3;
export const MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS = 24 * 60 * 60 * 1000;

// Retention: rows older than 90d are pruned at boot. Matches the
// memory_provenance + memory_verify_attempts retention windows; the
// detector cross-references provenance to anchor "which memories
// were visible during the denied tool call", so symmetric retention
// keeps the join valid for the full window.
export const MEMORY_OVERRIDE_EVENTS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

// ─── shapes ───────────────────────────────────────────────────────────

export interface MemoryOverrideEventRow {
  id: string;
  sessionId: string | null;
  memoryScope: MemoryScope;
  memoryName: string;
  signal: OverrideSignal;
  toolCallId: string | null;
  // Free-form JSON owned by the detector — parsed-on-read with
  // null on malformed (best-effort, mirrors memory_provenance).
  details: Record<string, unknown> | null;
  createdAt: number;
}

interface RawOverrideRow {
  id: string;
  session_id: string | null;
  memory_scope: MemoryScope;
  memory_name: string;
  signal: string;
  tool_call_id: string | null;
  details: string | null;
  created_at: number;
}

const parseDetails = (raw: string | null): Record<string, unknown> | null => {
  if (raw === null || raw.length === 0) return null;
  try {
    const v = JSON.parse(raw);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
};

const fromRow = (row: RawOverrideRow): MemoryOverrideEventRow => {
  if (!VALID_SIGNALS.has(row.signal as OverrideSignal)) {
    throw new Error(`memory_override_events[${row.id}]: invalid signal '${row.signal}'`);
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    memoryScope: row.memory_scope,
    memoryName: row.memory_name,
    signal: row.signal as OverrideSignal,
    toolCallId: row.tool_call_id,
    details: parseDetails(row.details),
    createdAt: row.created_at,
  };
};

// ─── insert ───────────────────────────────────────────────────────────

export interface RecordOverrideEventInput {
  id?: string;
  sessionId: string | null;
  memoryScope: MemoryScope;
  memoryName: string;
  signal: OverrideSignal;
  toolCallId?: string | null;
  details?: Record<string, unknown> | null;
  createdAt?: number;
}

export interface RecordOverrideEventResult {
  id: string;
}

const INSERT_SQL = `
  INSERT INTO memory_override_events
    (id, session_id, memory_scope, memory_name, signal,
     tool_call_id, details, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

export const recordOverrideEvent = (
  db: DB,
  input: RecordOverrideEventInput,
): RecordOverrideEventResult => {
  if (!VALID_SCOPES.has(input.memoryScope)) {
    throw new Error(`recordOverrideEvent: invalid memoryScope '${input.memoryScope}'`);
  }
  if (typeof input.memoryName !== 'string' || input.memoryName.length === 0) {
    throw new Error('recordOverrideEvent: memoryName must be non-empty string');
  }
  if (!VALID_SIGNALS.has(input.signal)) {
    throw new Error(`recordOverrideEvent: invalid signal '${input.signal}'`);
  }
  const createdAt = input.createdAt ?? Date.now();
  if (createdAt <= 0) {
    throw new Error(`recordOverrideEvent: createdAt must be > 0 (got ${createdAt})`);
  }
  const id = input.id ?? crypto.randomUUID();
  const detailsRaw =
    input.details === null || input.details === undefined ? null : JSON.stringify(input.details);
  db.query(INSERT_SQL).run(
    id,
    input.sessionId,
    input.memoryScope,
    input.memoryName,
    input.signal,
    input.toolCallId ?? null,
    detailsRaw,
    createdAt,
  );
  return { id };
};

// ─── counter (sliding window) ─────────────────────────────────────────

const COUNT_SQL = `
  SELECT COUNT(*) AS n
    FROM memory_override_events
   WHERE memory_scope = ? AND memory_name = ?
     AND created_at >= ?
`;

// Sliding-window count for the threshold gate. The cutoff is
// INCLUSIVE on the lower bound (`>= nowMs - windowMs`) to mirror
// "the last 24h up to and including right now". `windowMs` is the
// caller's window size — typically `MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS`.
export const countOverridesInWindow = (
  db: DB,
  scope: MemoryScope,
  name: string,
  windowMs: number,
  nowMs?: number,
): number => {
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`countOverridesInWindow: invalid scope '${scope}'`);
  }
  if (windowMs <= 0) {
    throw new Error(`countOverridesInWindow: windowMs must be > 0 (got ${windowMs})`);
  }
  const now = nowMs ?? Date.now();
  const cutoff = now - windowMs;
  const row = db.query<{ n: number }, [string, string, number]>(COUNT_SQL).get(scope, name, cutoff);
  return row?.n ?? 0;
};

// ─── listings (forensics + scheduler) ─────────────────────────────────

const SELECT_ALL = `
  SELECT id, session_id, memory_scope, memory_name, signal,
         tool_call_id, details, created_at
    FROM memory_override_events
`;

// Most recent overrides for a single memory. Backs the LLM-judge
// dispatcher's context payload ("here are the operator's last N
// override events for this memory") and the operator-facing
// /memory governance status surface (S3.6).
export const listRecentOverridesForMemory = (
  db: DB,
  scope: MemoryScope,
  name: string,
  limit = 20,
): MemoryOverrideEventRow[] => {
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`listRecentOverridesForMemory: invalid scope '${scope}'`);
  }
  const rows = db
    .query<RawOverrideRow, [string, string, number]>(
      `${SELECT_ALL}
        WHERE memory_scope = ? AND memory_name = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(scope, name, limit);
  return rows.map(fromRow);
};

// Scheduler polling primitive: events strictly newer than the
// caller's cursor `(createdAt, id)`. Lexicographic on the tuple so
// same-ms inserts don't get skipped on the next poll. Mirrors the
// memory_provenance cursor pattern documented in the verify-semantic
// scheduler.
export const listOverrideEventsSince = (
  db: DB,
  cursorCreatedAt: number,
  cursorId: string,
  limit = 50,
): MemoryOverrideEventRow[] => {
  const rows = db
    .query<RawOverrideRow, [number, number, string, number]>(
      `${SELECT_ALL}
        WHERE created_at > ?
           OR (created_at = ? AND id > ?)
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    )
    .all(cursorCreatedAt, cursorCreatedAt, cursorId, limit);
  return rows.map(fromRow);
};

// ─── retention ────────────────────────────────────────────────────────

// Boot-time prune. Returns deleted row count for telemetry. Match
// shape of pruneMemoryProvenance and pruneVerifyAttempts:
//   `created_at < olderThanMs` — exclusive cutoff so a row at
//   exactly the boundary is KEPT.
export const pruneOverrideEvents = (db: DB, olderThanMs: number): number => {
  if (olderThanMs <= 0) {
    throw new Error(`pruneOverrideEvents: olderThanMs must be > 0 (got ${olderThanMs})`);
  }
  const result = db
    .query('DELETE FROM memory_override_events WHERE created_at < ?')
    .run(olderThanMs);
  return Number(result.changes);
};
