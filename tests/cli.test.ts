import { describe, expect, test } from 'bun:test';

const ENTRY = 'src/cli/index.ts';

const run = (...args: string[]) => {
  const result = Bun.spawnSync({
    cmd: ['bun', 'run', ENTRY, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
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

  test('no args exits 1 with stderr pointer to spec', () => {
    const { code, stderr } = run();
    expect(code).toBe(1);
    expect(stderr).toContain('not implemented');
    expect(stderr).toContain('AGENTIC_CLI.md');
  });
});
