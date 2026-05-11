import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args.ts';
import { runDoctor } from '../../src/cli/doctor.ts';
import type { SealEntry, SealStore } from '../../src/permissions/index.ts';

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
    // 6 checks + 1 summary (sealing check added in slice 60).
    expect(lines.length).toBe(7);
    const events = lines.map((l) => JSON.parse(l));
    expect(events[0].kind).toBe('check');
    expect(events[0].name).toBe('platform');
    const summary = events[events.length - 1];
    expect(summary.kind).toBe('summary');
    expect(summary.ok).toBe(true);
    expect(summary.counts).toEqual({ ok: 6, warn: 0, fail: 0 });
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
