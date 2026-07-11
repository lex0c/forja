// memory_verify_attempts repo (migration 057, S11 / T11.10).
//
// Cross-session, content-addressed dedup for the LLM-judge semantic
// verifier. Scheduler queries `lookupRecentAttempt` BEFORE dispatch
// to avoid paying LLM cost for a memory the judge just looked at.
// Stays append-only; pruning is a boot-time sweep.
//
// Dedup semantic (per TODO T11.10):
//
//   - passed / inconclusive: dedup for 7 days. Re-dispatch only when
//     content_hash changes (operator edited the body) OR the window
//     elapses.
//   - contradicted: ALWAYS re-dispatch. Single-shot contradicted is
//     high-stakes; re-confirmation against the same body is cheap
//     insurance against a flaky verdict.

import type { MemoryScope } from '../../memory/index.ts';
import type { DB } from '../db.ts';

// ─── enums ────────────────────────────────────────────────────────────

export const SEMANTIC_VERIFY_VERDICTS = ['passed', 'contradicted', 'inconclusive'] as const;
export type SemanticVerifyVerdict = (typeof SEMANTIC_VERIFY_VERDICTS)[number];

const VALID_VERDICTS: ReadonlySet<SemanticVerifyVerdict> = new Set(SEMANTIC_VERIFY_VERDICTS);
const VALID_SCOPES: ReadonlySet<MemoryScope> = new Set(['user', 'project_shared', 'project_local']);

// ─── tunables ─────────────────────────────────────────────────────────

// Passed / inconclusive verdicts dedup within this window. Picked to
// match the boot cadence operators run with (7d covers a week of
// daily-driver sessions without re-paying LLM cost for memories the
// judge just judged). Contradicted always re-dispatches regardless
// of window — high-stakes verdict deserves re-confirmation, and the
// cost cap (T11.9) is the rate-limit, not this window.
export const SEMANTIC_VERIFY_DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Retention for the dedup table. 90d mirrors memory_provenance —
// these rows are observability + dedup substrate; beyond 90d the
// content_hash + scope/name pair has almost certainly drifted, and
// re-dispatch is fine.
export const MEMORY_VERIFY_ATTEMPTS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

// ─── shapes ───────────────────────────────────────────────────────────

export interface MemoryVerifyAttemptRow {
  id: string;
  memoryScope: MemoryScope;
  memoryName: string;
  contentHash: string;
  verdict: SemanticVerifyVerdict;
  confidence: number;
  modelId: string;
  promptHash: string;
  subagentRunSessionId: string | null;
  attemptedAt: number;
}

interface RawAttemptRow {
  id: string;
  memory_scope: MemoryScope;
  memory_name: string;
  content_hash: string;
  verdict: string;
  confidence: number;
  model_id: string;
  prompt_hash: string;
  subagent_run_session_id: string | null;
  attempted_at: number;
}

const fromRow = (row: RawAttemptRow): MemoryVerifyAttemptRow => {
  if (!VALID_VERDICTS.has(row.verdict as SemanticVerifyVerdict)) {
    throw new Error(`memory_verify_attempts[${row.id}]: invalid verdict '${row.verdict}'`);
  }
  return {
    id: row.id,
    memoryScope: row.memory_scope,
    memoryName: row.memory_name,
    contentHash: row.content_hash,
    verdict: row.verdict as SemanticVerifyVerdict,
    confidence: row.confidence,
    modelId: row.model_id,
    promptHash: row.prompt_hash,
    subagentRunSessionId: row.subagent_run_session_id,
    attemptedAt: row.attempted_at,
  };
};

export interface RecordAttemptInput {
  id?: string;
  memoryScope: MemoryScope;
  memoryName: string;
  contentHash: string;
  verdict: SemanticVerifyVerdict;
  confidence: number;
  modelId: string;
  promptHash: string;
  subagentRunSessionId?: string | null;
  attemptedAt?: number;
}

// ─── recordAttempt ────────────────────────────────────────────────────

