import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args.ts';
import { runPermissionGrants } from '../../src/cli/permission-grants.ts';
import { ensureInstallId } from '../../src/permissions/index.ts';
import { MIGRATIONS, migrate, openDb } from '../../src/storage/index.ts';
import { insertGrant, revokeGrant } from '../../src/storage/repos/grants.ts';

const captured = () => {
  const lines: string[] = [];
  return { write: (s: string) => lines.push(s), lines };
};

describe('parseArgs — forja permission grants', () => {
  test('grants verb is recognized', () => {
    const r = parseArgs(['permission', 'grants']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.verb).toBe('grants');
      expect(r.args.permission?.positionals).toEqual([]);
    }
  });

  test('--all flag is captured', () => {
    const r = parseArgs(['permission', 'grants', '--all']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.allGrants).toBe(true);
    }
  });

  test('--all on non-grants verb is rejected', () => {
    const r = parseArgs(['permission', 'verify', '--all']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('--all');
  });

  test('positionals after grants are rejected', () => {
    const r = parseArgs(['permission', 'grants', 'extra']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('no positionals expected');
  });

  test('--reason on grants is rejected', () => {
    const r = parseArgs(['permission', 'grants', '--reason', 'why']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('--reason only applies');
  });
});

describe('runPermissionGrants', () => {
  let tmp: string;
  let dbPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-perm-grants-'));
    dbPath = join(tmp, 'sessions.db');
    env = { HOME: tmp };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const seedGrant = (
    overrides: Partial<{
      id: string;
      install_id: string;
      scope_value: string;
      capability: string;
      granted_at: number;
      expires_at: number;
      revoked_at: number | null;
    }> = {},
  ): { install_id: string } => {
    const identity = ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    insertGrant(db, {
      id: overrides.id ?? '01JN0000000000000000000001',
      install_id: overrides.install_id ?? identity.install_id,
      scope_kind: 'pattern',
      scope_value: overrides.scope_value ?? 'src/**',
      capability: overrides.capability ?? 'read-fs:src/**',
      granted_at: overrides.granted_at ?? 1_000,
      expires_at: overrides.expires_at ?? 9_999_999_999_999,
      granted_by: 'user',
      granted_reason: null,
    });
    if (overrides.revoked_at !== undefined && overrides.revoked_at !== null) {
      revokeGrant(db, overrides.id ?? '01JN0000000000000000000001', overrides.revoked_at, 'test');
    }
    return { install_id: identity.install_id };
  };

  test('empty install: lists "none" with the --all hint', async () => {
    const out = captured();
    const err = captured();
    const code = await runPermissionGrants({
      dbPath,
      env,
      out: out.write,
      err: err.write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('active grants: (none)');
    expect(text).toContain('--all');
    expect(err.lines).toEqual([]);
  });

  test('lists active grants with id + scope + capability', async () => {
    seedGrant();
    const out = captured();
    const code = await runPermissionGrants({
      dbPath,
      env,
      out: out.write,
      err: captured().write,
      now: () => 5_000, // before expires_at
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('active grants (1)');
    expect(text).toContain('01JN0000000000000000000001');
    expect(text).toContain('pattern:src/**');
    expect(text).toContain('read-fs:src/**');
    expect(text).toContain('active');
  });

  test('expired grants excluded from default list, included with --all', async () => {
    seedGrant({
      id: '01JN0000000000000000000002',
      expires_at: 1_500, // expired at snapshot 5000
    });
    const defaultOut = captured();
    await runPermissionGrants({
      dbPath,
      env,
      out: defaultOut.write,
      err: captured().write,
      now: () => 5_000,
    });
    expect(defaultOut.lines.join('')).toContain('active grants: (none)');

    const allOut = captured();
    await runPermissionGrants({
      all: true,
      dbPath,
      env,
      out: allOut.write,
      err: captured().write,
      now: () => 5_000,
    });
    const allText = allOut.lines.join('');
    expect(allText).toContain('all grants (1)');
    expect(allText).toContain('01JN0000000000000000000002');
    expect(allText).toContain('expired');
  });

  test('revoked grants excluded from default list, included with --all', async () => {
    seedGrant({
      id: '01JN0000000000000000000003',
      revoked_at: 1_500,
    });
    const defaultOut = captured();
    await runPermissionGrants({
      dbPath,
      env,
      out: defaultOut.write,
      err: captured().write,
      now: () => 5_000,
    });
    expect(defaultOut.lines.join('')).toContain('active grants: (none)');

    const allOut = captured();
    await runPermissionGrants({
      all: true,
      dbPath,
      env,
      out: allOut.write,
      err: captured().write,
      now: () => 5_000,
    });
    expect(allOut.lines.join('')).toContain('revoked');
  });

  test('--json: emits one NDJSON line per grant', async () => {
    seedGrant({ id: '01JN0000000000000000000004' });
    seedGrant({ id: '01JN0000000000000000000005' });
    const out = captured();
    const code = await runPermissionGrants({
      json: true,
      dbPath,
      env,
      out: out.write,
      err: captured().write,
      now: () => 5_000,
    });
    expect(code).toBe(0);
    const lines = out.lines.join('').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    const parsed = lines.map((l) => JSON.parse(l));
    // Newest granted_at first per the repo's ORDER BY — both grants
    // share granted_at=1000 here, so ordering between them is
    // unspecified; assert SHAPE not order.
    const ids = new Set(parsed.map((p) => p.id));
    expect(ids.has('01JN0000000000000000000004')).toBe(true);
    expect(ids.has('01JN0000000000000000000005')).toBe(true);
  });

  test('--json with empty result emits zero lines on stdout', async () => {
    const out = captured();
    const code = await runPermissionGrants({
      json: true,
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).toBe('');
  });
});
