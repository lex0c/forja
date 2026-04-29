import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BgManager, createBgManager } from '../../src/bg/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { getBgProcess } from '../../src/storage/repos/bg-processes.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { monitor } from '../../src/wait/monitor.ts';

let db: DB;
let sessionId: string;
let mgr: BgManager;
const tempRoots: string[] = [];
const timers: ReturnType<typeof setTimeout>[] = [];

const mktemp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'forja-monitor-'));
  tempRoots.push(d);
  return d;
};

const later = (fn: () => void, ms: number): void => {
  timers.push(setTimeout(fn, ms));
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  mgr = createBgManager({ db, sessionId, logDir: mktemp() });
});

afterEach(async () => {
  for (const t of timers) clearTimeout(t);
  timers.length = 0;
  await mgr.cleanup();
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  tempRoots.length = 0;
});

describe('monitor: process_output_lines', () => {
  test('captures every line emitted within the duration', async () => {
    const r = await mgr.spawn({
      command: 'echo line-1; sleep 0.05; echo line-2; sleep 0.05; echo line-3',
    });
    const result = await monitor(
      { kind: 'process_output_lines', processId: r.id },
      { durationMs: 2000, pollIntervalMs: 50, bgManager: mgr },
    );
    const lines = result.events.map((e) => (e.payload as { line?: string }).line);
    expect(lines).toContain('line-1');
    expect(lines).toContain('line-2');
    expect(lines).toContain('line-3');
    // Process exits before duration; reason should be process_exited
    expect(result.reason).toBe('process_exited');
  });

  test('separates stdout and stderr in event payload', async () => {
    const r = await mgr.spawn({
      command: 'echo to-stdout; echo to-stderr 1>&2; sleep 0.05',
    });
    const result = await monitor(
      { kind: 'process_output_lines', processId: r.id },
      { durationMs: 2000, pollIntervalMs: 50, bgManager: mgr },
    );
    const stdoutLines = result.events
      .filter((e) => (e.payload as { stream: string }).stream === 'stdout')
      .map((e) => (e.payload as { line: string }).line);
    const stderrLines = result.events
      .filter((e) => (e.payload as { stream: string }).stream === 'stderr')
      .map((e) => (e.payload as { line: string }).line);
    expect(stdoutLines).toContain('to-stdout');
    expect(stderrLines).toContain('to-stderr');
  });

  test('observational — does NOT consume bytes from model cursor', async () => {
    const r = await mgr.spawn({ command: 'echo OBSERVE-MONITOR; sleep 0.05' });
    await monitor(
      { kind: 'process_output_lines', processId: r.id },
      { durationMs: 1000, pollIntervalMs: 50, bgManager: mgr },
    );
    // Model cursor untouched
    const row = getBgProcess(db, r.id);
    expect(row?.stdoutCursorPosition).toBe(0);
    // Subsequent canonical bash_output STILL sees the line
    const out = await mgr.readOutput(r.id);
    expect(out.stdout).toContain('OBSERVE-MONITOR');
  });

  test('terminates by max_events when count cap reached', async () => {
    // Emit 5 lines with small delays so the monitor sees them
    // across multiple polls.
    const r = await mgr.spawn({
      command: 'for i in 1 2 3 4 5; do echo line-$i; sleep 0.05; done',
    });
    const result = await monitor(
      { kind: 'process_output_lines', processId: r.id },
      {
        durationMs: 5000,
        pollIntervalMs: 30,
        maxEvents: 3,
        bgManager: mgr,
      },
    );
    expect(result.reason).toBe('max_events');
    expect(result.events.length).toBe(3);
  });

  test('terminates by duration when process keeps emitting', async () => {
    // sleep 30 process emits nothing for the whole duration cap.
    const r = await mgr.spawn({ command: 'sleep 30' });
    const result = await monitor(
      { kind: 'process_output_lines', processId: r.id },
      { durationMs: 200, pollIntervalMs: 50, bgManager: mgr },
    );
    expect(result.reason).toBe('duration');
    expect(result.events.length).toBe(0);
    expect(result.processStatus).toBe('running');
  });

  test('drains pending bytes after exit (lines past 64KB cap)', async () => {
    // Regression: a single readOutput call returns at most maxBytes
    // (default 64KB). If the process emits >64KB and exits, the
    // first poll scans only the first chunk and `r.stdoutPending`
    // is >0. Without the post-exit drain loop, lines in the tail
    // are silently lost.
    //
    // We emit ~70KB of filler bytes (single line via printf without
    // \n) THEN a `\necho TAIL-LINE-MARKER` line so the marker lands
    // past the first 64KB chunk on a fresh line.
    const r = await mgr.spawn({
      command: `printf 'x%.0s' {1..70000}; echo; echo TAIL-LINE-MARKER`,
    });
    const result = await monitor(
      { kind: 'process_output_lines', processId: r.id },
      { durationMs: 5000, pollIntervalMs: 50, maxEvents: 200, bgManager: mgr },
    );
    expect(result.reason).toBe('process_exited');
    const lines = result.events.map((e) => (e.payload as { line: string }).line);
    // Marker is on a line PAST the 70KB filler — without the drain,
    // it sits in the unread tail and gets dropped.
    expect(lines.some((l) => l.includes('TAIL-LINE-MARKER'))).toBe(true);
  });

  test('emits a trailing partial line on process exit', async () => {
    // printf without trailing \n leaves an unterminated line. The
    // drain on exit should emit it as a partial event.
    const r = await mgr.spawn({ command: `printf 'no-newline-tail'; sleep 0.05` });
    const result = await monitor(
      { kind: 'process_output_lines', processId: r.id },
      { durationMs: 2000, pollIntervalMs: 50, bgManager: mgr },
    );
    const tail = result.events.find(
      (e) =>
        (e.payload as { line?: string }).line === 'no-newline-tail' &&
        (e.payload as { partial?: boolean }).partial === true,
    );
    expect(tail).toBeDefined();
  });
});

