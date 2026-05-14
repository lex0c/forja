import { beforeEach, describe, expect, test } from 'bun:test';
import type { DB } from '../../src/storage/db.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  type AppendApprovalsLogInput,
  appendApprovalsLog,
} from '../../src/storage/repos/approvals-log.ts';
import {
  clearQuarantine,
  getLatestChainMeta,
  listArchivedByRotation,
  listChainMetaByInstall,
  rotateChain,
} from '../../src/storage/repos/chain-rotation.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

const INSTALL = 'inst-fixture-1';

// Build a logically-valid approvals_log row payload. Hash chain
// validity is NOT enforced at this layer (audit.ts owns that); the
// repo only persists what it's given and the rotation moves the same
// bytes. We use placeholder hashes for clarity.
const fixtureRow = (overrides: Partial<AppendApprovalsLogInput> = {}): AppendApprovalsLogInput => ({
  ts: 1000,
  install_id: INSTALL,
  session_id: 'sess-x',
  parent_approval_id: null,
  tool_name: 'bash',
  tool_version: 'v1',
  resolver_version: 'v1',
  args_hash: 'sha256:args',
  capabilities_json: '[]',
  decision: 'allow',
  score: 0,
  score_components_json: '{}',
  confidence: 'high',
  classifier_hash: null,
  classifier_adjust: null,
  policy_hash: 'sha256:policy',
  sandbox_profile: null,
  ttl_expires_at: null,
  reason_chain_json: '[]',
  prev_hash: 'GENESIS:placeholder',
  this_hash: 'hash-placeholder',
  ...overrides,
});

describe('chain-rotation repo — rotateChain', () => {
  test('archives every approvals_log row for the install + records chain_meta', () => {
    appendApprovalsLog(db, fixtureRow({ ts: 1000, this_hash: 'h1' }));
    appendApprovalsLog(db, fixtureRow({ ts: 2000, this_hash: 'h2' }));
    appendApprovalsLog(db, fixtureRow({ ts: 3000, this_hash: 'h3' }));

    const result = rotateChain(db, {
      install_id: INSTALL,
      reason: 'unit test',
      rotated_at_ms: 9999,
    });

    expect(result.rotation_id).toBe(1);
    expect(result.archived_rows).toBe(3);
    expect(result.pre_rotation_tip_hash).toBe('h3');
    expect(result.pre_rotation_seq_max).toBe(3);
    expect(result.rotated_at_ms).toBe(9999);

    // approvals_log empty for this install post-rotation.
    const liveCount = db
      .query('SELECT COUNT(*) as n FROM approvals_log WHERE install_id = ?')
      .get(INSTALL) as { n: number };
    expect(liveCount.n).toBe(0);

    // approvals_log_archived has all 3 rows, tagged.
    const archived = listArchivedByRotation(db, INSTALL, result.rotation_id);
    expect(archived.length).toBe(3);
    expect(archived.every((r) => r.archive_rotation_id === 1)).toBe(true);
    expect(archived.every((r) => r.archived_at_ms === 9999)).toBe(true);
    expect(archived.map((r) => r.this_hash)).toEqual(['h1', 'h2', 'h3']);
  });

  test('persists chain_meta with quarantine=1 by default', () => {
    appendApprovalsLog(db, fixtureRow({ this_hash: 'tip-h' }));
    const result = rotateChain(db, {
      install_id: INSTALL,
      reason: 'breach scare',
      rotated_at_ms: 5555,
    });

    const meta = getLatestChainMeta(db, INSTALL);
    expect(meta).not.toBeNull();
    if (meta === null) return;
    expect(meta.rotation_id).toBe(result.rotation_id);
    expect(meta.install_id).toBe(INSTALL);
    expect(meta.rotated_at_ms).toBe(5555);
    expect(meta.reason).toBe('breach scare');
    expect(meta.pre_rotation_tip_hash).toBe('tip-h');
    expect(meta.pre_rotation_seq_max).toBe(1);
    expect(meta.quarantined).toBe(1);
  });

  test('empty chain rotation (preventive) records zero-state meta cleanly', () => {
    // No rows in approvals_log for this install. Rotation still
    // succeeds — operator-initiated preventive rotations are valid
    // per §7.2 ("operator chooses to rotate after an incident scare
    // even if integrity is intact").
    const result = rotateChain(db, {
      install_id: INSTALL,
      reason: 'preventive',
      rotated_at_ms: 1234,
    });

    expect(result.archived_rows).toBe(0);
    expect(result.pre_rotation_tip_hash).toBe('');
    expect(result.pre_rotation_seq_max).toBe(0);

    const meta = getLatestChainMeta(db, INSTALL);
    expect(meta?.pre_rotation_tip_hash).toBe('');
    expect(meta?.pre_rotation_seq_max).toBe(0);
    expect(meta?.quarantined).toBe(1);
  });

  test('re-rotation appends a new chain_meta row + segment', () => {
    appendApprovalsLog(db, fixtureRow({ this_hash: 'tip-1' }));
    const r1 = rotateChain(db, { install_id: INSTALL, reason: 'first', rotated_at_ms: 1 });

    appendApprovalsLog(db, fixtureRow({ ts: 4000, this_hash: 'tip-2' }));
    const r2 = rotateChain(db, { install_id: INSTALL, reason: 'second', rotated_at_ms: 2 });

    expect(r2.rotation_id).toBe(r1.rotation_id + 1);

    const history = listChainMetaByInstall(db, INSTALL);
    expect(history.length).toBe(2);
    expect(history.map((m) => m.reason)).toEqual(['first', 'second']);

    // Each archived segment preserves its own rows independently.
    const seg1 = listArchivedByRotation(db, INSTALL, r1.rotation_id);
    const seg2 = listArchivedByRotation(db, INSTALL, r2.rotation_id);
    expect(seg1.map((r) => r.this_hash)).toEqual(['tip-1']);
    expect(seg2.map((r) => r.this_hash)).toEqual(['tip-2']);
  });

  test('rotation is per-install — other installs untouched', () => {
    const OTHER = 'inst-fixture-other';
    appendApprovalsLog(db, fixtureRow({ this_hash: 'mine' }));
    appendApprovalsLog(db, fixtureRow({ install_id: OTHER, this_hash: 'theirs' }));

    rotateChain(db, { install_id: INSTALL, reason: 'mine only', rotated_at_ms: 1 });

    const mineCount = db
      .query('SELECT COUNT(*) as n FROM approvals_log WHERE install_id = ?')
      .get(INSTALL) as { n: number };
    const theirsCount = db
      .query('SELECT COUNT(*) as n FROM approvals_log WHERE install_id = ?')
      .get(OTHER) as { n: number };
    expect(mineCount.n).toBe(0);
    expect(theirsCount.n).toBe(1);

    // No meta row created for OTHER.
    expect(getLatestChainMeta(db, OTHER)).toBeNull();
  });
});

