import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BgManager, createBgManager } from '../../src/bg/index.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import type { DB } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { getBgProcess, listBgProcessesBySession } from '../../src/storage/repos/bg-processes.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;
let sessionId: string;
let logDir: string;
let mgr: BgManager;
const tempRoots: string[] = [];

const setupTempLogDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-bg-'));
  tempRoots.push(dir);
  return dir;
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  logDir = setupTempLogDir();
  mgr = createBgManager({ db, sessionId, logDir });
});

afterEach(() => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  tempRoots.length = 0;
});

// Small helper: poll until the DB row's status leaves 'running' or
// the timeout fires. Used by tests that wait for natural exit
// without coupling to the precise exit handler scheduling.
const waitForExit = async (id: string, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = getBgProcess(db, id);
    if (row && row.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`process ${id} did not exit within ${timeoutMs}ms`);
};

describe('bg manager: spawn', () => {
  test('spawns a short-lived command and records exited status', async () => {
    const r = await mgr.spawn({ command: 'echo hello-bg', label: 'echo-test' });
    expect(r.osPid).toBeGreaterThan(0);
    expect(r.label).toBe('echo-test');
    await waitForExit(r.id);
    const row = getBgProcess(db, r.id);
    expect(row?.status).toBe('exited');
    expect(row?.exitCode).toBe(0);
    expect(row?.label).toBe('echo-test');
  });

  test('records non-zero exit codes', async () => {
    const r = await mgr.spawn({ command: 'exit 42' });
    await waitForExit(r.id);
    const row = getBgProcess(db, r.id);
    expect(row?.status).toBe('exited');
    expect(row?.exitCode).toBe(42);
  });

  test('label is null when omitted', async () => {
    const r = await mgr.spawn({ command: 'true' });
    expect(r.label).toBeNull();
    await waitForExit(r.id);
  });

  test('liveCount drops back to zero after natural exit', async () => {
    expect(mgr.liveCount()).toBe(0);
    const r = await mgr.spawn({ command: 'true' });
    // liveCount may be 0 or 1 here depending on whether `true`
    // already finished; the post-exit assertion is what matters
    await waitForExit(r.id);
    // tiny extra wait so the exit handler's `live.delete` runs
    await new Promise((res) => setTimeout(res, 25));
    expect(mgr.liveCount()).toBe(0);
  });
});

describe('bg manager: readOutput', () => {
  test('returns stdout content and advances cursor', async () => {
    const r = await mgr.spawn({ command: 'echo line-one; echo line-two' });
    await waitForExit(r.id);
    const out = await mgr.readOutput(r.id);
    expect(out.stdout).toContain('line-one');
    expect(out.stdout).toContain('line-two');
    expect(out.stdoutCursor).toBeGreaterThan(0);
    expect(out.status).toBe('exited');
    expect(out.exitCode).toBe(0);
    expect(out.stdoutPending).toBe(0);
    // cursor was persisted
    const row = getBgProcess(db, r.id);
    expect(row?.stdoutCursorPosition).toBe(out.stdoutCursor);
  });

  test('subsequent read returns empty when caught up', async () => {
    const r = await mgr.spawn({ command: 'echo x' });
    await waitForExit(r.id);
    await mgr.readOutput(r.id);
    const second = await mgr.readOutput(r.id);
    expect(second.stdout).toBe('');
    expect(second.stdoutPending).toBe(0);
  });

  test('captures stderr separately', async () => {
    const r = await mgr.spawn({ command: 'echo to-stderr 1>&2; echo to-stdout' });
    await waitForExit(r.id);
    const out = await mgr.readOutput(r.id);
    expect(out.stderr).toContain('to-stderr');
    expect(out.stdout).toContain('to-stdout');
  });

  test('respects maxBytes and reports stdoutPending', async () => {
    // 200 bytes of stdout, ask for 50.
    const r = await mgr.spawn({
      command: `printf 'x%.0s' {1..200}`,
    });
    await waitForExit(r.id);
    const out = await mgr.readOutput(r.id, { maxBytes: 50 });
    expect(out.stdout.length).toBe(50);
    expect(out.stdoutPending).toBe(150);
    const next = await mgr.readOutput(r.id, { maxBytes: 1000 });
    expect(next.stdout.length).toBe(150);
    expect(next.stdoutPending).toBe(0);
  });

  test('explicit `sinceStdout` overrides stored cursor', async () => {
    const r = await mgr.spawn({ command: 'echo abcdef' });
    await waitForExit(r.id);
    await mgr.readOutput(r.id); // advances cursor to end
    const replay = await mgr.readOutput(r.id, { sinceStdout: 0, sinceStderr: 0 });
    expect(replay.stdout).toContain('abcdef');
  });

  test('stderr cursor is independent — noisy stdout does not strand stderr writes', async () => {
    // Stage 1: stdout writes 50 bytes, stderr writes 1 byte.
    const r = await mgr.spawn({
      command: `printf 'x%.0s' {1..50}; echo 1>&2 -n A; sleep 0.5; echo 1>&2 -n B`,
    });
    // Read once early — stdout will be ahead of stderr by then.
    await new Promise((res) => setTimeout(res, 100));
    const first = await mgr.readOutput(r.id);
    expect(first.stdout.length).toBe(50);
    expect(first.stderr).toBe('A');
    // After waitForExit, stderr appended 'B'. With the OLD single-cursor
    // bug, cursor would have advanced past stderr's end and 'B' would
    // be lost. With dual cursors, the next read picks up exactly 'B'.
    await waitForExit(r.id);
    const second = await mgr.readOutput(r.id);
    expect(second.stderr).toBe('B');
  });

  test('throws on unknown id', async () => {
    expect(mgr.readOutput('nope')).rejects.toThrow(/not found/);
  });

  test('throws on cross-session id', async () => {
    const otherSession = createSession(db, { model: 'm', cwd: '/p' }).id;
    const otherDir = setupTempLogDir();
    const otherMgr = createBgManager({ db, sessionId: otherSession, logDir: otherDir });
    const r = await otherMgr.spawn({ command: 'true' });
    await waitForExit(r.id);
    expect(mgr.readOutput(r.id)).rejects.toThrow(/not in this session/);
  });
});

