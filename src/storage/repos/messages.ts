import type { DB } from '../db.ts';
import { parseJsonSafe } from '../json-safe.ts';
// Value import; `compaction-events.ts` only imports a TYPE from here (erased at runtime), so
// this does not create a runtime module cycle.
import { compactionMetering } from './compaction-events.ts';

export type MessageRole = 'user' | 'assistant' | 'tool';

// Who/what produced a message's INPUT (migration 075). 'operator' = the
// human typed it (the default and normal case); 'system' = the harness/
// REPL injected it (a bg_done wake notification today, reminders later).
// Distinguishes audit/resume rendering of an injected user-role turn from
// real operator input — the provider sees both as user context.
export type MessageSource = 'operator' | 'system';

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
  // Who produced this message's input — migration 075. 'operator' for
  // every pre-migration row and the normal case; 'system' for
  // harness-injected turns (bg_done wake notifications). See MessageSource.
  source: MessageSource;
  // The model that BILLED this turn — migration 077. Set on ASSISTANT rows (the
  // provider id, e.g. 'ollama/glm-5.2' / 'anthropic/claude-opus-4-8'); NULL on
  // user/tool rows and rows persisted before the migration. Per-turn provenance
  // so historical cost surfaces resolve a session's ACTUAL metering from the
  // models it really used, not the session's initial `sessions.model`.
  model: string | null;
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
  source: MessageSource;
  model: string | null;
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
  source: row.source,
  model: row.model,
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
  // Input origin (migration 075). Defaults to 'operator'; the wake-turn
  // path passes 'system' so the notification isn't audited/resumed as
  // operator input. See MessageSource.
  source?: MessageSource;
  // The model that billed this turn (migration 077). The harness loop sources
  // it from the per-request provider id. Nullable: user/tool rows and turns
  // with no resolved provider.
  model?: string | null;
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
  const source: MessageSource = input.source ?? 'operator';
  const model = input.model ?? null;
  db.query(
    `INSERT INTO messages
     (id, session_id, parent_id, role, content,
      tokens_in, tokens_out, cached_tokens, cache_creation_tokens, cost_usd, created_at, prompt_hash, effort, source, model, seq)
     VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
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
    source,
    model,
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
    source,
    model,
  };
};

export const getMessage = (db: DB, id: string): Message | null => {
  const row = db
    .query(
      `SELECT id, session_id, parent_id, role, content,
              tokens_in, tokens_out, cached_tokens, cache_creation_tokens, cost_usd, created_at, prompt_hash, effort, source, model
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
              tokens_in, tokens_out, cached_tokens, cache_creation_tokens, cost_usd, created_at, prompt_hash, effort, source, model
       FROM messages
       WHERE session_id = ?
       ORDER BY seq ASC`,
    )
    .all(sessionId) as MessageRow[];
  return rows.map(fromRow);
};

// The distinct non-null models that BILLED a session's turns (migration 077) —
// per-turn provenance. Lets a historical cost surface resolve the session's
// ACTUAL metering from the models it really used, instead of `sessions.model`
// (the model at createSession time, which a `/model` switch leaves stale).
// Empty when no turn recorded a model (pre-migration rows, or a session with no
// billed assistant turns); callers fall back to `sessions.model` in that case.
export const distinctSessionModels = (db: DB, sessionId: string): string[] => {
  const rows = db
    .query('SELECT DISTINCT model FROM messages WHERE session_id = ? AND model IS NOT NULL')
    .all(sessionId) as { model: string }[];
  return rows.map((r) => r.model);
};

// The session's EFFECTIVE models for metering: every model it BILLED on — per-turn assistant
// models (`messages`, migration 077) UNIONED with compaction-call models (`compaction_events`,
// migration 078, whose cost is in `total_cost_usd` but writes no message row) — PLUS the stored
// `sessions.model` fallback when (a) no model was recorded at all, OR (b) any billed turn/call
// still has a NULL model (an assistant row pre-077 or a billed compaction pre-078 — spend on a
// model we can't recover, attributed to `sessions.model`). The ONE place the fallback rule
// lives, so the read surfaces (`--list`, `/sessions`, `/stats`) can't drift on it. Always
// non-empty, so callers (e.g. `isSessionUnmetered`) never face `[].every()`.
//
// Including the fallback on (b) — not only (a) — is load-bearing: a session that spent on a
// metered model PRE-migration (NULL rows) and is later resumed with an unmetered turn would
// otherwise return only the unmetered model and read as unmetered, hiding that metered spend.
export const effectiveSessionModels = (
  db: DB,
  sessionId: string,
  fallbackModel: string,
): string[] => {
  const compaction = compactionMetering(db, sessionId);
  const models = [...new Set([...distinctSessionModels(db, sessionId), ...compaction.models])];
  const hasUntrackedAssistant =
    db
      .query(
        "SELECT 1 FROM messages WHERE session_id = ? AND role = 'assistant' AND model IS NULL LIMIT 1",
      )
      .get(sessionId) !== null;
  if (models.length === 0 || hasUntrackedAssistant || compaction.hasUntracked) {
    return models.includes(fallbackModel) ? models : [...models, fallbackModel];
  }
  return models;
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

// Cheap COUNT(*) of persisted rows for a session — no row materialization.
// The resume-mode modal surfaces this so the operator can weigh "load all N"
// vs "compact" before any history is hydrated into memory.
export const countMessagesBySession = (db: DB, sessionId: string): number =>
  (
    db.query('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as {
      n: number;
    }
  ).n;

// Count of assistant message rows for a session — one per billed provider
// call, so this is the session's TURN count (the denominator for /stats'
// per-turn averages). Tool-result and user rows are excluded: they aren't
// separate provider calls and would inflate the count. Cheap COUNT(*), no
// row materialization.
export const countAssistantMessagesBySession = (db: DB, sessionId: string): number =>
  (
    db
      .query("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'assistant'")
      .get(sessionId) as { n: number }
  ).n;

// `limit < 0` (canonically -1) means "no limit" — SQLite treats `LIMIT -1`
// as unbounded, so it returns every row for the session. Used by the
// uncapped "full"/"summary" resume modes; the capped path passes a positive
// limit as before.
export const listMessageTailBySession = (db: DB, sessionId: string, limit: number): MessageTail => {
  const rows = db
    .query(
      `SELECT id, session_id, parent_id, role, content,
              tokens_in, tokens_out, cached_tokens, cache_creation_tokens, cost_usd, created_at, prompt_hash, effort, source, model
       FROM (
         SELECT * FROM messages
         WHERE session_id = ?
         ORDER BY seq DESC
         LIMIT ?
       )
       ORDER BY seq ASC`,
    )
    .all(sessionId, limit) as MessageRow[];
  // Uncapped (limit < 0) fetched the whole log already, so rows.length IS the
  // total — skip the redundant COUNT(*). The capped path still needs it to
  // report how many older rows fell outside the window.
  const totalCount =
    limit < 0
      ? rows.length
      : (
          db.query('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as {
            n: number;
          }
        ).n;
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
