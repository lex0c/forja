// memory_conflict_attempts repo (migration 061, S13 / T13.4).
//
// Cross-session, pair-keyed, content-addressed dedup for the LLM-judge
// conflict detector. Mirrors memory_verify_attempts in shape; the
// difference is the key — every operation deals with a CANONICAL
// pair of (scope, name, content_hash) triples rather than a single
// memo.
//
// Pair canonicalization is enforced at the call site: callers MUST
// sort the pair so the lexicographically smaller `scope/name`
// becomes side A. The CHECK constraint in migration 061 refuses
// non-canonical pairs at INSERT time; this module exposes a
// canonicalizePair helper so callers don't have to re-derive the
// rule.
//
// Dedup semantic mirrors memory_verify_attempts:
//   - verdict='compatible' → dedup for SEMANTIC_CONFLICT_DEDUP_WINDOW_MS
//     (7d). Re-dispatch when window elapses OR either body hash
//     changes (operator edited a memory, content_hash drifts, the
//     pair-key changes, lookup misses).
//   - verdict='conflicting' → ALWAYS null. High-stakes verdict
//     deserves re-confirmation; the cost cap is the rate-limit.

import type { MemoryScope } from '../../memory/index.ts';
import type { DB } from '../db.ts';

// ─── enums ────────────────────────────────────────────────────────────

export const CONFLICT_VERDICTS = ['conflicting', 'compatible'] as const;
export type ConflictVerdict = (typeof CONFLICT_VERDICTS)[number];

const VALID_VERDICTS: ReadonlySet<ConflictVerdict> = new Set(CONFLICT_VERDICTS);
const VALID_SCOPES: ReadonlySet<MemoryScope> = new Set(['user', 'project_shared', 'project_local']);

// ─── tunables ─────────────────────────────────────────────────────────

// Same shape + cadence as SEMANTIC_VERIFY_DEDUP_WINDOW_MS. Kept as
// a distinct constant so a future tuning round can adjust conflict
// dedup independently of semantic-verify dedup without coupling.
export const SEMANTIC_CONFLICT_DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Same shape as MEMORY_VERIFY_ATTEMPTS_RETENTION_MS; mirrors
// memory_provenance retention.
export const MEMORY_CONFLICT_ATTEMPTS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

// ─── shapes ───────────────────────────────────────────────────────────

export interface MemoryConflictAttemptRow {
  id: string;
  scopeA: MemoryScope;
  nameA: string;
  contentHashA: string;
  scopeB: MemoryScope;
  nameB: string;
  contentHashB: string;
  verdict: ConflictVerdict;
  conflictKind: string | null;
  confidence: number;
  modelId: string;
  promptHash: string;
  subagentRunSessionId: string | null;
  attemptedAt: number;
}

interface RawConflictRow {
  id: string;
  scope_a: MemoryScope;
  name_a: string;
  content_hash_a: string;
  scope_b: MemoryScope;
  name_b: string;
  content_hash_b: string;
  verdict: string;
  conflict_kind: string | null;
  confidence: number;
  model_id: string;
  prompt_hash: string;
  subagent_run_session_id: string | null;
  attempted_at: number;
}

const fromRow = (row: RawConflictRow): MemoryConflictAttemptRow => {
  if (!VALID_VERDICTS.has(row.verdict as ConflictVerdict)) {
    throw new Error(`memory_conflict_attempts[${row.id}]: invalid verdict '${row.verdict}'`);
  }
  return {
    id: row.id,
    scopeA: row.scope_a,
    nameA: row.name_a,
    contentHashA: row.content_hash_a,
    scopeB: row.scope_b,
    nameB: row.name_b,
    contentHashB: row.content_hash_b,
    verdict: row.verdict as ConflictVerdict,
    conflictKind: row.conflict_kind,
    confidence: row.confidence,
    modelId: row.model_id,
    promptHash: row.prompt_hash,
    subagentRunSessionId: row.subagent_run_session_id,
    attemptedAt: row.attempted_at,
  };
};

