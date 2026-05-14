import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  test('`recap` subcommand does NOT require a prompt (--json + headless)', async () => {
    // Regression: the entry's `promptOptional` list omitted
    // `args.recap`, so `agent recap session <id> --json` was
    // rejected with "--json requires a prompt (REPL mode is TTY
    // only)" before reaching `runRecapHeadless`. Same shape as
    // the --list-sessions / --undo regressions above. End-to-end
    // through the real binary so the entry-level gate is exercised.
    // The session id is unknown, so the handler errors with a
    // recap-side diagnostic — what matters is that the prompt
    // gate doesn't fire first.
    const { exitCode, stderr } = await runCliWithRun([
      'recap',
      'session',
      'no-such-session',
      '--json',
      '--no-llm-render',
    ]);
    expect(stderr).not.toContain('requires a prompt');
    expect(stderr).not.toContain('TTY');
    // Headless errors come through stderr with the `/recap:`
    // prefix from runRecapHeadless. Exit 1 from the unknown id.
    expect(stderr).toContain('/recap:');
    expect(exitCode).toBe(1);
  });

  test('`recap` subcommand does NOT require a prompt (no --json, no TTY)', async () => {
    // Same shape without --json — pre-fix this fell into the TTY
    // gate ("interactive mode requires a TTY") because the empty
    // prompt routed to the REPL branch. The recap headless path
    // is non-interactive by design and should reach its handler
    // regardless of TTY state.
    const { stderr } = await runCliWithRun([
      'recap',
      'session',
      'no-such-session',
      '--no-llm-render',
    ]);
    expect(stderr).not.toContain('TTY');
    expect(stderr).toContain('/recap:');
  });

  // Slice 138 regression net for `agent permission <verb>`. The
  // entry's `promptOptional` list MUST include `args.permission`
  // — every permission verb is DB-only with no prompt. Pre-slice
  // 138 the gate fired BEFORE the dispatcher in run.ts could
  // route the verb, so e.g. `agent permission verify --json`
  // produced "--json requires a prompt" instead of the chain
  // integrity report.
  //
  // All other permission-verb unit tests call their runners
  // directly (runPermissionVerify / etc.), bypassing index.ts —
  // a regression that drops `args.permission !== undefined` from
  // the promptOptional list would slip through every existing
  // assertion. This end-to-end test, spawned through the actual
  // binary, is the canary for that gap.
  test('`permission verify --json` does NOT require a prompt (slice 138 regression net)', async () => {
    const { stderr } = await runCliWithRun(['permission', 'verify', '--json']);
    expect(stderr).not.toContain('requires a prompt');
    expect(stderr).not.toContain('TTY');
  });

  test('`permission calibration-export` does NOT require a prompt (slice 138)', async () => {
    const { exitCode, stderr } = await runCliWithRun(['permission', 'calibration-export']);
    expect(stderr).not.toContain('requires a prompt');
    expect(stderr).not.toContain('TTY');
    // The verb runs to completion on an empty DB (clean exit 0).
    expect(exitCode).toBe(0);
  });

  test('`recap` warns and falls back to stub when provider bootstrap fails', async () => {
    // Regression: pre-fix the dispatcher hardcoded a stub provider
    // (`constrained: false`), so `agent recap pr` could never
    // exercise the LLM render path even with API keys configured.
    // Post-fix: try `bootstrap()` for the real provider; on failure
    // (e.g., missing ANTHROPIC_API_KEY) emit a one-line warn AND
    // continue with the stub so deterministic surfaces still work.
    //
    // Bun auto-loads `.env` from the cwd of the bun process, so
    // running with `cwd: repoRoot` would surface the developer's
    // `.env`-supplied API key and bootstrap would succeed silently.
    // Spawn from a tmpdir (no `.env`) AND clear the env var to make
    // the failure path deterministic.
    const dataDir = mkdtempSync(join(tmpdir(), 'forja-cli-'));
    const spawnCwd = mkdtempSync(join(tmpdir(), 'forja-no-env-'));
    try {
      const env = { ...process.env, XDG_DATA_HOME: dataDir };
      delete (env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY;
      const proc = Bun.spawn(
        ['bun', entry, 'recap', 'session', 'no-such-session', '--no-llm-render'],
        { cwd: spawnCwd, stdout: 'pipe', stderr: 'pipe', env },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);
      // The warn precedes the recap-side error; both land on stderr.
      expect(stderr).toContain('forja recap: provider bootstrap failed');
      expect(stderr).toContain('LLM render disabled');
      // Subsequent dispatch into runRecapHeadless still happens —
      // the unknown session id surfaces the recap-side error.
      expect(stderr).toContain('/recap:');
      expect(exitCode).toBe(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(spawnCwd, { recursive: true, force: true });
    }
  });

  test('`recap` hard-fails on unknown --model (no silent fallback)', async () => {
    // Regression: pre-fix the catch block treated all bootstrap
    // failures as "LLM unavailable" and fell back to the stub,
    // exit 0. A typo in `--model <bad-id>` would silently render
    // deterministically while CI logs claimed success — masking
    // the configuration mistake. Spec: invalid model selection
    // is a config error and must exit non-zero.
    const dataDir = mkdtempSync(join(tmpdir(), 'forja-cli-'));
    const spawnCwd = mkdtempSync(join(tmpdir(), 'forja-no-env-'));
    try {
      // Even with the API key present (loaded from .env or env),
      // an unknown model id throws "unknown model: ..." inside
      // the registry lookup BEFORE the factory runs, so the auth
      // path is irrelevant. Pass through the dev's env so the
      // failure is unambiguously about the model id.
      const env = { ...process.env, XDG_DATA_HOME: dataDir };
      const proc = Bun.spawn(
        ['bun', entry, 'recap', 'session', 'no-such-session', '--model', 'anthropic/sonnett-typo'],
        { cwd: spawnCwd, stdout: 'pipe', stderr: 'pipe', env },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);
      // Hard-fail diagnostic; NOT the "LLM render disabled" warn.
      expect(stderr).toContain('forja recap: unknown model');
      expect(stderr).toContain('anthropic/sonnett-typo');
      expect(stderr).not.toContain('LLM render disabled');
      expect(exitCode).toBe(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(spawnCwd, { recursive: true, force: true });
    }
  });

  test('`recap` hard-fails on a malformed .agent/permissions.yaml (config error, not auth)', async () => {
    // Regression: pre-fix the catch block was a catch-all — every
    // bootstrap failure that wasn't "unknown model" degraded to
    // the stub, including malformed policy YAML, broken hook
    // config, and other repo setup mistakes. Operator's CI saw
    // `exit 0` and "LLM render disabled" hiding a real config
    // bug. Post-fix: ONLY the API-key-required path falls back;
    // every other bootstrap exception is a hard fail.
    const dataDir = mkdtempSync(join(tmpdir(), 'forja-cli-'));
    const spawnCwd = mkdtempSync(join(tmpdir(), 'forja-bad-policy-'));
    try {
      // Seed a malformed permissions.yaml inside .agent/. Bootstrap
      // reads it during policy resolution and throws a YAML parse
      // error — that's exactly the "real config bug" shape the
      // fallback was wrongly hiding.
      mkdirSync(join(spawnCwd, '.agent'), { recursive: true });
      writeFileSync(join(spawnCwd, '.agent', 'permissions.yaml'), 'this: is: not: valid: yaml\n');
      // Inject a fake API key so bootstrap clears the provider
      // auth gate (which fires before YAML parsing) — without
      // this, environments without ANTHROPIC_API_KEY in process.env
      // (clean checkouts, CI without secrets) would hit the
      // auth-fallback path instead of the YAML hard-fail we're
      // pinning. The fake key never reaches the network: this
      // test never makes an LLM call.
      const env = {
        ...process.env,
        XDG_DATA_HOME: dataDir,
        ANTHROPIC_API_KEY: 'sk-ant-fake-test-key',
      };
      const proc = Bun.spawn(
        ['bun', entry, 'recap', 'session', 'no-such-session', '--no-llm-render'],
        { cwd: spawnCwd, stdout: 'pipe', stderr: 'pipe', env },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);
      // Hard-fail; NOT the LLM-render-disabled warn.
      expect(stderr).toContain('forja recap:');
      expect(stderr).not.toContain('LLM render disabled');
      // The YAML parser's diagnostic surfaces in the message;
      // assert non-zero exit + no silent fallback rather than
      // pinning a specific YAML error string (parser-version
      // dependent).
      expect(exitCode).toBe(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(spawnCwd, { recursive: true, force: true });
    }
  });
});

// Slice 135 P0-14: pin the first-boot nudge (slice 46 §13.5).
// The line "forja: first run detected — try `agent welcome`..."
// fires when install_id doesn't exist, EXCEPT on setup verbs
// (welcome/doctor/sandbox). The once-only contract is the whole
// UX promise — a regression that flips the condition silently
// spams every invocation OR drops the nudge entirely. Without
// this test the CI passes either way.
describe('first-boot nudge (slice 46 §13.5)', () => {
  // Isolated install dir via XDG_CONFIG_HOME so the test never
  // touches the developer's ~/.config/agent/install_id.
  const runWithIsolatedConfig = async (
    args: string[],
    options: { preinstalledIdentity?: boolean } = {},
  ): Promise<CliResult> => {
    const configDir = mkdtempSync(join(tmpdir(), 'forja-firstboot-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'forja-firstboot-data-'));
    try {
      if (options.preinstalledIdentity === true) {
        // Pre-plant install_id so isFirstBoot returns false.
        mkdirSync(join(configDir, 'agent'), { recursive: true, mode: 0o700 });
        writeFileSync(
          join(configDir, 'agent', 'install_id'),
          JSON.stringify({ install_id: 'pre-existing', created_at_ms: 1 }),
          { mode: 0o600 },
        );
      }
      const proc = Bun.spawn(['bun', entry, ...args], {
        cwd: repoRoot,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          XDG_CONFIG_HOME: configDir,
          XDG_DATA_HOME: dataDir,
          // Strip $HOME-rooted discovery to force XDG_CONFIG_HOME path
          // (installIdPath prefers XDG when set).
        },
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);
      return { exitCode, stdout, stderr };
    } finally {
      rmSync(configDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  };

  test('missing identity + normal verb (--list-sessions) → nudge on stderr', async () => {
    const r = await runWithIsolatedConfig(['--list-sessions']);
    expect(r.stderr).toContain('first run detected');
    expect(r.stderr).toContain('agent welcome');
  });

  test('present identity → no nudge', async () => {
    const r = await runWithIsolatedConfig(['--list-sessions'], {
      preinstalledIdentity: true,
    });
    expect(r.stderr).not.toContain('first run detected');
  });
});
