import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args.ts';
import { runWelcome } from '../../src/cli/welcome.ts';

const captured = () => {
  const lines: string[] = [];
  return { write: (s: string) => lines.push(s), lines };
};

const ALWAYS_WHICH = (cmd: string): string | null => `/usr/bin/${cmd}`;
const NEVER_WHICH = (_cmd: string): string | null => null;

describe('parseArgs — agent welcome', () => {
  test('verb is recognized', () => {
    const r = parseArgs(['welcome']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.welcome).toBe(true);
    }
  });

  test('--help short-circuits to help mode', () => {
    const r = parseArgs(['welcome', '--help']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.help).toBe(true);
      expect(r.args.welcome).toBeUndefined();
    }
  });

  test('unknown flag rejected', () => {
    const r = parseArgs(['welcome', '--json']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('--json');
  });

  test('positional after welcome rejected as unknown flag', () => {
    const r = parseArgs(['welcome', 'extra']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('extra');
  });
});

describe('runWelcome', () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-welcome-'));
    env = { HOME: tmp, PATH: process.env.PATH };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('all green: prints intro + doctor + sandbox + next-steps + exit 0', async () => {
    const out = captured();
    const code = await runWelcome({
      env,
      platform: 'linux',
      arch: 'x64',
      which: ALWAYS_WHICH,
      readOsRelease: () => 'ID=ubuntu\nPRETTY_NAME="Ubuntu 22.04"\n',
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('Welcome to Forja!');
    expect(text).toContain('Environment health check');
    expect(text).toContain('Sandbox setup');
    expect(text).toContain('Next steps');
    expect(text).toContain('agent doctor');
    expect(text).toContain('agent init');
    expect(text).toContain('agent --help');
  });

  test('missing sandbox + git: surfaces both warnings, exit still 0', async () => {
    const out = captured();
    const code = await runWelcome({
      env,
      platform: 'linux',
      arch: 'x64',
      which: NEVER_WHICH, // bwrap + git both missing
      readOsRelease: () => 'ID=ubuntu\nPRETTY_NAME="Ubuntu 22.04 LTS"\n',
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0); // warnings don't fail welcome
    const text = out.lines.join('');
    // doctor warning lines
    expect(text).toContain('warn');
    // sandbox setup advice surfaces
    expect(text).toContain('sudo apt install bubblewrap');
  });

  test('non-writable HOME → doctor fail → welcome exit 1', async () => {
    // No HOME → config_dir + data_dir both fail. Welcome propagates
    // the worst exit code (Math.max of inner verb codes).
    const out = captured();
    const code = await runWelcome({
      env: { PATH: process.env.PATH }, // no HOME
      platform: 'linux',
      arch: 'x64',
      which: ALWAYS_WHICH,
      readOsRelease: () => 'ID=ubuntu\n',
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(1);
    const text = out.lines.join('');
    expect(text).toContain('fail');
  });

  test('sections are clearly delimited by dividers', async () => {
    const out = captured();
    await runWelcome({
      env,
      platform: 'linux',
      arch: 'x64',
      which: ALWAYS_WHICH,
      readOsRelease: () => 'ID=ubuntu\n',
      out: out.write,
      err: captured().write,
    });
    const text = out.lines.join('');
    // Box-drawing divider lines appear above each section header.
    const dividerCount = (text.match(/─{60}/g) ?? []).length;
    expect(dividerCount).toBeGreaterThanOrEqual(4); // 2 per section × 2 sections
  });

  test('macOS scenario: shows path-broken message instead of install command', async () => {
    const out = captured();
    await runWelcome({
      env,
      platform: 'darwin',
      arch: 'arm64',
      which: NEVER_WHICH,
      out: out.write,
      err: captured().write,
    });
    const text = out.lines.join('');
    expect(text).toContain('built into macOS');
    expect(text).toContain('$PATH');
    // Must NOT recommend apt/brew/etc.
    expect(text).not.toContain('sudo apt');
    expect(text).not.toContain('brew install');
  });
});
