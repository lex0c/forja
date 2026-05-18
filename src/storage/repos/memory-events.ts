import type { DB } from '../db.ts';

// Repo for `memory_events` (migration 016). Audit-only — content
// of memories lives in markdown files, not here. This table
// answers "when/where/by-whom did a memory operation happen?".
//
// 5.1 lands the schema + helpers; 5.2 starts emitting `read`
// events from the lazy-load tool, 5.3 emits proposed/created/
// refused/edited/deleted from the write surface, 5.4 emits the
// trust-related rows, 5.5 emits promoted/demoted, and 5.6 emits
// expired.

export type MemoryEventScope = 'user' | 'project_local' | 'project_shared';
export type MemoryEventAction =
  | 'proposed'
  | 'created'
  | 'edited'
  | 'deleted'
  | 'read'
  | 'refused'
  | 'promoted'
  | 'demoted'
  | 'expired'
  // Phase 0 stitching (MEMORY.md §5.3 + EVICTION.md §3) added
  // five lifecycle actions. Migration 048 expanded the CHECK
  // constraint to admit them; this union mirrors the schema.
  | 'quarantined'
  | 'invalidated'
  | 'evicted'
  | 'restored'
  | 'purged'
  // Migration 063: governance proposal expiry-extension audit
  // (`/memory governance defer <id> <days>`). One row per defer
  // attributed to the memory the proposal would transition on
  // approve (target_key when multi-memory, else
  // sourceMemoryKeys[0]).
  | 'deferred';
export type MemoryEventSource = 'user_explicit' | 'inferred' | 'imported';

export interface MemoryEvent {
  id: string;
  scope: MemoryEventScope;
  action: MemoryEventAction;
  memoryName: string;
  source: MemoryEventSource;
  sessionId: string | null;
  cwd: string | null;
  createdAt: number;
  // Action-specific extras. The repo neither validates nor
  // interprets the shape; consumers (UI, lifecycle, trust audit)
  // own the per-action contract. Returned as null when the row
  // had no details OR when the persisted JSON was malformed —
  // callers needing to distinguish "absent" from "corrupted"
  // should query the raw column directly.
  details: Record<string, unknown> | null;
}

interface MemoryEventRow {
  id: string;
  scope: MemoryEventScope;
  action: MemoryEventAction;
  memory_name: string;
  source: MemoryEventSource;
  session_id: string | null;
  cwd: string | null;
  created_at: number;
  details: string | null;
}

