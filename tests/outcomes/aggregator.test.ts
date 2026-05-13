import { beforeEach, describe, expect, test } from 'bun:test';
import {
  COMPOSITE_HARMFUL_THRESHOLD,
  computeOutcomeForApproval,
  computeOutcomesBatch,
  createSqliteOutcomeSink,
} from '../../src/outcomes/index.ts';
import { type DB, MIGRATIONS, migrate, openMemoryDb } from '../../src/storage/index.ts';
import { appendApprovalsLog } from '../../src/storage/repos/approvals-log.ts';

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
