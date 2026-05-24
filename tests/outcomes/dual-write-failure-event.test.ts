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

  test('slice 178 (hardening M2): dual-write failure emits a compensation row', async () => {
    // Compensation runs on a microtask after the current emit's
    // transaction commits. Two failure_events rows persist:
    //   1. the original (the user's emit call)
    //   2. the compensation (storage.persist_failed with the
    //      original failure_id and approval_seq in payload)
    // Without the compensation, the dual-write gap is only
    // visible in stderr — forensics queries that scan
    // failure_events miss it entirely.
    const seq = seedApproval(db);
    const brokenOutcomeSink = {
      emit: () => {
        throw new Error('outcome sink boom');
      },
    };
    const failureSink = createSqliteFailureSink({ db, outcomeSink: brokenOutcomeSink });
    const originalRow = failureSink.emit({
      code: 'storage.lock_contention',
      classe: 'storage',
      recovery_action: 'ignored',
      user_visible: false,
      session_id: 's',
      payload: { approval_seq: seq },
    });
    // queueMicrotask defers the compensation past the current
    // call; flush the microtask queue by awaiting a resolved
    // promise. Bun + Node both drain microtasks at the next
    // await point.
    await Promise.resolve();
    const allRows = db
      .query("SELECT id, code, payload_json FROM failure_events WHERE session_id = 's'")
      .all() as Array<{ id: string; code: string; payload_json: string }>;
    expect(allRows.length).toBe(2);
    const original = allRows.find((r) => r.id === originalRow.id);
    const compensation = allRows.find((r) => r.id !== originalRow.id);
    expect(original?.code).toBe('storage.lock_contention');
    expect(compensation?.code).toBe('storage.persist_failed');
    const compPayload = JSON.parse(compensation?.payload_json ?? '{}') as Record<string, unknown>;
    expect(compPayload.subsystem).toBe('outcome_signal_dual_write');
    expect(compPayload.original_failure_id).toBe(originalRow.id);
    // Field is `original_approval_seq`, NOT `approval_seq` — using
    // the bare `approval_seq` key would re-trigger the dual-write
    // path on the compensation row itself, looping forever against
    // the still-broken outcomeSink. Pin the rename so a future
    // refactor doesn't undo it.
    expect(compPayload.original_approval_seq).toBe(seq);
    expect(compPayload.approval_seq).toBeUndefined();
    expect(typeof compPayload.reason).toBe('string');
  });
});
