import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args.ts';
import { runPermissionVerify } from '../../src/cli/permission-verify.ts';
import { createSqliteSink, ensureInstallId } from '../../src/permissions/index.ts';
import { MIGRATIONS, migrate, openDb } from '../../src/storage/index.ts';

const captured = () => {
  const lines: string[] = [];
  return { write: (s: string) => lines.push(s), lines };
};

describe('parseArgs — permission subcommand', () => {
  test('agent permission verify routes to permission.verb', () => {
    const r = parseArgs(['permission', 'verify']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.verb).toBe('verify');
      expect(r.args.permission?.positionals).toEqual([]);
      expect(r.args.json).toBe(false);
    }
  });

  test('--json toggle parsed', () => {
    const r = parseArgs(['permission', 'verify', '--json']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.json).toBe(true);
      expect(r.args.permission?.verb).toBe('verify');
    }
  });

  test('--help short-circuits to help mode', () => {
    const r = parseArgs(['permission', 'verify', '--help']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.help).toBe(true);
      expect(r.args.permission).toBeUndefined();
    }
  });

  test('missing verb fails parse', () => {
    const r = parseArgs(['permission']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('verify');
    }
  });

  test('unknown verb fails parse', () => {
    // `revoke` is listed in the spec's future-verb table but not yet
    // implemented — known-unknown for this test.
    const r = parseArgs(['permission', 'revoke']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('revoke');
      expect(r.message).toContain('verify');
    }
  });

  test('positionals after verb collected verbatim', () => {
    const r = parseArgs(['permission', 'verify', 'extra-arg', 'another']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.positionals).toEqual(['extra-arg', 'another']);
    }
  });
});

