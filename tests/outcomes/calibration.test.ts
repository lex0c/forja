// Slice 138 — outcome-signals calibration extractor. Spec
// PERMISSION_ENGINE.md §6.3.2 step 1: "Coletar telemetria por 30d
// em deployment piloto: `(score, decision_humano, outcome)`
// triples". Tests cover the contract of
// `extractCalibrationTriples` + `summarizeCalibrationCoverage`:
//   - install_id scope is required + load-bearing;
//   - decision filter defaults to confirm-allowed/confirm-denied
//     and `'*'` widens;
//   - time-window predicate is half-open [since, until);
//   - outcome aggregate is joined per row;
//   - score_components_json malformed → empty (no abort);
//   - limit caps the result set;
//   - coverage summary mirrors the same filter set.

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  createSqliteOutcomeSink,
  extractCalibrationTriples,
  summarizeCalibrationCoverage,
} from '../../src/outcomes/index.ts';
import { type DB, MIGRATIONS, migrate, openMemoryDb } from '../../src/storage/index.ts';
import {
  type ApprovalLogDecision,
  appendApprovalsLog,
} from '../../src/storage/repos/approvals-log.ts';

const freshDb = (): DB => {
  const db = openMemoryDb();
  migrate(db, MIGRATIONS);
  return db;
};

interface SeedOptions {
  installId?: string;
  decision?: string;
  toolName?: string;
  score?: number;
  scoreComponents?: Record<string, number>;
  ts?: number;
}

let serialCounter = 0;
const seedApproval = (db: DB, opts: SeedOptions = {}): number => {
  serialCounter++;
  const r = appendApprovalsLog(db, {
    ts: opts.ts ?? 1000,
    install_id: opts.installId ?? 'install-A',
    session_id: 's',
    parent_approval_id: null,
    tool_name: opts.toolName ?? 'bash',
    tool_version: 'v1',
    resolver_version: 'v1',
    args_hash: `h-${serialCounter}`,
    capabilities_json: '[]',
    decision: (opts.decision ?? 'confirm-allowed') as ApprovalLogDecision,
    score: opts.score ?? 0.5,
    score_components_json: JSON.stringify(opts.scoreComponents ?? {}),
    confidence: 'high',
    classifier_hash: null,
    classifier_adjust: null,
    policy_hash: 'p',
    sandbox_profile: null,
    ttl_expires_at: null,
    reason_chain_json: '[]',
    prev_hash: `prev-${serialCounter}`,
    this_hash: `this-${serialCounter}`,
  });
  return r.seq;
};

describe('extractCalibrationTriples — base contract', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  test('empty DB returns []', () => {
    const r = extractCalibrationTriples(db, { installId: 'install-A' });
    expect(r).toEqual([]);
  });

  test('returns rows for the requested install only', () => {
    // Each install gets distinct ts values so we can identify rows
    // by ts rather than relying on row count alone. Pre-fix the
    // assertion only checked length === 2; a regression that
    // broadened the scope to include install-B would have produced
    // 3 rows (caught) BUT a regression that swapped install-A's
    // rows for install-B's would have still produced 2 rows
    // (silently passed). Pinning the ts set rules out that shape.
    seedApproval(db, { installId: 'install-A', ts: 100, decision: 'confirm-allowed' });
    seedApproval(db, { installId: 'install-B', ts: 999, decision: 'confirm-allowed' });
    seedApproval(db, { installId: 'install-A', ts: 200, decision: 'confirm-denied' });
    const r = extractCalibrationTriples(db, { installId: 'install-A' });
    expect(r.length).toBe(2);
    const timestamps = r.map((t) => t.ts).sort();
    expect(timestamps).toEqual([100, 200]);
    // The install-B sentinel ts (999) MUST NOT appear in the
    // result — its presence would indicate cross-install leakage.
    expect(r.find((t) => t.ts === 999)).toBeUndefined();
  });

  test('default decision filter rejects auto-allow / auto-deny / confirm rows', () => {
    // Per spec §6.3.2.1 the clean labels are confirm-allowed/denied
    // only. Auto-decisions add selection bias; we drop them by
    // default.
    seedApproval(db, { decision: 'allow' });
    seedApproval(db, { decision: 'deny' });
    seedApproval(db, { decision: 'confirm' });
    seedApproval(db, { decision: 'confirm-allowed' });
    seedApproval(db, { decision: 'confirm-denied' });
    const r = extractCalibrationTriples(db, { installId: 'install-A' });
    expect(r.length).toBe(2);
    const decisions = r.map((t) => t.decision).sort();
    expect(decisions).toEqual(['confirm-allowed', 'confirm-denied']);
  });

  test("decisions: '*' widens to every row", () => {
    seedApproval(db, { decision: 'allow' });
    seedApproval(db, { decision: 'deny' });
    seedApproval(db, { decision: 'confirm-allowed' });
    const r = extractCalibrationTriples(db, { installId: 'install-A', decisions: '*' });
    expect(r.length).toBe(3);
  });

  test('explicit decisions array overrides the default', () => {
    seedApproval(db, { decision: 'allow' });
    seedApproval(db, { decision: 'confirm-allowed' });
    seedApproval(db, { decision: 'confirm-denied' });
    const r = extractCalibrationTriples(db, {
      installId: 'install-A',
      decisions: ['allow'],
    });
    expect(r.length).toBe(1);
    expect(r[0]?.decision).toBe('allow');
  });
});