describe('monitor: process_output_pattern', () => {
  test('captures every regex match across multiple lines', async () => {
    const r = await mgr.spawn({
      command: 'echo "WARN: a"; echo "INFO: b"; echo "WARN: c"; sleep 0.05',
    });
    const result = await monitor(
      {
        kind: 'process_output_pattern',
        processId: r.id,
        pattern: /WARN:\s+\w+/g,
      },
      { durationMs: 2000, pollIntervalMs: 50, bgManager: mgr },
    );
    const matches = result.events.map((e) => (e.payload as { match: string }).match);
    expect(matches).toContain('WARN: a');
    expect(matches).toContain('WARN: c');
    expect(matches.every((m) => m.startsWith('WARN'))).toBe(true);
    expect(matches.length).toBe(2);
  });

  test('terminates by max_events on first hit when cap is 1', async () => {
    const r = await mgr.spawn({
      command: 'echo first; echo second; echo third; sleep 0.05',
    });
    const result = await monitor(
      {
        kind: 'process_output_pattern',
        processId: r.id,
        pattern: /\w+/g,
      },
      { durationMs: 2000, pollIntervalMs: 50, maxEvents: 1, bgManager: mgr },
    );
    expect(result.reason).toBe('max_events');
    expect(result.events.length).toBe(1);
  });

  test('catches a pattern that straddles a poll boundary (overlap)', async () => {
    // Same regression class fixed in wait_for's process_output
    // (commit 2bb1e36): a pattern split across two polls would be
    // missed without the carry-over buffer. printf without newline
    // keeps the writes adjacent in the log; sleep ensures they
    // land in different polls.
    const r = await mgr.spawn({
      command: `printf 'BLT-MON-'; sleep 0.1; printf 'TOKEN-99'`,
    });
    const result = await monitor(
      {
        kind: 'process_output_pattern',
        processId: r.id,
        pattern: /BLT-MON-TOKEN-99/g,
      },
      { durationMs: 5000, pollIntervalMs: 50, bgManager: mgr },
    );
    const matches = result.events.map((e) => (e.payload as { match: string }).match);
    expect(matches).toContain('BLT-MON-TOKEN-99');
    expect(matches.length).toBe(1);
  });

  test('does NOT double-emit a match found in a previous poll', async () => {
    // The overlap buffer carries the last 64 bytes; matchAll on the
    // combined text would re-find a match entirely in the buffer
    // unless we filter via the matchEnd > buffer.length check. This
    // test pins that filter: emit a single short marker and let
    // multiple polls run after — exactly one event should fire.
    const r = await mgr.spawn({ command: 'echo SOLO-MARKER; sleep 0.5' });
    const result = await monitor(
      {
        kind: 'process_output_pattern',
        processId: r.id,
        pattern: /SOLO-MARKER/g,
      },
      { durationMs: 1000, pollIntervalMs: 30, bgManager: mgr },
    );
    const matches = result.events.filter(
      (e) => (e.payload as { match: string }).match === 'SOLO-MARKER',
    );
    expect(matches.length).toBe(1);
  });

  test('throws when pattern lacks the global (g) flag', () => {
    expect(
      monitor(
        {
          kind: 'process_output_pattern',
          processId: 'x',
          pattern: /no-global-flag/,
        },
        { durationMs: 100, bgManager: mgr },
      ),
    ).rejects.toThrow(/global.*'g'/);
  });

  test('drains pending bytes after exit (pattern in tail past 64KB cap)', async () => {
    // Regression: pattern mode also has the per-call 64KB cap.
    // A pattern in the tail of a process that emitted >64KB and
    // exited would be silently lost without the drain loop.
    const r = await mgr.spawn({
      command: `printf 'x%.0s' {1..70000}; echo TAIL-PATTERN-37`,
    });
    const result = await monitor(
      {
        kind: 'process_output_pattern',
        processId: r.id,
        pattern: /TAIL-PATTERN-37/g,
      },
      { durationMs: 5000, pollIntervalMs: 50, bgManager: mgr },
    );
    expect(result.reason).toBe('process_exited');
    const matches = result.events.map((e) => (e.payload as { match: string }).match);
    expect(matches).toContain('TAIL-PATTERN-37');
  });

  test('terminates with process_exited and processStatus payload', async () => {
    const r = await mgr.spawn({ command: 'echo solo; exit 7' });
    const result = await monitor(
      {
        kind: 'process_output_pattern',
        processId: r.id,
        pattern: /solo/g,
      },
      { durationMs: 2000, pollIntervalMs: 50, bgManager: mgr },
    );
    expect(result.reason).toBe('process_exited');
    expect(result.processStatus).toBe('exited');
    expect(result.processExitCode).toBe(7);
  });
});

