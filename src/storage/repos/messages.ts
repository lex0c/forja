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
  // SHA256 hex of the system prompt active when this message was
  // persisted — soft FK into `prompt_versions.hash` (AUDIT §1.3.2).
  // Null for rows persisted before migration 068 and for paths not
  // yet wired (subagent seed in `subagents/runtime.ts`).
  promptHash: string | null;
  // Resolved provider reasoning-effort that produced this message
  // ('low' | 'medium' | 'high' | 'max') — migration 074. The mutable,
  // not-otherwise-recoverable dimension for regression attribution (did
  // quality shift because effort changed or because context did?). Set on
  // ASSISTANT rows; NULL on user/tool rows, pre-migration rows, and turns
  // with no resolved effort. Typed `string` (not the harness enum) to keep
  // storage decoupled from the harness/provider layer.
  effort: string | null;
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
  prompt_hash: string | null;
  effort: string | null;
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
  promptHash: row.prompt_hash,
  effort: row.effort,
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
  // SHA256 hex of the system prompt active for this message — soft FK
  // into `prompt_versions.hash` (AUDIT §1.3.2). Caller (the harness
  // loop) sources it from `HarnessConfig.systemPromptHash`. Nullable
  // because messages persisted before migration 068 carry no hash and
  // because subagent paths haven't been wired yet.
  promptHash?: string | null;
  // Resolved provider reasoning-effort for this message (migration 074).
  // The harness loop sources it from the per-request resolved effort.
  // Nullable: non-assistant rows and turns with no resolved effort.
  effort?: string | null;
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
  const promptHash = input.promptHash ?? null;
  const effort = input.effort ?? null;
  db.query(
    `INSERT INTO messages
     (id, session_id, parent_id, role, content,
      tokens_in, tokens_out, cached_tokens, cache_creation_tokens, cost_usd, created_at, prompt_hash, effort, seq)
     VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
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
    promptHash,
    effort,
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
    promptHash,
    effort,
  };
};

export const getMessage = (db: DB, id: string): Message | null => {
  const row = db
    .query(
      `SELECT id, session_id, parent_id, role, content,
              tokens_in, tokens_out, cached_tokens, cache_creation_tokens, cost_usd, created_at, prompt_hash, effort
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
              tokens_in, tokens_out, cached_tokens, cache_creation_tokens, cost_usd, created_at, prompt_hash, effort
       FROM messages
       WHERE session_id = ?
       ORDER BY seq ASC`,
    )
    .all(sessionId) as MessageRow[];
  return rows.map(fromRow);
};

// Bounded tail variant for resume: fetches at most `limit` of the
// most-recent messages plus the session's total message count.
// Loading the full log into JS just to slice in memory defeats the
// resume cap and OOMs on large sessions; this query keeps the
// memory floor at ~limit rows regardless of session size.
//
// Returned messages are oldest-first WITHIN the tail (matches
// listMessagesBySession ordering); the inner SELECT picks the
// newest `limit` rows by seq DESC, the outer wraps them back to
// ASC for canonical replay order.
//
// `totalCount` lets the caller report a faithful "kept N of M"
// diagnostic even though the function itself never materializes
// the full M rows.
export interface MessageTail {
  messages: Message[];
  totalCount: number;
}

export const listMessageTailBySession = (db: DB, sessionId: string, limit: number): MessageTail => {
  const totalCount = (
    db.query('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as {
      n: number;
    }
  ).n;
  const rows = db
    .query(
      `SELECT id, session_id, parent_id, role, content,
              tokens_in, tokens_out, cached_tokens, cache_creation_tokens, cost_usd, created_at, prompt_hash, effort
       FROM (
         SELECT * FROM messages
         WHERE session_id = ?
         ORDER BY seq DESC
         LIMIT ?
       )
       ORDER BY seq ASC`,
    )
    .all(sessionId, limit) as MessageRow[];
  return { messages: rows.map(fromRow), totalCount };
};

// Provider-reported token totals for a single session, summed across
// every message row. Used by the usage-stats aggregator (`/stats` and
// the footer) to roll up a session's lifetime token throughput.
//
// COALESCE folds the nullable columns to 0 — a turn that reported no
// usage (provider edge case / mid-stream abort) contributes nothing
// rather than poisoning the SUM with NULL. That makes the total a
// LOWER BOUND when any turn lacked usage; the caller pairs this with
// `sessions.usage_complete` to flag the undercount.
export interface MessageUsageTotals {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreation: number;
}

export const sumMessageUsage = (db: DB, sessionId: string): MessageUsageTotals => {
  const row = db
    .query<{ ti: number; tout: number; cr: number; cc: number }, [string]>(
      `SELECT COALESCE(SUM(tokens_in), 0)              AS ti,
              COALESCE(SUM(tokens_out), 0)             AS tout,
              COALESCE(SUM(cached_tokens), 0)          AS cr,
              COALESCE(SUM(cache_creation_tokens), 0)  AS cc
       FROM messages WHERE session_id = ?`,
    )
    .get(sessionId);
  return {
    tokensIn: row?.ti ?? 0,
    tokensOut: row?.tout ?? 0,
    cacheRead: row?.cr ?? 0,
    cacheCreation: row?.cc ?? 0,
  };
};
