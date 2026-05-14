import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AuditEmitInput,
  type AuditSink,
  buildHashPayload,
  computeGenesisHash,
  createNoopSink,
  createSqliteSink,
  listChainBreakAcceptedRows,
} from '../../src/permissions/audit.ts';
import { canonicalize, sha256Hex } from '../../src/permissions/canonical.ts';
import type { InstallIdentity } from '../../src/permissions/install_id.ts';
import { type DB, MIGRATIONS, migrate, openDb, openMemoryDb } from '../../src/storage/index.ts';
import {
  getApprovalsLogBySeq,
  listApprovalsLogByInstall,
} from '../../src/storage/repos/approvals-log.ts';

const fakeIdentity = (): InstallIdentity => ({
  install_id: '00000000-0000-0000-0000-000000000001',
  created_at_ms: 1731000000000,
});

const baseInput = (overrides: Partial<AuditEmitInput> = {}): AuditEmitInput => ({
  session_id: 'sess-1',
  tool_name: 'bash',
  args: { command: 'ls' },
  decision: 'allow',
  policy_hash: 'sha256:policy-fixture',
  reason_chain: [{ stage: 'static-rule', layer: 'project', rule: 'ls *', section: 'bash' }],
  // Slice 143 (API-3): the 7 load-bearing fields below are now
  // required on `AuditEmitInput`. `baseInput` supplies "no signal"
  // defaults for every required field so tests can override only
  // the fields under assertion.
  capabilities: [],
  score: 0,
  score_components: {},
  classifier_hash: 'none',
  classifier_adjust: null,
  sandbox_profile: null,
  ttl_expires_at: null,
  ts: 1731000001000,
  ...overrides,
});

const fresh = (): { db: DB; sink: AuditSink; identity: InstallIdentity } => {
  const db = openMemoryDb();
  migrate(db, MIGRATIONS);
  const identity = fakeIdentity();
  const sink = createSqliteSink({ db, identity });
  return { db, sink, identity };
};

describe('createNoopSink', () => {
  test('emits sentinel row and verifies clean', () => {
    const sink = createNoopSink();
    expect(sink.emit(baseInput())).toEqual({ seq: 0, this_hash: '' });
    expect(sink.verifyChain()).toEqual({
      ok: true,
      rows: 0,
      current_rotation_id: 0,
      quarantined: false,
    });
  });
});

