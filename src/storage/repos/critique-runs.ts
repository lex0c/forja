import type { DB } from '../db.ts';

// Storage layer for `critique_runs` (migration 031). Mirrors the
// shape of `recap_runs` — one row per critique invocation, written
// at the same point the harness emits the `critique_finished`
// lifecycle event. Persisted columns are camelCased from snake_case
// at the boundary; consumers see the camelCase shape.

export type CritiqueRunMode = 'on_writes' | 'always';
export type CritiqueRunStrategy = 'llm' | 'skipped' | 'failed';
export type CritiqueRunDecision = 'ignore' | 'redo' | 'abort' | 'cancel' | 'no_modal';

// Spec line 552 audit codes plus harness-specific extensions. Free-
// form TEXT in the schema so a future code addition doesn't require
// a migration; the closed set here is documentation and a type-
// narrower for callers, not a CHECK constraint at the DB layer.
//
// Spec calls out `critique.warning_shown` as the umbrella code for
// "issues crossed threshold AND modal opened". The harness instead
// emits the more specific operator-decision codes (_ignored /
// _redo / _abort) — `_shown` is the implicit prefix-match for
// audit consumers that want "did the modal open at all"
// (`code LIKE 'critique.warning_%'`). Keeping `_shown` out of the
// union avoids dead-code drift; the prefix-filter convention is
// documented in the spec line 552 comment and the migration's
// schema commentary.
export type CritiqueRunCode =
  | 'critique.warning_ignored'
  | 'critique.warning_redo'
  | 'critique.warning_abort'
  | 'critique.skipped'
  | 'critique.failed'
  | 'critique.clean';

export interface CritiqueRun {
  id: string;
  sessionId: string;
  stepN: number;
  mode: CritiqueRunMode;
  strategy: CritiqueRunStrategy;
  decision: CritiqueRunDecision;
  code: CritiqueRunCode;
  rawCount: number;
  filteredCount: number;
  overallConfidence: number;
  durationMs: number;
  costUsd: number;
  toolPlanWrites: boolean;
  reason: string | null;
  promptVersion: string;
  threshold: number;
  createdAt: number;
}

interface CritiqueRunRow {
  id: string;
  session_id: string;
  step_n: number;
  mode: CritiqueRunMode;
  strategy: CritiqueRunStrategy;
  decision: CritiqueRunDecision;
  code: string;
  raw_count: number;
  filtered_count: number;
  overall_confidence: number;
  duration_ms: number;
  cost_usd: number;
  tool_plan_writes: number;
  reason: string | null;
  prompt_version: string;
  threshold: number;
  created_at: number;
}

const fromRow = (row: CritiqueRunRow): CritiqueRun => ({
  id: row.id,
  sessionId: row.session_id,
  stepN: row.step_n,
  mode: row.mode,
  strategy: row.strategy,
  decision: row.decision,
  code: row.code as CritiqueRunCode,
  rawCount: row.raw_count,
  filteredCount: row.filtered_count,
  overallConfidence: row.overall_confidence,
  durationMs: row.duration_ms,
  costUsd: row.cost_usd,
  toolPlanWrites: row.tool_plan_writes === 1,
  reason: row.reason,
  promptVersion: row.prompt_version,
  threshold: row.threshold,
  createdAt: row.created_at,
});

export interface RecordCritiqueRunInput {
  id?: string;
  sessionId: string;
  stepN: number;
  mode: CritiqueRunMode;
  strategy: CritiqueRunStrategy;
  decision: CritiqueRunDecision;
  code: CritiqueRunCode;
  rawCount: number;
  filteredCount: number;
  overallConfidence: number;
  durationMs: number;
  costUsd: number;
  toolPlanWrites: boolean;
  reason?: string | null;
  promptVersion: string;
  threshold: number;
  createdAt?: number;
}

export const recordCritiqueRun = (db: DB, input: RecordCritiqueRunInput): CritiqueRun => {
  const id = input.id ?? crypto.randomUUID();
  const createdAt = input.createdAt ?? Date.now();
  const reason = input.reason ?? null;
  db.query(
    `INSERT INTO critique_runs
       (id, session_id, step_n, mode, strategy, decision, code,
        raw_count, filtered_count, overall_confidence,
        duration_ms, cost_usd, tool_plan_writes, reason,
        prompt_version, threshold, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.sessionId,
    input.stepN,
    input.mode,
    input.strategy,
    input.decision,
    input.code,
    input.rawCount,
    input.filteredCount,
    input.overallConfidence,
    input.durationMs,
    input.costUsd,
    input.toolPlanWrites ? 1 : 0,
    reason,
    input.promptVersion,
    input.threshold,
    createdAt,
  );
  return {
    id,
    sessionId: input.sessionId,
    stepN: input.stepN,
    mode: input.mode,
    strategy: input.strategy,
    decision: input.decision,
    code: input.code,
    rawCount: input.rawCount,
    filteredCount: input.filteredCount,
    overallConfidence: input.overallConfidence,
    durationMs: input.durationMs,
    costUsd: input.costUsd,
    toolPlanWrites: input.toolPlanWrites,
    reason,
    promptVersion: input.promptVersion,
    threshold: input.threshold,
    createdAt,
  };
};

export const listCritiqueRunsBySession = (db: DB, sessionId: string): CritiqueRun[] => {
  const rows = db
    .query(
      `SELECT id, session_id, step_n, mode, strategy, decision, code,
              raw_count, filtered_count, overall_confidence,
              duration_ms, cost_usd, tool_plan_writes, reason,
              prompt_version, threshold, created_at
       FROM critique_runs
       WHERE session_id = ?
       ORDER BY step_n ASC, created_at ASC`,
    )
    .all(sessionId) as CritiqueRunRow[];
  return rows.map(fromRow);
};