describe('extractCalibrationTriples — time window', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  test('sinceMs is inclusive, untilMs is exclusive', () => {
    seedApproval(db, { ts: 100 });
    seedApproval(db, { ts: 200 });
    seedApproval(db, { ts: 300 });
    const r = extractCalibrationTriples(db, {
      installId: 'install-A',
      sinceMs: 200,
      untilMs: 300,
    });
    expect(r.length).toBe(1);
    expect(r[0]?.ts).toBe(200);
  });

  test('sinceMs alone captures everything at or after the bound', () => {
    seedApproval(db, { ts: 100 });
    seedApproval(db, { ts: 200 });
    seedApproval(db, { ts: 300 });
    const r = extractCalibrationTriples(db, {
      installId: 'install-A',
      sinceMs: 150,
    });
    expect(r.length).toBe(2);
    expect(r.map((t) => t.ts).sort()).toEqual([200, 300]);
  });

  test('untilMs alone captures everything before the bound', () => {
    seedApproval(db, { ts: 100 });
    seedApproval(db, { ts: 200 });
    seedApproval(db, { ts: 300 });
    const r = extractCalibrationTriples(db, {
      installId: 'install-A',
      untilMs: 250,
    });
    expect(r.length).toBe(2);
    expect(r.map((t) => t.ts).sort()).toEqual([100, 200]);
  });

  test('sinceMs > untilMs throws', () => {
    expect(() =>
      extractCalibrationTriples(db, {
        installId: 'install-A',
        sinceMs: 500,
        untilMs: 100,
      }),
    ).toThrow(/sinceMs.*<=.*untilMs/);
  });

  test('empty intersection returns []', () => {
    seedApproval(db, { ts: 100 });
    const r = extractCalibrationTriples(db, {
      installId: 'install-A',
      sinceMs: 1000,
      untilMs: 2000,
    });
    expect(r).toEqual([]);
  });
});

describe('extractCalibrationTriples — outcome join', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  test('row with no signals: outcome=harmless, composite=0', () => {
    seedApproval(db, { decision: 'confirm-allowed' });
    const r = extractCalibrationTriples(db, { installId: 'install-A' });
    expect(r[0]?.outcome.outcome).toBe('harmless');
    expect(r[0]?.outcome.composite).toBe(0);
    expect(r[0]?.outcome.signals.length).toBe(0);
  });

  test('row with checkpoint_reverted signal: outcome=harmful, composite=0.9', () => {
    const seq = seedApproval(db, { decision: 'confirm-allowed' });
    const sink = createSqliteOutcomeSink({ db });
    sink.emit({ approval_seq: seq, signal_kind: 'checkpoint_reverted' });
    const r = extractCalibrationTriples(db, { installId: 'install-A' });
    expect(r[0]?.outcome.outcome).toBe('harmful');
    expect(r[0]?.outcome.composite).toBeCloseTo(0.9);
    expect(r[0]?.outcome.signals.length).toBe(1);
  });

  test('multi-signal row aggregates via max-wins', () => {
    const seq = seedApproval(db, { decision: 'confirm-allowed' });
    const sink = createSqliteOutcomeSink({ db });
    sink.emit({ approval_seq: seq, signal_kind: 'tool_error' }); // 0.3
    sink.emit({ approval_seq: seq, signal_kind: 'session_aborted' }); // 0.2
    sink.emit({ approval_seq: seq, signal_kind: 'checkpoint_reverted' }); // 0.9
    const r = extractCalibrationTriples(db, { installId: 'install-A' });
    expect(r[0]?.outcome.composite).toBeCloseTo(0.9);
    expect(r[0]?.outcome.signals.length).toBe(3);
  });
});