// Mirrors the defensive parse pattern in subagent-outputs /
// subagent-runs. Storage corruption shouldn't crash an audit
// listing; we surface a null `details` and let the consumer
// decide.
const parseDetails = (raw: string | null): Record<string, unknown> | null => {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

const fromRow = (row: MemoryEventRow): MemoryEvent => ({
  id: row.id,
  scope: row.scope,
  action: row.action,
  memoryName: row.memory_name,
  source: row.source,
  sessionId: row.session_id,
  cwd: row.cwd,
  createdAt: row.created_at,
  details: parseDetails(row.details),
});

export interface CreateMemoryEventInput {
  // Optional: caller can supply an id when batching events from
  // a deterministic source (e.g. a replay tool). Defaults to a
  // fresh UUID.
  id?: string;
  scope: MemoryEventScope;
  action: MemoryEventAction;
  memoryName: string;
  source: MemoryEventSource;
  sessionId?: string | null;
  cwd?: string | null;
  createdAt?: number;
  details?: Record<string, unknown> | null;
}

export const createMemoryEvent = (db: DB, input: CreateMemoryEventInput): MemoryEvent => {
  const id = input.id ?? crypto.randomUUID();
  const sessionId = input.sessionId ?? null;
  const cwd = input.cwd ?? null;
  const createdAt = input.createdAt ?? Date.now();
  const details = input.details ?? null;
  const detailsJson = details === null ? null : JSON.stringify(details);
  db.query(
    `INSERT INTO memory_events
       (id, scope, action, memory_name, source, session_id, cwd, created_at, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.scope,
    input.action,
    input.memoryName,
    input.source,
    sessionId,
    cwd,
    createdAt,
    detailsJson,
  );
  return {
    id,
    scope: input.scope,
    action: input.action,
    memoryName: input.memoryName,
    source: input.source,
    sessionId,
    cwd,
    createdAt,
    details,
  };
};

// Audit feed for the current session. Ordered chronologically
// (created_at ASC, id ASC as a stable tiebreak) so the timeline
// view doesn't shuffle on equal timestamps. The partial index on
// (session_id) WHERE NOT NULL covers this query. Rows whose
// session was purged remain in the table (FK SET NULL preserves
// them) but their session_id is now NULL, so the
// `WHERE session_id = ?` filter excludes them — the audit
// history is reachable instead via listMemoryEventsByName.
export const listMemoryEventsBySession = (db: DB, sessionId: string): MemoryEvent[] => {
  const rows = db
    .query<MemoryEventRow, [string]>(
      `SELECT id, scope, action, memory_name, source, session_id, cwd, created_at, details
         FROM memory_events
        WHERE session_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(sessionId);
  return rows.map(fromRow);
};

// Recent memory events, no name/session filter. Used by
// `/memory audit` to render "what happened lately" across the
// whole table. Ordered most-recent first (matches the index
// direction), capped by `limit` (default 50). Sub-50 spans the
// last few sessions in typical use; operators wanting full
// history pass a higher cap explicitly.
export const listRecentMemoryEvents = (db: DB, limit = 50): MemoryEvent[] => {
  const rows = db
    .query<MemoryEventRow, [number]>(
      `SELECT id, scope, action, memory_name, source, session_id, cwd, created_at, details
         FROM memory_events
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(limit);
  return rows.map(fromRow);
};

// Earliest `created` event timestamp for a memory in a scope,
// or null when no `created` row exists. Used by the user_explicit
// cooldown protection gate (EVICTION §6.2) to determine when a
// manually-created memory was first observed by the audit chain
// — so the gate can refuse `low_roi` / `irrelevant` evictions in
// the first 72h after creation.
//
// Falls back to NULL when the memory pre-dates the audit table
// (legacy registry pickups created before MEMORY §3.1.1's
// `created` event landed in the schema). The protection gate
// treats null as "age unknown" and SKIPS the cooldown — under-
// protect rather than over-protect. Rationale: a legacy memory
// with no `created` row would otherwise be permanently blocked
// from eviction by any cooldown-protected motivo, since age
// never elapses. The operator override (`actor: 'user'` via
// `/memory delete`) still works for those rows, and any newly-
// created memory (post-1.3) lands a `created` row alongside the
// write so the gate fires correctly.
export const getEarliestMemoryCreatedAt = (
  db: DB,
  scope: string,
  memoryName: string,
): number | null => {
  const row = db
    .query<{ created_at: number }, [string, string]>(
      `SELECT created_at
         FROM memory_events
        WHERE scope = ? AND memory_name = ? AND action = 'created'
        ORDER BY created_at ASC
        LIMIT 1`,
    )
    .get(scope, memoryName);
  return row !== null ? row.created_at : null;
};

// History of one memory across its full lifetime. Ordered most-
// recent first (matching the composite index direction) so the
// caller can `LIMIT N` to get the latest activity.
export const listMemoryEventsByName = (
  db: DB,
  memoryName: string,
  limit?: number,
): MemoryEvent[] => {
  if (limit !== undefined) {
    const rows = db
      .query<MemoryEventRow, [string, number]>(
        `SELECT id, scope, action, memory_name, source, session_id, cwd, created_at, details
           FROM memory_events
          WHERE memory_name = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(memoryName, limit);
    return rows.map(fromRow);
  }
  const rows = db
    .query<MemoryEventRow, [string]>(
      `SELECT id, scope, action, memory_name, source, session_id, cwd, created_at, details
         FROM memory_events
        WHERE memory_name = ?
        ORDER BY created_at DESC, id DESC`,
    )
    .all(memoryName);
  return rows.map(fromRow);
};
