import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BgManager, createBgManager } from '../../src/bg/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { getBgProcess } from '../../src/storage/repos/bg-processes.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { waitFor } from '../../src/wait/index.ts';

let db: DB;
let sessionId: string;
let mgr: BgManager;
const tempRoots: string[] = [];

const setupTempLogDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-wait-proc-'));
  tempRoots.push(dir);
  return dir;
};

const waitForExit = async (id: string, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = getBgProcess(db, id);
    if (row && row.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`process ${id} did not exit within ${timeoutMs}ms`);
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  mgr = createBgManager({ db, sessionId, logDir: setupTempLogDir() });
});

afterEach(async () => {
  await mgr.cleanup();
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  tempRoots.length = 0;
});

describe('wait_for: process_exit', () => {
  test('matches when the process exits naturally', async () => {
    // Spawn a 200ms sleep; wait fires shortly after exit.
    const r = await mgr.spawn({ command: 'sleep 0.2; exit 0' });
    const result = await waitFor(
      { kind: 'process_exit', processId: r.id },
      { timeoutMs: 5000, pollIntervalMs: 50, bgManager: mgr },
    );
    expect(result.matched).toBe(true);
    expect(result.conditionMet).toBe('process_exit');
    expect(result.payload?.processId).toBe(r.id);
    expect(result.payload?.status).toBe('exited');
    expect(result.payload?.exitCode).toBe(0);
  });

  test('captures non-zero exit code', async () => {
    const r = await mgr.spawn({ command: 'exit 7' });
    const result = await waitFor(
      { kind: 'process_exit', processId: r.id },
      { timeoutMs: 5000, pollIntervalMs: 50, bgManager: mgr },
    );
    expect(result.matched).toBe(true);
    expect(result.payload?.exitCode).toBe(7);
  });

  test('matches immediately if the process has already exited', async () => {
    const r = await mgr.spawn({ command: 'true' });
    await waitForExit(r.id);
    const start = Date.now();
    const result = await waitFor(
      { kind: 'process_exit', processId: r.id },
      { timeoutMs: 5000, pollIntervalMs: 200, bgManager: mgr },
    );
    expect(result.matched).toBe(true);
    expect(Date.now() - start).toBeLessThan(200);
  });

  test('reports timeout if the process keeps running', async () => {
    const r = await mgr.spawn({ command: 'sleep 30' });
    const result = await waitFor(
      { kind: 'process_exit', processId: r.id },
      { timeoutMs: 200, pollIntervalMs: 50, bgManager: mgr },
    );
    expect(result.matched).toBe(false);
    expect(result.conditionMet).toBe('timeout');
  });

  test('throws on unknown process_id', async () => {
    expect(
      waitFor(
        { kind: 'process_exit', processId: 'nope' },
        { timeoutMs: 1000, pollIntervalMs: 50, bgManager: mgr },
      ),
    ).rejects.toThrow(/not found/);
  });

  test('throws when bgManager is missing', async () => {
    expect(
      waitFor({ kind: 'process_exit', processId: 'x' }, { timeoutMs: 1000, pollIntervalMs: 50 }),
    ).rejects.toThrow(/bgManager/);
  });
});

