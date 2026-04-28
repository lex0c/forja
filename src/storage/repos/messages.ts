import type { DB } from '../db.ts';
import { parseJsonSafe } from '../json-safe.ts';

export type MessageRole = 'user' | 'assistant' | 'tool';

export interface Message {
  id: string;
  sessionId: string;
  parentId: string | null;
  role: MessageRole;
  content: unknown;
  tokensIn: number | null;
  tokensOut: number | null;
  cachedTokens: number | null;
  createdAt: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  parent_id: string | null;
  role: MessageRole;
  content: string;
  tokens_in: number | null;
  tokens_out: number | null;
  cached_tokens: number | null;
  created_at: number;
}

const fromRow = (row: MessageRow): Message => ({
  id: row.id,
  sessionId: row.session_id,
  parentId: row.parent_id,
  role: row.role,
  content: parseJsonSafe(row.content, `messages(${row.id}).content`),
  tokensIn: row.tokens_in,
  tokensOut: row.tokens_out,
  cachedTokens: row.cached_tokens,
  createdAt: row.created_at,
});

export interface AppendMessageInput {
  id?: string;
  sessionId: string;
  parentId?: string | null;
  role: MessageRole;
  content: unknown;
  tokensIn?: number | null;
  tokensOut?: number | null;
  cachedTokens?: number | null;
  createdAt?: number;
}

export const appendMessage = (db: DB, input: AppendMessageInput): Message => {
  const id = input.id ?? crypto.randomUUID();
  const createdAt = input.createdAt ?? Date.now();
  const parentId = input.parentId ?? null;
  const tokensIn = input.tokensIn ?? null;
  const tokensOut = input.tokensOut ?? null;
  const cachedTokens = input.cachedTokens ?? null;
  const content = JSON.stringify(input.content);

  // The schema FK only enforces that parent_id exists in `messages`, not that
  // it lives in the same session. Cross-session chains corrupt history (the
  // child's session no longer reads as a coherent thread on its own), so we
  // catch it at the repo layer.
  if (parentId !== null) {
    const parent = db.query('SELECT session_id FROM messages WHERE id = ?').get(parentId) as {
      session_id: string;
    } | null;
    if (parent === null) {
      throw new Error(`parent message ${parentId} not found`);
    }
    if (parent.session_id !== input.sessionId) {
      throw new Error(
        `parent message ${parentId} belongs to session ${parent.session_id}, ` +
          `not ${input.sessionId}`,
      );
    }
  }

  db.query(
    `INSERT INTO messages
     (id, session_id, parent_id, role, content, tokens_in, tokens_out, cached_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.sessionId,
    parentId,
    input.role,
    content,
    tokensIn,
    tokensOut,
    cachedTokens,
    createdAt,
  );
  return {
    id,
    sessionId: input.sessionId,
    parentId,
    role: input.role,
    content: input.content,
    tokensIn,
    tokensOut,
    cachedTokens,
    createdAt,
  };
};

export const getMessage = (db: DB, id: string): Message | null => {
  const row = db
    .query(
      `SELECT id, session_id, parent_id, role, content,
              tokens_in, tokens_out, cached_tokens, created_at
       FROM messages WHERE id = ?`,
    )
    .get(id) as MessageRow | null;
  return row !== null ? fromRow(row) : null;
};

export const listMessagesBySession = (db: DB, sessionId: string): Message[] => {
  const rows = db
    .query(
      `SELECT id, session_id, parent_id, role, content,
              tokens_in, tokens_out, cached_tokens, created_at
       FROM messages
       WHERE session_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(sessionId) as MessageRow[];
  return rows.map(fromRow);
};
