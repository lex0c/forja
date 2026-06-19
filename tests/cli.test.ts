import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedModelCatalog } from './helpers/seed-catalog.ts';

const ENTRY = 'src/cli/index.ts';

// The model catalog is mandatory at boot — give the spawned CLI an
// isolated XDG_CONFIG_HOME seeded with the catalog so boot-reaching tests
// (unknown model, ...) don't read the dev's real ~/.config or fail on a
// clean CI that has none.
const cliConfigDir = mkdtempSync(join(tmpdir(), 'forja-cli-cfg-'));
seedModelCatalog({ ...process.env, XDG_CONFIG_HOME: cliConfigDir });
afterAll(() => rmSync(cliConfigDir, { recursive: true, force: true }));

const run = (...args: string[]) => {
  const result = Bun.spawnSync({
    cmd: ['bun', 'run', ENTRY, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, XDG_CONFIG_HOME: cliConfigDir },
  });
  return {
    code: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
};

describe('cli entry', () => {
  test('--version prints version and exits 0', () => {
    const { code, stdout } = run('--version');
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('0.0.0');
  });

  test('-v alias matches --version', () => {
    const { code, stdout } = run('-v');
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('0.0.0');
  });

  test('--version --json emits parseable JSON', () => {
    const { code, stdout } = run('--version', '--json');
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ version: '0.0.0' });
  });

  test('no args without a TTY exits 1 (REPL refuses non-interactive stdin)', () => {
    // Bare `forja` with stdin piped (the test runner case) opens
    // the REPL — which refuses without a TTY. The "missing prompt"
    // gate was relaxed when REPL mode landed; the new failure
    // surface is the REPL's TTY check.
    const { code, stderr } = run();
    expect(code).toBe(1);
    expect(stderr).toContain('TTY');
  });

  test('--help exits 0 and prints usage to stdout', () => {
    const { code, stdout } = run('--help');
    expect(code).toBe(0);
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('--json');
  });

  test('unknown flag exits 1 with diagnostic', () => {
    const { code, stderr } = run('--bogus');
    expect(code).toBe(1);
    expect(stderr).toContain('unknown flag');
  });

  test('unknown model exits 1 with diagnostic from bootstrap', () => {
    const { code, stderr } = run('--model', 'fake/model', 'hello');
    expect(code).toBe(1);
    expect(stderr).toContain('unknown model');
  });
});