// ─── pair canonicalization ────────────────────────────────────────────

export interface ConflictPairSide {
  scope: MemoryScope;
  name: string;
  contentHash: string;
}

export interface CanonicalConflictPair {
  a: ConflictPairSide;
  b: ConflictPairSide;
}

// Sort a pair so the lexicographically smaller `scope/name` becomes
// side A. Matches the CHECK constraint in migration 061. Pure;
// callers can use it without an open DB connection.
export const canonicalizePair = (
  x: ConflictPairSide,
  y: ConflictPairSide,
): CanonicalConflictPair => {
  const keyX = `${x.scope}/${x.name}`;
  const keyY = `${y.scope}/${y.name}`;
  if (keyX === keyY) {
    throw new Error(`canonicalizePair: same (scope, name) on both sides — refusing (${keyX})`);
  }
  return keyX < keyY ? { a: x, b: y } : { a: y, b: x };
};

// ─── recordConflictAttempt ────────────────────────────────────────────

export interface RecordConflictAttemptInput {
  id?: string;
  pair: CanonicalConflictPair;
  verdict: ConflictVerdict;
  conflictKind?: string | null;
  confidence: number;
  modelId: string;
  promptHash: string;
  subagentRunSessionId?: string | null;
  attemptedAt?: number;
}

const INSERT_SQL = `
  INSERT INTO memory_conflict_attempts
    (id, scope_a, name_a, content_hash_a,
     scope_b, name_b, content_hash_b,
     verdict, conflict_kind, confidence,
     model_id, prompt_hash, subagent_run_session_id, attempted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export const recordConflictAttempt = (
  db: DB,
  input: RecordConflictAttemptInput,
): MemoryConflictAttemptRow => {
  const { a, b } = input.pair;
  if (!VALID_SCOPES.has(a.scope)) {
    throw new Error(`recordConflictAttempt: invalid scope_a '${a.scope}'`);
  }
  if (!VALID_SCOPES.has(b.scope)) {
    throw new Error(`recordConflictAttempt: invalid scope_b '${b.scope}'`);
  }
  // Defense-in-depth: the SQL CHECK refuses non-canonical pairs,
  // but throwing here gives the caller a TS-level error message
  // (the CHECK fires with a generic SQLite constraint string).
  const keyA = `${a.scope}/${a.name}`;
  const keyB = `${b.scope}/${b.name}`;
  if (keyA >= keyB) {
    throw new Error(
      `recordConflictAttempt: pair not in canonical order (${keyA} >= ${keyB}) — use canonicalizePair`,
    );
  }
  if (!VALID_VERDICTS.has(input.verdict)) {
    throw new Error(`recordConflictAttempt: invalid verdict '${input.verdict}'`);
  }
  if (input.confidence < 0 || input.confidence > 1 || !Number.isFinite(input.confidence)) {
    throw new Error(
      `recordConflictAttempt: confidence must be in [0, 1] (got ${input.confidence})`,
    );
  }
  if (typeof input.modelId !== 'string' || input.modelId.length === 0) {
    throw new Error('recordConflictAttempt: modelId must be non-empty string');
  }
  if (typeof input.promptHash !== 'string' || input.promptHash.length === 0) {
    throw new Error('recordConflictAttempt: promptHash must be non-empty string');
  }
  const id = input.id ?? crypto.randomUUID();
  const attemptedAt = input.attemptedAt ?? Date.now();
  if (attemptedAt <= 0) {
    throw new Error(`recordConflictAttempt: attemptedAt must be > 0 (got ${attemptedAt})`);
  }
  const conflictKind = input.conflictKind ?? null;
  db.query(INSERT_SQL).run(
    id,
    a.scope,
    a.name,
    a.contentHash,
    b.scope,
    b.name,
    b.contentHash,
    input.verdict,
    conflictKind,
    input.confidence,
    input.modelId,
    input.promptHash,
    input.subagentRunSessionId ?? null,
    attemptedAt,
  );
  return {
    id,
    scopeA: a.scope,
    nameA: a.name,
    contentHashA: a.contentHash,
    scopeB: b.scope,
    nameB: b.name,
    contentHashB: b.contentHash,
    verdict: input.verdict,
    conflictKind,
    confidence: input.confidence,
    modelId: input.modelId,
    promptHash: input.promptHash,
    subagentRunSessionId: input.subagentRunSessionId ?? null,
    attemptedAt,
  };
};

// ─── lookupRecentConflictAttempt ──────────────────────────────────────

const SELECT_RECENT_SQL = `
  SELECT id, scope_a, name_a, content_hash_a,
         scope_b, name_b, content_hash_b,
         verdict, conflict_kind, confidence,
         model_id, prompt_hash, subagent_run_session_id, attempted_at
    FROM memory_conflict_attempts
   WHERE scope_a = ? AND name_a = ? AND content_hash_a = ?
     AND scope_b = ? AND name_b = ? AND content_hash_b = ?
   ORDER BY attempted_at DESC, id DESC
   LIMIT 1
