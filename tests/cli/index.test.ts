import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Spawn the CLI entrypoint as a subprocess with a preload that throws
// the moment src/cli/run.ts is loaded. If `--help` or `--version`
// transitively pull run.ts (and therefore the provider SDKs), the
// preload's onLoad hook fires and the subprocess exits non-zero —
// catching any future regression that re-introduces a top-level
// `import './run.ts'` in src/cli/index.ts.
const repoRoot = resolve(import.meta.dir, '../..');
const entry = resolve(repoRoot, 'src/cli/index.ts');
const preload = resolve(repoRoot, 'tests/cli/fixtures/block-run-load.ts');
const blockReplPreload = resolve(repoRoot, 'tests/cli/fixtures/block-repl-load.ts');

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const runCli = async (args: string[]): Promise<CliResult> => {
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

// Variant that spawns the CLI without the lazy-load preload so
// run.ts is allowed to load. Used for flags like --list-sessions
// that legitimately reach into the run path. Sets XDG_DATA_HOME
// to an isolated tmpdir so the test doesn't read or write the
// developer's actual ~/.local/share/forja state.
const runCliWithRun = async (args: string[]): Promise<CliResult & { dataDir: string }> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'forja-cli-'));
  try {
    const proc = Bun.spawn(['bun', entry, ...args], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, XDG_DATA_HOME: dataDir },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr, dataDir };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
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

describe('cli entrypoint: prompt requirement', () => {
  test('--list-sessions does NOT require a prompt', async () => {
    // Regression: index.ts had an unconditional empty-prompt check
    // that fired before --list-sessions could short-circuit inside
    // run(). The unit test in resume.test.ts didn't catch this
    // because it called run() directly, bypassing the entry. Now
    // verified end-to-end through the real binary path.
    const { exitCode, stderr } = await runCliWithRun(['--list-sessions', '--json']);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('missing prompt');
  });

  test('bare invocation without a TTY refuses to open the REPL', async () => {
    // Empty prompt opens the interactive REPL (option (i) — see
    // step 1.d.4 in BACKLOG); without a TTY (test runner has piped
    // stdin) the REPL refuses. The old "missing prompt" gate was
    // relaxed at the entry; failure now surfaces from the REPL's
    // TTY check.
    const { exitCode, stderr } = await runCli([]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('TTY');
  });

  test('bare invocation without a TTY does NOT load cli/repl.ts (regression)', async () => {
    // Pre-fix the entry imported ./repl.ts BEFORE any TTY check, so a
    // broken provider/storage transitive dep would surface as
    // "unexpected error" via the outer catch instead of the clean
    // "interactive mode requires a TTY" diagnostic. The CI / piped-
    // stdin install-troubleshooting path requires that bare
    // invocation fail fast without touching the runtime stack.
    //
    // Spawn with a preload that throws if cli/repl.ts loads. Pre-fix
    // the throw fires (exit code != 1, stderr contains the loader
    // hook's message); post-fix the entry-level TTY check returns 1
    // with the clean message and the import never runs.
    const proc = Bun.spawn(['bun', '--preload', blockReplPreload, entry], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('TTY');
    expect(stderr).not.toContain('cli/repl.ts was loaded');
  });

  test('--undo does NOT require a prompt', async () => {
    // Same regression shape as --list-sessions: the entry-level
    // empty-prompt guard was firing before --undo could dispatch
    // inside run(). Caught by the criterion-6 smoke (real model)
    // before this fix landed.
    const { exitCode, stderr } = await runCliWithRun(['--undo', 'no-such-session']);
    // Exit 1 is expected (the session id doesn't exist) but the
    // failure must come from the handler reporting "session not
    // found", NOT from the entry's prompt gate.
    expect(stderr).not.toContain('missing prompt');
    expect(stderr).toContain('not found');
    expect(exitCode).toBe(1);
  });

  test('--checkpoints does NOT require a prompt', async () => {
    const { stderr } = await runCliWithRun(['--checkpoints', 'list', 'no-such-session']);
    expect(stderr).not.toContain('missing prompt');
    // 'not found' lands when the session id is unknown — the
    // dispatch reached the handler.
    expect(stderr).toContain('not found');
  });
});
