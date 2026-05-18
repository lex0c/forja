// memory_verify_override_attempts repo (migration 065, S3.3).
//
// Cross-session, content-addressed dedup cache for the S3 LLM-judge
// override detector. Mirrors memory_verify_attempts (S11) in shape;
// the differences:
//
//   - Verdict is a boolean `misguiding`, stored as INTEGER 0/1
//     (mirror of memory_conflict_attempts.verdict serialization).
//   - Carries a `suggested_motivo` so the proposal generator can
//     forward it to the governance apply path without re-parsing the
//     subagent output.
//   - No "always re-dispatch on critical verdict" branch — the
//     pending-proposal gate upstream handles dedup of operator queue
//     entries; this cache just prevents redundant LLM cost within
//     SEMANTIC_OVERRIDE_COOLDOWN_MS.

import type { MemoryScope } from '../../memory/index.ts';
import type { DB } from '../db.ts';

// ─── tunables ─────────────────────────────────────────────────────────

// Retention for the dedup table. 90d mirrors memory_verify_attempts +
// memory_conflict_attempts retention windows.
export const MEMORY_VERIFY_OVERRIDE_ATTEMPTS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

// ─── enums ────────────────────────────────────────────────────────────

export const OVERRIDE_SUGGESTED_MOTIVOS = ['conflict', 'shift', 'low_roi'] as const;
export type OverrideSuggestedMotivo = (typeof OVERRIDE_SUGGESTED_MOTIVOS)[number];

const VALID_MOTIVOS: ReadonlySet<OverrideSuggestedMotivo> = new Set(OVERRIDE_SUGGESTED_MOTIVOS);
const VALID_SCOPES: ReadonlySet<MemoryScope> = new Set(['user', 'project_shared', 'project_local']);

// ─── shapes ───────────────────────────────────────────────────────────

export interface MemoryVerifyOverrideAttemptRow {
  id: string;
  memoryScope: MemoryScope;
  memoryName: string;
  contentHash: string;
  misguiding: boolean;
  confidence: number;
  suggestedMotivo: OverrideSuggestedMotivo;
  modelId: string;
  promptHash: string;
  subagentRunSessionId: string | null;
  attemptedAt: number;
}

interface RawOverrideAttemptRow {
  id: string;
  memory_scope: MemoryScope;
  memory_name: string;
  content_hash: string;
  misguiding: number;
  confidence: number;
  suggested_motivo: string;
  model_id: string;
  prompt_hash: string;
  subagent_run_session_id: string | null;
  attempted_at: number;
}

const fromRow = (row: RawOverrideAttemptRow): MemoryVerifyOverrideAttemptRow => {
  if (!VALID_MOTIVOS.has(row.suggested_motivo as OverrideSuggestedMotivo)) {
    throw new Error(
      `memory_verify_override_attempts[${row.id}]: invalid suggested_motivo '${row.suggested_motivo}'`,
    );
  }
  return {
    id: row.id,
    memoryScope: row.memory_scope,
    memoryName: row.memory_name,
    contentHash: row.content_hash,
    misguiding: row.misguiding === 1,
    confidence: row.confidence,
    suggestedMotivo: row.suggested_motivo as OverrideSuggestedMotivo,
    modelId: row.model_id,
    promptHash: row.prompt_hash,
    subagentRunSessionId: row.subagent_run_session_id,
    attemptedAt: row.attempted_at,
  };
};

// ─── insert ───────────────────────────────────────────────────────────

export interface RecordOverrideAttemptInput {
  id?: string;
  memoryScope: MemoryScope;
  memoryName: string;
  contentHash: string;
  misguiding: boolean;
  confidence: number;
  suggestedMotivo: OverrideSuggestedMotivo;
  modelId: string;
  promptHash: string;
  subagentRunSessionId?: string | null;
  attemptedAt?: number;
}