`;

// Returns the most-recent attempt for the canonical pair IF it
// should still suppress a re-dispatch.
//
// Suppression rules (mirror memory_verify_attempts.lookupRecentAttempt):
//   - verdict='conflicting' → ALWAYS null (re-dispatch).
//   - verdict='compatible' → row IF attempted_at within
//     SEMANTIC_CONFLICT_DEDUP_WINDOW_MS of nowMs; null past it.
//
// Caller MUST pass a canonicalized pair (see canonicalizePair). Same
// shape rationale as recordConflictAttempt.
export const lookupRecentConflictAttempt = (
  db: DB,
  pair: CanonicalConflictPair,
  opts: { nowMs?: number; windowMs?: number } = {},
): MemoryConflictAttemptRow | null => {
  const { a, b } = pair;
  const row = db
    .query<RawConflictRow, [MemoryScope, string, string, MemoryScope, string, string]>(
      SELECT_RECENT_SQL,
    )
    .get(a.scope, a.name, a.contentHash, b.scope, b.name, b.contentHash);
  if (row === null) return null;
  const parsed = fromRow(row);
  if (parsed.verdict === 'conflicting') return null;
  const now = opts.nowMs ?? Date.now();
  const window = opts.windowMs ?? SEMANTIC_CONFLICT_DEDUP_WINDOW_MS;
  if (now - parsed.attemptedAt >= window) return null;
  return parsed;
};

// ─── listRecentConflictAttempts ───────────────────────────────────────

// Cross-session recent attempts, most recent first. Used by the
// `/memory governance status` slash. Default limit 20 keeps the
// slash output scannable.
export const listRecentConflictAttempts = (db: DB, limit = 20): MemoryConflictAttemptRow[] => {
  const rows = db
    .query<RawConflictRow, [number]>(
      `SELECT id, scope_a, name_a, content_hash_a,
              scope_b, name_b, content_hash_b,
              verdict, conflict_kind, confidence,
              model_id, prompt_hash, subagent_run_session_id, attempted_at
         FROM memory_conflict_attempts
        ORDER BY attempted_at DESC, id DESC
        LIMIT ?`,
    )
    .all(limit);
  return rows.map(fromRow);
};

// ─── pruneConflictAttempts ────────────────────────────────────────────

// Boot-time GC sweep: drop rows older than `olderThanMs`. Returns
// the row count. Cutoff EXCLUSIVE (mirror pruneVerifyAttempts).
export const pruneConflictAttempts = (db: DB, olderThanMs: number): number => {
  const result = db
    .query('DELETE FROM memory_conflict_attempts WHERE attempted_at < ?')
    .run(olderThanMs);
  return Number(result.changes);
};
