import { beforeEach, describe, expect, test } from 'bun:test';
import {
  type AuditEmitInput,
  computeGenesisHash,
  computeRotatedGenesisHash,
  createSqliteSink,
} from '../../src/permissions/audit.ts';
import type { DB } from '../../src/storage/db.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { rotateChain } from '../../src/storage/repos/chain-rotation.ts';

const IDENTITY = { install_id: 'inst-audit-rotation', created_at_ms: 1700000000000 } as const;

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

const emitN = (sink: ReturnType<typeof createSqliteSink>, n: number, base = 1000): void => {
  for (let i = 1; i <= n; i += 1) {
    const input: AuditEmitInput = {
      session_id: 'sess-rot',
      tool_name: 'bash',
      args: { command: `step-${i}` },
      decision: 'allow',
      policy_hash: 'sha256:policy',
      reason_chain: [{ stage: 'engine-default' }],
      ts: base + i,
    };
    sink.emit(input);
  }
};

describe('audit — rotated genesis hash', () => {
  test('GENESIS-ROTATED prefix is distinct from GENESIS prefix', () => {
    const original = computeGenesisHash(IDENTITY);
    const rotated = computeRotatedGenesisHash(IDENTITY, 1, 9999);
    expect(original.startsWith('GENESIS:')).toBe(true);
    expect(rotated.startsWith('GENESIS-ROTATED:')).toBe(true);
    expect(original).not.toBe(rotated);
  });

  test('different rotation_id values produce different rotated genesis', () => {
    const r1 = computeRotatedGenesisHash(IDENTITY, 1, 9999);
    const r2 = computeRotatedGenesisHash(IDENTITY, 2, 9999);
    expect(r1).not.toBe(r2);
  });

  test('different rotated_at_ms values produce different rotated genesis', () => {
    const t1 = computeRotatedGenesisHash(IDENTITY, 1, 9999);
    const t2 = computeRotatedGenesisHash(IDENTITY, 1, 10000);
    expect(t1).not.toBe(t2);
  });

  test('same inputs are deterministic across calls (replay-able)', () => {
    const a = computeRotatedGenesisHash(IDENTITY, 1, 9999);
    const b = computeRotatedGenesisHash(IDENTITY, 1, 9999);
    expect(a).toBe(b);
  });
});

describe('audit — createSqliteSink rotation awareness', () => {
  test('fresh install reports current_rotation_id=0 and quarantined=false', () => {
    const sink = createSqliteSink({ db, identity: IDENTITY });
    const result = sink.verifyChain();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.current_rotation_id).toBe(0);
    expect(result.quarantined).toBe(false);
  });

  test('post-rotation sink uses GENESIS-ROTATED for new emits', () => {
    const sink = createSqliteSink({ db, identity: IDENTITY });
    emitN(sink, 2);

    const rotation = rotateChain(db, {
      install_id: IDENTITY.install_id,
      reason: 'test',
      rotated_at_ms: 50000,
    });

    // Reconstruct the sink — production CLI exits and the next
    // process opens a fresh one. Pre-rotation cached genesis is gone.
    const sink2 = createSqliteSink({ db, identity: IDENTITY });
    emitN(sink2, 1, 60000);

    const newFirstRow = db
      .query('SELECT prev_hash FROM approvals_log WHERE install_id = ? ORDER BY seq ASC LIMIT 1')
      .get(IDENTITY.install_id) as { prev_hash: string };
    const expected = computeRotatedGenesisHash(
      IDENTITY,
      rotation.rotation_id,
      rotation.rotated_at_ms,
    );
    expect(newFirstRow.prev_hash).toBe(expected);
  });

  test('post-rotation verifyChain reports current_rotation_id + quarantined=true', () => {
    const sink = createSqliteSink({ db, identity: IDENTITY });
    emitN(sink, 1);

    rotateChain(db, {
      install_id: IDENTITY.install_id,
      reason: 'test',
      rotated_at_ms: 50000,
    });

    const sink2 = createSqliteSink({ db, identity: IDENTITY });
    const result = sink2.verifyChain();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toBe(0); // new chain starts empty
    expect(result.current_rotation_id).toBe(1);
    expect(result.quarantined).toBe(true);
  });

  test('new chain after rotation chains correctly via hash verification', () => {
    const sink = createSqliteSink({ db, identity: IDENTITY });
    emitN(sink, 2);

    rotateChain(db, {
      install_id: IDENTITY.install_id,
      reason: 'test',
      rotated_at_ms: 50000,
    });

    const sink2 = createSqliteSink({ db, identity: IDENTITY });
    emitN(sink2, 3, 60000);

    // verifyChain walks the new chain only (rotated genesis → 3 rows).
    const result = sink2.verifyChain();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toBe(3);
  });

  test('quarantined flag flips off when chain_meta.quarantined is cleared', () => {
    const sink = createSqliteSink({ db, identity: IDENTITY });
    emitN(sink, 1);
    const rotation = rotateChain(db, {
      install_id: IDENTITY.install_id,
      reason: 'test',
      rotated_at_ms: 50000,
    });

    db.query('UPDATE chain_meta SET quarantined = 0 WHERE install_id = ? AND rotation_id = ?').run(
      IDENTITY.install_id,
      rotation.rotation_id,
    );

    const sink2 = createSqliteSink({ db, identity: IDENTITY });
    const result = sink2.verifyChain();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quarantined).toBe(false);
    expect(result.current_rotation_id).toBe(1);
  });

  test('re-rotation uses the LATEST rotation_id for new genesis', () => {
    const sink1 = createSqliteSink({ db, identity: IDENTITY });
    emitN(sink1, 1);
    const r1 = rotateChain(db, {
      install_id: IDENTITY.install_id,
      reason: 'first',
      rotated_at_ms: 50000,
    });

    const sink2 = createSqliteSink({ db, identity: IDENTITY });
    emitN(sink2, 1, 60000);
    const r2 = rotateChain(db, {
      install_id: IDENTITY.install_id,
      reason: 'second',
      rotated_at_ms: 80000,
    });

    const sink3 = createSqliteSink({ db, identity: IDENTITY });
    emitN(sink3, 1, 90000);

    const newFirst = db
      .query('SELECT prev_hash FROM approvals_log WHERE install_id = ? ORDER BY seq ASC LIMIT 1')
      .get(IDENTITY.install_id) as { prev_hash: string };

    expect(newFirst.prev_hash).toBe(
      computeRotatedGenesisHash(IDENTITY, r2.rotation_id, r2.rotated_at_ms),
    );
    // And NOT the first rotation's genesis.
    expect(newFirst.prev_hash).not.toBe(
      computeRotatedGenesisHash(IDENTITY, r1.rotation_id, r1.rotated_at_ms),
    );

    const result = sink3.verifyChain();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.current_rotation_id).toBe(r2.rotation_id);
  });
});
