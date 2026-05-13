import { beforeEach, describe, expect, test } from 'bun:test';
import {
  COMPOSITE_HARMFUL_THRESHOLD,
  computeOutcomeForApproval,
  computeOutcomesBatch,
  createSqliteOutcomeSink,
} from '../../src/outcomes/index.ts';
import { type DB, MIGRATIONS, migrate, openMemoryDb } from '../../src/storage/index.ts';
import { appendApprovalsLog } from '../../src/storage/repos/approvals-log.ts';
import { rotateChain } from '../../src/storage/repos/chain-rotation.ts';

const freshDb = (): DB => {
  const db = openMemoryDb();
  migrate(db, MIGRATIONS);
  return db;
};

const seedApproval = (db: DB, ts: number, hint: number): number => {
  const r = appendApprovalsLog(db, {
    ts,
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
    prev_hash: `prev-${ts}-${hint}`,
    this_hash: `this-${ts}-${hint}`,
  });
  return r.seq;
};

describe('computeOutcomeForApproval', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  test('zero signals → harmless, composite 0', () => {
    const seq = seedApproval(db, 1, 1);
    const r = computeOutcomeForApproval(db, seq);
    expect(r).toEqual({ outcome: 'harmless', composite: 0, signals: [] });
  });

  test('single weak signal (tool_error 0.3) → harmless', () => {
    const seq = seedApproval(db, 1, 1);
    const sink = createSqliteOutcomeSink({ db });
    sink.emit({ approval_seq: seq, signal_kind: 'tool_error' });
    const r = computeOutcomeForApproval(db, seq);
    expect(r.outcome).toBe('harmless');
    expect(r.composite).toBeCloseTo(0.3);
    expect(r.signals.length).toBe(1);
  });

  test('single strong signal (checkpoint_reverted 0.9) → harmful', () => {
    const seq = seedApproval(db, 1, 1);
    const sink = createSqliteOutcomeSink({ db });
    sink.emit({ approval_seq: seq, signal_kind: 'checkpoint_reverted' });
    const r = computeOutcomeForApproval(db, seq);
    expect(r.outcome).toBe('harmful');
    expect(r.composite).toBeCloseTo(0.9);
  });

  test('max-wins composite: strong dominates weak', () => {
    const seq = seedApproval(db, 1, 1);
    const sink = createSqliteOutcomeSink({ db });
    sink.emit({ approval_seq: seq, signal_kind: 'tool_error' }); // 0.3
    sink.emit({ approval_seq: seq, signal_kind: 'session_aborted' }); // 0.2
    sink.emit({ approval_seq: seq, signal_kind: 'checkpoint_reverted' }); // 0.9
    const r = computeOutcomeForApproval(db, seq);
    expect(r.composite).toBeCloseTo(0.9);
    expect(r.outcome).toBe('harmful');
    expect(r.signals.length).toBe(3);
  });

  test('threshold edge: composite exactly at COMPOSITE_HARMFUL_THRESHOLD → harmful', () => {
    const seq = seedApproval(db, 1, 1);
    const sink = createSqliteOutcomeSink({ db });
    sink.emit({
      approval_seq: seq,
      signal_kind: 'tool_error',
      signal_weight: COMPOSITE_HARMFUL_THRESHOLD,
    });
    const r = computeOutcomeForApproval(db, seq);
    expect(r.outcome).toBe('harmful');
  });

  test('threshold edge: composite just below threshold → harmless', () => {
    const seq = seedApproval(db, 1, 1);
    const sink = createSqliteOutcomeSink({ db });
    sink.emit({
      approval_seq: seq,
      signal_kind: 'tool_error',
      signal_weight: COMPOSITE_HARMFUL_THRESHOLD - 0.01,
    });
    const r = computeOutcomeForApproval(db, seq);
    expect(r.outcome).toBe('harmless');
  });
});

