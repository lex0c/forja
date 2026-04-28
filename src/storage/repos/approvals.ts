import type { DB } from '../db.ts';

export type ApprovalDecision = 'allow' | 'deny' | 'confirm_yes' | 'confirm_no';
export type ApprovalDecidedBy = 'policy' | 'user' | 'hook';

export interface Approval {
  id: string;
  toolCallId: string;
  decision: ApprovalDecision;
  decidedBy: ApprovalDecidedBy;
  decidedAt: number;
  reason: string | null;
}

interface ApprovalRow {
  id: string;
  tool_call_id: string;
  decision: ApprovalDecision;
  decided_by: ApprovalDecidedBy;
  decided_at: number;
  reason: string | null;
}

const fromRow = (row: ApprovalRow): Approval => ({
  id: row.id,
  toolCallId: row.tool_call_id,
  decision: row.decision,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  reason: row.reason,
});

export interface RecordApprovalInput {
  id?: string;
  toolCallId: string;
  decision: ApprovalDecision;
  decidedBy: ApprovalDecidedBy;
  reason?: string | null;
  decidedAt?: number;
}

export const recordApproval = (db: DB, input: RecordApprovalInput): Approval => {
  const id = input.id ?? crypto.randomUUID();
  const decidedAt = input.decidedAt ?? Date.now();
  const reason = input.reason ?? null;
  db.query(
    `INSERT INTO approvals (id, tool_call_id, decision, decided_by, decided_at, reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.toolCallId, input.decision, input.decidedBy, decidedAt, reason);
  return {
    id,
    toolCallId: input.toolCallId,
    decision: input.decision,
    decidedBy: input.decidedBy,
    decidedAt,
    reason,
  };
};

export const listApprovalsByToolCall = (db: DB, toolCallId: string): Approval[] => {
  const rows = db
    .query(
      `SELECT id, tool_call_id, decision, decided_by, decided_at, reason
       FROM approvals
       WHERE tool_call_id = ?
       ORDER BY decided_at ASC, id ASC`,
    )
    .all(toolCallId) as ApprovalRow[];
  return rows.map(fromRow);
};