const INSERT_SQL = `
  INSERT INTO memory_verify_override_attempts
    (id, memory_scope, memory_name, content_hash, misguiding, confidence,
     suggested_motivo, model_id, prompt_hash, subagent_run_session_id, attempted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export const recordOverrideAttempt = (
  db: DB,
  input: RecordOverrideAttemptInput,
): { id: string } => {
  if (!VALID_SCOPES.has(input.memoryScope)) {
    throw new Error(`recordOverrideAttempt: invalid memoryScope '${input.memoryScope}'`);
  }
  if (typeof input.memoryName !== 'string' || input.memoryName.length === 0) {
    throw new Error('recordOverrideAttempt: memoryName must be non-empty string');
  }
  if (typeof input.contentHash !== 'string' || input.contentHash.length === 0) {
    throw new Error('recordOverrideAttempt: contentHash must be non-empty string');
  }
  if (typeof input.confidence !== 'number' || input.confidence < 0 || input.confidence > 1) {
    throw new Error(
      `recordOverrideAttempt: confidence must be in [0, 1] (got ${input.confidence})`,
    );
  }
  if (!VALID_MOTIVOS.has(input.suggestedMotivo)) {
    throw new Error(`recordOverrideAttempt: invalid suggestedMotivo '${input.suggestedMotivo}'`);
  }
  const attemptedAt = input.attemptedAt ?? Date.now();
  if (attemptedAt <= 0) {
    throw new Error(`recordOverrideAttempt: attemptedAt must be > 0 (got ${attemptedAt})`);
  }
  const id = input.id ?? crypto.randomUUID();
  db.query(INSERT_SQL).run(
    id,
    input.memoryScope,
    input.memoryName,
    input.contentHash,
    input.misguiding ? 1 : 0,
    input.confidence,
    input.suggestedMotivo,
    input.modelId,
    input.promptHash,
    input.subagentRunSessionId ?? null,
    attemptedAt,
  );
  return { id };
};

// ─── lookup (dedup query) ─────────────────────────────────────────────

const SELECT_ALL = `
  SELECT id, memory_scope, memory_name, content_hash, misguiding, confidence,
         suggested_motivo, model_id, prompt_hash, subagent_run_session_id, attempted_at
    FROM memory_verify_override_attempts
`;

// Most-recent attempt for the (scope, name, content_hash) triple
// within the cooldown window. Returns null when no match — the
// dispatcher proceeds to spawn the subagent. Returns a row when
// the cache still holds a verdict for the same body within the
// window — the dispatcher honors the cached verdict and skips the
// LLM cost.
//
// `cooldownMs` is the window measured from `nowMs` (default
// `Date.now()`). Pass `SEMANTIC_OVERRIDE_COOLDOWN_MS` for the
// canonical S3 24h cooldown.
export const lookupRecentOverrideAttempt = (
  db: DB,
  scope: MemoryScope,
  name: string,
  contentHash: string,
  cooldownMs: number,
  nowMs?: number,
): MemoryVerifyOverrideAttemptRow | null => {
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`lookupRecentOverrideAttempt: invalid scope '${scope}'`);
  }
  if (cooldownMs <= 0) {
    throw new Error(`lookupRecentOverrideAttempt: cooldownMs must be > 0 (got ${cooldownMs})`);
  }
  const now = nowMs ?? Date.now();
  const cutoff = now - cooldownMs;
  const row = db
    .query<RawOverrideAttemptRow, [MemoryScope, string, string, number]>(
      `${SELECT_ALL}
        WHERE memory_scope = ? AND memory_name = ? AND content_hash = ?
          AND attempted_at >= ?
        ORDER BY attempted_at DESC
        LIMIT 1`,
    )
    .get(scope, name, contentHash, cutoff);
  return row !== null ? fromRow(row) : null;
};

// ─── listings (forensics + status surface) ─────────────────────────────

// Most-recent attempts across all memories. Backs the /memory
// governance status (S3.6) surface. Default 20 mirrors S11/S13
// status table size.
export const listRecentOverrideAttempts = (
  db: DB,
  limit = 20,
): MemoryVerifyOverrideAttemptRow[] => {
  const rows = db
    .query<RawOverrideAttemptRow, [number]>(
      `${SELECT_ALL} ORDER BY attempted_at DESC, id DESC LIMIT ?`,
    )
    .all(limit);
  return rows.map(fromRow);
};

// ─── retention ────────────────────────────────────────────────────────

export const pruneOverrideAttempts = (db: DB, olderThanMs: number): number => {
  if (olderThanMs <= 0) {
    throw new Error(`pruneOverrideAttempts: olderThanMs must be > 0 (got ${olderThanMs})`);
  }
  const result = db
    .query('DELETE FROM memory_verify_override_attempts WHERE attempted_at < ?')
    .run(olderThanMs);
  return Number(result.changes);
};