describe('extractCalibrationTriples — score_components', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  test('valid JSON record passes through verbatim', () => {
    seedApproval(db, {
      decision: 'confirm-allowed',
      scoreComponents: { writes_outside_cwd: 0.25, untrusted_egress: 0.15 },
    });
    const r = extractCalibrationTriples(db, { installId: 'install-A' });
    expect(r[0]?.score_components).toEqual({
      writes_outside_cwd: 0.25,
      untrusted_egress: 0.15,
    });
  });

  test('empty object stays empty', () => {
    seedApproval(db, { decision: 'confirm-allowed', scoreComponents: {} });
    const r = extractCalibrationTriples(db, { installId: 'install-A' });
    expect(r[0]?.score_components).toEqual({});
  });

  test('malformed JSON degrades to {} (no abort)', () => {
    // Plant a row with corrupt score_components_json directly via
    // SQL to bypass the appender's validation.
    db.run(
      `INSERT INTO approvals_log (
         ts, install_id, session_id, parent_approval_id, tool_name,
         tool_version, resolver_version, args_hash, capabilities_json,
         decision, score, score_components_json, confidence,
         classifier_hash, classifier_adjust, policy_hash,
         sandbox_profile, ttl_expires_at, reason_chain_json,
         prev_hash, this_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        1000,
        'install-A',
        's',
        null,
        'bash',
        'v1',
        'v1',
        'h-malformed',
        '[]',
        'confirm-allowed',
        0.5,
        '{not json',
        'high',
        null,
        null,
        'p',
        null,
        null,
        '[]',
        'prev-mal',
        'this-mal',
      ],
    );
    const r = extractCalibrationTriples(db, { installId: 'install-A' });
    expect(r.length).toBe(1);
    expect(r[0]?.score_components).toEqual({});
  });

  test('non-number values inside score_components are silently dropped', () => {
    // A `Number.NaN` or stringified number is shape-corrupt at the
    // calibration boundary even if JSON.parse accepts it.
    db.run(
      `INSERT INTO approvals_log (
         ts, install_id, session_id, parent_approval_id, tool_name,
         tool_version, resolver_version, args_hash, capabilities_json,
         decision, score, score_components_json, confidence,
         classifier_hash, classifier_adjust, policy_hash,
         sandbox_profile, ttl_expires_at, reason_chain_json,
         prev_hash, this_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        1000,
        'install-A',
        's',
        null,
        'bash',
        'v1',
        'v1',
        'h-mixed',
        '[]',
        'confirm-allowed',
        0.5,
        JSON.stringify({ ok: 0.5, bad_str: 'oops', nested: { x: 1 } }),
        'high',
        null,
        null,
        'p',
        null,
        null,
        '[]',
        'prev-mix',
        'this-mix',
      ],
    );
    const r = extractCalibrationTriples(db, { installId: 'install-A' });
    expect(r[0]?.score_components).toEqual({ ok: 0.5 });
  });
});

describe('extractCalibrationTriples — limit', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  test('limit caps the returned rows', () => {
    for (let i = 0; i < 10; i++) seedApproval(db, { decision: 'confirm-allowed' });
    const r = extractCalibrationTriples(db, { installId: 'install-A', limit: 3 });
    expect(r.length).toBe(3);
  });

  test('limit < 1 throws', () => {
    expect(() => extractCalibrationTriples(db, { installId: 'install-A', limit: 0 })).toThrow(
      /limit must be >= 1/,
    );
  });
});

describe('summarizeCalibrationCoverage', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  test('empty DB → all-zero coverage', () => {
    const c = summarizeCalibrationCoverage(db, { installId: 'install-A' });
    expect(c).toEqual({
      total: 0,
      harmful: 0,
      harmless: 0,
      byDecision: {},
      withAnySignal: 0,
    });
  });

  test('counts harmful + harmless + by-decision + with-signal', () => {
    const allowedSeq = seedApproval(db, { decision: 'confirm-allowed' });
    const allowedNoSignalSeq = seedApproval(db, { decision: 'confirm-allowed' });
    const deniedSeq = seedApproval(db, { decision: 'confirm-denied' });
    const sink = createSqliteOutcomeSink({ db });
    sink.emit({ approval_seq: allowedSeq, signal_kind: 'checkpoint_reverted' });
    sink.emit({ approval_seq: deniedSeq, signal_kind: 'tool_error' });
    // allowedNoSignalSeq: zero signals → harmless without coverage
    // Silence unused-var lint — kept for shape readability.
    expect(allowedNoSignalSeq).toBeGreaterThan(0);

    const c = summarizeCalibrationCoverage(db, { installId: 'install-A' });
    expect(c.total).toBe(3);
    expect(c.harmful).toBe(1);
    expect(c.harmless).toBe(2);
    expect(c.byDecision['confirm-allowed']).toBe(2);
    expect(c.byDecision['confirm-denied']).toBe(1);
    expect(c.withAnySignal).toBe(2);
  });

  test('coverage honors the same filter set as extract', () => {
    seedApproval(db, { decision: 'allow' });
    seedApproval(db, { decision: 'confirm-allowed' });
    // Default decision filter → only confirm-allowed counted.
    const c = summarizeCalibrationCoverage(db, { installId: 'install-A' });
    expect(c.total).toBe(1);
    // Wide filter → both.
    const cAll = summarizeCalibrationCoverage(db, {
      installId: 'install-A',
      decisions: '*',
    });
    expect(cAll.total).toBe(2);
  });
});
