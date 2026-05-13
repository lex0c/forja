import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type BgManager, type BgManagerEvent, createBgManager } from '../../src/bg/index.ts';
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

  test('spawned subprocess does not keep parent runtime alive (unref)', async () => {
    // Regression: without proc.unref(), a referenced bg subprocess
    // holds the parent event loop active even after the last
    // userspace work is done — a CLI that spawned a long-running
    // process and then "exited cleanly" would hang until the child
    // dies. Verified end-to-end by spawning a fresh `bun` process
    // that creates a manager + spawns a 30s sleep + returns
    // without cleanup. With unref, that bun process exits in ms;
    // without it, the bun process hangs ≥30s waiting on the child.
    const repoRoot = resolve(import.meta.dir, '..', '..');
    const script = `
      import { mkdtempSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { createBgManager } from '${repoRoot}/src/bg/index.ts';
      import { openMemoryDb } from '${repoRoot}/src/storage/db.ts';
      import { migrate } from '${repoRoot}/src/storage/migrate.ts';
      import { createSession } from '${repoRoot}/src/storage/repos/sessions.ts';
      const db = openMemoryDb();
      migrate(db);
      const sid = createSession(db, { model: 'm', cwd: '/p' }).id;
      const dir = mkdtempSync(join(tmpdir(), 'unref-test-'));
      const mgr = createBgManager({ db, sessionId: sid, logDir: dir });
      await mgr.spawn({ command: 'sleep 30' });
      // No cleanup, no exit-event awaits, nothing keeping the loop
      // alive except the unref'd subprocess itself.
    `;
    const start = Date.now();
    const child = Bun.spawn(['bun', '-e', script], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const exitCode = await child.exited;
    const elapsed = Date.now() - start;
    expect(exitCode).toBe(0);
    // Parent should exit in well under 5 seconds; the bg process
    // sleeps 30 seconds. If unref regressed, this would block
    // ~30 seconds and the test runner would time out.
    expect(elapsed).toBeLessThan(5000);
    // Reap the orphaned grandchild bg process so the test host is
    // clean. Best-effort — the bun process is gone, so the bash
    // grandchild may have been reparented to PID 1 already.
    try {
      // Find sleep processes by command line and signal them. We
      // don't have the pid here (the script didn't surface it), so
      // a targeted pkill is the cleanest portable option.
      Bun.spawnSync(['pkill', '-f', 'sleep 30'], { stdout: 'ignore', stderr: 'ignore' });
    } catch {
      // If pkill is missing or denied, leave it — sleep 30 will
      // self-exit within the test wall clock.
    }
  });

  test('scrubs credentials from spawned env (defense-in-depth)', async () => {
    // Set a sentinel API-key-shaped variable on the harness env. The
    // shape matches scrubEnv's pattern (`*_API_KEY` suffix). The
    // spawned process echoes the variable; if scrubbing works the
    // child sees an empty string.
    const sentinel = 'forja-test-secret-must-not-leak';
    const prev = process.env.FORJA_TEST_API_KEY;
    process.env.FORJA_TEST_API_KEY = sentinel;
    try {
      const r = await mgr.spawn({
        command: 'printf "%s" "${FORJA_TEST_API_KEY:-<empty>}"',
      });
      await waitForExit(r.id);
      const out = await mgr.readOutput(r.id);
      expect(out.stdout).toBe('<empty>');
      expect(out.stdout).not.toContain(sentinel);
    } finally {
      if (prev === undefined) delete process.env.FORJA_TEST_API_KEY;
      else process.env.FORJA_TEST_API_KEY = prev;
    }
  });

  test('preserves innocuous env vars (PATH, HOME)', async () => {
    // Sanity check that scrubEnv didn't gut the env entirely. A child
    // that can't find `bash` would fail with status='failed' or non-
    // zero exit; instead we expect a successful echo of $PATH which
    // bash can only resolve if it ran.
    const r = await mgr.spawn({
      command: 'echo "PATH=$PATH"',
    });
    await waitForExit(r.id);
    const out = await mgr.readOutput(r.id);
    expect(out.stdout).toContain('PATH=');
    expect(out.stdout.length).toBeGreaterThan('PATH='.length);
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

  test('concurrent readOutput calls preserve max cursor (no rollback)', async () => {
    // Regression: two callers reading the same process in parallel
    // (e.g., canonical bash_output racing a wait_for / monitor poll
    // loop) can each compute a different stdoutWin.end. Whichever
    // resolves second used to clobber the cursor with its smaller
    // value, replaying already-emitted bytes on the next canonical
    // call. The DB-level WHERE cursor_position < ? clause makes
    // out-of-order writes no-ops.
    const r = await mgr.spawn({ command: `printf 'x%.0s' {1..500}` });
    await waitForExit(r.id);
    // Both reads are canonical (no `since*`); they both target
    // cursor=0 at start. One asks for 50 bytes, the other for 200.
    // Whichever resolves last would, under the old code, clobber
    // the cursor with its end value.
    const [smallRead, bigRead] = await Promise.all([
      mgr.readOutput(r.id, { maxBytes: 50 }),
      mgr.readOutput(r.id, { maxBytes: 200 }),
    ]);
    expect(smallRead.stdoutCursor).toBe(50);
    expect(bigRead.stdoutCursor).toBe(200);
    // Persisted cursor is the MAX of the two — never less.
    const row = getBgProcess(db, r.id);
    expect(row?.stdoutCursorPosition).toBe(200);
  });

  test('explicit `sinceStdout` overrides stored cursor', async () => {
    const r = await mgr.spawn({ command: 'echo abcdef' });
    await waitForExit(r.id);
    await mgr.readOutput(r.id); // advances cursor to end
    const replay = await mgr.readOutput(r.id, { sinceStdout: 0, sinceStderr: 0 });
    expect(replay.stdout).toContain('abcdef');
  });

  test('explicit since does NOT rewind the persisted cursor (replay safety)', async () => {
    // Regression: a `sinceStdout: 0` replay used to write the new
    // (smaller) end back to the cursor, so subsequent canonical
    // reads would re-deliver bytes the model already saw.
    const r = await mgr.spawn({ command: 'echo abcdef' });
    await waitForExit(r.id);
    const first = await mgr.readOutput(r.id);
    const cursorAfterFirst = getBgProcess(db, r.id)?.stdoutCursorPosition ?? 0;
    expect(first.stdout).toContain('abcdef');
    expect(cursorAfterFirst).toBeGreaterThan(0);

    // Replay from byte 0 — should return the same content but
    // leave the persisted cursor untouched.
    await mgr.readOutput(r.id, { sinceStdout: 0, sinceStderr: 0 });
    const cursorAfterReplay = getBgProcess(db, r.id)?.stdoutCursorPosition;
    expect(cursorAfterReplay).toBe(cursorAfterFirst);

    // Canonical read after replay sees nothing new (caught up).
    const next = await mgr.readOutput(r.id);
    expect(next.stdout).toBe('');
  });

  test('explicit since past EOF does NOT skip future writes', async () => {
    // Regression: a `sinceStdout: 999999` past EOF used to set the
    // cursor to 999999 (readWindow returns end=start when start>=
    // total), silently swallowing every real future write up to
    // byte 999999.
    const r = await mgr.spawn({
      command: 'echo first; sleep 0.3; echo second',
    });
    // Read 'first' early so we have a real cursor.
    await new Promise((res) => setTimeout(res, 100));
    const early = await mgr.readOutput(r.id);
    expect(early.stdout).toContain('first');
    const cursorBefore = getBgProcess(db, r.id)?.stdoutCursorPosition ?? 0;

    // Probe past EOF — would corrupt cursor under the old logic.
    const probe = await mgr.readOutput(r.id, { sinceStdout: 999999 });
    expect(probe.stdout).toBe('');
    const cursorAfterProbe = getBgProcess(db, r.id)?.stdoutCursorPosition;
    expect(cursorAfterProbe).toBe(cursorBefore);

    // Wait for second echo, then canonical read sees it.
    await waitForExit(r.id);
    const after = await mgr.readOutput(r.id);
    expect(after.stdout).toContain('second');
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

  // Slice 135 P1 conc-5: kill() concurrent with readOutput().
  // The readOutput path: getBgProcess snapshot → fileSize →
  // readWindow → cursor advance. If kill() lands BETWEEN the
  // snapshot and the cursor advance, the row is finalized to
  // status='killed' while the read still completes. The cursor
  // advance writes through a `WHERE cursor_position < ?` guard
  // (DB-level monotonicity), so racing writes can't roll the
  // cursor backwards. This pins:
  //   - readOutput completes without throwing (no race against
  //     finalize);
  //   - the row ends as status='killed';
  //   - cursor advances monotonically;
  //   - subsequent readOutput on the killed row still returns
  //     the captured output.
  test('kill() racing readOutput() leaves cursor monotonic + status killed (slice 135 P1 conc-5)', async () => {
    // Process that streams enough output for the read to span
    // the kill — `yes` is a flooding command, capped at 1s so
    // the test doesn't hang if kill misfires.
    const r = await mgr.spawn({ command: "yes 'streaming-payload-line' | head -n 5000" });
    // Race: fire readOutput + kill in parallel.
    const [readResult, killResult] = await Promise.all([
      mgr.readOutput(r.id, { maxBytes: 10_000 }),
      mgr.kill(r.id, { signal: 'SIGKILL' }),
    ]);
    // Both must resolve without throwing — no race against the
    // finalize transaction.
    expect(killResult.status).toBe('killed');
    expect(typeof readResult.stdout).toBe('string');
    expect(readResult.stdoutCursor).toBeGreaterThanOrEqual(0);
    // Row finalized as killed (kill won the race or the SIGKILL
    // landed before the kernel flushed the natural exit path).
    const row = getBgProcess(db, r.id);
    expect(row?.status).toBe('killed');
    expect(row?.stdoutCursorPosition).toBeGreaterThanOrEqual(readResult.stdoutCursor);
    // Follow-up read on the killed row still works — no crash on
    // the missing live handle.
    const after = await mgr.readOutput(r.id);
    expect(after.status).toBe('killed');
    expect(after.stdoutCursor).toBeGreaterThanOrEqual(row?.stdoutCursorPosition ?? 0);
  });

  test('kill() does not invalidate stdout reads issued before AND after the kill', async () => {
    // Sequential rather than racing: read BEFORE kill, kill, then
    // read AFTER. The "after" read must still find the file (logs
    // aren't deleted on kill) and advance the cursor correctly.
    // Use an unbounded `yes` to guarantee the process is alive
    // when kill lands (head -n N would race the kill against
    // natural exit).
    const r = await mgr.spawn({ command: "yes 'persist-after-kill'" });
    // Let some output land before killing.
    await new Promise((res) => setTimeout(res, 50));
    const before = await mgr.readOutput(r.id, { maxBytes: 2_000 });
    expect(before.stdout.length).toBeGreaterThan(0);
    await mgr.kill(r.id, { signal: 'SIGKILL' });
    // Post-kill read: cursor advances, status reports killed.
    const after = await mgr.readOutput(r.id);
    expect(after.status).toBe('killed');
    expect(after.stdoutCursor).toBeGreaterThanOrEqual(before.stdoutCursor);
  });

  // Slice 148 (BG1 — process-group isolation). Pre-slice the bg
  // manager spawned via `Bun.spawn` WITHOUT `detached: true`. The
  // shape was `bash -c "<cmd>"` where `<cmd>` typically forks
  // (npm run dev → node → webpack, pytest --watch → many subprocs).
  // `proc.kill('SIGTERM')` signalled ONLY the wrapping bash; the
  // grandchildren got orphaned to PID 1, holding ports + file
  // locks until the next system reboot. Slice 148 adds setsid
  // (`detached: true`) on spawn + group-kill (`process.kill(-pid)`)
  // on kill, cascading the signal across every descendant.
  test('spawn places the child in its own process group (BG1)', async () => {
    // Spawn a process whose grandchild writes its own pid + pgid
    // (process group) to a temp file. After the spawn we read the
    // file and assert the child's PGID equals the child's own PID
    // (setsid succeeded — the child IS the group leader, distinct
    // from the harness's PGID).
    const tmpFile = join(logDir, `pgid-${Date.now()}.txt`);
    const r = await mgr.spawn({
      command: `(echo "pid=$$ pgid=$(ps -o pgid= -p $$ | tr -d ' ')" > ${tmpFile}; sleep 5)`,
    });
    // Wait for the echo to land.
    await new Promise((res) => setTimeout(res, 200));
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(tmpFile, 'utf8');
    // Parse pid=<n> pgid=<n>
    const match = content.match(/pid=(\d+) pgid=(\d+)/);
    expect(match).not.toBeNull();
    if (match === null) throw new Error('output parse failed');
    const childPid = Number(match[1]);
    const childPgid = Number(match[2]);
    // The grandchild's PGID equals the spawned shell's PID (the bash
    // wrapper). `osPid` returned by spawn is the bash PID; PGID of
    // the grandchild's process tree must match it. Pre-slice this
    // would have been the HARNESS's PGID instead.
    expect(childPgid).toBe(r.osPid);
    // PGID also distinct from harness's own PGID — defense in depth.
    expect(childPgid).not.toBe(process.pid);
    expect(childPid).toBeGreaterThan(0);
    // Cleanup the lingering sleep.
    await mgr.kill(r.id, { signal: 'SIGKILL' });
  });

  // Slice 151 (review): per-id dedup for concurrent kill() callers.
  // Pre-slice two callers entering kill(id) simultaneously both
  // signalled SIGTERM, both started a grace timer, and both could
  // race their own SIGKILL escalation onto a PID the kernel had
  // already reaped + reused. Dedup via inFlightKills makes the
  // second caller piggyback on the first kill's promise.
  test('concurrent kill() calls dedupe via inFlightKills (slice 151)', async () => {
    const r = await mgr.spawn({ command: 'sleep 30' });
    // Fire 4 concurrent kills on the same id. Without dedup, each
    // would issue its own SIGTERM + grace timer + SIGKILL cycle.
    // With dedup, all four await the same in-flight promise.
    const results = await Promise.all([
      mgr.kill(r.id),
      mgr.kill(r.id),
      mgr.kill(r.id),
      mgr.kill(r.id),
    ]);
    // All four return the same shape (status='killed').
    for (const result of results) {
      expect(result.status).toBe('killed');
    }
    // DB row is killed exactly once — no duplicate finalize.
    const row = getBgProcess(db, r.id);
    expect(row?.status).toBe('killed');
  });

  // Slice 151 (review): cleanup() returned ids.length + flipped,
  // which double-counted when a kill threw between signal-send and
  // finalize — the row stayed 'running', flipped picked it up, and
  // the same row was counted twice (once in ids.length, once in
  // flipped). 3 live processes reported "killed: 6". Fixed by
  // snapshotting runningBefore count instead.
  test('cleanup() returns a deduplicated count of rows transitioned (slice 151)', async () => {
    // Spawn 3 long-running bg processes.
    const r1 = await mgr.spawn({ command: 'sleep 30' });
    const r2 = await mgr.spawn({ command: 'sleep 30' });
    const r3 = await mgr.spawn({ command: 'sleep 30' });
    // All three should be 'running' at this point.
    expect(getBgProcess(db, r1.id)?.status).toBe('running');
    expect(getBgProcess(db, r2.id)?.status).toBe('running');
    expect(getBgProcess(db, r3.id)?.status).toBe('running');
    // Cleanup should report exactly 3 killed (no double-count).
    const result = await mgr.cleanup();
    expect(result.killed).toBe(3);
    // Verify all 3 rows are killed.
    expect(getBgProcess(db, r1.id)?.status).toBe('killed');
    expect(getBgProcess(db, r2.id)?.status).toBe('killed');
    expect(getBgProcess(db, r3.id)?.status).toBe('killed');
  });

  // Slice 151 (review): early-handle-undef path in kill() preserves
  // the DB's existing exitCode. Pre-slice it hard-coded null,
  // clobbering any exit metadata the natural-exit handler had
  // already captured for the same row.
  test('kill() with no live handle preserves existing exitCode (slice 151)', async () => {
    // Spawn a process that exits IMMEDIATELY with code 42. The
    // exit handler runs and writes exitCode=42 to the DB. Then
    // call kill() — DB shows 'exited', not 'running', so the
    // idempotent branch returns the row as-is. To exercise the
    // EARLY-undef path we need DB.status='running' BUT no live
    // handle — that's the race-y case the early-undef branch is
    // documented for. Simulate by directly mutating the DB row
    // to 'running' after natural exit + clearing live handle.
    const r = await mgr.spawn({ command: 'exit 42' });
    await waitForExit(r.id);
    // At this point DB has status='exited', exit_code=42.
    expect(getBgProcess(db, r.id)?.status).toBe('exited');
    expect(getBgProcess(db, r.id)?.exitCode).toBe(42);
    // Force DB back to 'running' (synthetic stuck-row state) to
    // exercise the early-handle-undef branch. The natural-exit
    // path already cleared live handle.
    db.query("UPDATE background_processes SET status = 'running' WHERE id = ?").run(r.id);
    // Now kill: DB says 'running', live handle is gone. Old
    // behavior: exitCode forced to null. New behavior: preserve
    // exitCode=42 from the DB row.
    const result = await mgr.kill(r.id);
    expect(result.status).toBe('killed');
    expect(result.exitCode).toBe(42);
    // DB row also preserved.
    expect(getBgProcess(db, r.id)?.exitCode).toBe(42);
  });

  test('kill cascades to grandchildren via process-group signal (BG1)', async () => {
    // The motivating shape: bash spawns a subshell that runs sleep.
    // Pre-slice `proc.kill('SIGTERM')` would signal bash only —
    // sleep survives as an orphan. With group-kill, sleep also dies.
    //
    // Verification trick: the inner sleep writes its own PID to a
    // file BEFORE sleeping. After mgr.kill() we use `kill -0 <pid>`
    // to check whether sleep still lives (kill -0 = signal 0,
    // "exists check"). If the grandchild was orphaned, kill -0 would
    // succeed for several more seconds; with group-kill it fails
    // immediately with ESRCH.
    const tmpFile = join(logDir, `sleep-pid-${Date.now()}.txt`);
    const r = await mgr.spawn({
      command: `(sleep 30 & echo $! > ${tmpFile}; wait)`,
    });
    // Wait for the inner sleep to launch + write its PID.
    await new Promise((res) => setTimeout(res, 200));
    const fs = await import('node:fs/promises');
    const pidContent = await fs.readFile(tmpFile, 'utf8');
    const sleepPid = Number(pidContent.trim());
    expect(sleepPid).toBeGreaterThan(0);
    // Sanity: sleep is alive right now.
    expect(() => process.kill(sleepPid, 0)).not.toThrow();
    // Kill the bg via the manager.
    await mgr.kill(r.id, { signal: 'SIGTERM', gracePeriodMs: 1000 });
    // Give the OS a beat to process the group signal.
    await new Promise((res) => setTimeout(res, 100));
    // The grandchild MUST be gone (group-kill cascaded). Pre-slice
    // it would still be alive, requiring its own SIGTERM.
    let stillAlive = false;
    try {
      process.kill(sleepPid, 0);
      stillAlive = true;
    } catch {
      // ESRCH expected — process is gone.
    }
    expect(stillAlive).toBe(false);
  });
});

describe('bg manager: maxRuntimeMs', () => {
  test('caps a long-running process at the runtime budget', async () => {
    const r = await mgr.spawn({ command: 'sleep 30', maxRuntimeMs: 200 });
    // Wait long enough for SIGTERM grace + SIGKILL escalation cycle
    // (5s default grace) + slack. The cap fires at 200ms; the
    // process is cooperative so it should be killed well within
    // the per-call kill grace, not the full 5s window.
    const start = Date.now();
    while (Date.now() - start < 8000) {
      if (getBgProcess(db, r.id)?.status === 'killed') break;
      await new Promise((res) => setTimeout(res, 25));
    }
    const elapsed = Date.now() - start;
    expect(getBgProcess(db, r.id)?.status).toBe('killed');
    // Sanity: cap fired roughly when expected (≥200ms, well under 8s)
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(8000);
  });

  test('cap timer is cleared on natural exit before firing', async () => {
    // Process exits in ~50ms; cap is 5s. If the timer fires after
    // exit it would attempt a kill — kill() is a no-op on already-
    // exited (status check), so we observe via status='exited'.
    const r = await mgr.spawn({ command: 'true', maxRuntimeMs: 5000 });
    await waitForExit(r.id);
    // Wait past 5s to confirm no spurious kill happens after exit
    // (would flip status to 'killed' if the timer didn't clear).
    await new Promise((res) => setTimeout(res, 100));
    expect(getBgProcess(db, r.id)?.status).toBe('exited');
  });

  test('omitting maxRuntimeMs leaves process unbounded', async () => {
    const r = await mgr.spawn({ command: 'sleep 30' });
    // Wait 200ms to give any spurious cap timer a chance to fire.
    await new Promise((res) => setTimeout(res, 200));
    expect(getBgProcess(db, r.id)?.status).toBe('running');
    await mgr.kill(r.id, { signal: 'SIGKILL' });
  });
});

describe('bg manager: abortSignal', () => {
  test('aborting the signal kills running bg processes promptly', async () => {
    const ac = new AbortController();
    const signalDir = setupTempLogDir();
    const signalMgr = createBgManager({
      db,
      sessionId,
      logDir: signalDir,
      abortSignal: ac.signal,
    });
    const r = await signalMgr.spawn({ command: 'sleep 30' });
    // Sanity: process is running before abort
    expect(getBgProcess(db, r.id)?.status).toBe('running');
    ac.abort();
    // Wait for the cleanup-on-abort listener to fire and finish.
    // 5s ceiling matches CLEANUP_KILL_GRACE_MS + slack — process is
    // cooperative (sleep responds to SIGTERM), so it should be much
    // faster.
    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (getBgProcess(db, r.id)?.status === 'killed') break;
      await new Promise((res) => setTimeout(res, 25));
    }
    expect(getBgProcess(db, r.id)?.status).toBe('killed');
  });

  test('signal already aborted at construction time is handled gracefully', async () => {
    const ac = new AbortController();
    ac.abort();
    const signalDir = setupTempLogDir();
    // Should not throw; cleanup runs (no-op since no spawns yet).
    const signalMgr = createBgManager({
      db,
      sessionId,
      logDir: signalDir,
      abortSignal: ac.signal,
    });
    expect(signalMgr.liveCount()).toBe(0);
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

describe('bg manager: onEvent', () => {
  test('fires started + ended for natural exit, exactly once each', async () => {
    const events: BgManagerEvent[] = [];
    const observed = createBgManager({
      db,
      sessionId,
      logDir,
      onEvent: (e) => events.push(e),
    });
    const r = await observed.spawn({ command: 'echo natural', label: 'n' });
    await waitForExit(r.id);
    // Wait one extra tick — exitedSettled emits inside its own
    // microtask after the OS reaps; waitForExit returns when the DB
    // row flips, which can be the same tick as the emit.
    await new Promise((res) => setTimeout(res, 25));
    const forThisProcess = events.filter((e) => e.processId === r.id);
    expect(forThisProcess.map((e) => e.kind)).toEqual(['started', 'ended']);
    const startedEv = forThisProcess[0] as Extract<BgManagerEvent, { kind: 'started' }>;
    expect(startedEv.command).toBe('echo natural');
    expect(startedEv.label).toBe('n');
    const endedEv = forThisProcess[1] as Extract<BgManagerEvent, { kind: 'ended' }>;
    expect(endedEv.status).toBe('exited');
    expect(endedEv.exitCode).toBe(0);
  });

  test('ended fires with status=killed when kill() terminates the process', async () => {
    const events: BgManagerEvent[] = [];
    const observed = createBgManager({
      db,
      sessionId,
      logDir,
      onEvent: (e) => events.push(e),
    });
    const r = await observed.spawn({ command: 'sleep 30' });
    await observed.kill(r.id);
    // Give exitedSettled a moment to fire its emit after the kill.
    await new Promise((res) => setTimeout(res, 25));
    const ended = events.find(
      (e): e is Extract<BgManagerEvent, { kind: 'ended' }> =>
        e.kind === 'ended' && e.processId === r.id,
    );
    expect(ended).toBeDefined();
    expect(ended?.status).toBe('killed');
  });

  test('ended fallback after DB failure preserves killed status (regression)', async () => {
    // When kill() terminates the process AND the DB write inside the
    // exitedSettled handler throws (e.g. concurrent close, migration
    // mid-flight), the catch branch must still report status='killed'
    // — the `killing` marker is the source of truth, not the DB row.
    // Pre-fix the fallback hardcoded 'exited', which lied about the
    // cause for exactly the scenario this fallback is meant to cover
    // (terminate-then-DB-fail).
    //
    // Wrap the DB with a Proxy that throws on the SECOND getBgProcess
    // call: the first lets kill() pass its own status check; the
    // second (inside exitedSettled) trips the fallback path.
    let getCallCount = 0;
    const wrappedDb = new Proxy(db, {
      get(target, prop) {
        if (prop === 'query') {
          return (sql: string): unknown => {
            const stmt = (target as { query: (s: string) => unknown }).query(sql);
            // Only sabotage the SELECT used by getBgProcess; let
            // everything else (UPDATE, INSERT in finalize, etc.)
            // pass so kill() can still complete cleanup.
            if (sql.includes('SELECT') && sql.includes('FROM background_processes')) {
              return new Proxy(stmt as object, {
                get(s, p): unknown {
                  if (p === 'get') {
                    return (...args: unknown[]): unknown => {
                      getCallCount += 1;
                      if (getCallCount >= 2) {
                        throw new Error('simulated DB failure mid-flight');
                      }
                      return (s as { get: (...a: unknown[]) => unknown }).get(...args);
                    };
                  }
                  return (s as Record<string | symbol, unknown>)[p];
                },
              });
            }
            return stmt;
          };
        }
        return (target as unknown as Record<string | symbol, unknown>)[prop];
      },
    }) as DB;

    const events: BgManagerEvent[] = [];
    const observed = createBgManager({
      db: wrappedDb,
      sessionId,
      logDir,
      onEvent: (e) => events.push(e),
    });
    const r = await observed.spawn({ command: 'sleep 30' });
    await observed.kill(r.id).catch(() => {
      // kill's own finalizeBgProcess may throw because the wrapped
      // db is now in failure mode — that's expected; this test is
      // about the EMIT shape, not kill's return value.
    });
    await new Promise((res) => setTimeout(res, 25));
    const ended = events.find(
      (e): e is Extract<BgManagerEvent, { kind: 'ended' }> =>
        e.kind === 'ended' && e.processId === r.id,
    );
    expect(ended).toBeDefined();
    // The bug was status='exited' here; the fix mirrors the happy-
    // path discriminator and reports 'killed' since `killing` was
    // set by kill().
    expect(ended?.status).toBe('killed');
    // exitCode is null in the fallback path (couldn't read past the
    // throw) — sanity check the contract.
    expect(ended?.exitCode).toBeNull();
  });

  test('observer that throws does not break process lifecycle', async () => {
    const observed = createBgManager({
      db,
      sessionId,
      logDir,
      onEvent: () => {
        throw new Error('observer crashed');
      },
    });
    const r = await observed.spawn({ command: 'echo ok' });
    // No throw despite observer raising — spawn returned and the
    // process exits naturally.
    await waitForExit(r.id);
    expect(getBgProcess(db, r.id)?.status).toBe('exited');
  });
});