describe('monitor: file_changes', () => {
  test('emits an event for each mtime change', async () => {
    const dir = mktemp();
    const path = join(dir, 'watched.txt');
    writeFileSync(path, 'a');
    later(() => writeFileSync(path, 'b'), 100);
    later(() => writeFileSync(path, 'c'), 250);
    const result = await monitor(
      { kind: 'file_changes', path },
      { durationMs: 800, pollIntervalMs: 50 },
    );
    expect(result.events.length).toBeGreaterThanOrEqual(2);
    expect(result.events.every((e) => e.kind === 'file_change')).toBe(true);
    const last = result.events[result.events.length - 1];
    expect((last?.payload as { path: string }).path).toBe(path);
  });

  test('returns empty events when file is stable', async () => {
    const dir = mktemp();
    const path = join(dir, 'stable.txt');
    writeFileSync(path, 'x');
    const result = await monitor(
      { kind: 'file_changes', path },
      { durationMs: 200, pollIntervalMs: 50 },
    );
    expect(result.events.length).toBe(0);
    expect(result.reason).toBe('duration');
  });
});

describe('monitor: signal handling', () => {
  test('aborts mid-monitor on caller signal', async () => {
    const ac = new AbortController();
    const r = await mgr.spawn({ command: 'sleep 30' });
    const promise = monitor(
      { kind: 'process_output_lines', processId: r.id },
      {
        durationMs: 30000,
        pollIntervalMs: 50,
        signal: ac.signal,
        bgManager: mgr,
      },
    );
    setTimeout(() => ac.abort(), 100);
    const result = await promise;
    expect(result.reason).toBe('aborted');
    await mgr.kill(r.id, { signal: 'SIGKILL' });
  });

  test('returns aborted immediately if signal already fired', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await monitor(
      { kind: 'file_changes', path: '/tmp/whatever' },
      { durationMs: 5000, signal: ac.signal },
    );
    expect(result.reason).toBe('aborted');
    expect(result.events.length).toBe(0);
  });
});

describe('monitor: bgManager validation', () => {
  test('throws when process_output_lines used without bgManager', () => {
    expect(
      monitor({ kind: 'process_output_lines', processId: 'x' }, { durationMs: 100 }),
    ).rejects.toThrow(/bgManager/);
  });

  test('throws when process_output_pattern used without bgManager', () => {
    expect(
      monitor(
        { kind: 'process_output_pattern', processId: 'x', pattern: /y/ },
        { durationMs: 100 },
      ),
    ).rejects.toThrow(/bgManager/);
  });

  test('file_changes does NOT require bgManager', async () => {
    const dir = mktemp();
    const path = join(dir, 'no-mgr-needed.txt');
    writeFileSync(path, 'x');
    // No bgManager passed — should still work.
    const result = await monitor(
      { kind: 'file_changes', path },
      { durationMs: 100, pollIntervalMs: 50 },
    );
    expect(result.reason).toBe('duration');
    // Just the absence of throwing is the assertion; we ignored
    // the elapsed because waitForExit isn't relevant here.
    expect(result.events).toBeArray();
  });

  test('throws on unknown process_id', () => {
    expect(
      monitor(
        { kind: 'process_output_lines', processId: 'nope' },
        { durationMs: 1000, pollIntervalMs: 50, bgManager: mgr },
      ),
    ).rejects.toThrow(/not found/);
  });
});
