import { describe, expect, test } from 'bun:test';
import {
  type AuditEmitInput,
  type AuditSink,
  computeGenesisHash,
  createNoopSink,
  createSqliteSink,
} from '../../src/permissions/audit.ts';
import { sha256Hex } from '../../src/permissions/canonical.ts';
import type { InstallIdentity } from '../../src/permissions/install_id.ts';
import { type DB, MIGRATIONS, migrate, openMemoryDb } from '../../src/storage/index.ts';
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

  test('emits populate every NOT NULL column with sensible defaults', () => {
    const { sink, db } = fresh();
    sink.emit(baseInput());
    const row = getApprovalsLogBySeq(db, 1);
    expect(row).not.toBeNull();
    // Stubs (filled by future slices)
    expect(row?.tool_version).toBe('v1');
    expect(row?.resolver_version).toBe('v1');
    expect(row?.capabilities_json).toBe('[]');
    expect(row?.score).toBe(0);
    expect(row?.score_components_json).toBe('{}');
    expect(row?.confidence).toBe('high');
    expect(row?.classifier_hash).toBeNull();
    expect(row?.classifier_adjust).toBeNull();
    expect(row?.sandbox_profile).toBeNull();
    expect(row?.ttl_expires_at).toBeNull();
    expect(row?.parent_approval_id).toBeNull();
    // Populated by this slice
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
