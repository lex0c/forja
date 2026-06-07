import type { SQLQueryBindings } from 'bun:sqlite';
import { generateUlid } from '../../permissions/ulid.ts';
import type { DB } from '../db.ts';

// compaction_events repo (migration 072). Append-only audit/replay trail for
// each compaction (CONTEXT_TUNING §12): the live array persists no messages,
// so this is where the DECISION lives — strategy, how much it freed, the
// before/after context hashes, and the non-reproducible LLM summary text.
// Cross-ref AUDIT.md.

export interface CompactionEventRow {
  id: string;
  session_id: string | null;
  strategy: string;
  folded_count: number;
  freed_bytes: number | null;
  tokens_before: number | null; // NULL for a forced /compact (no trigger count)
  tokens_after: number | null;
  before_hash: string;
  after_hash: string;
  elided_ids: string | null; // JSON array of tool_use_ids (relevance path)
  summary: string | null;
  reason: string | null;
  recorded_at: number;
}

export interface AppendCompactionEventInput {
  sessionId: string | null;
  // The CompactionStrategy value, typed as `string` here so storage stays
  // BELOW the harness layer (no storage→harness import / cycle). The DB CHECK
  // plus the typed call site (loop / `/compact`) constrain it to a real strategy.
  strategy: string;
  foldedCount: number;
  freedBytes?: number;
  // Absent for a forced `/compact` — it has no trigger token count.
  tokensBefore?: number;
  tokensAfter?: number;
  beforeHash: string;
  afterHash: string;
  elidedIds?: readonly string[];
  summary?: string;
  reason?: string;
  recordedAt: number;
}

const INSERT_SQL = `INSERT INTO compaction_events
  (id, session_id, strategy, folded_count, freed_bytes, tokens_before,
   tokens_after, before_hash, after_hash, elided_ids, summary, reason, recorded_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_ALL = `SELECT id, session_id, strategy, folded_count, freed_bytes,
       tokens_before, tokens_after, before_hash, after_hash, elided_ids,
       summary, reason, recorded_at
  FROM compaction_events`;

// Append one row; returns the generated id. ULID = sortable + globally unique
// (same id discipline as failure_events / eviction_events).
export const appendCompactionEvent = (db: DB, input: AppendCompactionEventInput): string => {
  const id = generateUlid();
  const bindings: SQLQueryBindings[] = [
    id,
    input.sessionId,
    input.strategy,
    input.foldedCount,
    input.freedBytes ?? null,
    input.tokensBefore ?? null,
    input.tokensAfter ?? null,
    input.beforeHash,
    input.afterHash,
    input.elidedIds !== undefined ? JSON.stringify([...input.elidedIds]) : null,
    input.summary ?? null,
    input.reason ?? null,
    input.recordedAt,
  ];
  db.query(INSERT_SQL).run(...bindings);
  return id;
};

// Forensic list in append order. Bounded by per-session retention.
export const listCompactionEventsBySession = (db: DB, sessionId: string): CompactionEventRow[] =>
  db
    .query(`${SELECT_ALL} WHERE session_id = ? ORDER BY recorded_at ASC, id ASC`)
    .all(sessionId) as CompactionEventRow[];
