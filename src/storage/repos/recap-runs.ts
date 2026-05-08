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
}

interface RecapRunRow {
  id: string;
  scope_kind: RecapScopeKind;
  session_ids: string;
  renderer: string;
  used_llm: number;
  output_path: string | null;
  created_at: number;
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
});

export interface RecordRecapRunInput {
  id?: string;
  scopeKind: RecapScopeKind;
  sessionIds: string[];
  renderer: string;
  usedLlm: boolean;
  outputPath?: string | null;
  createdAt?: number;
}

export const recordRecapRun = (db: DB, input: RecordRecapRunInput): RecapRun => {
  const id = input.id ?? crypto.randomUUID();
  const createdAt = input.createdAt ?? Date.now();
  const outputPath = input.outputPath ?? null;
  const sessionIdsJson = JSON.stringify(input.sessionIds);
  db.query(
    `INSERT INTO recap_runs
       (id, scope_kind, session_ids, renderer, used_llm, output_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.scopeKind,
    sessionIdsJson,
    input.renderer,
    input.usedLlm ? 1 : 0,
    outputPath,
    createdAt,
  );
  return {
    id,
    scopeKind: input.scopeKind,
    sessionIds: [...input.sessionIds],
    renderer: input.renderer,
    usedLlm: input.usedLlm,
    outputPath,
    createdAt,
  };
};

export const getRecapRun = (db: DB, id: string): RecapRun | null => {
  const row = db
    .query<RecapRunRow, [string]>(
      `SELECT id, scope_kind, session_ids, renderer, used_llm, output_path, created_at
         FROM recap_runs WHERE id = ?`,
    )
    .get(id);
  return row !== null ? fromRow(row) : null;
};

// Most-recent first. Drives `/recap audit` and the anomaly
// detector. Default cap of 50 matches `listRecentMemoryEvents`
// — same shape, same use case.
export const listRecentRecapRuns = (db: DB, limit = 50): RecapRun[] => {
  const rows = db
    .query<RecapRunRow, [number]>(
      `SELECT id, scope_kind, session_ids, renderer, used_llm, output_path, created_at
         FROM recap_runs
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(limit);
  return rows.map(fromRow);
};