describe('wait_for: process_output', () => {
  test('matches a literal pattern in stdout', async () => {
    // Process emits READY after a delay so the wait actually polls.
    const r = await mgr.spawn({ command: 'sleep 0.15; echo READY-MARKER' });
    const result = await waitFor(
      { kind: 'process_output', processId: r.id, pattern: /READY-MARKER/ },
      { timeoutMs: 5000, pollIntervalMs: 50, bgManager: mgr },
    );
    expect(result.matched).toBe(true);
    expect(result.conditionMet).toBe('process_output');
    expect(result.payload?.stream).toBe('stdout');
    expect(result.payload?.match).toBe('READY-MARKER');
  });

  test('matches a regex pattern in stderr', async () => {
    const r = await mgr.spawn({
      command: 'sleep 0.1; echo "WARN: deprecated foo" 1>&2',
    });
    const result = await waitFor(
      { kind: 'process_output', processId: r.id, pattern: /WARN:\s+\w+/ },
      { timeoutMs: 5000, pollIntervalMs: 50, bgManager: mgr },
    );
    expect(result.matched).toBe(true);
    expect(result.payload?.stream).toBe('stderr');
    expect(result.payload?.match).toMatch(/^WARN:\s+\w+$/);
  });

  test('does NOT consume bytes — model cursor stays at 0', async () => {
    // Crucial contract: wait_for(process_output) is observational.
    // After the wait, the model's persisted cursor must be unchanged
    // so a subsequent canonical bash_output sees the same content
    // (including the matched window).
    const r = await mgr.spawn({ command: 'echo OBSERVE-ME; sleep 0.05' });
    await waitFor(
      { kind: 'process_output', processId: r.id, pattern: /OBSERVE-ME/ },
      { timeoutMs: 5000, pollIntervalMs: 50, bgManager: mgr },
    );
    const row = getBgProcess(db, r.id);
    expect(row?.stdoutCursorPosition).toBe(0);
    expect(row?.stderrCursorPosition).toBe(0);
    // And a canonical bash_output read STILL sees the marker.
    const out = await mgr.readOutput(r.id);
    expect(out.stdout).toContain('OBSERVE-ME');
  });

  test('reports timeout when pattern never appears', async () => {
    const r = await mgr.spawn({ command: 'sleep 30; echo NEVER' });
    const result = await waitFor(
      { kind: 'process_output', processId: r.id, pattern: /NEVER/ },
      { timeoutMs: 200, pollIntervalMs: 50, bgManager: mgr },
    );
    expect(result.matched).toBe(false);
    expect(result.conditionMet).toBe('timeout');
  });

  test('reports processExited in payload when process exits without matching', async () => {
    // Process exits cleanly; pattern was never written.
    // Regression: previously this returned conditionMet='aborted'
    // because finishUnmatched maps to aborted/timeout based on
    // whether the outer timeout fired. With timeoutMs=5000 and a
    // process that exits in ~100ms, timeout.timeoutFired() is
    // false → 'aborted' was reported despite no abort having
    // occurred. The explicit 'process_exited' terminal preserves
    // the contract that 'aborted' means "a signal aborted the
    // wait", not "the process happened to finish".
    const r = await mgr.spawn({ command: 'echo something-else; sleep 0.1' });
    const result = await waitFor(
      { kind: 'process_output', processId: r.id, pattern: /BG_NEVER_HAPPENS/ },
      { timeoutMs: 5000, pollIntervalMs: 50, bgManager: mgr },
    );
    expect(result.matched).toBe(false);
    expect(result.conditionMet).toBe('process_exited');
    expect(result.payload?.processExited).toBe(true);
    expect(result.payload?.status).toBe('exited');
    expect(result.payload?.exitCode).toBe(0);
  });

  test('drains pending bytes after process exit (pattern past 64KB)', async () => {
    // Regression: a single readOutput call returns at most maxBytes
    // (default 64KB). If the process emits >64KB and exits, the
    // first read scans only the first chunk. Without the post-exit
    // drain loop, a pattern in the tail would be missed and
    // processExited reported despite the marker being in the log.
    //
    // We emit ~70KB of filler then EXIT-MARKER then exit. Without
    // the drain fix, processExited fires on the first poll with
    // pending=~6KB and the marker is lost.
    const r = await mgr.spawn({
      command: `printf 'x%.0s' {1..70000}; echo EXIT-MARKER-DRAIN`,
    });
    const result = await waitFor(
      { kind: 'process_output', processId: r.id, pattern: /EXIT-MARKER-DRAIN/ },
      { timeoutMs: 5000, pollIntervalMs: 50, bgManager: mgr },
    );
    expect(result.matched).toBe(true);
    expect(result.payload?.match).toBe('EXIT-MARKER-DRAIN');
  });

  test('catches a pattern that straddles a poll boundary (overlap)', async () => {
    // The pattern lives across two writes ~80ms apart — with poll
    // 50ms, the chunks land in different polls. Overlap of 64 bytes
    // ensures the fragment from the first poll is re-read alongside
    // the second poll, so the full pattern matches.
    //
    // bash printf without trailing newline keeps the writes adjacent
    // in the log. The marker BLT-TOKEN-37 spans the gap.
    const r = await mgr.spawn({
      command: `printf 'BLT-'; sleep 0.1; printf 'TOKEN-37'`,
    });
    const result = await waitFor(
      { kind: 'process_output', processId: r.id, pattern: /BLT-TOKEN-37/ },
      { timeoutMs: 5000, pollIntervalMs: 50, bgManager: mgr },
    );
    expect(result.matched).toBe(true);
    expect(result.payload?.match).toBe('BLT-TOKEN-37');
  });

  test('throws on unknown process_id', async () => {
    expect(
      waitFor(
        { kind: 'process_output', processId: 'nope', pattern: /x/ },
        { timeoutMs: 1000, pollIntervalMs: 50, bgManager: mgr },
      ),
    ).rejects.toThrow(/not found/);
  });

  test('throws when bgManager is missing', async () => {
    expect(
      waitFor(
        { kind: 'process_output', processId: 'x', pattern: /y/ },
        { timeoutMs: 1000, pollIntervalMs: 50 },
      ),
    ).rejects.toThrow(/bgManager/);
  });
});
