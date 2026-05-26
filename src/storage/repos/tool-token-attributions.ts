import type { DB } from '../db.ts';

// Repo for `tool_token_attributions` (migration 069). Spec:
// `docs/spec/TOKEN_ATTRIBUTION.md`.
//
// Captures per-tool-call token estimates so `agent stats --tools`
// can answer "which tool drove cost in this session?" without
// inferring from the raw message log. Writer site:
// `src/harness/invoke-tool.ts` (post-tool-execution, pre-message-
// append). Best-effort — INSERT failure logs stderr and tool
// prossegue (TOKEN_ATTRIBUTION.md §0 princípio 2).
//
// The `UNIQUE(tool_use_id)` invariant in the schema means a retry
// path (same call re-entered, e.g., partial provider stream replay)
// silently no-ops via `INSERT OR IGNORE` — first emission wins,
// no double-count.

export interface ToolTokenAttribution {
  id: number;
  sessionId: string;
  stepN: number;
  toolUseId: string;
  toolName: string;
  resultInputTokens: number;
  callOutputTokens: number;
  // Null when the writer didn't have provider capabilities in hand
  // and deferred cost computation to the reader. Reader can lookup
  // capabilities via session_id → sessions.model → provider registry
  // and compute on-the-fly.
  estimatedCostUsd: number | null;
  createdAt: number;
}

interface ToolTokenAttributionRow {
  id: number;
  session_id: string;
  step_n: number;
  tool_use_id: string;
  tool_name: string;
  result_input_tokens: number;
  call_output_tokens: number;
  estimated_cost_usd: number | null;
  created_at: number;
}

const fromRow = (row: ToolTokenAttributionRow): ToolTokenAttribution => ({
  id: row.id,
  sessionId: row.session_id,
  stepN: row.step_n,
  toolUseId: row.tool_use_id,
  toolName: row.tool_name,
  resultInputTokens: row.result_input_tokens,
  callOutputTokens: row.call_output_tokens,
  estimatedCostUsd: row.estimated_cost_usd,
  createdAt: row.created_at,
});

export interface AppendToolAttributionInput {
  sessionId: string;
  stepN: number;
  toolUseId: string;
  toolName: string;
  resultInputTokens: number;
  callOutputTokens: number;
  // Optional: caller computes cost only when provider capabilities
  // are at hand. Otherwise null and the reader derives.
  estimatedCostUsd?: number | null;
  // Optional injection seam for tests. Production callers omit;
  // `Date.now()` fills in.
  createdAt?: number;
}