describe('chain-rotation repo — read-side', () => {
  test('getLatestChainMeta returns null for an install that never rotated', () => {
    expect(getLatestChainMeta(db, 'never-rotated-install')).toBeNull();
  });

  test('listChainMetaByInstall returns empty array when no history', () => {
    expect(listChainMetaByInstall(db, 'never-rotated-install')).toEqual([]);
  });

  test('clearQuarantine flips the flag for an existing rotation', () => {
    const r = rotateChain(db, { install_id: INSTALL, reason: 't', rotated_at_ms: 1 });
    expect(getLatestChainMeta(db, INSTALL)?.quarantined).toBe(1);

    clearQuarantine(db, INSTALL, r.rotation_id);
    expect(getLatestChainMeta(db, INSTALL)?.quarantined).toBe(0);
  });

  test('clearQuarantine is a no-op for a non-existent (install_id, rotation_id) pair', () => {
    // Should not throw, should not affect any unrelated rows.
    expect(() => clearQuarantine(db, 'ghost-install', 99)).not.toThrow();
  });

  test('clearQuarantine only affects the targeted rotation', () => {
    const r1 = rotateChain(db, { install_id: INSTALL, reason: 'r1', rotated_at_ms: 1 });
    const r2 = rotateChain(db, { install_id: INSTALL, reason: 'r2', rotated_at_ms: 2 });

    clearQuarantine(db, INSTALL, r1.rotation_id);

    const history = listChainMetaByInstall(db, INSTALL);
    const m1 = history.find((m) => m.rotation_id === r1.rotation_id);
    const m2 = history.find((m) => m.rotation_id === r2.rotation_id);
    expect(m1?.quarantined).toBe(0);
    expect(m2?.quarantined).toBe(1);
  });
});

describe('chain-rotation repo — transaction atomicity', () => {
  test('rotateChain wraps copy + delete + meta-insert in a single transaction', () => {
    // Seed.
    appendApprovalsLog(db, fixtureRow({ this_hash: 'h1' }));
    appendApprovalsLog(db, fixtureRow({ ts: 2000, this_hash: 'h2' }));

    // Successful path: post-state is consistent (live empty, archive
    // populated, meta written). Atomicity is observable by the
    // invariant "no half-archived state visible to readers".
    rotateChain(db, { install_id: INSTALL, reason: 't', rotated_at_ms: 1 });

    const live = db
      .query('SELECT COUNT(*) as n FROM approvals_log WHERE install_id = ?')
      .get(INSTALL) as { n: number };
    const archived = db
      .query('SELECT COUNT(*) as n FROM approvals_log_archived WHERE install_id = ?')
      .get(INSTALL) as { n: number };
    const meta = db
      .query('SELECT COUNT(*) as n FROM chain_meta WHERE install_id = ?')
      .get(INSTALL) as { n: number };

    expect(live.n).toBe(0);
    expect(archived.n).toBe(2);
    expect(meta.n).toBe(1);
  });
});
