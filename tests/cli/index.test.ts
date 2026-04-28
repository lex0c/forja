import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

// Spawn the CLI entrypoint as a subprocess with a preload that throws
// the moment src/cli/run.ts is loaded. If `--help` or `--version`
// transitively pull run.ts (and therefore the provider SDKs), the
// preload's onLoad hook fires and the subprocess exits non-zero —
// catching any future regression that re-introduces a top-level
// `import './run.ts'` in src/cli/index.ts.
const repoRoot = resolve(import.meta.dir, '../..');
const entry = resolve(repoRoot, 'src/cli/index.ts');
const preload = resolve(repoRoot, 'tests/cli/fixtures/block-run-load.ts');

const runCli = async (
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(['bun', '--preload', preload, entry, ...args], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

describe('cli entrypoint lazy-loads run module', () => {
  test('--help exits 0 without loading cli/run.ts', async () => {
    const { exitCode, stdout, stderr } = await runCli(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('--help');
    expect(stderr).toBe('');
  });

  test('-h exits 0 without loading cli/run.ts', async () => {
    const { exitCode, stdout } = await runCli(['-h']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('--help');
  });

  test('--version exits 0 without loading cli/run.ts', async () => {
    const { exitCode, stdout, stderr } = await runCli(['--version']);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('0.0.0');
    expect(stderr).toBe('');
  });

  test('--version --json exits 0 without loading cli/run.ts', async () => {
    const { exitCode, stdout } = await runCli(['--version', '--json']);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({ version: '0.0.0' });
  });

  test('preload sanity: invoking with a real prompt DOES load run.ts (and the loader hook fires)', async () => {
    // Confirms the preload is actually wired up — without this, all the
    // assertions above could pass simply because the hook never ran. A
    // prompt forces the lazy import path; the hook throws; subprocess
    // exits non-zero with the diagnostic message on stderr.
    const { exitCode, stderr } = await runCli(['hello']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('cli/run.ts was loaded');
  });
});