const INSERT_SQL = `
  INSERT INTO memory_verify_attempts
    (id, memory_scope, memory_name, content_hash, verdict, confidence,
     model_id, prompt_hash, subagent_run_session_id, attempted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export const recordAttempt = (db: DB, input: RecordAttemptInput): MemoryVerifyAttemptRow => {
  if (!VALID_SCOPES.has(input.memoryScope)) {
    throw new Error(`recordAttempt: invalid memoryScope '${input.memoryScope}'`);
  }
  if (typeof input.memoryName !== 'string' || input.memoryName.length === 0) {
    throw new Error('recordAttempt: memoryName must be non-empty string');
  }
  if (typeof input.contentHash !== 'string' || input.contentHash.length === 0) {
    throw new Error('recordAttempt: contentHash must be non-empty string');
  }
  if (!VALID_VERDICTS.has(input.verdict)) {
    throw new Error(`recordAttempt: invalid verdict '${input.verdict}'`);
  }
  if (input.confidence < 0 || input.confidence > 1 || !Number.isFinite(input.confidence)) {
    throw new Error(`recordAttempt: confidence must be in [0, 1] (got ${input.confidence})`);
  }
  if (typeof input.modelId !== 'string' || input.modelId.length === 0) {
    throw new Error('recordAttempt: modelId must be non-empty string');
  }
  if (typeof input.promptHash !== 'string' || input.promptHash.length === 0) {
    throw new Error('recordAttempt: promptHash must be non-empty string');
  }
  const id = input.id ?? crypto.randomUUID();
  const attemptedAt = input.attemptedAt ?? Date.now();
  if (attemptedAt <= 0) {
    throw new Error(`recordAttempt: attemptedAt must be > 0 epoch ms (got ${attemptedAt})`);
  }
  db.query(INSERT_SQL).run(
    id,
    input.memoryScope,
    input.memoryName,
    input.contentHash,
    input.verdict,
    input.confidence,
    input.modelId,
    input.promptHash,
    input.subagentRunSessionId ?? null,
    attemptedAt,
  );
  return {
    id,
    memoryScope: input.memoryScope,
    memoryName: input.memoryName,
    contentHash: input.contentHash,
    verdict: input.verdict,
    confidence: input.confidence,
    modelId: input.modelId,
    promptHash: input.promptHash,
    subagentRunSessionId: input.subagentRunSessionId ?? null,
    attemptedAt,
  };
};

// ─── lookupRecentAttempt ──────────────────────────────────────────────

const SELECT_RECENT_SQL = `
  SELECT id, memory_scope, memory_name, content_hash, verdict, confidence,
         model_id, prompt_hash, subagent_run_session_id, attempted_at
    FROM memory_verify_attempts
   WHERE memory_scope = ? AND memory_name = ? AND content_hash = ?
   ORDER BY attempted_at DESC, id DESC
   LIMIT 1
`;

// Returns the most-recent attempt for (scope, name, content_hash)
// IF it should still suppress a re-dispatch. Returns null otherwise.
//
// Suppression rules:
//   - verdict='contradicted' → ALWAYS null (re-dispatch every time).
//   - verdict='passed' OR 'inconclusive' → row IF attempted_at within
//     SEMANTIC_VERIFY_DEDUP_WINDOW_MS of nowMs; null past the window.
//
// `windowMs` overrides SEMANTIC_VERIFY_DEDUP_WINDOW_MS for tests.
// `nowMs` defaults to Date.now().
export const lookupRecentAttempt = (
  db: DB,
  scope: MemoryScope,
  name: string,
  contentHash: string,
  opts: { nowMs?: number; windowMs?: number } = {},
): MemoryVerifyAttemptRow | null => {
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`lookupRecentAttempt: invalid scope '${scope}'`);
  }
  const row = db
    .query<RawAttemptRow, [MemoryScope, string, string]>(SELECT_RECENT_SQL)
    .get(scope, name, contentHash);
  if (row === null) return null;
  const parsed = fromRow(row);
  if (parsed.verdict === 'contradicted') return null;
  const now = opts.nowMs ?? Date.now();
  const window = opts.windowMs ?? SEMANTIC_VERIFY_DEDUP_WINDOW_MS;
  if (now - parsed.attemptedAt >= window) return null;
  return parsed;
};

// ─── listRecentAttempts ───────────────────────────────────────────────

// Cross-session recent attempts, most recent first. Used by the
// `/memory governance status` slash to surface what the verifier
// has been doing without a session filter (memory_verify_attempts
// has no session_id column — verifications are content-addressed,
// not session-scoped). Default limit 20 keeps the slash output
// scannable.
export const listRecentAttempts = (db: DB, limit = 20): MemoryVerifyAttemptRow[] => {
  const rows = db
    .query<RawAttemptRow, [number]>(
      `SELECT id, memory_scope, memory_name, content_hash, verdict, confidence,
              model_id, prompt_hash, subagent_run_session_id, attempted_at
         FROM memory_verify_attempts
        ORDER BY attempted_at DESC, id DESC
        LIMIT ?`,
    )
    .all(limit);
  return rows.map(fromRow);
};

// ─── pruneVerifyAttempts ──────────────────────────────────────────────

// Boot-time GC sweep: drop rows older than `olderThanMs`. Returns
// the row count for telemetry. Cutoff EXCLUSIVE — a row at exactly
// `olderThanMs` is KEPT (matches pruneMemoryProvenance semantics).
export const pruneVerifyAttempts = (db: DB, olderThanMs: number): number => {
  const result = db
    .query('DELETE FROM memory_verify_attempts WHERE attempted_at < ?')
    .run(olderThanMs);
  return Number(result.changes);
};
