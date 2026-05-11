import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args.ts';
import { runDoctor } from '../../src/cli/doctor.ts';
import {
  type SealEntry,
  type SealStore,
  createSqliteSink,
  ensureInstallId,
} from '../../src/permissions/index.ts';
import { MIGRATIONS, migrate, openDb } from '../../src/storage/index.ts';

const captured = () => {
  const lines: string[] = [];
  return { write: (s: string) => lines.push(s), lines };
};

describe('parseArgs — agent doctor', () => {
  test('doctor verb is recognized', () => {
    const r = parseArgs(['doctor']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.doctor?.json).toBe(false);
      expect(r.args.json).toBe(false);
    }
  });

  test('--json flag is captured', () => {
    const r = parseArgs(['doctor', '--json']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.doctor?.json).toBe(true);
      expect(r.args.json).toBe(true);
    }
  });

  test('--help short-circuits to help mode', () => {
    const r = parseArgs(['doctor', '--help']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.help).toBe(true);
      expect(r.args.doctor).toBeUndefined();
    }
  });

  test('unknown flag rejected', () => {
    const r = parseArgs(['doctor', '--foo']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('--foo');
  });

  test('positional after doctor is treated as unknown flag', () => {
    // Doctor takes no positionals; the loop in the parser hits
    // the unknown-flag branch on the first non-flag token.
    const r = parseArgs(['doctor', 'extra']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('extra');
  });
});