describe('computeGenesisHash', () => {
  test('derived from install_id || created_at_ms with GENESIS: prefix', () => {
    const identity: InstallIdentity = {
      install_id: 'aaa',
      created_at_ms: 1731000000000,
    };
    expect(computeGenesisHash(identity)).toBe(`GENESIS:${sha256Hex('aaa1731000000000')}`);
  });

  test('different identities produce different genesis hashes', () => {
    const a = computeGenesisHash({ install_id: 'a', created_at_ms: 1 });
    const b = computeGenesisHash({ install_id: 'b', created_at_ms: 1 });
    const c = computeGenesisHash({ install_id: 'a', created_at_ms: 2 });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('createSqliteSink — emit + chain', () => {
  test('first emit uses genesis as prev_hash', () => {
    const { sink, identity, db } = fresh();
    const { seq, this_hash } = sink.emit(baseInput());
    expect(seq).toBe(1);
    const row = getApprovalsLogBySeq(db, 1);
    expect(row).not.toBeNull();
    expect(row?.prev_hash).toBe(computeGenesisHash(identity));
    expect(row?.this_hash).toBe(this_hash);
    expect(this_hash).not.toBe('');
  });

  test('subsequent emit uses previous this_hash as prev_hash', () => {
    const { sink, db } = fresh();
    const first = sink.emit(baseInput({ ts: 1 }));
    const second = sink.emit(baseInput({ ts: 2, tool_name: 'write_file' }));

    const row2 = getApprovalsLogBySeq(db, second.seq);
    expect(row2?.prev_hash).toBe(first.this_hash);
  });

  test('emits populate every NOT NULL column with the values the caller supplied', () => {
    // Slice 143 (API-3) tightened `AuditEmitInput`: capabilities,
    // score, score_components, classifier_hash, classifier_adjust,
    // sandbox_profile and ttl_expires_at are now REQUIRED — the
    // sink no longer silently substitutes "?? <default>" when the
    // caller omits one. The test below pins the contract under
    // `baseInput()` (the shared fixture in this file) which feeds
    // every required field with a "no signal" value. The
    // still-optional columns (parent_approval_id, confidence,
    // tool_version, resolver_version) retain their persistence-layer
    // defaults documented at audit.ts.
    const { sink, db } = fresh();
    sink.emit(baseInput());
    const row = getApprovalsLogBySeq(db, 1);
    expect(row).not.toBeNull();
    // Still-optional fields keep their persistence defaults.
    expect(row?.tool_version).toBe('v1');
    expect(row?.resolver_version).toBe('v1');
    expect(row?.parent_approval_id).toBeNull();
    expect(row?.confidence).toBe('high');
    // Required fields persist exactly what baseInput passed in.
    expect(row?.capabilities_json).toBe('[]');
    expect(row?.score).toBe(0);
    expect(row?.score_components_json).toBe('{}');
    expect(row?.classifier_hash).toBe('none');
    expect(row?.classifier_adjust).toBeNull();
    expect(row?.sandbox_profile).toBeNull();
    expect(row?.ttl_expires_at).toBeNull();
    // Populated by this slice (the carrier fields).
    expect(row?.tool_name).toBe('bash');
    expect(row?.decision).toBe('allow');
    expect(row?.policy_hash).toBe('sha256:policy-fixture');
    expect(row?.reason_chain_json).toBe(
      '[{"stage":"static-rule","layer":"project","rule":"ls *","section":"bash"}]',
    );
  });

  test('args_hash is sha256 of canonical args (raw args not persisted)', () => {
    const { sink, db } = fresh();
    sink.emit(baseInput({ args: { command: 'ls -la /tmp' } }));
    const row = getApprovalsLogBySeq(db, 1);
    // Raw command must not appear anywhere
    expect(JSON.stringify(row)).not.toContain('/tmp');
    expect(JSON.stringify(row)).not.toContain('ls -la');
    expect(row?.args_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('args_hash is invariant under semantic equivalence of args object', () => {
    const { sink, db } = fresh();
    sink.emit(baseInput({ args: { a: 1, b: 2 } }));
    sink.emit(baseInput({ args: { b: 2, a: 1 } }));
    const r1 = getApprovalsLogBySeq(db, 1);
    const r2 = getApprovalsLogBySeq(db, 2);
    expect(r1?.args_hash).toBe(r2?.args_hash);
  });

  test('different decisions produce different this_hash for same inputs', () => {
    const { sink, db } = fresh();
    sink.emit(baseInput({ decision: 'allow', ts: 1 }));
    sink.emit(baseInput({ decision: 'deny', ts: 1 }));
    const r1 = getApprovalsLogBySeq(db, 1);
    const r2 = getApprovalsLogBySeq(db, 2);
    expect(r1?.this_hash).not.toBe(r2?.this_hash);
  });
});

describe('createSqliteSink — verifyChain', () => {
  test('empty chain verifies clean', () => {
    const { sink } = fresh();
    expect(sink.verifyChain()).toEqual({
      ok: true,
      rows: 0,
      current_rotation_id: 0,
      quarantined: false,
    });
  });

  test('single-row chain verifies', () => {
    const { sink } = fresh();
    sink.emit(baseInput());
    expect(sink.verifyChain()).toEqual({
      ok: true,
      rows: 1,
      current_rotation_id: 0,
      quarantined: false,
    });
  });

  test('multi-row chain verifies', () => {
    const { sink } = fresh();
    sink.emit(baseInput({ ts: 1 }));
    sink.emit(baseInput({ ts: 2, decision: 'deny' }));
    sink.emit(baseInput({ ts: 3, tool_name: 'write_file' }));
    expect(sink.verifyChain()).toEqual({
      ok: true,
      rows: 3,
      current_rotation_id: 0,
      quarantined: false,
    });
  });

  test('verify detects prev_hash mismatch on tampered row', () => {
    const { sink, db } = fresh();
    sink.emit(baseInput({ ts: 1 }));
    sink.emit(baseInput({ ts: 2 }));
    // Tamper row 2's prev_hash to break the chain
    db.run('UPDATE approvals_log SET prev_hash = ? WHERE seq = 2', ['forged-hash']);
    const result = sink.verifyChain();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(2);
      expect(result.reason).toBe('prev_hash_mismatch');
      expect(result.actual).toBe('forged-hash');
    }
  });

  test('verify detects this_hash mismatch on tampered content', () => {
    const { sink, db } = fresh();
    sink.emit(baseInput({ ts: 1 }));
    sink.emit(baseInput({ ts: 2 }));
    // Tamper row 1's decision; this_hash no longer matches contents
    db.run('UPDATE approvals_log SET decision = ? WHERE seq = 1', ['deny']);
    const result = sink.verifyChain();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(1);
      expect(result.reason).toBe('this_hash_mismatch');
    }
  });

  test('verify catches a forged row inserted between two valid ones', () => {
    const { sink, db } = fresh();
    sink.emit(baseInput({ ts: 1 }));
    sink.emit(baseInput({ ts: 2 }));
    // Synthesize a row with fake hashes between seq 1 and 2 via
    // direct SQL — verify must catch it.
    db.run(
      `INSERT INTO approvals_log (
        ts, install_id, session_id, tool_name, args_hash, decision,
        policy_hash, reason_chain_json, prev_hash, this_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        1500,
        fakeIdentity().install_id,
        'sess-1',
        'evil',
        'forged_args_hash',
        'allow',
        'sha256:policy-fixture',
        '[]',
        'forged-prev',
        'forged-this',
      ],
    );
    const result = sink.verifyChain();
    expect(result.ok).toBe(false);
  });

  test('chains across installations are independent', () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const idA: InstallIdentity = { install_id: 'AAA', created_at_ms: 1 };
    const idB: InstallIdentity = { install_id: 'BBB', created_at_ms: 2 };
    const sinkA = createSqliteSink({ db, identity: idA });
    const sinkB = createSqliteSink({ db, identity: idB });

    sinkA.emit(baseInput({ ts: 1, session_id: 'sA' }));
    sinkB.emit(baseInput({ ts: 2, session_id: 'sB' }));
    sinkA.emit(baseInput({ ts: 3, session_id: 'sA' }));

    expect(sinkA.verifyChain()).toEqual({
      ok: true,
      rows: 2,
      current_rotation_id: 0,
      quarantined: false,
    });
    expect(sinkB.verifyChain()).toEqual({
      ok: true,
      rows: 1,
      current_rotation_id: 0,
      quarantined: false,
    });

    // Verify B has its own genesis-anchored chain (the seq numbers
    // are shared with A in the AUTOINCREMENT space but each
    // install's chain stands alone).
    const aRows = listApprovalsLogByInstall(db, 'AAA');
    const bRows = listApprovalsLogByInstall(db, 'BBB');
    expect(aRows.length).toBe(2);
    expect(bRows.length).toBe(1);
    expect(bRows[0]?.prev_hash).toBe(computeGenesisHash(idB));
  });
});

describe('listChainBreakAcceptedRows — §7.2 --accept-broken-chain visibility', () => {
  test('returns empty array when no acceptance rows exist', () => {
    const db = openMemoryDb();
    migrate(db);
    const rows = listChainBreakAcceptedRows(db, 'never-accepted');
    expect(rows).toEqual([]);
  });

  test('finds chain-break-accepted rows by install_id, ordered by seq', () => {
    // Simulate two accept events on the same install + one
    // unrelated row that should NOT match.
    const db = openMemoryDb();
    migrate(db);
    const id = { install_id: 'inst-acc', created_at_ms: 1000 };
    const sink = createSqliteSink({ db, identity: id });
    // Unrelated tool row first.
    sink.emit(
      baseInput({
        policy_hash: 'sha256:fix',
        reason_chain: [{ stage: 'static-rule' }],
        ts: 1,
      }),
    );
    // Engine-emitted chain-break-accepted (mimics what
    // bootstrap-engine writes on the override path).
    sink.emit(
      baseInput({
        session_id: 'pre',
        tool_name: 'permission-engine',
        args: { acceptBrokenChain: true },
        policy_hash: 'sha256:fix',
        reason_chain: [{ stage: 'chain-break-accepted', note: 'broken_at=1' }],
        ts: 2,
      }),
    );
    sink.emit(
      baseInput({
        session_id: 'pre',
        tool_name: 'permission-engine',
        args: { acceptBrokenChain: true },
        policy_hash: 'sha256:fix',
        reason_chain: [{ stage: 'chain-break-accepted', note: 'broken_at=5' }],
        ts: 3,
      }),
    );

    const rows = listChainBreakAcceptedRows(db, id.install_id);
    expect(rows.length).toBe(2);
    expect(rows[0]?.ts).toBe(2);
    expect(rows[1]?.ts).toBe(3);
    expect(rows[0]?.seq).toBeLessThan(rows[1]?.seq ?? 0);
  });

  test('scoped to the requested install_id (no cross-install leak)', () => {
    const db = openMemoryDb();
    migrate(db);
    const sink = createSqliteSink({
      db,
      identity: { install_id: 'OTHER', created_at_ms: 1 },
    });
    sink.emit(
      baseInput({
        session_id: 'pre',
        tool_name: 'permission-engine',
        args: {},
        policy_hash: 'sha256:x',
        reason_chain: [{ stage: 'chain-break-accepted' }],
        ts: 1,
      }),
    );

    expect(listChainBreakAcceptedRows(db, 'NOT-OTHER')).toEqual([]);
    expect(listChainBreakAcceptedRows(db, 'OTHER').length).toBe(1);
  });
});

// Slice 129 (R5 P0 time): the wall-clock ts on AuditEmitInput is
// caller-supplied. Before this slice, an attacker-controlled tool
// path could inject a ts arbitrarily far in the future, causing
// time-based filters / rate-limits / quarantine windows to misfire.
// Slice 134 P0-1: pin the concurrent emit invariant. Slice 127
// R3 P0-A wrapped read-last + insert in BEGIN IMMEDIATE so
// parallel emits to the SAME install_id serialize cleanly.
// Pre-fixup the read + insert ran in autocommit; two callers
// observing `last = X` would both compute `prev_hash =
// X.this_hash` and one would lose the UNIQUE on `this_hash`.
// `failure_events` ships an equivalent test (slice 130 fixup #2);
// `approvals_log` had no regression net. This pins it.
describe('createSqliteSink — slice 134 P0-1 concurrent emit', () => {
  test('parallel emits to same install_id all persist with intact chain', async () => {
    const { sink } = fresh();
    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        Promise.resolve().then(() => sink.emit(baseInput({ ts: 1000 + i }))),
      ),
    );
    // Every emit returned a row.
    expect(results.length).toBe(N);
    // All seqs distinct (UNIQUE on seq via PK autoinc) — no race
    // produced duplicate IDs.
    const seqs = new Set(results.map((r) => r.seq));
    expect(seqs.size).toBe(N);
    // All this_hash distinct (UNIQUE constraint on the column).
    const hashes = new Set(results.map((r) => r.this_hash));
    expect(hashes.size).toBe(N);
    // Chain verifies — every row's prev_hash links to the
    // previous row's this_hash.
    const verify = sink.verifyChain();
    expect(verify.ok).toBe(true);
    if (verify.ok) {
      expect(verify.rows).toBe(N);
    }
  });
});

describe('createSqliteSink — slice 129 R5 ts validation', () => {
  test('refuses ts more than 1h ahead of wall clock', () => {
    const { sink } = fresh();
    const future = Date.now() + 2 * 60 * 60 * 1000;
    expect(() => sink.emit(baseInput({ ts: future }))).toThrow(/forgery/);
  });

  test('refuses NaN ts', () => {
    const { sink } = fresh();
    expect(() => sink.emit(baseInput({ ts: Number.NaN }))).toThrow(/non-negative/);
  });

  test('refuses negative ts', () => {
    const { sink } = fresh();
    expect(() => sink.emit(baseInput({ ts: -1 }))).toThrow(/non-negative/);
  });

  test('refuses non-integer ts', () => {
    const { sink } = fresh();
    expect(() => sink.emit(baseInput({ ts: 1.5 }))).toThrow(/non-negative/);
  });

  test('accepts ts within the 1h future-skew window', () => {
    const { sink } = fresh();
    const nearFuture = Date.now() + 30 * 60 * 1000;
    expect(() => sink.emit(baseInput({ ts: nearFuture }))).not.toThrow();
  });
});

// Slice 163 (review — Batch A): past-side ts monotonicity. The
// future-side check existed pre-slice (see above); slice 163 added
// symmetric backward-skew rejection AT EMIT TIME (caught inside the
// IMMEDIATE transaction after fetching the chain head) AND at
// VERIFY TIME (`verifyChain` reports `ts_monotonic_break`). Both
// layers close the "attacker with DB write back-dates a row" path.
describe('createSqliteSink — slice 163 past-skew ts monotonicity', () => {
  test('refuses emit when ts is more than 1h before previous row', () => {
    const { sink } = fresh();
    // Use wall clock as the anchor so the future-skew check above
    // doesn't trip on test fixture dates.
    const baseTs = Date.now();
    sink.emit(baseInput({ ts: baseTs }));
    // Now try to emit at baseTs - 2h. Past skew window is 1h →
    // refuse.
    const farPast = baseTs - 2 * 60 * 60 * 1000;
    expect(() => sink.emit(baseInput({ ts: farPast }))).toThrow(/forgery/);
  });

  test('accepts emit when ts is within the past-skew window (NTP smear / suspend-resume)', () => {
    const { sink } = fresh();
    const baseTs = Date.now();
    sink.emit(baseInput({ ts: baseTs }));
    // 30 min before the previous row — within the 1h window. Legit
    // NTP smear / clock-back-adjust scenario.
    const nearPast = baseTs - 30 * 60 * 1000;
    expect(() => sink.emit(baseInput({ ts: nearPast }))).not.toThrow();
  });

  test('past-skew check is no-op for the first row (no predecessor)', () => {
    const { sink } = fresh();
    // First emit has no previous row → past-skew check is bypassed.
    // Only the future-skew check fires (validateTs above).
    const baseTs = Date.now() - 60_000;
    expect(() => sink.emit(baseInput({ ts: baseTs }))).not.toThrow();
  });

  test('verifyChain reports ts_monotonic_break when DB tamper inserts a back-dated row', () => {
    // The threat: attacker with DB write back-dates row #2's ts AND
    // recomputes the hash chain. Hash chain stays valid (no
    // prev_hash_mismatch / this_hash_mismatch), but ts is now before
    // row #1's ts - skew window. The new check inside verifyChain
    // catches this.
    const { sink, db, identity } = fresh();
    const baseTs = Date.now();
    sink.emit(baseInput({ ts: baseTs }));
    sink.emit(baseInput({ ts: baseTs + 1000 }));
    // Read row #2 as the attacker would, then forge a back-dated
    // version with a fresh hash so prev/this_hash checks pass.
    const rows = listApprovalsLogByInstall(db, identity.install_id);
    const row2 = rows[1];
    if (row2 === undefined) throw new Error('expected 2 rows');
    const backTs = baseTs - 2 * 60 * 60 * 1000;
    const tamperedRow = { ...row2, ts: backTs };
    const newHash = sha256Hex(row2.prev_hash + canonicalize(buildHashPayload(tamperedRow)));
    db.exec(
      `UPDATE approvals_log SET ts = ${backTs}, this_hash = '${newHash}' WHERE install_id = '${identity.install_id}' AND seq = 2`,
    );
    const verify = sink.verifyChain();
    expect(verify.ok).toBe(false);
    if (!verify.ok) {
      expect(verify.reason).toBe('ts_monotonic_break');
      expect(verify.brokenAt).toBe(2);
    }
  });

  test('verifyChain stays ok when ts movements are within the skew window', () => {
    const { sink } = fresh();
    const baseTs = Date.now();
    sink.emit(baseInput({ ts: baseTs }));
    // 30 min earlier — within window, emit accepts.
    sink.emit(baseInput({ ts: baseTs - 30 * 60 * 1000 }));
    // Forward again.
    sink.emit(baseInput({ ts: baseTs + 5000 }));
    const verify = sink.verifyChain();
    expect(verify.ok).toBe(true);
  });
});

// Slice 135 P1 audit-1: bootstrap cross-install collision. When
// two distinct installs share the same DB (operator running two
// independent Forja workspaces against the same SQLite file, or
// a parent + child subprocess that synthesized a fresh identity
// mid-flight), each install_id has its own chain. The chains MUST
// stay independent:
//   - install A's `verifyChain` only walks A's rows (install_id
//     filter at `listApprovalsLogByInstall`);
//   - install A's `verifyChain` is blind to B's tampering on B's
//     rows;
//   - cross-install grafting (an attacker plants a row claiming
//     install_id=A but with a hash that fits B's chain) is caught
//     by A's verify because the prev_hash chain wouldn't reconnect.
describe('createSqliteSink — slice 135 P1 audit-1 cross-install isolation', () => {
  const buildSharedDb = () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    return db;
  };

  test('two installs on one DB produce independent chains', () => {
    const db = buildSharedDb();
    const idA: InstallIdentity = {
      install_id: 'install-A-aaaa',
      created_at_ms: 1731000000000,
    };
    const idB: InstallIdentity = {
      install_id: 'install-B-bbbb',
      created_at_ms: 1731000000000,
    };
    const sinkA = createSqliteSink({ db, identity: idA });
    const sinkB = createSqliteSink({ db, identity: idB });
    // Interleaved emits — each sink's `getLastApprovalsLogByInstall`
    // is scoped to its own install_id so chains stay independent
    // even though they share the DB file.
    sinkA.emit(baseInput({ ts: 100, session_id: 'A-1' }));
    sinkB.emit(baseInput({ ts: 200, session_id: 'B-1' }));
    sinkA.emit(baseInput({ ts: 300, session_id: 'A-2' }));
    sinkB.emit(baseInput({ ts: 400, session_id: 'B-2' }));

    const verifyA = sinkA.verifyChain();
    const verifyB = sinkB.verifyChain();
    expect(verifyA.ok).toBe(true);
    expect(verifyB.ok).toBe(true);
    if (verifyA.ok) expect(verifyA.rows).toBe(2);
    if (verifyB.ok) expect(verifyB.rows).toBe(2);

    // listApprovalsLogByInstall returns each install's rows in
    // isolation. A's rows know nothing about B's.
    const rowsA = listApprovalsLogByInstall(db, idA.install_id);
    const rowsB = listApprovalsLogByInstall(db, idB.install_id);
    expect(rowsA.length).toBe(2);
    expect(rowsB.length).toBe(2);
    // Both chains start from their own genesis (different install
    // ids → different genesis hashes).
    expect(rowsA[0]?.prev_hash).toBe(computeGenesisHash(idA));
    expect(rowsB[0]?.prev_hash).toBe(computeGenesisHash(idB));
    expect(rowsA[0]?.prev_hash).not.toBe(rowsB[0]?.prev_hash);
  });

  test("tampering on install B does not invalidate install A's chain", () => {
    const db = buildSharedDb();
    const idA: InstallIdentity = {
      install_id: 'install-A-aaaa',
      created_at_ms: 1731000000000,
    };
    const idB: InstallIdentity = {
      install_id: 'install-B-bbbb',
      created_at_ms: 1731000000000,
    };
    const sinkA = createSqliteSink({ db, identity: idA });
    const sinkB = createSqliteSink({ db, identity: idB });
    sinkA.emit(baseInput({ ts: 1, session_id: 'a' }));
    sinkA.emit(baseInput({ ts: 2, session_id: 'a' }));
    sinkB.emit(baseInput({ ts: 3, session_id: 'b' }));
    sinkB.emit(baseInput({ ts: 4, session_id: 'b' }));

    // Tamper one of install B's rows. A's verify shouldn't notice.
    db.run(
      'UPDATE approvals_log SET prev_hash = ? WHERE install_id = ? AND seq = (SELECT MAX(seq) FROM approvals_log WHERE install_id = ?)',
      ['forged-on-B', idB.install_id, idB.install_id],
    );
    expect(sinkA.verifyChain().ok).toBe(true);
    expect(sinkB.verifyChain().ok).toBe(false);
  });

  test("cross-install graft (row with install_id=A but hash from B) caught by A's verify", () => {
    const db = buildSharedDb();
    const idA: InstallIdentity = {
      install_id: 'install-A-aaaa',
      created_at_ms: 1731000000000,
    };
    const idB: InstallIdentity = {
      install_id: 'install-B-bbbb',
      created_at_ms: 1731000000000,
    };
    const sinkA = createSqliteSink({ db, identity: idA });
    const sinkB = createSqliteSink({ db, identity: idB });
    sinkA.emit(baseInput({ ts: 1 }));
    const bRow = sinkB.emit(baseInput({ ts: 2 }));

    // Forge: take B's most-recent row and rewrite its install_id
    // to A. A's chain head is at seq=1 (or similar). The grafted
    // row's prev_hash was computed against B's genesis, so when
    // A's verify walks past its own seq=1 (whose this_hash matches
    // A's chain), the next row (now showing install_id=A) carries
    // a prev_hash that doesn't link to A's seq=1.
    db.run('UPDATE approvals_log SET install_id = ? WHERE this_hash = ?', [
      idA.install_id,
      bRow.this_hash,
    ]);
    const verifyA = sinkA.verifyChain();
    expect(verifyA.ok).toBe(false);
    if (!verifyA.ok) {
      // The break is at the grafted row (whatever seq the graft
      // ended up at when filtered by install_id=A). The reason is
      // 'prev_hash_mismatch' — the grafted row's prev_hash points
      // at B's genesis, not A's chain head.
      expect(verifyA.reason).toBe('prev_hash_mismatch');
    }
  });

  test('each install has its own genesis row (chain_meta isolation)', () => {
    const db = buildSharedDb();
    const idA: InstallIdentity = {
      install_id: 'install-A-aaaa',
      created_at_ms: 1731000000000,
    };
    const idB: InstallIdentity = {
      install_id: 'install-B-bbbb',
      created_at_ms: 1731000000099,
    };
    // Construction-time alone (no emits): verify both chains are
    // clean and rotation_id starts at 0 for each.
    const sinkA = createSqliteSink({ db, identity: idA });
    const sinkB = createSqliteSink({ db, identity: idB });
    const vA = sinkA.verifyChain();
    const vB = sinkB.verifyChain();
    expect(vA.ok).toBe(true);
    expect(vB.ok).toBe(true);
    if (vA.ok && vB.ok) {
      expect(vA.rows).toBe(0);
      expect(vB.rows).toBe(0);
      expect(vA.current_rotation_id).toBe(0);
      expect(vB.current_rotation_id).toBe(0);
    }
    // Genesis hashes differ because install_id + created_at_ms differ.
    expect(computeGenesisHash(idA)).not.toBe(computeGenesisHash(idB));
  });
});

// Slice 135 P0-10: cross-process audit chain coherence. The in-
// process concurrent test (P0-1, above) covers `Promise.all` over
// one DB connection inside one process — that pins the JS-side
// serialization of `withImmediateTransaction`. The cross-process
// path is fundamentally different: each child has its OWN
// `Database` handle on the SAME file, lock contention is mediated
// by SQLite's WAL writer lock + `busy_timeout = 5000` (set in
// `openDb`), and the BEGIN IMMEDIATE semantics ensure each
// child's read-modify-write sequence is atomic against the other.
// This test forks two real Bun processes, has each emit N rows
// concurrently, and verifies:
//   - total row count = 2N
//   - all seqs distinct and contiguous (PK monotonic)
//   - all this_hash unique (UNIQUE constraint)
//   - chain verifies (every row's prev_hash links to the seq-1
//     row's this_hash)
//
// Failure mode this would catch: dropping `withImmediateTransaction`
// for `withTransaction` (DEFERRED), which lets two concurrent
// emits both see the same chain head and produce a UNIQUE-violation
// or — worse — a fork in the chain that masquerades as valid until
// verifyChain runs.
describe('createSqliteSink — slice 135 P0-10 cross-process emit', () => {
  test('two Bun processes emit 5 rows each → chain stays coherent', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'forja-cross-proc-'));
    try {
      const dbPath = join(tmpRoot, 'audit.db');
      // Parent: migrate once. The workers don't run migrations
      // (their `openDb` would race the schema apply); the parent
      // owns schema setup.
      const parentDb = openDb(dbPath);
      migrate(parentDb, MIGRATIONS);
      parentDb.close();

      const identity: InstallIdentity = {
        install_id: 'cross-proc-uuid-aaaa-bbbb',
        created_at_ms: 1731000000000,
      };
      const workerScript = new URL('./_cross-proc-emitter.ts', import.meta.url).pathname;
      const N = 5;

      // Spawn two workers in parallel — both will compete for the
      // WAL writer lock. The chain insert is wrapped in BEGIN
      // IMMEDIATE so they serialize cleanly even though they
      // started simultaneously.
      const spawnEmitter = (sessionPrefix: string) =>
        Bun.spawn({
          cmd: [
            'bun',
            workerScript,
            dbPath,
            identity.install_id,
            String(identity.created_at_ms),
            sessionPrefix,
            String(N),
          ],
          stdout: 'pipe',
          stderr: 'pipe',
        });
      const procA = spawnEmitter('alpha');
      const procB = spawnEmitter('beta');
      const [codeA, codeB] = await Promise.all([procA.exited, procB.exited]);
      // Helpful diagnostics if either failed.
      if (codeA !== 0 || codeB !== 0) {
        const errA = await new Response(procA.stderr).text();
        const errB = await new Response(procB.stderr).text();
        throw new Error(
          `emitters failed: codeA=${codeA} stderrA="${errA}" codeB=${codeB} stderrB="${errB}"`,
        );
      }
      expect(codeA).toBe(0);
      expect(codeB).toBe(0);

      // Re-open the DB and inspect the chain.
      const db = openDb(dbPath);
      try {
        const rows = listApprovalsLogByInstall(db, identity.install_id);
        expect(rows.length).toBe(2 * N);
        // Seqs are PK-monotonic starting at 1.
        const seqs = rows.map((r) => r.seq);
        expect(seqs).toEqual(Array.from({ length: 2 * N }, (_, i) => i + 1));
        // All this_hash distinct.
        const hashes = new Set(rows.map((r) => r.this_hash));
        expect(hashes.size).toBe(2 * N);
        // Both workers contributed rows (no starvation).
        const fromAlpha = rows.filter((r) => r.session_id.startsWith('alpha-')).length;
        const fromBeta = rows.filter((r) => r.session_id.startsWith('beta-')).length;
        expect(fromAlpha).toBe(N);
        expect(fromBeta).toBe(N);
        // Chain verifies (re-attach a sink to the parent connection
        // to call verifyChain — the sink is just a façade over
        // SELECTs, so the identity must match what the workers used).
        const sink = createSqliteSink({ db, identity });
        const verify = sink.verifyChain();
        expect(verify.ok).toBe(true);
        if (verify.ok) {
          expect(verify.rows).toBe(2 * N);
        }
      } finally {
        db.close();
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 15_000); // generous timeout — spawning two Bun runtimes is slow on cold CI
});

// Slice 142 C-lat-2: stripUndefined defense at audit.emit boundary.
// `canonicalize` throws on undefined values; pre-fix, a caller
// passing `{ foo: undefined }` (legal TS, illegal JSON) crashed
// emit BEFORE the transaction opened, propagating to the harness
// as internalError. Strip pass at the boundary closes that path.
describe('createSqliteSink — stripUndefined defense (slice 142 C-lat-2)', () => {
  test('args with top-level undefined value does not throw', () => {
    const { sink } = fresh();
    // Construct args with undefined directly (bypasses model-emitted
    // JSON which couldn't carry undefined). Cast through unknown to
    // satisfy ToolArgs's `[k: string]: unknown` while letting the
    // undefined live in the value position.
    const args: Record<string, unknown> = { real: 'value', missing: undefined };
    expect(() => sink.emit(baseInput({ args }))).not.toThrow();
  });

  test('args with nested undefined value does not throw', () => {
    const { sink } = fresh();
    const args: Record<string, unknown> = {
      outer: {
        keep: 1,
        drop: undefined,
        deep: { also_drop: undefined, also_keep: 2 },
      },
    };
    expect(() => sink.emit(baseInput({ args }))).not.toThrow();
  });

  test('args_hash is stable: stripped row has the same hash as the explicitly-omitted row', () => {
    // The strip is shape-preserving in the JSON sense: stripping
    // an undefined value produces the same canonical hash as if
    // the caller had omitted the key entirely.
    const { sink, db } = fresh();
    sink.emit(baseInput({ ts: 1, args: { a: 1 } }));
    sink.emit(baseInput({ ts: 2, args: { a: 1, b: undefined } as Record<string, unknown> }));
    const row1 = getApprovalsLogBySeq(db, 1);
    const row2 = getApprovalsLogBySeq(db, 2);
    // Same canonical input → same args_hash.
    expect(row1?.args_hash).toBe(row2?.args_hash);
  });

  test('args with cycle does not blow stack (cycle guard)', () => {
    const { sink } = fresh();
    const args: Record<string, unknown> = { id: 'a' };
    args.self = args; // cycle
    expect(() => sink.emit(baseInput({ args }))).not.toThrow();
  });

  test('arrays containing undefined slots: each undefined becomes null', () => {
    // JSON.stringify behavior: [1, undefined, 2] → "[1,null,2]".
    // The strip mirrors this so canonical hash matches what a
    // JSON-emitting caller would have produced.
    const { sink } = fresh();
    const args: Record<string, unknown> = { items: [1, undefined, 2] };
    expect(() => sink.emit(baseInput({ args }))).not.toThrow();
  });

  test('DAG-sharing: a node referenced from two siblings is NOT treated as a cycle', () => {
    // Path-based seen-set: `shared` enters/leaves cleanly on the
    // first traversal, so the second traversal walks it fully
    // instead of returning the cycle stand-in (`null`). The
    // resulting args_hash must equal the hash produced by the same
    // structure with each branch holding an independent copy of
    // `shared` — JSON.stringify treats both shapes as identical.
    const { sink, db } = fresh();
    const shared: Record<string, unknown> = { x: 1 };
    const argsShared: Record<string, unknown> = { a: shared, b: shared };
    const argsCopies: Record<string, unknown> = { a: { x: 1 }, b: { x: 1 } };
    sink.emit(baseInput({ ts: 10, args: argsShared }));
    sink.emit(baseInput({ ts: 20, args: argsCopies }));
    const row1 = getApprovalsLogBySeq(db, 1);
    const row2 = getApprovalsLogBySeq(db, 2);
    expect(row1?.args_hash).toBe(row2?.args_hash);
  });
});

// Slice 142 C-lat-1: verifyChain post-rotation race. Pre-fix, the
// sink captured `genesisHash` at construction time. An
// out-of-process `--rotate-chain` between construction and verify
// (long-lived REPL + operator running rotate in another terminal)
// left the live approvals_log rows belonging to the NEW chain
// (first row's prev_hash = rotated genesis) while expectedPrev
// started at the STALE construction-time hash — spurious
// prev_hash_mismatch on a perfectly intact post-rotation chain.
// Fix recomputes genesis from the live tipMeta on every verify.
describe('createSqliteSink — verifyChain post-rotation race (slice 142 C-lat-1)', () => {
  test('rotation between sink construction and verify does not produce spurious mismatch', async () => {
    const { rotateChain } = await import('../../src/storage/repos/chain-rotation.ts');
    const { db, sink, identity } = fresh();
    sink.emit(baseInput({ ts: 100 }));
    // Construct a SECOND sink BEFORE rotation. This sink captures
    // the pre-rotation genesis at line 256-259. If `verifyChain`
    // uses that captured value instead of re-deriving, the post-
    // rotation chain (with rotated genesis) will trigger
    // prev_hash_mismatch.
    const earlySink = createSqliteSink({ db, identity });
    // Verify clean before rotation — sanity.
    expect(earlySink.verifyChain().ok).toBe(true);
    // Operator rotates in another terminal.
    rotateChain(db, {
      install_id: identity.install_id,
      reason: 'live-rotation-test',
      rotated_at_ms: 200,
    });
    // Add one row to the NEW chain (post-rotation; its prev_hash
    // is the rotated-genesis).
    const sink2 = createSqliteSink({ db, identity });
    sink2.emit(baseInput({ ts: 300 }));
    // Critical: the EARLY sink (constructed pre-rotation) must
    // still verify cleanly. Pre-fix it would use the pre-rotation
    // genesis and fail to match the new chain's first row.
    const v = earlySink.verifyChain();
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.rows).toBe(1); // only the post-rotation row
      expect(v.current_rotation_id).toBe(1);
    }
  });
});