// Append one row. `INSERT OR IGNORE` against the `UNIQUE(tool_use_id)`
// constraint — retry path that re-enters the capture site for the
// same call silently no-ops, first emission wins. FK violation
// (session_id pointing nowhere) throws; SQLITE_BUSY under WAL
// contention throws — caller (`invoke-tool.ts`) wraps in try/catch
// and logs stderr, tool prossegue.
export const appendToolAttribution = (db: DB, input: AppendToolAttributionInput): void => {
  const createdAt = input.createdAt ?? Date.now();
  db.query(
    `INSERT OR IGNORE INTO tool_token_attributions
       (session_id, step_n, tool_use_id, tool_name,
        result_input_tokens, call_output_tokens, estimated_cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.sessionId,
    input.stepN,
    input.toolUseId,
    input.toolName,
    input.resultInputTokens,
    input.callOutputTokens,
    input.estimatedCostUsd ?? null,
    createdAt,
  );
};

// All attributions for a session, ordered chronologically within
// step (step_n ASC, then created_at ASC). Powers `agent stats --tools`
// per-session view + the drill-down `--step N` filter (caller
// filters in TS rather than parameterizing the query — N rarely
// exceeds 100, and the simpler shape is worth more than a marginal
// SQL clause).
export const listToolAttributionsBySession = (
  db: DB,
  sessionId: string,
): ToolTokenAttribution[] => {
  const rows = db
    .query<ToolTokenAttributionRow, [string]>(
      `SELECT id, session_id, step_n, tool_use_id, tool_name,
              result_input_tokens, call_output_tokens,
              estimated_cost_usd, created_at
         FROM tool_token_attributions
        WHERE session_id = ?
        ORDER BY step_n ASC, created_at ASC, id ASC`,
    )
    .all(sessionId);
  return rows.map(fromRow);
};

export interface ToolAttributionAggregate {
  toolName: string;
  calls: number;
  totalResultInputTokens: number;
  totalCallOutputTokens: number;
  // Sum across rows that carried a cost estimate. May be incomplete
  // if some rows had estimated_cost_usd=NULL (caller surface should
  // signal this to the operator — see CLI spec §4.1 "some calls com
  // cost estimado on-the-fly").
  totalEstimatedCostUsd: number | null;
  // Count of rows in the aggregate whose `estimated_cost_usd` was
  // NULL. When > 0, `totalEstimatedCostUsd` is a lower bound. The
  // operator-facing CLI displays "(N calls com cost estimado on-the-
  // fly)" when this is nonzero.
  rowsWithoutCost: number;
}

interface ToolAttributionAggregateRow {
  tool_name: string;
  calls: number;
  total_result_input_tokens: number;
  total_call_output_tokens: number;
  total_estimated_cost_usd: number | null;
  rows_without_cost: number;
}

// GROUP BY tool_name within a session. Ordered by total_result_input_tokens
// DESC — operator wants "biggest context drains first". Ties resolved
// by tool_name ASC for deterministic display.
export const aggregateToolAttributionsByName = (
  db: DB,
  sessionId: string,
): ToolAttributionAggregate[] => {
  const rows = db
    .query<ToolAttributionAggregateRow, [string]>(
      `SELECT tool_name,
              COUNT(*) AS calls,
              SUM(result_input_tokens) AS total_result_input_tokens,
              SUM(call_output_tokens) AS total_call_output_tokens,
              SUM(estimated_cost_usd) AS total_estimated_cost_usd,
              SUM(CASE WHEN estimated_cost_usd IS NULL THEN 1 ELSE 0 END)
                AS rows_without_cost
         FROM tool_token_attributions
        WHERE session_id = ?
        GROUP BY tool_name
        ORDER BY total_result_input_tokens DESC, tool_name ASC`,
    )
    .all(sessionId);
  return rows.map((r) => ({
    toolName: r.tool_name,
    calls: r.calls,
    totalResultInputTokens: r.total_result_input_tokens,
    totalCallOutputTokens: r.total_call_output_tokens,
    totalEstimatedCostUsd: r.total_estimated_cost_usd,
    rowsWithoutCost: r.rows_without_cost,
  }));
};

export interface ToolAttributionGlobalAggregate extends ToolAttributionAggregate {
  // Distinct sessions that contributed to this row.
  sessions: number;
}

interface ToolAttributionGlobalAggregateRow extends ToolAttributionAggregateRow {
  sessions: number;
}

// Cross-session aggregation for `agent stats --tools --all [--since <ms>]`.
// `sinceMs`: optional epoch lower bound on `created_at`.
// `limit`: optional cap on rows returned (default unbounded — caller
// truncates).
export const aggregateToolAttributionsGlobal = (
  db: DB,
  opts: { sinceMs?: number; limit?: number } = {},
): ToolAttributionGlobalAggregate[] => {
  // Build the query in pieces so the WHERE clause is optional without
  // forcing a `WHERE 1=1` shim that some SQLite versions plan badly.
  const sinceClause = opts.sinceMs !== undefined ? 'WHERE created_at >= ?' : '';
  const limitClause = opts.limit !== undefined ? 'LIMIT ?' : '';
  const sql = `SELECT tool_name,
                      COUNT(*) AS calls,
                      COUNT(DISTINCT session_id) AS sessions,
                      SUM(result_input_tokens) AS total_result_input_tokens,
                      SUM(call_output_tokens) AS total_call_output_tokens,
                      SUM(estimated_cost_usd) AS total_estimated_cost_usd,
                      SUM(CASE WHEN estimated_cost_usd IS NULL THEN 1 ELSE 0 END)
                        AS rows_without_cost
                 FROM tool_token_attributions
                 ${sinceClause}
                 GROUP BY tool_name
                 ORDER BY total_result_input_tokens DESC, tool_name ASC
                 ${limitClause}`;
  const params: (string | number)[] = [];
  if (opts.sinceMs !== undefined) params.push(opts.sinceMs);
  if (opts.limit !== undefined) params.push(opts.limit);
  const rows = db.query<ToolAttributionGlobalAggregateRow, (string | number)[]>(sql).all(...params);
  return rows.map((r) => ({
    toolName: r.tool_name,
    calls: r.calls,
    sessions: r.sessions,
    totalResultInputTokens: r.total_result_input_tokens,
    totalCallOutputTokens: r.total_call_output_tokens,
    totalEstimatedCostUsd: r.total_estimated_cost_usd,
    rowsWithoutCost: r.rows_without_cost,
  }));
};

// Total row count — useful for "any data?" guards in the CLI surface.
export const countToolAttributions = (db: DB, sessionId?: string): number => {
  if (sessionId === undefined) {
    const row = db
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM tool_token_attributions')
      .get();
    return row?.n ?? 0;
  }
  const row = db
    .query<{ n: number }, [string]>(
      'SELECT COUNT(*) AS n FROM tool_token_attributions WHERE session_id = ?',
    )
    .get(sessionId);
  return row?.n ?? 0;
};
