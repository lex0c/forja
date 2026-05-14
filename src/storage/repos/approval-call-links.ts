// approval_call_links repo (PERMISSION_ENGINE.md §17 prerequisite).
//
// Bidirectional edge between an audit row's `approval_seq` and the
// `tool_calls` row that triggered it. Slice 15 lands the write path
// in `invoke-tool.ts`; future replay modes (`--against-current-policy`
// and `permission diff`) join on this table to recover raw args
// from `tool_calls.input` keyed by `approvals_log.seq`.
//
// Upsert semantics: re-running the harness against a session that
// already has links (rare; happens in test fixtures that emit + link
// twice for the same seq) is a no-op. Idempotency keeps the link
// stable under accidental double-emit.

import type { DB } from '../db.ts';

export interface ApprovalCallLinkRow {
  approval_seq: number;
  tool_call_id: string;
}

export interface LinkApprovalToToolCallInput {
  approvalSeq: number;
  toolCallId: string;
}

const INSERT_OR_IGNORE_SQL = `
  INSERT INTO approval_call_links (approval_seq, tool_call_id)
  VALUES (?, ?)
  ON CONFLICT(approval_seq) DO NOTHING
`;

const SELECT_BY_SEQ_SQL = `
  SELECT approval_seq, tool_call_id
    FROM approval_call_links
   WHERE approval_seq = ?
`;

const SELECT_BY_TOOL_CALL_SQL = `
  SELECT approval_seq, tool_call_id
    FROM approval_call_links
   WHERE tool_call_id = ?
   ORDER BY approval_seq ASC
   LIMIT 1
`;

// Idempotent link. Two callers writing the same edge (rare; happens
// in tests that emit + link in a retry loop) leave the table at one
// row. Caller responsible for happens-before: the approvals_log seq
// must already exist (FK-like invariant, not DB-enforced because
// approval_seq is INTEGER PRIMARY KEY here without a REFERENCES
// declaration — kept loose so the link survives if approvals_log is
// rotated out under §7.2).
export const linkApprovalToToolCall = (db: DB, input: LinkApprovalToToolCallInput): void => {
  db.query(INSERT_OR_IGNORE_SQL).run(input.approvalSeq, input.toolCallId);
};

// Forward lookup: given an audit row's seq, return the tool_calls
// row id that produced it. Null when no link exists (the audit row
// was emitted by a non-tool-call path — e.g. `chain-break-accepted`
// — or the link write failed and we want to keep replay graceful).
export const getToolCallByApprovalSeq = (db: DB, approvalSeq: number): string | null => {
  const row = db.query(SELECT_BY_SEQ_SQL).get(approvalSeq) as ApprovalCallLinkRow | null;
  return row?.tool_call_id ?? null;
};

// Reverse lookup: given a tool_calls row id, return the earliest
// approval_seq linked to it. A single tool_calls row corresponds to
// at most one engine.check() invocation (and so at most one audit
// row), but the LIMIT 1 + ORDER BY keeps the contract defensive
// against a future change that would allow multiple decisions per
// call (e.g. a re-evaluation flow).
export const getApprovalSeqByToolCall = (db: DB, toolCallId: string): number | null => {
  const row = db.query(SELECT_BY_TOOL_CALL_SQL).get(toolCallId) as ApprovalCallLinkRow | null;
  return row?.approval_seq ?? null;
};

export const countApprovalCallLinks = (db: DB): number => {
  const row = db.query('SELECT COUNT(*) as n FROM approval_call_links').get() as { n: number };
  return row.n;
};