describe('bg manager: kill', () => {
  test('SIGTERM stops a long-running process and reports killed', async () => {
    const r = await mgr.spawn({ command: 'sleep 30' });
    const killed = await mgr.kill(r.id, { gracePeriodMs: 2000 });
    expect(killed.status).toBe('killed');
    const row = getBgProcess(db, r.id);
    expect(row?.status).toBe('killed');
  });

  test('SIGKILL escalation when process ignores SIGTERM', async () => {
    // Trap SIGTERM so the process refuses to die gracefully. Only
    // SIGKILL will end it. Grace is short to keep the test fast.
    const r = await mgr.spawn({
      command: "trap '' TERM; sleep 30",
    });
    // Give bash a beat to install the trap
    await new Promise((res) => setTimeout(res, 100));
    const start = Date.now();
    const killed = await mgr.kill(r.id, { gracePeriodMs: 300 });
    const elapsed = Date.now() - start;
    expect(killed.status).toBe('killed');
    // Should escalate after ~300ms grace; allow generous slack.
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(2000);
  });

  test('immediate SIGKILL skips the grace period', async () => {
    const r = await mgr.spawn({ command: 'sleep 30' });
    const start = Date.now();
    const killed = await mgr.kill(r.id, { signal: 'SIGKILL' });
    const elapsed = Date.now() - start;
    expect(killed.status).toBe('killed');
    expect(elapsed).toBeLessThan(500);
  });

  test('idempotent on already-exited process', async () => {
    const r = await mgr.spawn({ command: 'true' });
    await waitForExit(r.id);
    const result = await mgr.kill(r.id);
    // status from the DB row's perspective at the time we asked
    expect(['exited', 'killed']).toContain(result.status);
    // a second kill is a no-op
    const second = await mgr.kill(r.id);
    expect(['exited', 'killed']).toContain(second.status);
  });

  test('throws on unknown id', async () => {
    expect(mgr.kill('nope')).rejects.toThrow(/not found/);
  });
});

describe('bg manager: cleanup', () => {
  test('terminates every still-running process for the session', async () => {
    const a = await mgr.spawn({ command: 'sleep 30' });
    const b = await mgr.spawn({ command: 'sleep 30' });
    const c = await mgr.spawn({ command: 'true' });
    await waitForExit(c.id);
    const result = await mgr.cleanup();
    expect(result.killed).toBeGreaterThanOrEqual(2);
    expect(getBgProcess(db, a.id)?.status).toBe('killed');
    expect(getBgProcess(db, b.id)?.status).toBe('killed');
    expect(getBgProcess(db, c.id)?.status).toBe('exited');
  });

  test('cleanup is safe when nothing is running', async () => {
    const result = await mgr.cleanup();
    expect(result.killed).toBe(0);
  });

  test('cleanup does not touch other sessions', async () => {
    const otherSession = createSession(db, { model: 'm', cwd: '/p' }).id;
    const otherDir = setupTempLogDir();
    const otherMgr = createBgManager({ db, sessionId: otherSession, logDir: otherDir });
    const mine = await mgr.spawn({ command: 'sleep 30' });
    const theirs = await otherMgr.spawn({ command: 'sleep 30' });
    await mgr.cleanup();
    expect(getBgProcess(db, mine.id)?.status).toBe('killed');
    expect(getBgProcess(db, theirs.id)?.status).toBe('running');
    await otherMgr.cleanup();
  });

  test('rows persist in DB with full audit trail', async () => {
    await mgr.spawn({ command: 'echo a', label: 'one' });
    await mgr.spawn({ command: 'echo b', label: 'two' });
    // Wait a tick for naturals to exit
    await new Promise((res) => setTimeout(res, 100));
    const list = listBgProcessesBySession(db, sessionId);
    expect(list.length).toBe(2);
    expect(list.map((p) => p.label).sort()).toEqual(['one', 'two']);
    for (const row of list) {
      expect(row.command).toMatch(/^echo /);
      expect(row.osPid).toBeGreaterThan(0);
      expect(row.cwd).toBeString();
    }
  });
});
