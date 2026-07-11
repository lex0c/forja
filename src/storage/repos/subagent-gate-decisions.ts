import type { DB } from '../db.ts';

// Repo for `subagent_gate_decisions` (migration 023). Captures
// pre-spawn refusals from `task`, `task_sync`, and `task_async`
// so postmortem queries can run plain SQL instead of JSON-
// scanning `messages.tool_results`.
//
// Writers: the three subagent tools (`task` / `task_sync` /
// `task_async`) each call into the harness-bound recorder
// before returning the corresponding tool error. Inserts are
// best-effort: a SQLITE_BUSY or schema-mismatch throw is
// caught and stderr-warned by the recorder. Losing one row
// degrades audit completeness but does not affect the model's
// view (the tool error already returned).
//
// Readers: audit / postmortem code (no caller in v1; surface
// is built so external tooling can SELECT directly or a
// future `agent dump-decisions <session>` CLI can wrap it).

// PERMISSION_ENGINE.md §10.1 spawn refusal kinds. New entries require
// a migration to widen the CHECK constraint (see migration 036 for
// the `subagent_escalation` addition).
export type GateDecisionType =
  | 'budget_exhausted'
  | 'unknown_subagent'
  | 'depth_exceeded'
  | 'subagent_escalation';

export type GateDecisionTool = 'task' | 'task_sync' | 'task_async';

export interface SubagentGateDecision {
  id: number;
  parentSessionId: string;
  decisionType: GateDecisionType;
  toolName: GateDecisionTool;
  // The subagent name the caller requested. Useful for "which
  // typos did the model retry into?" queries.
  requestedName: string;
  // Per-kind shape:
  //   - budget_exhausted: { spent, estimate, projected, cap }
  //   - unknown_subagent: { available: string[] }
  //   - depth_exceeded:   { depth, max_depth }
  // The repo parses defensively — corrupted JSON returns null
  // and consumers treat it like a missing payload.
  details: Record<string, unknown> | null;
  decidedAt: number;
}

interface SubagentGateDecisionRow {
  id: number;
  parent_session_id: string;
  decision_type: GateDecisionType;
  tool_name: GateDecisionTool;
  requested_name: string;
  details: string;
  decided_at: number;
}

const parseDetails = (raw: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

const fromRow = (row: SubagentGateDecisionRow): SubagentGateDecision => ({
  id: row.id,
  parentSessionId: row.parent_session_id,
  decisionType: row.decision_type,
  toolName: row.tool_name,
  requestedName: row.requested_name,
  details: parseDetails(row.details),
  decidedAt: row.decided_at,
});

export interface InsertSubagentGateDecisionInput {
  parentSessionId: string;
  decisionType: GateDecisionType;
  toolName: GateDecisionTool;
  requestedName: string;
  details: Record<string, unknown>;
  decidedAt?: number;
}

// Insert one row. Throws on FK violations (parent session row
// dropped via cascade), CHECK violations (unrecognized
// decision_type or tool_name — programmer bug, fail loud),
// or SQLITE_BUSY under WAL contention. Caller wraps in
// try/catch.
export const insertSubagentGateDecision = (
  db: DB,
  input: InsertSubagentGateDecisionInput,
): void => {
  const decidedAt = input.decidedAt ?? Date.now();
  db.query(
    `INSERT INTO subagent_gate_decisions
       (parent_session_id, decision_type, tool_name, requested_name, details, decided_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.parentSessionId,
    input.decisionType,
    input.toolName,
    input.requestedName,
    JSON.stringify(input.details),
    decidedAt,
  );
};

// Per-session listing in chronological order. The typical
// audit query: "show every refusal in this session." Tied
// orderings break by `id` ASC for determinism.
export const listSubagentGateDecisionsByParent = (
  db: DB,
  parentSessionId: string,
): SubagentGateDecision[] => {
  const rows = db
    .query<SubagentGateDecisionRow, [string]>(
      `SELECT id, parent_session_id, decision_type, tool_name, requested_name, details, decided_at
         FROM subagent_gate_decisions
        WHERE parent_session_id = ?
        ORDER BY decided_at ASC, id ASC`,
    )
    .all(parentSessionId);
  return rows.map(fromRow);
};

// Filter by decision type within a session. "Did this run hit
// the budget cap?" / "Did the model typo subagent names?" map
// directly. Same ordering as the un-filtered variant.
export const listSubagentGateDecisionsByType = (
  db: DB,
  parentSessionId: string,
  decisionType: GateDecisionType,
): SubagentGateDecision[] => {
  const rows = db
    .query<SubagentGateDecisionRow, [string, GateDecisionType]>(
      `SELECT id, parent_session_id, decision_type, tool_name, requested_name, details, decided_at
         FROM subagent_gate_decisions
        WHERE parent_session_id = ? AND decision_type = ?
        ORDER BY decided_at ASC, id ASC`,
    )
    .all(parentSessionId, decisionType);
  return rows.map(fromRow);
};
