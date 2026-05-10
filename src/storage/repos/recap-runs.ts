import type { DB } from '../db.ts';

export type RecapScopeKind =
  | 'session_current'
  | 'session_specific'
  | 'day'
  | 'range'
  | 'pre_compact';

export interface RecapRun {
  id: string;
  scopeKind: RecapScopeKind;
  // Sessions touched by the projection. Cardinality 1 for
  // session_current / session_specific / pre_compact; N for
  // day / range. Forensic only — no FK back to `sessions`,
  // since a since-purged session is still a real historical
  // recap we want to keep.
  sessionIds: string[];
  renderer: string;
  usedLlm: boolean;
  // Set when `--out <path>` was passed; null for stdout-only
  // renders. Audit consumers detecting "recap leaking to disk"
  // key on non-null values here.
  outputPath: string | null;
  createdAt: number;
  // Cost accounting added in migration 033 (RECAP.md §6.3).
  // Zero for deterministic / cache-hit / json renderers; real
  // dollar amount for the LLM render path on a cache miss.
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  // Prompt version label (e.g. 'pr-v1'). Null for deterministic
  // renders that did not feed a prompt to any LLM.
  promptVersion: string | null;
  // True iff the LLM render path served from `recap_cache` rather
  // than calling the provider. Distinguishes "we paid" from "we
  // reused" in production audit aggregations.
  cacheHit: boolean;
}

interface RecapRunRow {
  id: string;
  scope_kind: RecapScopeKind;
  session_ids: string;
  renderer: string;
  used_llm: number;
  output_path: string | null;
  created_at: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  prompt_version: string | null;
  cache_hit: number;
}

// Defensive parse on the JSON array column. Storage corruption is
// unlikely (only this repo writes it), but a malformed payload
// should not crash audit listings — surface an empty array and
// let the consumer detect via `sessionIds.length === 0` paired
// with the row's other metadata. Mirrors the pattern in
// `subagent-outputs.ts:58-69`.
const parseSessionIds = (raw: string): string[] => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
};

const fromRow = (row: RecapRunRow): RecapRun => ({
  id: row.id,
  scopeKind: row.scope_kind,
  sessionIds: parseSessionIds(row.session_ids),
  renderer: row.renderer,
  usedLlm: row.used_llm === 1,
  outputPath: row.output_path,
  createdAt: row.created_at,
  costUsd: row.cost_usd,
  tokensIn: row.tokens_in,
  tokensOut: row.tokens_out,
  promptVersion: row.prompt_version,
  cacheHit: row.cache_hit === 1,
});

export interface RecordRecapRunInput {
  id?: string;
  scopeKind: RecapScopeKind;
  sessionIds: string[];
  renderer: string;
  usedLlm: boolean;
  outputPath?: string | null;
  createdAt?: number;
  // M4.2 LLM render path fields. All optional with sensible
  // defaults so M4.1 callers (deterministic only) keep working
  // unchanged: deterministic renders pay $0, use no tokens, have
  // no prompt version, and never cache-hit (the cache only stores
  // LLM output).
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  promptVersion?: string | null;
  cacheHit?: boolean;
}

const SELECT_COLS =
  'id, scope_kind, session_ids, renderer, used_llm, output_path, ' +
  'created_at, cost_usd, tokens_in, tokens_out, prompt_version, cache_hit';

export const recordRecapRun = (db: DB, input: RecordRecapRunInput): RecapRun => {
  const id = input.id ?? crypto.randomUUID();
  const createdAt = input.createdAt ?? Date.now();
  const outputPath = input.outputPath ?? null;
  const sessionIdsJson = JSON.stringify(input.sessionIds);
  const costUsd = input.costUsd ?? 0;
  const tokensIn = input.tokensIn ?? 0;
  const tokensOut = input.tokensOut ?? 0;
  const promptVersion = input.promptVersion ?? null;
  const cacheHit = input.cacheHit ?? false;
  db.query(
    `INSERT INTO recap_runs
       (id, scope_kind, session_ids, renderer, used_llm, output_path,
        created_at, cost_usd, tokens_in, tokens_out, prompt_version, cache_hit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.scopeKind,
    sessionIdsJson,
    input.renderer,
    input.usedLlm ? 1 : 0,
    outputPath,
    createdAt,
    costUsd,
    tokensIn,
    tokensOut,
    promptVersion,
    cacheHit ? 1 : 0,
  );
  return {
    id,
    scopeKind: input.scopeKind,
    sessionIds: [...input.sessionIds],
    renderer: input.renderer,
    usedLlm: input.usedLlm,
    outputPath,
    createdAt,
    costUsd,
    tokensIn,
    tokensOut,
    promptVersion,
    cacheHit,
  };
};

export const getRecapRun = (db: DB, id: string): RecapRun | null => {
  const row = db
    .query<RecapRunRow, [string]>(`SELECT ${SELECT_COLS} FROM recap_runs WHERE id = ?`)
    .get(id);
  return row !== null ? fromRow(row) : null;
};

// Most-recent first. Drives `/recap audit` and the anomaly
// detector. Default cap of 50 matches `listRecentMemoryEvents`
// — same shape, same use case.
export const listRecentRecapRuns = (db: DB, limit = 50): RecapRun[] => {
  const rows = db
    .query<RecapRunRow, [number]>(
      `SELECT ${SELECT_COLS} FROM recap_runs
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(limit);
  return rows.map(fromRow);
};
