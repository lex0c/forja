import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args.ts';
import { runDoctor } from '../../src/cli/doctor.ts';

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
    // 5 checks + 1 summary
    expect(lines.length).toBe(6);
    const events = lines.map((l) => JSON.parse(l));
    expect(events[0].kind).toBe('check');
    expect(events[0].name).toBe('platform');
    const summary = events[events.length - 1];
    expect(summary.kind).toBe('summary');
    expect(summary.ok).toBe(true);
    expect(summary.counts).toEqual({ ok: 5, warn: 0, fail: 0 });
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
