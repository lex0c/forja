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
  cacheCreationTokens: number | null;
  costUsd: number | null;
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
  cache_creation_tokens: number | null;
  cost_usd: number | null;
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
  cacheCreationTokens: row.cache_creation_tokens,
  costUsd: row.cost_usd,
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
  cacheCreationTokens?: number | null;
  costUsd?: number | null;
  createdAt?: number;
}

export const appendMessage = (db: DB, input: AppendMessageInput): Message => {
  const id = input.id ?? crypto.randomUUID();
  const createdAt = input.createdAt ?? Date.now();
  const parentId = input.parentId ?? null;
  const tokensIn = input.tokensIn ?? null;
  const tokensOut = input.tokensOut ?? null;
  const cachedTokens = input.cachedTokens ?? null;
  const cacheCreationTokens = input.cacheCreationTokens ?? null;
  const costUsd = input.costUsd ?? null;
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

  // `seq` is computed via subquery in the same INSERT so it's
  // atomic under SQLite's single-writer model. Without this, two
  // appends in the same millisecond would tie on created_at and
  // be ordered by UUID lex (random) on listMessagesBySession,
  // breaking resume's tool_use ↔ tool_result pairing. The subquery
  // sees committed state at INSERT time; concurrent writers are
  // serialized by SQLite, so MAX(seq) is always current.
  db.query(
    `INSERT INTO messages
     (id, session_id, parent_id, role, content,
      tokens_in, tokens_out, cached_tokens, cache_creation_tokens, cost_usd, created_at, seq)
     VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       (SELECT COALESCE(MAX(seq), -1) + 1 FROM messages WHERE session_id = ?)
     )`,
  ).run(
    id,
    input.sessionId,
    parentId,
    input.role,
    content,
    tokensIn,
    tokensOut,
    cachedTokens,
    cacheCreationTokens,
    costUsd,
    createdAt,
    input.sessionId,
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
    cacheCreationTokens,
    costUsd,
    createdAt,
  };
};

export const getMessage = (db: DB, id: string): Message | null => {
  const row = db
    .query(
      `SELECT id, session_id, parent_id, role, content,
              tokens_in, tokens_out, cached_tokens, cache_creation_tokens, cost_usd, created_at
       FROM messages WHERE id = ?`,
    )
    .get(id) as MessageRow | null;
  return row !== null ? fromRow(row) : null;
};

export const listMessagesBySession = (db: DB, sessionId: string): Message[] => {
  // ORDER BY seq is the canonical replay order — strictly monotonic
  // per session, populated atomically at INSERT time, so two appends
  // in the same millisecond no longer tie. created_at is preserved
  // for diagnostics (rendering, cost analysis) but doesn't drive
  // ordering anymore. The (session_id, seq) index makes this an
  // index seek.
  const rows = db
    .query(
      `SELECT id, session_id, parent_id, role, content,
              tokens_in, tokens_out, cached_tokens, cache_creation_tokens, cost_usd, created_at
       FROM messages
       WHERE session_id = ?
       ORDER BY seq ASC`,
    )
    .all(sessionId) as MessageRow[];
  return rows.map(fromRow);
};