describe('computeOutcomesBatch', () => {
  test('preserves input order; per-approval aggregates', () => {
    const db = freshDb();
    const a = seedApproval(db, 1, 1);
    const b = seedApproval(db, 2, 2);
    const c = seedApproval(db, 3, 3);
    const sink = createSqliteOutcomeSink({ db });
    sink.emit({ approval_seq: a, signal_kind: 'tool_error' });
    sink.emit({ approval_seq: c, signal_kind: 'checkpoint_reverted' });
    // b has no signals
    const r = computeOutcomesBatch(db, [c, a, b]);
    expect(r.length).toBe(3);
    expect(r[0]?.outcome).toBe('harmful');
    expect(r[1]?.outcome).toBe('harmless');
    expect(r[2]?.outcome).toBe('harmless');
    expect(r[2]?.signals.length).toBe(0);
  });
});

// Slice 135 P1 audit-3: computeOutcomeForApproval behavior across
// a chain rotation. PERMISSION_ENGINE.md §7.2: rotation moves
// approvals_log rows into approvals_log_archived and DELETES the
// originals. The outcome_signals table is NOT touched by the
// rotation transaction. The calibration script reads
// (approval_seq, signal_*) triples on a sliding window — it MUST
// still resolve signals for seqs that have been archived. Pre-fix
// this could leak: a regression that joined outcome_signals
// against approvals_log instead of keeping the table independent
// would lose all post-rotation signals.
describe('computeOutcomeForApproval — post-rotation behavior (slice 135 P1 audit-3)', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  test('signals survive a rotation that archives their approval', () => {
    // Seed two approvals with mixed signal weights, then rotate.
    // After rotation the approvals_log rows are gone but
    // outcome_signals rows remain (rotation only touches
    // approvals_log + chain_meta tables).
    const sink = createSqliteOutcomeSink({ db });
    const seqHarmful = seedApproval(db, 100, 1);
    sink.emit({ approval_seq: seqHarmful, signal_kind: 'checkpoint_reverted' });
    const seqHarmless = seedApproval(db, 200, 2);
    sink.emit({ approval_seq: seqHarmless, signal_kind: 'tool_error' });

    // Pre-rotation aggregate.
    const beforeHarmful = computeOutcomeForApproval(db, seqHarmful);
    const beforeHarmless = computeOutcomeForApproval(db, seqHarmless);
    expect(beforeHarmful.outcome).toBe('harmful');
    expect(beforeHarmless.outcome).toBe('harmless');

    // Operator rotates the chain (post-incident or scheduled).
    const rotation = rotateChain(db, {
      install_id: 'i',
      reason: 'test-rotation',
      rotated_at_ms: 500,
    });
    expect(rotation.archived_rows).toBe(2);

    // Post-rotation: approvals_log is empty for install 'i', but
    // computeOutcomeForApproval reads from outcome_signals — which
    // is unaffected. Same aggregates as before.
    const afterHarmful = computeOutcomeForApproval(db, seqHarmful);
    const afterHarmless = computeOutcomeForApproval(db, seqHarmless);
    expect(afterHarmful.outcome).toBe('harmful');
    expect(afterHarmful.composite).toBeCloseTo(0.9);
    expect(afterHarmless.outcome).toBe('harmless');
    expect(afterHarmless.composite).toBeCloseTo(0.3);
    // Signal rows themselves preserved.
    expect(afterHarmful.signals.length).toBe(1);
    expect(afterHarmless.signals.length).toBe(1);
  });

  test('outcome sink REFUSES new signals against an archived approval_seq', () => {
    // The sink validates `approval_seq` exists in approvals_log at
    // emit time (createSqliteOutcomeSink, slice 131 fixup #1). After
    // rotation, the row is in approvals_log_archived, not
    // approvals_log — so a late signal attempt MUST throw. The
    // pre-rotation signals survive (next test); only NEW emits are
    // refused.
    const seq = seedApproval(db, 1, 1);
    rotateChain(db, { install_id: 'i', reason: 'r1', rotated_at_ms: 2 });
    const sink = createSqliteOutcomeSink({ db });
    expect(() => sink.emit({ approval_seq: seq, signal_kind: 'checkpoint_reverted' })).toThrow(
      /does not exist in approvals_log/,
    );
    // computeOutcomeForApproval against the seq returns "no signals"
    // — there were none pre-rotation and emit was refused post-.
    const r = computeOutcomeForApproval(db, seq);
    expect(r.outcome).toBe('harmless');
    expect(r.composite).toBe(0);
    expect(r.signals.length).toBe(0);
  });

  test('signals emitted between rotations all aggregate at compute time', () => {
    // The sink contract: emit only succeeds while the approval row
    // is still in approvals_log. Within that window any number of
    // signals can land. We can't emit AFTER a rotation for the
    // pre-rotation seq (the sink refuses); the realistic shape is
    // multiple signals between two rotation events:
    //   seed → emit A → rotation → seed → emit B → rotation
    // Each seq's pre-rotation signals survive; the aggregator
    // reads them all out via the denormalized install_id.
    const sink = createSqliteOutcomeSink({ db });
    const seqA = seedApproval(db, 1, 1);
    sink.emit({ approval_seq: seqA, signal_kind: 'tool_error' }); // 0.3
    sink.emit({ approval_seq: seqA, signal_kind: 'session_aborted' }); // 0.2
    rotateChain(db, { install_id: 'i', reason: 'r1', rotated_at_ms: 2 });
    const seqB = seedApproval(db, 3, 3);
    sink.emit({ approval_seq: seqB, signal_kind: 'checkpoint_reverted' }); // 0.9
    rotateChain(db, { install_id: 'i', reason: 'r2', rotated_at_ms: 4 });

    // Both seqs' signals are still queryable.
    const rA = computeOutcomeForApproval(db, seqA);
    expect(rA.signals.length).toBe(2);
    expect(rA.composite).toBeCloseTo(0.3); // max(0.3, 0.2)
    const rB = computeOutcomeForApproval(db, seqB);
    expect(rB.signals.length).toBe(1);
    expect(rB.composite).toBeCloseTo(0.9);
    expect(rB.outcome).toBe('harmful');
  });

  test('rotation leaves the outcome_signals table row count untouched', () => {
    // Inventory check — rotation deletes from approvals_log but
    // not from outcome_signals. Pin so a future "GC archived
    // signals" feature lands intentionally with its own visible
    // contract.
    const sink = createSqliteOutcomeSink({ db });
    const a = seedApproval(db, 1, 1);
    const b = seedApproval(db, 2, 2);
    sink.emit({ approval_seq: a, signal_kind: 'tool_error' });
    sink.emit({ approval_seq: a, signal_kind: 'failure_event', payload: { failure_id: 1 } });
    sink.emit({ approval_seq: b, signal_kind: 'checkpoint_reverted' });
    const countBefore = (
      db.query('SELECT COUNT(*) AS n FROM outcome_signals').get() as { n: number }
    ).n;
    rotateChain(db, { install_id: 'i', reason: 'r', rotated_at_ms: 100 });
    const countAfter = (
      db.query('SELECT COUNT(*) AS n FROM outcome_signals').get() as { n: number }
    ).n;
    expect(countBefore).toBe(3);
    expect(countAfter).toBe(3);
  });

  test('computeOutcomesBatch across mixed pre/post-rotation seqs returns 1:1', () => {
    // The batch shape preserves caller-supplied seq order
    // regardless of archive state. A calibration sweep listing
    // (seq, score, decision) over a window MAY span a rotation —
    // the batch result must still align positionally.
    const sink = createSqliteOutcomeSink({ db });
    const preA = seedApproval(db, 1, 1);
    const preB = seedApproval(db, 2, 2);
    sink.emit({ approval_seq: preA, signal_kind: 'checkpoint_reverted' });
    sink.emit({ approval_seq: preB, signal_kind: 'tool_error' });
    rotateChain(db, { install_id: 'i', reason: 'r', rotated_at_ms: 100 });
    const postC = seedApproval(db, 3, 3);
    sink.emit({ approval_seq: postC, signal_kind: 'session_aborted' });

    const result = computeOutcomesBatch(db, [postC, preA, preB]);
    expect(result.length).toBe(3);
    expect(result[0]?.composite).toBeCloseTo(0.2); // postC session_aborted
    expect(result[1]?.composite).toBeCloseTo(0.9); // preA checkpoint_reverted
    expect(result[2]?.composite).toBeCloseTo(0.3); // preB tool_error
  });
});