describe('runDoctor', () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-doctor-'));
    // Point HOME at a writable temp dir so config_dir + data_dir
    // checks pass deterministically on any runner.
    env = { HOME: tmp, PATH: process.env.PATH };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('all checks pass → exit 0 + "all checks passed" footer', async () => {
    const out = captured();
    const code = await runDoctor({
      env,
      // Stub which() so the sandbox + git checks pass regardless of
      // the runner's $PATH (CI hosts often lack bwrap).
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('platform');
    expect(text).toContain('sandbox');
    expect(text).toContain('config_dir');
    expect(text).toContain('data_dir');
    expect(text).toContain('git');
    expect(text).toContain('summary: all checks passed');
  });

  test('missing sandbox tool → warn, exit 0 (sandbox absence is recoverable)', async () => {
    const out = captured();
    const code = await runDoctor({
      env,
      which: (cmd) => (cmd === 'bwrap' || cmd === 'sandbox-exec' ? null : `/usr/bin/${cmd}`),
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0); // warnings don't fail the check
    const text = out.lines.join('');
    expect(text).toContain('sandbox');
    expect(text).toContain('warn');
    expect(text).toMatch(/warning\(s\)/);
  });

  test('missing git → warn, exit 0', async () => {
    const out = captured();
    const code = await runDoctor({
      env,
      which: (cmd) => (cmd === 'git' ? null : `/usr/bin/${cmd}`),
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('git not found on $PATH');
    expect(text).toContain('install git');
  });

  test('--json: NDJSON one event per check + summary line', async () => {
    const out = captured();
    const code = await runDoctor({
      json: true,
      env,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const lines = out.lines.join('').trim().split('\n').filter(Boolean);
    // 8 checks + 1 summary (hash_chain added in slice 62,
    // policy_load in slice 61, sealing in slice 60).
    expect(lines.length).toBe(9);
    const events = lines.map((l) => JSON.parse(l));
    expect(events[0].kind).toBe('check');
    expect(events[0].name).toBe('platform');
    const summary = events[events.length - 1];
    expect(summary.kind).toBe('summary');
    expect(summary.ok).toBe(true);
    expect(summary.counts).toEqual({ ok: 8, warn: 0, fail: 0 });
  });

  test('--json: failures bump summary.ok to false + exit 1', async () => {
    // Force a failure by pointing HOME at a non-existent + non-
    // writable parent. Real production checks would hit this when
    // operators have HOME set to a path their user can't reach.
    const noHome = { PATH: process.env.PATH };
    const out = captured();
    const code = await runDoctor({
      json: true,
      env: noHome,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(1);
    const lines = out.lines.join('').trim().split('\n').filter(Boolean);
    const summary = JSON.parse(lines[lines.length - 1] as string);
    expect(summary.kind).toBe('summary');
    expect(summary.ok).toBe(false);
    expect(summary.counts.fail).toBeGreaterThanOrEqual(1);
  });

  test('plain text: failures render the remediation hint', async () => {
    const noHome = { PATH: process.env.PATH };
    const out = captured();
    await runDoctor({
      env: noHome,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    const text = out.lines.join('');
    expect(text).toContain('→');
    expect(text).toMatch(/failure\(s\)/);
  });
});

describe('runDoctor — sealing check (§13.3 / slice 60)', () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-doctor-seal-'));
    env = { HOME: tmp, PATH: process.env.PATH };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const writeUserYaml = (sealSection: string | null): string => {
    const path = join(tmp, 'user-permissions.yaml');
    const content =
      sealSection === null
        ? 'defaults:\n  mode: strict\n'
        : `defaults:\n  mode: strict\n${sealSection}\n`;
    writeFileSync(path, content);
    return path;
  };

  const makeStaticStore =
    (entries: SealEntry[]): (() => SealStore) =>
    () => ({
      append: () => ({ ok: true }),
      list: () => entries.slice(),
      close: () => {},
    });

  test('no seal section → ok "not configured"', async () => {
    const userPath = writeUserYaml(null);
    const out = captured();
    const code = await runDoctor({
      env,
      cwd: tmp,
      enterprisePath: null,
      userPath,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('not configured (optional per spec §7.3)');
  });

  test('mode=none → ok "not configured"', async () => {
    const userPath = writeUserYaml('seal:\n  mode: none');
    const out = captured();
    const code = await runDoctor({
      env,
      cwd: tmp,
      enterprisePath: null,
      userPath,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('not configured');
  });

  test('mode=worm-file with empty seal file → warn "no entries yet"', async () => {
    const userPath = writeUserYaml('seal:\n  mode: worm-file\n  path: /var/log/agent/seal.log');
    const out = captured();
    const code = await runDoctor({
      env,
      cwd: tmp,
      enterprisePath: null,
      userPath,
      sealStoreFactory: makeStaticStore([]),
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0); // warn doesn't fail
    const text = out.lines.join('');
    expect(text).toContain('configured but no entries yet');
    expect(text).toContain('seal-now'); // remediation
  });

  test('mode=worm-file with N entries → ok with relative-time + count', async () => {
    const userPath = writeUserYaml('seal:\n  mode: worm-file\n  path: /var/log/agent/seal.log');
    const entries: SealEntry[] = [
      { seq: 1, ts: 1_000_000_000_000, hash: 'sha256:a' },
      { seq: 50, ts: 1_000_000_300_000, hash: 'sha256:b' }, // 5 minutes after start
      { seq: 100, ts: 1_000_000_600_000, hash: 'sha256:c' }, // 10 minutes after start
    ];
    const out = captured();
    const code = await runDoctor({
      env,
      cwd: tmp,
      enterprisePath: null,
      userPath,
      sealStoreFactory: makeStaticStore(entries),
      // Now = 4 hours after the last seal (4 * 3600 * 1000 ms).
      now: () => 1_000_000_600_000 + 4 * 3600 * 1000,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('3 entries');
    expect(text).toContain('last 4h ago');
    expect(text).toContain('worm-file at /var/log/agent/seal.log');
  });

  test('mode=worm-file with single entry → singular "1 entry"', async () => {
    const userPath = writeUserYaml('seal:\n  mode: worm-file\n  path: /var/log/agent/seal.log');
    const out = captured();
    const code = await runDoctor({
      env,
      cwd: tmp,
      enterprisePath: null,
      userPath,
      sealStoreFactory: makeStaticStore([{ seq: 1, ts: 1_000_000_000_000, hash: 'sha256:a' }]),
      now: () => 1_000_000_000_000 + 30 * 1000, // 30s after
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('1 entry,');
    expect(text).toContain('last 30s ago');
  });

  test('corrupted seal file (list throws) → fail with remediation', async () => {
    const userPath = writeUserYaml('seal:\n  mode: worm-file\n  path: /var/log/agent/seal.log');
    const factory = (): SealStore => ({
      append: () => ({ ok: true }),
      list: () => {
        throw new Error('malformed seal entry at line 3');
      },
      close: () => {},
    });
    const out = captured();
    const code = await runDoctor({
      env,
      cwd: tmp,
      enterprisePath: null,
      userPath,
      sealStoreFactory: factory,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(1); // fail exits non-zero
    const text = out.lines.join('');
    expect(text).toContain('seal file corrupted');
    expect(text).toContain('seal-verify'); // remediation hint
  });

  test('relative-time buckets: seconds / minutes / hours / days', async () => {
    const userPath = writeUserYaml('seal:\n  mode: worm-file\n  path: /tmp/s.log');
    const cases: Array<{ deltaMs: number; expect: string }> = [
      { deltaMs: 5 * 1000, expect: '5s ago' },
      { deltaMs: 90 * 1000, expect: '1m ago' },
      { deltaMs: 90 * 60 * 1000, expect: '1h ago' },
      { deltaMs: 2 * 24 * 3600 * 1000, expect: '2d ago' },
    ];
    for (const c of cases) {
      const out = captured();
      const baseTs = 1_000_000_000_000;
      await runDoctor({
        env,
        cwd: tmp,
        enterprisePath: null,
        userPath,
        sealStoreFactory: makeStaticStore([{ seq: 1, ts: baseTs, hash: 'sha256:a' }]),
        now: () => baseTs + c.deltaMs,
        which: (cmd) => `/usr/bin/${cmd}`,
        out: out.write,
        err: captured().write,
      });
      expect(out.lines.join('')).toContain(`last ${c.expect}`);
    }
  });

  test('--json: sealing check is included with structured fields', async () => {
    const userPath = writeUserYaml('seal:\n  mode: worm-file\n  path: /var/log/agent/seal.log');
    const out = captured();
    await runDoctor({
      env,
      cwd: tmp,
      enterprisePath: null,
      userPath,
      sealStoreFactory: makeStaticStore([{ seq: 7, ts: 1_000_000_000_000, hash: 'sha256:abc' }]),
      now: () => 1_000_000_000_000 + 5 * 1000,
      json: true,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    const lines = out.lines.join('').trim().split('\n').filter(Boolean);
    const events = lines.map((l) => JSON.parse(l));
    const sealing = events.find((e) => e.name === 'sealing');
    expect(sealing).toBeDefined();
    expect(sealing.status).toBe('ok');
    expect(sealing.detail).toContain('1 entry');
    expect(sealing.detail).toContain('last 5s ago');
  });
});

describe('runDoctor — policy_load check (§13.3 / slice 61)', () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-doctor-policy-'));
    env = { HOME: tmp, PATH: process.env.PATH };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('no layers present → ok "enterprise=none user=none project=none"', async () => {
    const out = captured();
    const code = await runDoctor({
      env,
      cwd: tmp,
      enterprisePath: null, // explicitly disabled (no file to look for)
      userPath: null,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('enterprise=none user=none project=none');
  });

  test('user layer present → ok "user=ok"', async () => {
    const userPath = join(tmp, 'user-permissions.yaml');
    writeFileSync(userPath, 'defaults:\n  mode: strict\n');
    const out = captured();
    const code = await runDoctor({
      env,
      cwd: tmp,
      enterprisePath: null,
      userPath,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('user=ok');
  });

  test('project layer present → ok "project=ok"', async () => {
    // Project layer is discovered relative to cwd. Build a project
    // policy under .agent/permissions.yaml.
    const projDir = join(tmp, 'proj');
    const agentDir = join(projDir, '.agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'permissions.yaml'), 'defaults:\n  mode: strict\n');
    const out = captured();
    const code = await runDoctor({
      env,
      cwd: projDir,
      enterprisePath: null,
      userPath: null,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('project=ok');
  });

  test('all three layers present → ok with every layer marked ok', async () => {
    const enterprisePath = join(tmp, 'enterprise-permissions.yaml');
    writeFileSync(enterprisePath, 'defaults:\n  mode: strict\n');
    const userPath = join(tmp, 'user-permissions.yaml');
    writeFileSync(userPath, 'defaults:\n  mode: strict\n');
    const projDir = join(tmp, 'proj');
    mkdirSync(join(projDir, '.agent'), { recursive: true });
    writeFileSync(join(projDir, '.agent', 'permissions.yaml'), 'defaults:\n  mode: strict\n');
    const out = captured();
    const code = await runDoctor({
      env,
      cwd: projDir,
      enterprisePath,
      userPath,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('enterprise=ok user=ok project=ok');
  });

  test('malformed yaml → fail with parser error + remediation', async () => {
    const userPath = join(tmp, 'user-permissions.yaml');
    writeFileSync(userPath, 'defaults:\n  mode: not_a_real_mode\n');
    const out = captured();
    const code = await runDoctor({
      env,
      cwd: tmp,
      enterprisePath: null,
      userPath,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(1); // fail exits non-zero
    const text = out.lines.join('');
    expect(text).toContain('policy_load');
    expect(text).toMatch(/defaults\.mode|not_a_real_mode/);
    expect(text).toContain('check the YAML files');
  });

  test('lock conflict → warn with conflict summary + remediation', async () => {
    // Enterprise locks defaults.mode=strict; user tries to set
    // mode=acceptEdits. Hierarchy reports a lock conflict; the
    // policy still loads (lower-layer change is dropped).
    const enterprisePath = join(tmp, 'enterprise-permissions.yaml');
    writeFileSync(enterprisePath, 'defaults:\n  mode: strict\n  locked: true\n');
    const userPath = join(tmp, 'user-permissions.yaml');
    writeFileSync(userPath, 'defaults:\n  mode: acceptEdits\n');
    const out = captured();
    const code = await runDoctor({
      env,
      cwd: tmp,
      enterprisePath,
      userPath,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0); // warn doesn't exit non-zero
    const text = out.lines.join('');
    expect(text).toContain('enterprise=ok user=ok');
    expect(text).toContain('lock conflict');
    expect(text).toContain('locked by enterprise');
    expect(text).toContain('attempted by user');
    expect(text).toContain('review layer precedence');
  });

  test('--json: policy_load check is included with structured fields', async () => {
    const userPath = join(tmp, 'user-permissions.yaml');
    writeFileSync(userPath, 'defaults:\n  mode: strict\n');
    const out = captured();
    await runDoctor({
      json: true,
      env,
      cwd: tmp,
      enterprisePath: null,
      userPath,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    const lines = out.lines.join('').trim().split('\n').filter(Boolean);
    const events = lines.map((l) => JSON.parse(l));
    const policy = events.find((e) => e.name === 'policy_load');
    expect(policy).toBeDefined();
    expect(policy.status).toBe('ok');
    expect(policy.detail).toBe('enterprise=none user=ok project=none');
  });
});

describe('runDoctor — hash_chain check (§7.2 / §13.3 / slice 62)', () => {
  let tmp: string;
  let dbPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-doctor-chain-'));
    dbPath = join(tmp, 'state.sqlite');
    env = { HOME: tmp, PATH: process.env.PATH };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // Seed the audit chain with `rowCount` clean rows under the
  // ensureInstallId identity. Returns the install identity so
  // tests can also tamper rows by primary-key seq if needed.
  const seedChain = (rowCount: number) => {
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const identity = ensureInstallId({
      env,
      now: () => 1,
      uuid: () => 'chain-uuid-aaaa-bbbb',
    });
    const sink = createSqliteSink({ db, identity });
    for (let i = 0; i < rowCount; i++) {
      sink.emit({
        session_id: `s${i}`,
        tool_name: 'bash',
        args: { i },
        decision: 'allow',
        policy_hash: 'sha256:p',
        reason_chain: [],
        ts: 100 + i,
      });
    }
    db.close?.();
    return identity;
  };

  test('no DB file → ok "no chain yet"', async () => {
    const out = captured();
    const code = await runDoctor({
      env,
      cwd: tmp,
      dbPath, // path that doesn't exist yet
      enterprisePath: null,
      userPath: null,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('no chain yet');
  });

  test('DB exists but empty chain → ok "no chain rows yet"', async () => {
    seedChain(0);
    const out = captured();
    const code = await runDoctor({
      env,
      cwd: tmp,
      dbPath,
      enterprisePath: null,
      userPath: null,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('no chain rows yet');
  });

  test('healthy chain → ok "intact (N rows)"', async () => {
    seedChain(5);
    const out = captured();
    const code = await runDoctor({
      env,
      cwd: tmp,
      dbPath,
      enterprisePath: null,
      userPath: null,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('intact (5 rows)');
  });

  test('single-row chain uses singular "row"', async () => {
    seedChain(1);
    const out = captured();
    await runDoctor({
      env,
      cwd: tmp,
      dbPath,
      enterprisePath: null,
      userPath: null,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(out.lines.join('')).toContain('intact (1 row)');
  });

  test('broken chain → fail with broken seq + remediation', async () => {
    seedChain(3);
    // Tamper with seq=2 — flip decision so the stored this_hash no
    // longer matches the recomputed payload.
    const db = openDb(dbPath);
    db.run('UPDATE approvals_log SET decision = ? WHERE seq = 2', ['deny']);
    db.close?.();
    const out = captured();
    const code = await runDoctor({
      env,
      cwd: tmp,
      dbPath,
      enterprisePath: null,
      userPath: null,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(1); // fail exits non-zero
    const text = out.lines.join('');
    expect(text).toContain('hash_chain');
    expect(text).toContain('BROKEN at seq 2');
    expect(text).toContain('agent permission verify');
    expect(text).toContain('agent permission rotate-chain');
  });

  test('install_id discovery failure → fail with remediation', async () => {
    // No HOME / XDG / APPDATA → ensureInstallId throws.
    const noHomeEnv = { PATH: process.env.PATH };
    const out = captured();
    const code = await runDoctor({
      env: noHomeEnv,
      cwd: tmp,
      dbPath,
      enterprisePath: null,
      userPath: null,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(1);
    const text = out.lines.join('');
    expect(text).toContain('hash_chain');
    expect(text).toContain('install_id discovery failed');
  });

  test('--json: hash_chain check is included with structured fields', async () => {
    seedChain(7);
    const out = captured();
    await runDoctor({
      json: true,
      env,
      cwd: tmp,
      dbPath,
      enterprisePath: null,
      userPath: null,
      which: (cmd) => `/usr/bin/${cmd}`,
      out: out.write,
      err: captured().write,
    });
    const lines = out.lines.join('').trim().split('\n').filter(Boolean);
    const events = lines.map((l) => JSON.parse(l));
    const chain = events.find((e) => e.name === 'hash_chain');
    expect(chain).toBeDefined();
    expect(chain.status).toBe('ok');
    expect(chain.detail).toBe('intact (7 rows)');
  });
});
