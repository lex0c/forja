import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args.ts';
import { runPermissionRevoke } from '../../src/cli/permission-revoke.ts';
import { ensureInstallId } from '../../src/permissions/index.ts';
import { MIGRATIONS, migrate, openDb } from '../../src/storage/index.ts';
import { getGrantById, insertGrant } from '../../src/storage/repos/grants.ts';

const captured = () => {
  const lines: string[] = [];
  return { write: (s: string) => lines.push(s), lines };
};

describe('parseArgs — forja permission revoke', () => {
  test('revoke verb requires a single positional', () => {
    const r = parseArgs(['permission', 'revoke']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('exactly one <id>');
  });

  test('revoke with id is parsed', () => {
    const r = parseArgs(['permission', 'revoke', '01JN0000000000000000000001']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.verb).toBe('revoke');
      expect(r.args.permission?.positionals).toEqual(['01JN0000000000000000000001']);
    }
  });

  test('revoke with --reason captures the text', () => {
    const r = parseArgs([
      'permission',
      'revoke',
      '01JN0000000000000000000001',
      '--reason',
      'compliance',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.permission?.reason).toBe('compliance');
  });

  test('multiple positionals rejected', () => {
    const r = parseArgs(['permission', 'revoke', 'a', 'b']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('exactly one <id>');
  });
});

describe('runPermissionRevoke', () => {
  let tmp: string;
  let dbPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-perm-revoke-'));
    dbPath = join(tmp, 'sessions.db');
    env = { HOME: tmp };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const seedGrant = (id = '01JN0000000000000000000001'): string => {
    const identity = ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    insertGrant(db, {
      id,
      install_id: identity.install_id,
      scope_kind: 'pattern',
      scope_value: 'src/**',
      capability: 'read-fs:src/**',
      granted_at: 1_000,
      expires_at: 9_999_999_999_999,
      granted_by: 'user',
      granted_reason: null,
    });
    return id;
  };

  test('rejects non-ULID ids at the shape gate', async () => {
    const out = captured();
    const err = captured();
    const code = await runPermissionRevoke({
      id: 'not-a-ulid',
      dbPath,
      env,
      out: out.write,
      err: err.write,
    });
    expect(code).toBe(1);
    expect(err.lines.join('')).toContain('not a valid ULID');
    expect(out.lines).toEqual([]);
  });

  test('revokes an existing grant + renders the revocation envelope', async () => {
    const id = seedGrant();
    const out = captured();
    const code = await runPermissionRevoke({
      id,
      reason: 'compliance-audit',
      dbPath,
      env,
      out: out.write,
      err: captured().write,
      now: () => 5_000,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain(`revoked grant ${id}`);
    expect(text).toContain('reason:     compliance-audit');
    // DB state: row is marked revoked.
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const row = getGrantById(db, id);
    expect(row?.revoked_at).toBe(5_000);
    expect(row?.revoked_reason).toBe('compliance-audit');
  });

  test('second revoke is idempotent + renders the original metadata', async () => {
    const id = seedGrant();
    await runPermissionRevoke({
      id,
      reason: 'first-reason',
      dbPath,
      env,
      out: captured().write,
      err: captured().write,
      now: () => 5_000,
    });
    const out = captured();
    const code = await runPermissionRevoke({
      id,
      reason: 'second-reason',
      dbPath,
      env,
      out: out.write,
      err: captured().write,
      now: () => 9_000,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('already revoked');
    // First revocation's metadata MUST survive — the second call
    // didn't overwrite it.
    expect(text).toContain('first-reason');
    expect(text).not.toContain('second-reason');
    // DB confirms: revoked_at + reason still from first call.
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const row = getGrantById(db, id);
    expect(row?.revoked_at).toBe(5_000);
    expect(row?.revoked_reason).toBe('first-reason');
  });

  test('non-existent id surfaces "no grant" + exit 1', async () => {
    const out = captured();
    const err = captured();
    const code = await runPermissionRevoke({
      id: '01JN0000000000000000000099',
      dbPath,
      env,
      out: out.write,
      err: err.write,
    });
    expect(code).toBe(1);
    expect(err.lines.join('')).toContain('no grant with id');
  });

  test('--json: revoked=true on first call, false on subsequent', async () => {
    const id = seedGrant();
    const out1 = captured();
    const code1 = await runPermissionRevoke({
      id,
      json: true,
      dbPath,
      env,
      out: out1.write,
      err: captured().write,
      now: () => 5_000,
    });
    expect(code1).toBe(0);
    const first = JSON.parse(out1.lines.join('').trim());
    expect(first.ok).toBe(true);
    expect(first.revoked).toBe(true);
    expect(first.grant.revoked_at).toBe(5_000);

    const out2 = captured();
    await runPermissionRevoke({
      id,
      json: true,
      dbPath,
      env,
      out: out2.write,
      err: captured().write,
      now: () => 9_000,
    });
    const second = JSON.parse(out2.lines.join('').trim());
    expect(second.ok).toBe(true);
    expect(second.revoked).toBe(false);
    // Grant state in the response reflects the ORIGINAL revocation.
    expect(second.grant.revoked_at).toBe(5_000);
  });

  test('--json: not-found returns ok=false + error=not_found', async () => {
    const out = captured();
    const code = await runPermissionRevoke({
      id: '01JN0000000000000000000099',
      json: true,
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(1);
    const env_ = JSON.parse(out.lines.join('').trim());
    expect(env_.ok).toBe(false);
    expect(env_.error).toBe('not_found');
  });
});
