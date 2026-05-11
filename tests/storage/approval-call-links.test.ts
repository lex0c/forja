import { beforeEach, describe, expect, test } from 'bun:test';
import type { DB } from '../../src/storage/db.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  countApprovalCallLinks,
  getApprovalSeqByToolCall,
  getToolCallByApprovalSeq,
  linkApprovalToToolCall,
} from '../../src/storage/repos/approval-call-links.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

describe('approval_call_links — write path', () => {
  test('links an approval_seq with a tool_call_id', () => {
    linkApprovalToToolCall(db, { approvalSeq: 7, toolCallId: 'tc-abc' });
    expect(getToolCallByApprovalSeq(db, 7)).toBe('tc-abc');
    expect(getApprovalSeqByToolCall(db, 'tc-abc')).toBe(7);
  });

  test('idempotent: re-linking the same seq keeps the original tool_call_id', () => {
    linkApprovalToToolCall(db, { approvalSeq: 1, toolCallId: 'tc-first' });
    linkApprovalToToolCall(db, { approvalSeq: 1, toolCallId: 'tc-different' });
    expect(getToolCallByApprovalSeq(db, 1)).toBe('tc-first');
    expect(countApprovalCallLinks(db)).toBe(1);
  });

  test('distinct seqs land in distinct rows', () => {
    linkApprovalToToolCall(db, { approvalSeq: 1, toolCallId: 'tc-1' });
    linkApprovalToToolCall(db, { approvalSeq: 2, toolCallId: 'tc-2' });
    linkApprovalToToolCall(db, { approvalSeq: 3, toolCallId: 'tc-3' });
    expect(countApprovalCallLinks(db)).toBe(3);
  });
});

describe('approval_call_links — read path', () => {
  test('forward lookup returns null for unknown seq', () => {
    expect(getToolCallByApprovalSeq(db, 999)).toBeNull();
  });

  test('reverse lookup returns null for unknown tool_call_id', () => {
    expect(getApprovalSeqByToolCall(db, 'never-linked')).toBeNull();
  });

  test('count starts at 0 on a fresh DB', () => {
    expect(countApprovalCallLinks(db)).toBe(0);
  });
});
