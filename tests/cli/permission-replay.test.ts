import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args.ts';
import { runPermissionReplay } from '../../src/cli/permission-replay.ts';
import { createSqliteSink, ensureInstallId } from '../../src/permissions/index.ts';
import { MIGRATIONS, migrate, openDb } from '../../src/storage/index.ts';

const captured = () => {
  const lines: string[] = [];
  return { write: (s: string) => lines.push(s), lines };
};

describe('parseArgs — permission replay', () => {
  test('routes to permission.verb=replay with numeric seq positional', () => {
    const r = parseArgs(['permission', 'replay', '42']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.verb).toBe('replay');
      expect(r.args.permission?.positionals).toEqual(['42']);
    }
  });

  test('missing <seq> fails parse', () => {
    const r = parseArgs(['permission', 'replay']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('<seq>');
      expect(r.message).toContain('required');
    }
  });

  test('non-numeric <seq> fails parse', () => {
    const r = parseArgs(['permission', 'replay', 'abc']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('positive integer');
    }
  });

  test('zero <seq> fails parse', () => {
    const r = parseArgs(['permission', 'replay', '0']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('out of range');
    }
  });

  test('negative <seq> fails parse (treated as non-numeric by the regex)', () => {
    const r = parseArgs(['permission', 'replay', '-1']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('positive integer');
    }
  });

  test('multiple positionals fail parse', () => {
    const r = parseArgs(['permission', 'replay', '1', '2']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('exactly one');
    }
  });

  test('--json toggle parsed alongside <seq>', () => {
    const r = parseArgs(['permission', 'replay', '7', '--json']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.json).toBe(true);
      expect(r.args.permission?.positionals).toEqual(['7']);
    }
  });

  test('unknown verb message lists replay', () => {
    const r = parseArgs(['permission', 'mystery']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('replay');
    }
  });
});

