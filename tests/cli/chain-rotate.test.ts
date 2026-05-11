import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args.ts';
import { runChainRotate } from '../../src/cli/chain-rotate.ts';
import { runPermissionVerify } from '../../src/cli/permission-verify.ts';
import { createSqliteSink, ensureInstallId } from '../../src/permissions/index.ts';
import { MIGRATIONS, migrate, openDb } from '../../src/storage/index.ts';

const captured = () => {
  const lines: string[] = [];
  return { write: (s: string) => lines.push(s), lines };
};

describe('parseArgs — permission rotate-chain', () => {
  test('routes to permission.verb=rotate-chain when --reason provided', () => {
    const r = parseArgs(['permission', 'rotate-chain', '--reason', 'incident scare']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.verb).toBe('rotate-chain');
      expect(r.args.permission?.reason).toBe('incident scare');
    }
  });

  test('missing --reason fails parse (forensic requirement)', () => {
    const r = parseArgs(['permission', 'rotate-chain']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('--reason');
      expect(r.message).toContain('required');
    }
  });

  test('--reason without value fails parse', () => {
    const r = parseArgs(['permission', 'rotate-chain', '--reason']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('--reason');
    }
  });

  test('--reason followed by a flag fails parse (no swallowing)', () => {
    const r = parseArgs(['permission', 'rotate-chain', '--reason', '--json']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('--reason');
    }
  });

  test('whitespace-only --reason fails parse', () => {
    const r = parseArgs(['permission', 'rotate-chain', '--reason', '   ']);
    expect(r.ok).toBe(false);
  });

  test('--json toggle parsed alongside --reason', () => {
    const r = parseArgs(['permission', 'rotate-chain', '--reason', 'r', '--json']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.json).toBe(true);
      expect(r.args.permission?.reason).toBe('r');
    }
  });

  test('unknown verb message lists rotate-chain', () => {
    const r = parseArgs(['permission', 'mystery']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('rotate-chain');
    }
  });
});

describe('runChainRotate', () => {
  let tmp: string;
  let dbPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-rotate-'));
    dbPath = join(tmp, 'sessions.db');
    env = { HOME: tmp };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('exit 0 on preventive rotation of an empty chain', async () => {
    const out = captured();
    const err = captured();
    const code = await runChainRotate({
      reason: 'preventive',
      dbPath,
      env,
      out: out.write,
      err: err.write,
      now: () => 12345,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('audit chain: rotated');
    expect(text).toContain('rotation_id=1');
    expect(text).toContain('preventive');
    expect(text).toContain('QUARANTINED');
    expect(err.lines).toEqual([]);
  });

  test('archives existing rows under the new rotation_id', async () => {
    const identity = ensureInstallId({ env });

    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const sink = createSqliteSink({ db, identity });
    for (let i = 1; i <= 3; i += 1) {
      sink.emit({
        session_id: 'sess-pre',
        tool_name: 'bash',
        args: { command: `cmd-${i}` },
        decision: 'allow',
        policy_hash: 'sha256:p',
        reason_chain: [],
        ts: i,
      });
    }
    db.close();

    const out = captured();
    const code = await runChainRotate({
      reason: 'archive sweep',
      dbPath,
      env,
      out: out.write,
      err: captured().write,
      now: () => 50000,
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('archived 3 rows');

    // Verify post-rotation state via DB inspection.
    const db2 = openDb(dbPath);
    const live = db2
      .query('SELECT COUNT(*) as n FROM approvals_log WHERE install_id = ?')
      .get(identity.install_id) as { n: number };
    const archived = db2
      .query('SELECT COUNT(*) as n FROM approvals_log_archived WHERE install_id = ?')
      .get(identity.install_id) as { n: number };
    db2.close();
    expect(live.n).toBe(0);
    expect(archived.n).toBe(3);
  });

  test('--json emits a single NDJSON line on success', async () => {
    const out = captured();
    const code = await runChainRotate({
      reason: 'machine-readable test',
      dbPath,
      env,
      json: true,
      out: out.write,
      err: captured().write,
      now: () => 7777,
    });
    expect(code).toBe(0);
    expect(out.lines.length).toBe(1);
    const obj = JSON.parse(out.lines[0] as string) as Record<string, unknown>;
    expect(obj.ok).toBe(true);
    expect(obj.rotation_id).toBe(1);
    expect(obj.archived_rows).toBe(0);
    expect(obj.quarantined).toBe(true);
    expect(obj.reason).toBe('machine-readable test');
    expect(obj.rotated_at_ms).toBe(7777);
  });

  test('empty --reason rejected by the handler defensively', async () => {
    const out = captured();
    const err = captured();
    const code = await runChainRotate({
      reason: '   ',
      dbPath,
      env,
      out: out.write,
      err: err.write,
    });
    expect(code).toBe(1);
    expect(err.lines.join('')).toContain('cannot be empty');
  });

  test('rotated chain shows QUARANTINED in subsequent verify output', async () => {
    // Seed + rotate.
    const identity = ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const sink = createSqliteSink({ db, identity });
    sink.emit({
      session_id: 's',
      tool_name: 'bash',
      args: {},
      decision: 'allow',
      policy_hash: 'sha256:p',
      reason_chain: [],
      ts: 1,
    });
    db.close();

    await runChainRotate({
      reason: 'test',
      dbPath,
      env,
      out: captured().write,
      err: captured().write,
      now: () => 999,
    });

    const verifyOut = captured();
    const code = await runPermissionVerify({
      dbPath,
      env,
      out: verifyOut.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = verifyOut.lines.join('');
    expect(text).toContain('QUARANTINED');
    expect(text).toContain('rotation_id=1');
  });
});
