import type { DB } from '../db.ts';
import { parseJsonSafe } from '../json-safe.ts';

export type ToolCallStatus = 'pending' | 'running' | 'done' | 'error' | 'denied';

export interface ToolCall {
  id: string;
  messageId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  status: ToolCallStatus;
  durationMs: number | null;
  error: string | null;
  createdAt: number;
}

interface ToolCallRow {
  id: string;
  message_id: string;
  tool_name: string;
  input: string;
  output: string | null;
  status: ToolCallStatus;
  duration_ms: number | null;
  error: string | null;
  created_at: number;
}

const fromRow = (row: ToolCallRow): ToolCall => ({
  id: row.id,
  messageId: row.message_id,
  toolName: row.tool_name,
  input: parseJsonSafe(row.input, `tool_calls(${row.id}).input`),
  output: row.output !== null ? parseJsonSafe(row.output, `tool_calls(${row.id}).output`) : null,
  status: row.status,
  durationMs: row.duration_ms,
  error: row.error,
  createdAt: row.created_at,
});

export interface CreateToolCallInput {
  id?: string;
  messageId: string;
  toolName: string;
  input: unknown;
  createdAt?: number;
}

export const createToolCall = (db: DB, input: CreateToolCallInput): ToolCall => {
  const id = input.id ?? crypto.randomUUID();
  const inputJson = JSON.stringify(input.input);
  const createdAt = input.createdAt ?? Date.now();
  db.query(
    `INSERT INTO tool_calls (id, message_id, tool_name, input, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).run(id, input.messageId, input.toolName, inputJson, createdAt);
  return {
    id,
    messageId: input.messageId,
    toolName: input.toolName,
    input: input.input,
    output: null,
    status: 'pending',
    durationMs: null,
    error: null,
    createdAt,
  };
};

export const startToolCall = (db: DB, id: string): void => {
  const result = db
    .query("UPDATE tool_calls SET status = 'running' WHERE id = ? AND status = 'pending'")
    .run(id);
  if (result.changes === 0) {
    const exists = getToolCall(db, id);
    if (exists === null) throw new Error(`tool_call ${id} not found`);
    throw new Error(`tool_call ${id} not pending (was '${exists.status}')`);
  }
};

export interface FinishToolCallInput {
  id: string;
  status: Exclude<ToolCallStatus, 'pending' | 'running'>;
  output?: unknown;
  durationMs: number;
  error?: string | null;
}

// Allowed source statuses: 'pending' (denied/error before run, or skipped run
// step) and 'running' (normal completion). Re-finishing a terminal row is a
// bug — we refuse and surface the current status to the caller.
export const finishToolCall = (db: DB, input: FinishToolCallInput): void => {
  const outputJson = input.output === undefined ? null : JSON.stringify(input.output);
  const error = input.error ?? null;
  const result = db
    .query(
      `UPDATE tool_calls
       SET status = ?, output = ?, duration_ms = ?, error = ?
       WHERE id = ? AND status IN ('pending', 'running')`,
    )
    .run(input.status, outputJson, input.durationMs, error, input.id);
  if (result.changes === 0) {
    const exists = getToolCall(db, input.id);
    if (exists === null) throw new Error(`tool_call ${input.id} not found`);
    throw new Error(
      `tool_call ${input.id} cannot be finished from status '${exists.status}' (expected 'pending' or 'running')`,
    );
  }
};

export const getToolCall = (db: DB, id: string): ToolCall | null => {
  const row = db
    .query(
      `SELECT id, message_id, tool_name, input, output, status,
              duration_ms, error, created_at
       FROM tool_calls WHERE id = ?`,
    )
    .get(id) as ToolCallRow | null;
  return row !== null ? fromRow(row) : null;
};

export const listToolCallsByMessage = (db: DB, messageId: string): ToolCall[] => {
  const rows = db
    .query(
      `SELECT id, message_id, tool_name, input, output, status,
              duration_ms, error, created_at
       FROM tool_calls
       WHERE message_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(messageId) as ToolCallRow[];
  return rows.map(fromRow);
};
