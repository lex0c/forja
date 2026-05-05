import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/storage/db.ts';
import {
  appendMessage,
  createSession,
  insertSubagentRun,
  migrate,
} from '../../src/storage/index.ts';
import { type IpcMessage, parseLine } from '../../src/subagents/ipc.ts';

// Real-subprocess smoke test for the IPC wire (review tier-1).
//
// Every other test in tests/subagents/ runs in-process via the
// `fakeTransportPair` seam. That covers the channel + parser +
// transport-framer logic exhaustively, but does NOT exercise:
//
//   - Bun.spawn pipe semantics (real OS pipes, not in-memory queues)
//   - processTransport reading from process.stdin / writing to
//     process.stdout via the Node-compat shims
//   - The full child bootstrap path under `--ipc=<n>` (arg parser,
//     dispatch in cli/index.ts, error envelope on missing model,
//     SIGTERM handling, exit code surfacing)
//
// The smoke seeds the SQLite tables the child reads (parent
// session + child session + subagent_runs row + first user
// message) but DELIBERATELY uses a model id the registry won't
// know — so the child's bootstrap exits early with an
// `unknown_model` envelope. We don't care about the harness's
// success path here (in-process tests cover that); we care that:
//
//   1. The real binary boots under `--ipc=1`.
//   2. The first message on stdout is `session_start` with
//      `protocolVersion === 1`.
//   3. The last message on stdout is `session_finished` (bracket
//      close fires from the outer finally even on early refusal).
//   4. The process exits with a non-zero code (failure) but
//      WITHOUT corrupting the wire (no half-line truncation, no
//      stderr pollution into stdout).

const repoRoot = (() => {
  // The test file lives at <repo>/tests/subagents/. Walk up two.
  const here = import.meta.dir;
  return join(here, '..', '..');
})();

const cliEntry = join(repoRoot, 'src', 'cli', 'index.ts');

// The production binary resolves its DB path via XDG_DATA_HOME
// (storage/paths.ts: `<XDG_DATA_HOME>/forja/sessions.db`). For
// the smoke we hijack that env var so the child opens a DB
// inside a per-test temp dir rather than the operator's real
// data dir. Seeding writes to the same resolved path.
let xdgDir: string;
let dbPath: string;

beforeEach(() => {
  xdgDir = mkdtempSync(join(tmpdir(), 'forja-subprocess-smoke-'));
  // Mirror the production layout that defaultDbPath builds.
  const forjaDir = join(xdgDir, 'forja');
  mkdirSync(forjaDir, { recursive: true });
  dbPath = join(forjaDir, 'sessions.db');
});

afterEach(() => {
  try {
    rmSync(xdgDir, { recursive: true, force: true });
  } catch {}
});

const seedChildSession = (): { sessionId: string } => {
  const db = openDb(dbPath);
  try {
    migrate(db);
    // Use a model id that's not in the production registry so
    // the child's provider resolution refuses and publishes an
    // `unknown_model` envelope. We don't need the harness to
    // run successfully; we need the IPC wire to bracket
    // correctly even on early refusal.
    const parent = createSession(db, { model: 'mock/missing', cwd: '/p' });
    const child = createSession(db, {
      model: 'mock/missing',
      cwd: '/p',
      parentSessionId: parent.id,
    });
    insertSubagentRun(db, {
      sessionId: child.id,
      name: 'explore',
      scope: 'project',
      sourcePath: '/fake/explore.md',
      sourceSha256: 'a'.repeat(64),
      systemPrompt: 'You are explore.',
      toolsWhitelist: [],
      budgetMaxSteps: 5,
      budgetMaxCostUsd: 0.1,
    });
    appendMessage(db, {
      sessionId: child.id,
      role: 'user',
      content: 'find the README',
    });
    return { sessionId: child.id };
  } finally {
    db.close();
  }
};

const childEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  // Whitelist the env vars the binary actually needs. Forwarding
  // the entire process.env can leak the test runner's
  // XDG_DATA_HOME ahead of our override and (worse) the
  // operator's API keys into the spawned child — no real
  // provider call should happen here, but defense in depth.
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  env.XDG_DATA_HOME = xdgDir;
  return env;
};

// Spawn the real binary and collect every line the child writes
// to stdout, parsed as IpcMessage. Returns once the process has
// exited.
const runRealSubprocess = async (
  sessionId: string,
  extraArgs: readonly string[] = ['--ipc=1'],
): Promise<{
  exitCode: number;
  messages: IpcMessage[];
  malformed: string[];
  stderr: string;
  rawStdout: string;
}> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, '--subagent-session-id', sessionId, ...extraArgs],
    cwd: '/tmp',
    env: childEnv(),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdoutBuf = await new Response(proc.stdout).text();
  const stderrBuf =
    proc.stderr !== null && proc.stderr !== undefined ? await new Response(proc.stderr).text() : '';
  await proc.exited;

  const messages: IpcMessage[] = [];
  const malformed: string[] = [];
  for (const line of stdoutBuf.split('\n')) {
    if (line.length === 0) continue;
    const r = parseLine(line);
    if (r.ok) messages.push(r.msg);
    else malformed.push(`${r.reason}: ${line}`);
  }
  return {
    exitCode: proc.exitCode ?? -1,
    messages,
    malformed,
    stderr: stderrBuf,
    rawStdout: stdoutBuf,
  };
};

describe('subprocess smoke — real Bun.spawn + processTransport (production wire)', () => {
  test('child boots under --ipc=1 and brackets the run with session_start / session_finished', async () => {
    const { sessionId } = seedChildSession();
    const result = await runRealSubprocess(sessionId, ['--ipc=1']);

    // Sanity: stdout was 100% NDJSON (no stderr leaking into
    // stdout, no half-line truncation past the last newline).
    if (result.malformed.length > 0) {
      throw new Error(
        `subprocess emitted malformed lines on stdout (NDJSON contract violated): ${result.malformed.join('\n')}`,
      );
    }
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    const first = result.messages[0];
    const last = result.messages[result.messages.length - 1];
    expect(first?.type).toBe('session_start');
    expect(last?.type).toBe('session_finished');
    if (first?.type === 'session_start') {
      expect(first.protocolVersion).toBe(1);
      expect(first.sessionId).toBe(sessionId);
    }
  }, 15_000);

  test('child without --ipc stays in legacy mode (stdout pure, no IPC frames)', async () => {
    const { sessionId } = seedChildSession();
    const result = await runRealSubprocess(sessionId, []);
    // Legacy mode: the child should NOT have written any IPC
    // frames — production legacy callers don't read stdout, but
    // if anything parsed as a frame here it'd mean the child
    // accidentally opened the channel even without the flag,
    // violating the backwards-compat invariant (IPC.md §5).
    expect(result.messages).toEqual([]);
    expect(result.malformed.length).toBeGreaterThanOrEqual(0); // any text is fine; just no IPC frames
  }, 15_000);

  test('--ipc with a future protocol version exits non-zero before any IPC frame', async () => {
    // Spec §4.2: child refuses on version mismatch BEFORE
    // emitting any message. With `--ipc=999` the child should
    // exit 1 immediately and stdout should carry NO IPC frames
    // (no session_start, since the refusal lands before the
    // channel is fully wired).
    const { sessionId } = seedChildSession();
    const result = await runRealSubprocess(sessionId, ['--ipc=999']);
    // Exit code 64 (EX_USAGE) is the dedicated sentinel: parent's
    // wait loop maps `crashed { exitCode: 64 }` to the
    // `ipc_version_mismatch` reason (no payload was published, so
    // the exit code is the only signal channel).
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain('ipc_version_mismatch');
    expect(result.rawStdout).toBe('');
  }, 15_000);
});
