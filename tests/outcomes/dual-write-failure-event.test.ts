// Slice 131: when failure_events sink receives an emit with
// payload.approval_seq, it dual-writes an outcome_signal row.

import { beforeEach, describe, expect, test } from 'bun:test';
import { createSqliteFailureSink } from '../../src/failures/index.ts';
import { createSqliteOutcomeSink } from '../../src/outcomes/index.ts';
import { type DB, MIGRATIONS, migrate, openMemoryDb } from '../../src/storage/index.ts';
import { appendApprovalsLog } from '../../src/storage/repos/approvals-log.ts';
import { listOutcomeSignalsByApproval } from '../../src/storage/repos/outcome-signals.ts';

const freshDb = (): DB => {
  const db = openMemoryDb();
  migrate(db, MIGRATIONS);
  return db;
};

const seedApproval = (db: DB): number => {
  const r = appendApprovalsLog(db, {
    ts: 1,
    install_id: 'i',
    session_id: 's',
    parent_approval_id: null,
    tool_name: 'bash',
    tool_version: 'v1',
    resolver_version: 'v1',
    args_hash: 'h',
    capabilities_json: '[]',
    decision: 'allow',
    score: 0,
    score_components_json: '{}',
    confidence: 'high',
    classifier_hash: null,
    classifier_adjust: null,
    policy_hash: 'p',
    sandbox_profile: null,
    ttl_expires_at: null,
    reason_chain_json: '[]',
    prev_hash: 'prev',
    this_hash: 'this',
  });
  return r.seq;
};

describe('failure_events dual-write outcome_signal', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  test('emit with payload.approval_seq creates outcome_signal kind=failure_event', () => {
    const seq = seedApproval(db);
    const outcomeSink = createSqliteOutcomeSink({ db });
    const failureSink = createSqliteFailureSink({ db, outcomeSink });
    failureSink.emit({
      code: 'storage.lock_contention',
      classe: 'storage',
      recovery_action: 'ignored',
      user_visible: false,
      session_id: 's',
      payload: { approval_seq: seq, table: 'subagent_handles' },
    });
    const signals = listOutcomeSignalsByApproval(db, seq);
    expect(signals.length).toBe(1);
    expect(signals[0]?.signal_kind).toBe('failure_event');
    expect(signals[0]?.signal_weight).toBeCloseTo(0.5);
    const payload = JSON.parse(signals[0]?.payload_json as string);
    expect(payload.failure_code).toBe('storage.lock_contention');
    expect(payload.failure_classe).toBe('storage');
  });

  test('emit without approval_seq in payload does NOT create outcome_signal', () => {
    const outcomeSink = createSqliteOutcomeSink({ db });
    const failureSink = createSqliteFailureSink({ db, outcomeSink });
    failureSink.emit({
      code: 'sandbox.tool_unavailable',
      classe: 'sandbox',
      recovery_action: 'fatal',
      user_visible: true,
      session_id: 's',
      payload: { platform: 'linux' },
    });
    // Any seq — there were never any signals written.
    expect(listOutcomeSignalsByApproval(db, 99999).length).toBe(0);
  });

  test('emit without outcomeSink wired skips dual-write (back-compat)', () => {
    const seq = seedApproval(db);
    const failureSink = createSqliteFailureSink({ db });
    failureSink.emit({
      code: 'storage.lock_contention',
      classe: 'storage',
      recovery_action: 'ignored',
      user_visible: false,
      session_id: 's',
      payload: { approval_seq: seq },
    });
    expect(listOutcomeSignalsByApproval(db, seq).length).toBe(0);
  });

  test('slice 131 fixup #2: cross-session approval_seq is REJECTED (no dual-write)', () => {
    // Plant a failure event in session B that references an
    // approval owned by session A. Pre-fixup the dual-write
    // would plant a signal on session A's approval —
    // cross-session calibration pollution. Post-fixup the
    // dual-write is rejected with a stderr breadcrumb; the
    // failure_events row still persists.
    const seqInA = seedApproval(db);
    // Manually plant a SECOND approval row in session B with the
    // same install_id. The dual-write should NOT attach to seqInA.
    const otherApproval = appendApprovalsLog(db, {
      ts: 2,
      install_id: 'i',
      session_id: 'other-session',
      parent_approval_id: null,
      tool_name: 'bash',
      tool_version: 'v1',
      resolver_version: 'v1',
      args_hash: 'h2',
      capabilities_json: '[]',
      decision: 'allow',
      score: 0,
      score_components_json: '{}',
      confidence: 'high',
      classifier_hash: null,
      classifier_adjust: null,
      policy_hash: 'p',
      sandbox_profile: null,
      ttl_expires_at: null,
      reason_chain_json: '[]',
      prev_hash: 'prev2',
      this_hash: 'this2',
    });
    expect(otherApproval.seq).not.toBe(seqInA);
    const outcomeSink = createSqliteOutcomeSink({ db });
    const failureSink = createSqliteFailureSink({ db, outcomeSink });
    // Failure carries session_id='s' but plants approval_seq for
    // session 'other-session' — cross-session attribution.
    failureSink.emit({
      code: 'storage.lock_contention',
      classe: 'storage',
      recovery_action: 'ignored',
      user_visible: false,
      session_id: 's',
      payload: { approval_seq: otherApproval.seq },
    });
    // No signal on the cross-session approval.
    expect(listOutcomeSignalsByApproval(db, otherApproval.seq).length).toBe(0);
    // No signal on session 's' either (it has no matching approval).
    expect(listOutcomeSignalsByApproval(db, seqInA).length).toBe(0);
    // Failure_events row still landed.
    const failureRows = db
      .query("SELECT id FROM failure_events WHERE session_id = 's'")
      .all() as Array<{ id: string }>;
    expect(failureRows.length).toBe(1);
  });

  test('outcome_signal dual-write failure does NOT crash the failure_events emit', () => {
    const seq = seedApproval(db);
    // Pass an outcomeSink that throws — verify the failure row
    // still persists.
    const brokenOutcomeSink = {
      emit: () => {
        throw new Error('outcome sink boom');
      },
    };
    const failureSink = createSqliteFailureSink({ db, outcomeSink: brokenOutcomeSink });
    failureSink.emit({
      code: 'storage.lock_contention',
      classe: 'storage',
      recovery_action: 'ignored',
      user_visible: false,
      session_id: 's',
      payload: { approval_seq: seq },
    });
    // failure_events row landed; outcome_signals did not.
    const failureRows = db
      .query("SELECT id FROM failure_events WHERE session_id = 's'")
      .all() as Array<{ id: string }>;
    expect(failureRows.length).toBe(1);
    expect(listOutcomeSignalsByApproval(db, seq).length).toBe(0);
  });
});
