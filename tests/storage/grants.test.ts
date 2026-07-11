import { describe, expect, test } from 'bun:test';
import { MIGRATIONS, migrate, openMemoryDb } from '../../src/storage/index.ts';
import {
  type InsertGrantInput,
  getGrantById,
  insertGrant,
  listActiveGrants,
  listAllGrants,
  revokeGrant,
} from '../../src/storage/repos/grants.ts';

const INSTALL = '00000000-0000-0000-0000-000000000001';
const OTHER_INSTALL = '00000000-0000-0000-0000-000000000002';

const fresh = () => {
  const db = openMemoryDb();
  migrate(db, MIGRATIONS);
  return db;
};

const baseInput = (overrides: Partial<InsertGrantInput> = {}): InsertGrantInput => ({
  id: '01JN0000000000000000000001',
  install_id: INSTALL,
  scope_kind: 'pattern',
  scope_value: 'src/**',
  capability: 'read-fs:src/**',
  granted_at: 1_000,
  expires_at: 2_000,
  granted_by: 'user',
  granted_reason: null,
  ...overrides,
});

describe('grants — insert + read', () => {
  test('round-trips a row through getGrantById', () => {
    const db = fresh();
    insertGrant(db, baseInput({ id: '01JN0000000000000000000010' }));
    const row = getGrantById(db, '01JN0000000000000000000010');
    expect(row).not.toBeNull();
    expect(row?.scope_kind).toBe('pattern');
    expect(row?.scope_value).toBe('src/**');
    expect(row?.capability).toBe('read-fs:src/**');
    expect(row?.granted_at).toBe(1_000);
    expect(row?.expires_at).toBe(2_000);
    expect(row?.granted_by).toBe('user');
    expect(row?.revoked_at).toBeNull();
  });

  test('getGrantById on missing id returns null', () => {
    const db = fresh();
    expect(getGrantById(db, '01JN0000000000000000000099')).toBeNull();
  });

  test('PRIMARY KEY id uniqueness — duplicate insert throws', () => {
    const db = fresh();
    insertGrant(db, baseInput({ id: '01JN0000000000000000000011' }));
    expect(() => insertGrant(db, baseInput({ id: '01JN0000000000000000000011' }))).toThrow();
  });

  test('scope_kind CHECK rejects unknown values', () => {
    const db = fresh();
    expect(() =>
      insertGrant(db, baseInput({ scope_kind: 'session' as unknown as 'pattern' })),
    ).toThrow();
    expect(() =>
      insertGrant(db, baseInput({ scope_kind: 'once' as unknown as 'pattern' })),
    ).toThrow();
  });

  test('granted_by CHECK rejects unknown values', () => {
    const db = fresh();
    expect(() =>
      insertGrant(db, baseInput({ granted_by: 'session' as unknown as 'user' })),
    ).toThrow();
    expect(() =>
      insertGrant(db, baseInput({ granted_by: 'subagent' as unknown as 'user' })),
    ).toThrow();
  });
});

