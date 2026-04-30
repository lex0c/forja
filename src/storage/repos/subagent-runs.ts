import type { DB } from '../db.ts';

export type SubagentScope = 'user' | 'project';

export interface SubagentRun {
  sessionId: string;
  name: string;
  scope: SubagentScope;
  sourcePath: string;
  sourceSha256: string;
  systemPrompt: string;
  // Parsed JSON array. Stored as TEXT in SQLite per the schema in
  // migration 012; the repo handles serialization on insert and
  // parsing on read.
  toolsWhitelist: string[];
  budgetMaxSteps: number;
  budgetMaxCostUsd: number;
  // Mirrors the optional field in SubagentBudget. Null when the
  // definition didn't declare a wall-clock cap.
  budgetMaxWallMs: number | null;
  capturedAt: number;
}

interface SubagentRunRow {
  session_id: string;
  name: string;
  scope: SubagentScope;
  source_path: string;
  source_sha256: string;
  system_prompt: string;
  tools_whitelist: string;
  budget_max_steps: number;
  budget_max_cost_usd: number;
  budget_max_wall_ms: number | null;
  captured_at: number;
}

const fromRow = (row: SubagentRunRow): SubagentRun => {
  // Defensive parse on tools_whitelist. Storage corruption is
  // unlikely (the column is INSERT-once and TEXT is opaque to
  // SQLite), but a malformed JSON would crash audit queries
  // mid-listing — surface as an empty array with a deterministic
  // shape instead. Audit consumers who want to detect corruption
  // can compare with the parsed value's length against the
  // definition's tool count.
  let tools: string[];
  try {
    const parsed = JSON.parse(row.tools_whitelist) as unknown;
    tools = Array.isArray(parsed) && parsed.every((e) => typeof e === 'string') ? parsed : [];
  } catch {
    tools = [];
  }
  return {
    sessionId: row.session_id,
    name: row.name,
    scope: row.scope,
    sourcePath: row.source_path,
    sourceSha256: row.source_sha256,
    systemPrompt: row.system_prompt,
    toolsWhitelist: tools,
    budgetMaxSteps: row.budget_max_steps,
    budgetMaxCostUsd: row.budget_max_cost_usd,
    budgetMaxWallMs: row.budget_max_wall_ms,
    capturedAt: row.captured_at,
  };
};

export interface InsertSubagentRunInput {
  sessionId: string;
  name: string;
  scope: SubagentScope;
  sourcePath: string;
  sourceSha256: string;
  systemPrompt: string;
  toolsWhitelist: string[];
  budgetMaxSteps: number;
  budgetMaxCostUsd: number;
  budgetMaxWallMs?: number;
  capturedAt?: number;
}

export const insertSubagentRun = (db: DB, input: InsertSubagentRunInput): SubagentRun => {
  const capturedAt = input.capturedAt ?? Date.now();
  const wallMs = input.budgetMaxWallMs ?? null;
  // Serialize the whitelist as a JSON array. Same convention the
  // messages table uses for its `content` column — keep the
  // schema dumb, parse on read.
  const toolsJson = JSON.stringify(input.toolsWhitelist);
  db.query(
    `INSERT INTO subagent_runs
       (session_id, name, scope, source_path, source_sha256, system_prompt,
        tools_whitelist, budget_max_steps, budget_max_cost_usd,
        budget_max_wall_ms, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.sessionId,
    input.name,
    input.scope,
    input.sourcePath,
    input.sourceSha256,
    input.systemPrompt,
    toolsJson,
    input.budgetMaxSteps,
    input.budgetMaxCostUsd,
    wallMs,
    capturedAt,
  );
  return {
    sessionId: input.sessionId,
    name: input.name,
    scope: input.scope,
    sourcePath: input.sourcePath,
    sourceSha256: input.sourceSha256,
    systemPrompt: input.systemPrompt,
    toolsWhitelist: input.toolsWhitelist,
    budgetMaxSteps: input.budgetMaxSteps,
    budgetMaxCostUsd: input.budgetMaxCostUsd,
    budgetMaxWallMs: wallMs,
    capturedAt,
  };
};

// Returns null when no subagent_runs row exists for `sessionId`.
// Two distinct cases produce null and the caller must treat them
// the same way: (a) the session was never a subagent (no row was
// ever inserted), or (b) the session IS a subagent but its
// snapshot insert failed at runtime (see RunSubagentResult.
// auditFailure for the in-memory signal). The CLI listing surface
// uses sessions.is_subagent to disambiguate (a) from (b); audit
// queries that need to detect "missing snapshot" should always
// pair this lookup with the session row's `isSubagent` flag.
export const getSubagentRun = (db: DB, sessionId: string): SubagentRun | null => {
  const row = db
    .query<SubagentRunRow, [string]>(
      `SELECT session_id, name, scope, source_path, source_sha256, system_prompt,
              tools_whitelist, budget_max_steps, budget_max_cost_usd,
              budget_max_wall_ms, captured_at
         FROM subagent_runs
        WHERE session_id = ?`,
    )
    .get(sessionId);
  return row !== null ? fromRow(row) : null;
};
