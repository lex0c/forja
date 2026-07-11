import { beforeEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_SIGNAL_WEIGHTS,
  createNoopOutcomeSink,
  createSqliteOutcomeSink,
} from '../../src/outcomes/index.ts';
import { type DB, MIGRATIONS, migrate, openMemoryDb } from '../../src/storage/index.ts';
import { appendApprovalsLog } from '../../src/storage/repos/approvals-log.ts';
import {
  countOutcomeSignals,
  listOutcomeSignalsByApproval,
} from '../../src/storage/repos/outcome-signals.ts';

const freshDb = (): DB => {
  const db = openMemoryDb();
  migrate(db, MIGRATIONS);
  return db;
};

const seedApproval = (db: DB, ts: number, seqHint = 0): number => {
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
    prev_hash: `prev-${ts}-${seqHint}`,
    this_hash: `this-${ts}-${seqHint}`,
  });
  return r.seq;
};

describe('createNoopOutcomeSink', () => {
  test('emit returns sentinel', () => {
    const sink = createNoopOutcomeSink();
    const r = sink.emit({ approval_seq: 1, signal_kind: 'tool_error' });
    expect(r).toEqual({ id: '', approval_seq: 0 });
  });
});

describe('createSqliteOutcomeSink — validation', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  test('rejects unregistered signal_kind', () => {
    const sink = createSqliteOutcomeSink({ db });
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: runtime-typed caller
      sink.emit({ approval_seq: 1, signal_kind: 'unknown_kind' as any }),
    ).toThrow(/signal_kind/);
  });

  test('rejects non-positive approval_seq', () => {
    const sink = createSqliteOutcomeSink({ db });
    expect(() => sink.emit({ approval_seq: 0, signal_kind: 'tool_error' })).toThrow(
      /positive integer/,
    );
    expect(() => sink.emit({ approval_seq: -1, signal_kind: 'tool_error' })).toThrow();
  });

  test('rejects signal_weight outside [0,1]', () => {
    const seq = seedApproval(db, 1);
    const sink = createSqliteOutcomeSink({ db });
    expect(() =>
      sink.emit({ approval_seq: seq, signal_kind: 'tool_error', signal_weight: 1.5 }),
    ).toThrow(/\[0, 1\]/);
    expect(() =>
      sink.emit({ approval_seq: seq, signal_kind: 'tool_error', signal_weight: -0.1 }),
    ).toThrow();
  });

  test('rejects emit for non-existent approval_seq', () => {
    const sink = createSqliteOutcomeSink({ db });
    expect(() => sink.emit({ approval_seq: 99999, signal_kind: 'tool_error' })).toThrow(
      /does not exist/,
    );
  });
});

describe('createSqliteOutcomeSink — emit + persist', () => {
  test('emit happy path persists with per-kind default weight', () => {
    const db = freshDb();
    const seq = seedApproval(db, 1);
    const sink = createSqliteOutcomeSink({ db });
    sink.emit({ approval_seq: seq, signal_kind: 'tool_error' });
    const rows = listOutcomeSignalsByApproval(db, seq);
    expect(rows.length).toBe(1);
    expect(rows[0]?.signal_weight).toBe(DEFAULT_SIGNAL_WEIGHTS.tool_error);
  });

  test('signal_weight override is honored', () => {
    const db = freshDb();
    const seq = seedApproval(db, 1);
    const sink = createSqliteOutcomeSink({ db });
    sink.emit({ approval_seq: seq, signal_kind: 'tool_error', signal_weight: 0.42 });
    const rows = listOutcomeSignalsByApproval(db, seq);
    expect(rows[0]?.signal_weight).toBeCloseTo(0.42);
  });

  test('per-kind ttl applied (checkpoint_reverted gets longer retention)', () => {
    const FIXED_NOW = 1_700_000_000_000;
    const db = freshDb();
    const seq = seedApproval(db, 1);
    const sink = createSqliteOutcomeSink({ db, now: () => FIXED_NOW });
    sink.emit({ approval_seq: seq, signal_kind: 'tool_error' });
    sink.emit({ approval_seq: seq, signal_kind: 'checkpoint_reverted' });
    const rows = listOutcomeSignalsByApproval(db, seq);
    const toolErr = rows.find((r) => r.signal_kind === 'tool_error');
    const revert = rows.find((r) => r.signal_kind === 'checkpoint_reverted');
    expect(toolErr?.ttl_expires_at).toBe(FIXED_NOW + 365 * 24 * 60 * 60 * 1000);
    expect(revert?.ttl_expires_at).toBe(FIXED_NOW + 730 * 24 * 60 * 60 * 1000);
  });

  test('payload is scrubbed', () => {
    const db = freshDb();
    const seq = seedApproval(db, 1);
    const sink = createSqliteOutcomeSink({ db });
    sink.emit({
      approval_seq: seq,
      signal_kind: 'tool_error',
      payload: { trace: 'failed at /home/lex/.ssh/id_rsa' },
    });
    const rows = listOutcomeSignalsByApproval(db, seq);
    const payload = JSON.parse(rows[0]?.payload_json as string);
    expect(payload.trace).not.toContain('/home/lex/');
  });

  test('countOutcomeSignals reflects appended rows', () => {
    const db = freshDb();
    const seq = seedApproval(db, 1);
    const sink = createSqliteOutcomeSink({ db });
    expect(countOutcomeSignals(db)).toBe(0);
    sink.emit({ approval_seq: seq, signal_kind: 'tool_error' });
    sink.emit({ approval_seq: seq, signal_kind: 'session_aborted' });
    expect(countOutcomeSignals(db)).toBe(2);
  });
});

describe('createSqliteOutcomeSink — survives parent approval delete (fixup #1)', () => {
  test('signals OUTLIVE deletion of approvals_log row (no FK CASCADE)', () => {
    // Slice 131 fixup #1: prior shape declared `REFERENCES
    // approvals_log(seq) ON DELETE CASCADE`. Chain rotation
    // (slice 35) runs `DELETE FROM approvals_log WHERE
    // install_id = ?` after archiving — that would have
    // cascaded and wiped every calibration signal at rotation
    // time. Pin the inverse: signal rows persist even when
    // their parent approval row is removed. Calibration scripts
    // join across `approvals_log` + `approvals_log_archived` to
    // recover the full triple.
    const db = freshDb();
    const seq = seedApproval(db, 1);
    const sink = createSqliteOutcomeSink({ db });
    sink.emit({ approval_seq: seq, signal_kind: 'tool_error' });
    expect(listOutcomeSignalsByApproval(db, seq).length).toBe(1);
    db.query('DELETE FROM approvals_log WHERE seq = ?').run(seq);
    // Signal survives — proves the fixup's "no cascade" intent.
    expect(listOutcomeSignalsByApproval(db, seq).length).toBe(1);
  });

  test('install_id is denormalized from approvals_log at emit time', () => {
    const db = freshDb();
    const seq = seedApproval(db, 1);
    const sink = createSqliteOutcomeSink({ db });
    sink.emit({ approval_seq: seq, signal_kind: 'tool_error' });
    const rows = listOutcomeSignalsByApproval(db, seq);
    // seedApproval uses install_id: 'i'.
    expect(rows[0]?.install_id).toBe('i');
  });
});
