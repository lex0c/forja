// dispatch_rewrites repo (FEEDBACK_ADAPTATION §9.1 audit surface).
//
// Persisted log of L1 alias rewrites — the structured replacement
// for the stderr-only audit trail 3.5b shipped. Operators query
// here to answer "what did the adaptation engine do during this
// session?" without parsing stderr.
//
// Public surface mirrors memory_events / outcomes / policies
// pattern: PERSISTED_COLUMNS + valuesForInsert + SELECT_ALL +
// fromRow + a handful of query functions.

import type { SQLQueryBindings } from 'bun:sqlite';
import type { DB } from '../db.ts';
import type { ScopeKind } from './outcomes.ts';

export interface DispatchRewrite {
  id: string;
  toolCallId: string;
  sessionId: string;
  policyId: string;
  actionSignature: string;
  originalCommand: string;
  rewrittenCommand: string;
  matchedScope: ScopeKind;
  recordedAt: number;
}

interface DispatchRewriteRow {
  id: string;
  tool_call_id: string;
  session_id: string;
  policy_id: string;
  action_signature: string;
  original_command: string;
  rewritten_command: string;
  matched_scope: ScopeKind;
  recorded_at: number;
}

const PERSISTED_COLUMNS = [
  'id',
  'tool_call_id',
  'session_id',
  'policy_id',
  'action_signature',
  'original_command',
  'rewritten_command',
  'matched_scope',
  'recorded_at',
] as const;

const PLACEHOLDERS = PERSISTED_COLUMNS.map(() => '?').join(', ');
const COLUMN_LIST = PERSISTED_COLUMNS.join(', ');
const INSERT_SQL = `INSERT INTO dispatch_rewrites (${COLUMN_LIST}) VALUES (${PLACEHOLDERS})`;

const SELECT_ALL = `SELECT id, tool_call_id, session_id, policy_id, action_signature,
       original_command, rewritten_command, matched_scope, recorded_at
  FROM dispatch_rewrites`;

const fromRow = (row: DispatchRewriteRow): DispatchRewrite => ({
  id: row.id,
  toolCallId: row.tool_call_id,
  sessionId: row.session_id,
  policyId: row.policy_id,
  actionSignature: row.action_signature,
  originalCommand: row.original_command,
  rewrittenCommand: row.rewritten_command,
  matchedScope: row.matched_scope,
  recordedAt: row.recorded_at,
});

const valuesForInsert = (row: DispatchRewriteRow): SQLQueryBindings[] =>
  PERSISTED_COLUMNS.map((col) => {
    const v = (row as unknown as Record<string, unknown>)[col];
    return (v ?? null) as SQLQueryBindings;
  });

export interface CreateDispatchRewriteInput {
  toolCallId: string;
  sessionId: string;
  policyId: string;
  actionSignature: string;
  originalCommand: string;
  rewrittenCommand: string;
  matchedScope: ScopeKind;
  id?: string;
  recordedAt?: number;
}

// INSERT a rewrite row. Throws on DB error (CHECK violation, FK
// missing). Caller is the harness loop; failure stderr-logs and
// continues (best-effort like the outcome emitter — adaptation
// data loss is preferable to crashing the operator's session).
export const createDispatchRewrite = (
  db: DB,
  input: CreateDispatchRewriteInput,
): DispatchRewrite => {
  const id = input.id ?? crypto.randomUUID();
  const recordedAt = input.recordedAt ?? Date.now();
  const row: DispatchRewriteRow = {
    id,
    tool_call_id: input.toolCallId,
    session_id: input.sessionId,
    policy_id: input.policyId,
    action_signature: input.actionSignature,
    original_command: input.originalCommand,
    rewritten_command: input.rewrittenCommand,
    matched_scope: input.matchedScope,
    recorded_at: recordedAt,
  };
  db.query(INSERT_SQL).run(...valuesForInsert(row));
  return fromRow(row);
};

// Single-row lookup by tool_call_id. Returns null when the call
// wasn't rewritten — useful for the renderer / forensic query that
// asks "did this call get rewritten?". One row per call by
// construction (single rewrite per dispatch).
export const getDispatchRewriteForToolCall = (
  db: DB,
  toolCallId: string,
): DispatchRewrite | null => {
  const row = db
    .query<DispatchRewriteRow, [string]>(`${SELECT_ALL} WHERE tool_call_id = ? LIMIT 1`)
    .get(toolCallId);
  return row !== null ? fromRow(row) : null;
};

// All rewrites in a session, ordered newest first. Powers the
// future `/agent rewrites list` slash and recap surfaces.
export const listDispatchRewritesBySession = (
  db: DB,
  sessionId: string,
  limit?: number,
): DispatchRewrite[] => {
  if (limit !== undefined) {
    const rows = db
      .query<DispatchRewriteRow, [string, number]>(
        `${SELECT_ALL} WHERE session_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT ?`,
      )
      .all(sessionId, limit);
    return rows.map(fromRow);
  }
  const rows = db
    .query<DispatchRewriteRow, [string]>(
      `${SELECT_ALL} WHERE session_id = ? ORDER BY recorded_at DESC, rowid DESC`,
    )
    .all(sessionId);
  return rows.map(fromRow);
};

// All rewrites driven by a specific policy. Useful for evaluating
// policy effectiveness ("how many times did this policy actually
// fire?") from outside the loop frio's aggregator.
export const listDispatchRewritesByPolicy = (db: DB, policyId: string): DispatchRewrite[] => {
  const rows = db
    .query<DispatchRewriteRow, [string]>(
      `${SELECT_ALL} WHERE policy_id = ? ORDER BY recorded_at DESC, rowid DESC`,
    )
    .all(policyId);
  return rows.map(fromRow);
};

export const countDispatchRewrites = (db: DB): number => {
  const row = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM dispatch_rewrites').get() as {
    n: number;
  };
  return row.n;
};

export { PERSISTED_COLUMNS };