describe('runPermissionReplay', () => {
  let tmp: string;
  let dbPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-replay-'));
    dbPath = join(tmp, 'sessions.db');
    env = { HOME: tmp };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const seedRow = (): number => {
    const identity = ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const sink = createSqliteSink({ db, identity });
    const r = sink.emit({
      session_id: 'sess-replay',
      tool_name: 'bash',
      args: { command: 'ls -la' },
      decision: 'allow',
      policy_hash: 'sha256:fixture-policy-hash',
      reason_chain: [
        { stage: 'static-rule', layer: 'project', rule: 'ls *', section: 'bash' },
        { stage: 'risk-score', note: 'score=0.00' },
      ],
      capabilities: ['exec:shell', 'read-fs:/work/proj'],
      score: 0,
      score_components: {},
      confidence: 'high',
      classifier_hash: 'fixture-v1',
      classifier_adjust: -0.05,
      sandbox_profile: 'cwd-rw',
      ts: 1700000000000,
    });
    db.close();
    return r.seq;
  };

  test('text output: prints every preserved field', async () => {
    const seq = seedRow();
    const out = captured();
    const err = captured();
    const code = await runPermissionReplay({
      seq,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: err.write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain(`Replay approval seq=${seq}`);
    expect(text).toContain('tool:               bash (version=v1)');
    expect(text).toContain('decision:           allow');
    expect(text).toContain('args_hash:');
    expect(text).toContain('exec:shell');
    expect(text).toContain('read-fs:/work/proj');
    expect(text).toContain('sandbox profile:    cwd-rw');
    expect(text).toContain('classifier:         hash=fixture-v1, adjust=-0.05');
    expect(text).toContain('stage=static-rule');
    expect(text).toContain('rule="ls *"');
    expect(text).toContain('sha256:fixture-policy-hash');
    // The fixture policy hash will NOT match the active policy
    // (loadActivePolicy resolves a real one); drift should fire.
    expect(text).toContain('policy drift:');
    expect(err.lines).toEqual([]);
  });

  test('JSON output: one NDJSON line with parsed sub-objects', async () => {
    const seq = seedRow();
    const out = captured();
    const code = await runPermissionReplay({
      seq,
      json: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(out.lines.length).toBe(1);
    const obj = JSON.parse(out.lines[0] as string) as Record<string, unknown>;
    expect(obj.ok).toBe(true);
    expect(obj.seq).toBe(seq);
    expect(obj.tool_name).toBe('bash');
    expect(obj.decision).toBe('allow');
    expect(obj.capabilities).toEqual(['exec:shell', 'read-fs:/work/proj']);
    expect(obj.reason_chain).toEqual([
      { stage: 'static-rule', layer: 'project', rule: 'ls *', section: 'bash' },
      { stage: 'risk-score', note: 'score=0.00' },
    ]);
    expect(typeof obj.policy_drift).toBe('boolean');
    expect(typeof obj.active_policy_hash).toBe('string');
  });

  test('row missing → exit 1 with not_found error', async () => {
    // Seed install_id + DB but no rows.
    ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    db.close();

    const out = captured();
    const err = captured();
    const code = await runPermissionReplay({
      seq: 999,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: err.write,
    });
    expect(code).toBe(1);
    expect(err.lines.join('')).toContain('no approval row found at seq=999');
  });

  test('row from a different install_id → exit 1 (not_found)', async () => {
    // Seed under one install, then re-run replay with a different
    // HOME (different install_id) — the seq exists but belongs to
    // the other install. Replay must refuse cross-install lookups.
    const seq = seedRow();
    const otherTmp = mkdtempSync(join(tmpdir(), 'forja-replay-other-'));
    try {
      const otherEnv = { HOME: otherTmp };
      const otherOut = captured();
      const otherErr = captured();
      const code = await runPermissionReplay({
        seq,
        dbPath,
        env: otherEnv,
        cwd: otherTmp,
        out: otherOut.write,
        err: otherErr.write,
      });
      expect(code).toBe(1);
      expect(otherErr.lines.join('')).toContain('different install_id');
    } finally {
      rmSync(otherTmp, { recursive: true, force: true });
    }
  });

  test('JSON not_found shape includes install_id + seq', async () => {
    ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    db.close();

    const out = captured();
    const code = await runPermissionReplay({
      seq: 12345,
      json: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(1);
    const obj = JSON.parse(out.lines[0] as string) as Record<string, unknown>;
    expect(obj.ok).toBe(false);
    expect(obj.error).toBe('not_found');
    expect(obj.seq).toBe(12345);
    expect(typeof obj.install_id).toBe('string');
  });

  test('policy drift: ACTIVE matches the row → no drift', async () => {
    // Re-emit a row whose policy_hash matches the hash of an
    // explicitly-empty policy. cwd has no policy YAML, so the active
    // policy is the default (empty rules) — its canonical hash is
    // computable; we mirror it on the row's policy_hash and assert
    // no drift fires.
    const identity = ensureInstallId({ env });
    const { canonicalHash, resolvePolicy } = await import('../../src/permissions/index.ts');
    const activePolicy = resolvePolicy({ cwd: tmp, home: tmp, env }).policy;
    const activeHash = `sha256:${canonicalHash(activePolicy)}`;

    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const sink = createSqliteSink({ db, identity });
    const r = sink.emit({
      session_id: 'sess',
      tool_name: 'bash',
      args: { command: 'ls' },
      decision: 'allow',
      policy_hash: activeHash,
      reason_chain: [{ stage: 'engine-default' }],
      ts: 1,
    });
    db.close();

    const out = captured();
    const code = await runPermissionReplay({
      seq: r.seq,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('active policy matches the row');
  });

  test('policy drift: malformed active policy → drift undecidable, shown as unavailable', async () => {
    // Plant a malformed user-policy YAML so resolvePolicy throws.
    // Replay must still render the row (don't bring down a forensic
    // readout because the live config is broken).
    const seq = seedRow();

    // Override resolvePolicy lookup by setting a broken
    // user-policy file. resolvePolicy tries to read both enterprise +
    // user files; missing OK, but if HOME has a malformed
    // ~/.config/agent/permissions.yaml it throws.
    const userDir = join(tmp, '.config', 'agent');
    require('node:fs').mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'permissions.yaml'), 'this is: not :: valid: yaml: : :');

    const out = captured();
    const code = await runPermissionReplay({
      seq,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    // Replay swallows the policy error and reports the row.
    expect(out.lines.join('')).toContain(`Replay approval seq=${seq}`);
    expect(out.lines.join('')).toContain('active policy unavailable');
  });
});
