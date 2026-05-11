import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args.ts';
import { runPermissionInspect } from '../../src/cli/permission-inspect.ts';
import { createSqliteSink, ensureInstallId } from '../../src/permissions/index.ts';
import { MIGRATIONS, migrate, openDb } from '../../src/storage/index.ts';
import { listChainMetaByInstall, rotateChain } from '../../src/storage/repos/chain-rotation.ts';

const captured = () => {
  const lines: string[] = [];
  return { write: (s: string) => lines.push(s), lines };
};

describe('parseArgs — permission inspect', () => {
  test('routes to permission.verb=inspect with rotation_id', () => {
    const r = parseArgs(['permission', 'inspect', '1']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.verb).toBe('inspect');
      expect(r.args.permission?.positionals).toEqual(['1']);
      expect(r.args.permission?.clearQuarantine).toBeUndefined();
    }
  });

  test('--clear flag flows through', () => {
    const r = parseArgs(['permission', 'inspect', '1', '--clear']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.clearQuarantine).toBe(true);
    }
  });

  test('--clear on a non-inspect verb fails parse', () => {
    const r = parseArgs(['permission', 'verify', '--clear']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("--clear only applies to 'inspect'");
    }
  });

  test('missing rotation_id fails parse', () => {
    const r = parseArgs(['permission', 'inspect']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('exactly one <rotation_id>');
    }
  });

  test('non-numeric rotation_id fails parse', () => {
    const r = parseArgs(['permission', 'inspect', 'abc']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('positive integer');
    }
  });

  test('zero rotation_id fails parse', () => {
    const r = parseArgs(['permission', 'inspect', '0']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('out of range');
    }
  });

  test('--json toggle parsed alongside rotation_id', () => {
    const r = parseArgs(['permission', 'inspect', '1', '--json']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.json).toBe(true);
      expect(r.args.permission?.positionals).toEqual(['1']);
    }
  });
});

describe('runPermissionInspect', () => {
  let tmp: string;
  let dbPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-inspect-'));
    dbPath = join(tmp, 'sessions.db');
    env = { HOME: tmp };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // Seed an audit row + rotate so we have a known rotation_id with a
  // populated chain_meta row.
  const seedRotation = (reason = 'fixture'): number => {
    const identity = ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const sink = createSqliteSink({ db, identity });
    sink.emit({
      session_id: 's',
      tool_name: 'bash',
      args: { command: 'ls' },
      decision: 'allow',
      policy_hash: 'sha256:fixture',
      reason_chain: [],
      ts: 1,
    });
    const r = rotateChain(db, {
      install_id: identity.install_id,
      reason,
      rotated_at_ms: 5000,
    });
    db.close();
    return r.rotation_id;
  };

  test('text output renders chain_meta + archived row count', async () => {
    const rotationId = seedRotation('test scare');
    const out = captured();
    const code = await runPermissionInspect({
      rotationId,
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain(`Inspect rotation_id=${rotationId}`);
    expect(text).toContain('reason:                 test scare');
    expect(text).toContain('archived rows:          1');
    expect(text).toContain('quarantined (before):   yes');
    expect(text).toContain('QUARANTINED');
  });

  test('--clear flips quarantined to 0', async () => {
    const rotationId = seedRotation();
    const out = captured();
    const code = await runPermissionInspect({
      rotationId,
      clear: true,
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('quarantine cleared');

    // Confirm via direct repo read.
    const identity = ensureInstallId({ env });
    const db = openDb(dbPath);
    const allMeta = listChainMetaByInstall(db, identity.install_id);
    db.close();
    const meta = allMeta.find((m) => m.rotation_id === rotationId);
    expect(meta?.quarantined).toBe(0);
  });

  test('--clear on already-clear rotation is a no-op message', async () => {
    const rotationId = seedRotation();
    // Clear once.
    await runPermissionInspect({
      rotationId,
      clear: true,
      dbPath,
      env,
      out: captured().write,
      err: captured().write,
    });
    // Clear again.
    const out = captured();
    const code = await runPermissionInspect({
      rotationId,
      clear: true,
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('already clear');
  });

  test('missing rotation_id → exit 1 not_found', async () => {
    ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    db.close();

    const out = captured();
    const err = captured();
    const code = await runPermissionInspect({
      rotationId: 999,
      dbPath,
      env,
      out: out.write,
      err: err.write,
    });
    expect(code).toBe(1);
    expect(err.lines.join('')).toContain('no rotation found at rotation_id=999');
  });

  test('JSON output shape', async () => {
    const rotationId = seedRotation('json test');
    const out = captured();
    const code = await runPermissionInspect({
      rotationId,
      json: true,
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const obj = JSON.parse(out.lines[0] as string) as Record<string, unknown>;
    expect(obj.ok).toBe(true);
    expect(obj.rotation_id).toBe(rotationId);
    expect(obj.reason).toBe('json test');
    expect(obj.archived_row_count).toBe(1);
    expect(obj.quarantined_before).toBe(true);
    expect(obj.quarantined_after).toBe(true); // not cleared
    expect(obj.cleared).toBe(false);
  });

  test('JSON --clear shape includes quarantined_after=false + cleared=true', async () => {
    const rotationId = seedRotation();
    const out = captured();
    await runPermissionInspect({
      rotationId,
      clear: true,
      json: true,
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    const obj = JSON.parse(out.lines[0] as string) as Record<string, unknown>;
    expect(obj.cleared).toBe(true);
    expect(obj.quarantined_after).toBe(false);
  });
});