describe('grants — listActiveGrants', () => {
  test('filters out expired rows at the SQL layer', () => {
    const db = fresh();
    insertGrant(db, baseInput({ id: '01JN0000000000000000000020', expires_at: 1_500 }));
    insertGrant(db, baseInput({ id: '01JN0000000000000000000021', expires_at: 5_000 }));
    // snapshot at t=2000: row 20 is expired (expires_at=1500), row 21 is live.
    const rows = listActiveGrants(db, INSTALL, 2_000);
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe('01JN0000000000000000000021');
  });

  test('filters out revoked rows', () => {
    const db = fresh();
    insertGrant(db, baseInput({ id: '01JN0000000000000000000030', expires_at: 5_000 }));
    insertGrant(db, baseInput({ id: '01JN0000000000000000000031', expires_at: 5_000 }));
    revokeGrant(db, '01JN0000000000000000000030', 1_500, 'operator-revoked');
    const rows = listActiveGrants(db, INSTALL, 2_000);
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe('01JN0000000000000000000031');
  });

  test('scopes per install_id (cross-install bleed is filtered)', () => {
    const db = fresh();
    insertGrant(db, baseInput({ id: '01JN0000000000000000000040', expires_at: 5_000 }));
    insertGrant(
      db,
      baseInput({
        id: '01JN0000000000000000000041',
        install_id: OTHER_INSTALL,
        expires_at: 5_000,
      }),
    );
    const rows = listActiveGrants(db, INSTALL, 2_000);
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe('01JN0000000000000000000040');
  });

  test('orders newest granted_at first', () => {
    const db = fresh();
    insertGrant(
      db,
      baseInput({ id: '01JN0000000000000000000050', granted_at: 100, expires_at: 5_000 }),
    );
    insertGrant(
      db,
      baseInput({ id: '01JN0000000000000000000051', granted_at: 300, expires_at: 5_000 }),
    );
    insertGrant(
      db,
      baseInput({ id: '01JN0000000000000000000052', granted_at: 200, expires_at: 5_000 }),
    );
    const rows = listActiveGrants(db, INSTALL, 2_000);
    expect(rows.map((r) => r.granted_at)).toEqual([300, 200, 100]);
  });

  test('boundary: expires_at exactly equal to snapshot is EXPIRED (strict >)', () => {
    // Spec §8 says `WHERE expires_at > snapshot_ts` — strict-greater.
    // A grant whose expires_at equals the snapshot is past the
    // moment of validity. Mirror that exactly.
    const db = fresh();
    insertGrant(db, baseInput({ id: '01JN0000000000000000000060', expires_at: 2_000 }));
    expect(listActiveGrants(db, INSTALL, 2_000).length).toBe(0);
    expect(listActiveGrants(db, INSTALL, 1_999).length).toBe(1);
  });
});

describe('grants — listAllGrants', () => {
  test('includes expired and revoked rows', () => {
    const db = fresh();
    insertGrant(db, baseInput({ id: '01JN0000000000000000000070', expires_at: 1_500 }));
    insertGrant(db, baseInput({ id: '01JN0000000000000000000071', expires_at: 5_000 }));
    revokeGrant(db, '01JN0000000000000000000071', 1_700, 'oops');
    const rows = listAllGrants(db, INSTALL);
    expect(rows.length).toBe(2);
  });

  test('scopes per install_id', () => {
    const db = fresh();
    insertGrant(db, baseInput({ id: '01JN0000000000000000000080' }));
    insertGrant(db, baseInput({ id: '01JN0000000000000000000081', install_id: OTHER_INSTALL }));
    const rows = listAllGrants(db, INSTALL);
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe('01JN0000000000000000000080');
  });
});

describe('grants — revokeGrant', () => {
  test('marks revoked_at + revoked_reason on first call', () => {
    const db = fresh();
    insertGrant(db, baseInput({ id: '01JN0000000000000000000090', expires_at: 5_000 }));
    const result = revokeGrant(db, '01JN0000000000000000000090', 1_500, 'compliance-mandated');
    expect(result.revoked).toBe(true);
    const row = getGrantById(db, '01JN0000000000000000000090');
    expect(row?.revoked_at).toBe(1_500);
    expect(row?.revoked_reason).toBe('compliance-mandated');
  });

  test('idempotent: second revoke is a no-op (returns revoked=false)', () => {
    const db = fresh();
    insertGrant(db, baseInput({ id: '01JN0000000000000000000091', expires_at: 5_000 }));
    revokeGrant(db, '01JN0000000000000000000091', 1_500, 'first');
    const second = revokeGrant(db, '01JN0000000000000000000091', 1_600, 'second');
    expect(second.revoked).toBe(false);
    // Original revoke_at + reason preserved — second call did NOT
    // overwrite. Important so audit trail of the FIRST revocation
    // survives accidental re-runs.
    const row = getGrantById(db, '01JN0000000000000000000091');
    expect(row?.revoked_at).toBe(1_500);
    expect(row?.revoked_reason).toBe('first');
  });

  test('revoking a non-existent id returns revoked=false', () => {
    const db = fresh();
    const result = revokeGrant(db, '01JN0000000000000000000099', 1_500, null);
    expect(result.revoked).toBe(false);
  });

  test('null reason is accepted', () => {
    const db = fresh();
    insertGrant(db, baseInput({ id: '01JN0000000000000000000092', expires_at: 5_000 }));
    const result = revokeGrant(db, '01JN0000000000000000000092', 1_500, null);
    expect(result.revoked).toBe(true);
    const row = getGrantById(db, '01JN0000000000000000000092');
    expect(row?.revoked_reason).toBeNull();
  });
});