describe('runPermissionVerify', () => {
  let tmp: string;
  let dbPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-perm-verify-'));
    dbPath = join(tmp, 'sessions.db');
    env = { HOME: tmp };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('exit 0 with intact message on empty chain', async () => {
    const out = captured();
    const err = captured();
    const code = await runPermissionVerify({
      dbPath,
      env,
      out: out.write,
      err: err.write,
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('audit chain: intact');
    expect(out.lines.join('')).toContain('0 rows');
    expect(err.lines).toEqual([]);
  });

  test('exit 0 with row count after emit', async () => {
    // Bootstrap install_id by running once
    const identity = ensureInstallId({ env });

    // Emit a couple of rows directly
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const sink = createSqliteSink({ db, identity });
    sink.emit({
      session_id: 'sess-1',
      tool_name: 'bash',
      args: { command: 'ls' },
      decision: 'allow',
      policy_hash: 'sha256:fixture',
      reason_chain: [{ stage: 'static-rule' }],
      ts: 1,
    });
    sink.emit({
      session_id: 'sess-1',
      tool_name: 'write_file',
      args: { path: './foo' },
      decision: 'deny',
      policy_hash: 'sha256:fixture',
      reason_chain: [{ stage: 'default-deny' }],
      ts: 2,
    });
    db.close();

    const out = captured();
    const code = await runPermissionVerify({
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('audit chain: intact');
    expect(out.lines.join('')).toContain('2 rows');
  });

  test('exit 1 with diagnostic when chain is tampered', async () => {
    const identity = ensureInstallId({ env });

    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const sink = createSqliteSink({ db, identity });
    sink.emit({
      session_id: 'sess-x',
      tool_name: 'bash',
      args: {},
      decision: 'allow',
      policy_hash: 'sha256:fixture',
      reason_chain: [{ stage: 'static-rule' }],
      ts: 1,
    });
    sink.emit({
      session_id: 'sess-x',
      tool_name: 'bash',
      args: {},
      decision: 'allow',
      policy_hash: 'sha256:fixture',
      reason_chain: [{ stage: 'static-rule' }],
      ts: 2,
    });
    // Tamper row 2's prev_hash
    db.run('UPDATE approvals_log SET prev_hash = ? WHERE seq = 2', ['forged']);
    db.close();

    const out = captured();
    const code = await runPermissionVerify({
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(1);
    const text = out.lines.join('');
    expect(text).toContain('BROKEN at seq 2');
    expect(text).toContain('prev_hash_mismatch');
    expect(text).toContain('forged');
  });

  test('--json prints single NDJSON line', async () => {
    const out = captured();
    const code = await runPermissionVerify({
      json: true,
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    const parsed = JSON.parse(text);
    expect(parsed.ok).toBe(true);
    expect(parsed.rows).toBe(0);
    expect(parsed.install_id).toMatch(/^[0-9a-f-]+$/);
  });

  test('--json on broken chain reports ok:false with brokenAt', async () => {
    const identity = ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const sink = createSqliteSink({ db, identity });
    sink.emit({
      session_id: 'sess-y',
      tool_name: 'bash',
      args: {},
      decision: 'allow',
      policy_hash: 'sha256:fixture',
      reason_chain: [],
      ts: 1,
    });
    db.run('UPDATE approvals_log SET decision = ? WHERE seq = 1', ['deny']);
    db.close();

    const out = captured();
    const code = await runPermissionVerify({
      json: true,
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(out.lines.join(''));
    expect(parsed.ok).toBe(false);
    expect(parsed.brokenAt).toBe(1);
    expect(parsed.reason).toBe('this_hash_mismatch');
  });

  test('install_id discovery failure returns exit 1', async () => {
    const out = captured();
    const err = captured();
    const code = await runPermissionVerify({
      dbPath,
      env: {}, // no HOME, no XDG, no APPDATA
      out: out.write,
      err: err.write,
    });
    expect(code).toBe(1);
    expect(err.lines.join('')).toContain('cannot determine config directory');
  });

  test('install_id discovery failure with --json prints structured error', async () => {
    const out = captured();
    const code = await runPermissionVerify({
      json: true,
      dbPath,
      env: {},
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(out.lines.join(''));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('install_id');
  });

  test('intact chain with accepted breaks renders banner naming seqs', async () => {
    // Seed an intact row + a chain-break-accepted row. The chain
    // stays intact (the engine emit path appends it cleanly), but
    // verify should call out the acceptance.
    const identity = ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const sink = createSqliteSink({ db, identity });
    sink.emit({
      session_id: 'pre',
      tool_name: 'permission-engine',
      args: { acceptBrokenChain: true },
      decision: 'allow',
      policy_hash: 'sha256:fix',
      reason_chain: [{ stage: 'chain-break-accepted' }],
      ts: 1,
    });
    sink.emit({
      session_id: 's',
      tool_name: 'bash',
      args: { command: 'ls' },
      decision: 'allow',
      policy_hash: 'sha256:fix',
      reason_chain: [],
      ts: 2,
    });
    db.close();

    const out = captured();
    const code = await runPermissionVerify({
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('audit chain: intact');
    expect(text).toContain('chain-break-accepted row(s)');
    expect(text).toContain('seq');
  });

  test('JSON output includes accepted_breaks array', async () => {
    const identity = ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const sink = createSqliteSink({ db, identity });
    sink.emit({
      session_id: 'pre',
      tool_name: 'permission-engine',
      args: { acceptBrokenChain: true },
      decision: 'allow',
      policy_hash: 'sha256:fix',
      reason_chain: [{ stage: 'chain-break-accepted' }],
      ts: 1,
    });
    db.close();

    const out = captured();
    const code = await runPermissionVerify({
      json: true,
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.lines.join(''));
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.accepted_breaks)).toBe(true);
    expect(parsed.accepted_breaks.length).toBe(1);
    expect(typeof parsed.accepted_breaks[0].seq).toBe('number');
    expect(typeof parsed.accepted_breaks[0].ts).toBe('number');
  });

  test('clean chain with no accepted breaks does NOT render banner', async () => {
    const identity = ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const sink = createSqliteSink({ db, identity });
    sink.emit({
      session_id: 's',
      tool_name: 'bash',
      args: { command: 'ls' },
      decision: 'allow',
      policy_hash: 'sha256:fix',
      reason_chain: [],
      ts: 1,
    });
    db.close();

    const out = captured();
    await runPermissionVerify({
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    const text = out.lines.join('');
    expect(text).toContain('audit chain: intact');
    expect(text).not.toContain('chain-break-accepted');
  });

  test('broken-chain help text recommends --accept-broken-chain as a real option', async () => {
    // Seed a broken chain. The verify failure path renders the
    // forensic options including the accept-broken-chain hint —
    // this slice updates the wording away from "not implemented
    // in this slice" since the flag IS implemented.
    const identity = ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const sink = createSqliteSink({ db, identity });
    sink.emit({
      session_id: 's',
      tool_name: 'bash',
      args: {},
      decision: 'allow',
      policy_hash: 'sha256:fix',
      reason_chain: [],
      ts: 1,
    });
    // Tamper.
    db.run('UPDATE approvals_log SET this_hash = ? WHERE seq = 1', ['forged']);
    db.close();

    const out = captured();
    await runPermissionVerify({
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    const text = out.lines.join('');
    expect(text).toContain('BROKEN');
    expect(text).toContain('--accept-broken-chain');
    // Pin away from the obsolete "not implemented in this slice" wording.
    expect(text).not.toContain('not implemented in this slice');
  });
});
