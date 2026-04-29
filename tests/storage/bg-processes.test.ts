import { beforeEach, describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../../src/storage/db.ts';
import type { DB } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  advanceBgProcessStdoutCursor,
  finalizeBgProcess,
  getBgProcess,
  insertBgProcess,
  listBgProcessesBySession,
  markRunningAsKilled,
} from '../../src/storage/repos/bg-processes.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;
let sessionId: string;

const insert = (overrides: Partial<Parameters<typeof insertBgProcess>[1]> = {}) =>
  insertBgProcess(db, {
    sessionId,
    command: 'sleep 60',
    cwd: '/tmp',
    stdoutLogPath: '/tmp/x.stdout',
    stderrLogPath: '/tmp/x.stderr',
    ...overrides,
  });

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
});

describe('bg-processes repo', () => {
  test('inserts and reads a row back with all fields', () => {
    const proc = insert({
      label: 'dev-server',
      osPid: 12345,
      command: 'npm run dev',
      cwd: '/work',
      spawnedAt: 1000,
    });
    expect(proc.id).toBeString();
    expect(proc.status).toBe('running');
    expect(proc.stdoutCursorPosition).toBe(0);
    expect(proc.stderrCursorPosition).toBe(0);
    expect(proc.exitedAt).toBeNull();
    expect(proc.exitCode).toBeNull();

    const fetched = getBgProcess(db, proc.id);
    expect(fetched).toEqual(proc);
  });

  test('label and os_pid default to null when omitted', () => {
    const proc = insert();
    expect(proc.label).toBeNull();
    expect(proc.osPid).toBeNull();
  });

  test('getBgProcess returns null for unknown id', () => {
    expect(getBgProcess(db, 'no-such-process')).toBeNull();
  });

  test('listBgProcessesBySession returns rows for the session, newest spawn first', () => {
    insert({ label: 'a', spawnedAt: 100 });
    insert({ label: 'b', spawnedAt: 300 });
    insert({ label: 'c', spawnedAt: 200 });
    const list = listBgProcessesBySession(db, sessionId);
    expect(list.map((p) => p.label)).toEqual(['b', 'c', 'a']);
  });

  test('listBgProcessesBySession scopes by session', () => {
    const otherSession = createSession(db, { model: 'm', cwd: '/p' }).id;
    insert({ label: 'mine' });
    insertBgProcess(db, {
      sessionId: otherSession,
      label: 'theirs',
      command: 'sleep 60',
      cwd: '/tmp',
      stdoutLogPath: '/tmp/y.stdout',
      stderrLogPath: '/tmp/y.stderr',
    });
    const mine = listBgProcessesBySession(db, sessionId);
    expect(mine.map((p) => p.label)).toEqual(['mine']);
  });

  test('listBgProcessesBySession filters by single status', () => {
    const a = insert({ label: 'a' });
    const b = insert({ label: 'b' });
    insert({ label: 'c' });
    finalizeBgProcess(db, { id: a.id, status: 'exited', exitCode: 0 });
    finalizeBgProcess(db, { id: b.id, status: 'killed' });
    const running = listBgProcessesBySession(db, sessionId, { status: 'running' });
    expect(running.map((p) => p.label)).toEqual(['c']);
    const exited = listBgProcessesBySession(db, sessionId, { status: 'exited' });
    expect(exited.map((p) => p.label)).toEqual(['a']);
  });

  test('listBgProcessesBySession filters by status array', () => {
    const a = insert({ label: 'a' });
    const b = insert({ label: 'b' });
    insert({ label: 'c' });
    finalizeBgProcess(db, { id: a.id, status: 'exited', exitCode: 0 });
    finalizeBgProcess(db, { id: b.id, status: 'killed' });
    const final = listBgProcessesBySession(db, sessionId, { status: ['exited', 'killed'] });
    expect(final.map((p) => p.label).sort()).toEqual(['a', 'b']);
  });

  test('advanceBgProcessStdoutCursor updates only stdout cursor', () => {
    const proc = insert({ label: 'dev' });
    advanceBgProcessStdoutCursor(db, proc.id, 1024);
    const fetched = getBgProcess(db, proc.id);
    expect(fetched?.stdoutCursorPosition).toBe(1024);
    expect(fetched?.stderrCursorPosition).toBe(0);
    expect(fetched?.label).toBe('dev');
    expect(fetched?.status).toBe('running');
  });

  test('advanceBgProcessStderrCursor updates only stderr cursor', async () => {
    const { advanceBgProcessStderrCursor } = await import(
      '../../src/storage/repos/bg-processes.ts'
    );
    const proc = insert({ label: 'noisy-stderr' });
    advanceBgProcessStderrCursor(db, proc.id, 512);
    const fetched = getBgProcess(db, proc.id);
    expect(fetched?.stderrCursorPosition).toBe(512);
    expect(fetched?.stdoutCursorPosition).toBe(0);
  });

  test('finalizeBgProcess marks exited with code and timestamp', () => {
    const proc = insert();
    finalizeBgProcess(db, { id: proc.id, status: 'exited', exitCode: 0, exitedAt: 5000 });
    const fetched = getBgProcess(db, proc.id);
    expect(fetched?.status).toBe('exited');
    expect(fetched?.exitCode).toBe(0);
    expect(fetched?.exitedAt).toBe(5000);
  });

  test('finalizeBgProcess accepts killed without exit_code', () => {
    const proc = insert();
    finalizeBgProcess(db, { id: proc.id, status: 'killed' });
    const fetched = getBgProcess(db, proc.id);
    expect(fetched?.status).toBe('killed');
    expect(fetched?.exitCode).toBeNull();
  });

  test('markRunningAsKilled flips only running rows for the session', () => {
    const a = insert({ label: 'a' });
    const b = insert({ label: 'b' });
    const c = insert({ label: 'c' });
    finalizeBgProcess(db, { id: c.id, status: 'exited', exitCode: 0 });
    const touched = markRunningAsKilled(db, sessionId);
    expect(touched).toBe(2);
    expect(getBgProcess(db, a.id)?.status).toBe('killed');
    expect(getBgProcess(db, b.id)?.status).toBe('killed');
    // already-exited row is left alone
    expect(getBgProcess(db, c.id)?.status).toBe('exited');
  });

  test('markRunningAsKilled returns 0 when no running rows exist', () => {
    const a = insert();
    finalizeBgProcess(db, { id: a.id, status: 'exited', exitCode: 0 });
    expect(markRunningAsKilled(db, sessionId)).toBe(0);
  });

  test('CHECK rejects unknown status value', () => {
    expect(() =>
      db
        .query(
          `INSERT INTO background_processes
             (id, session_id, command, cwd, spawned_at, status, stdout_log_path, stderr_log_path)
           VALUES (?, ?, 'x', '/tmp', 0, 'bogus', '/a', '/b')`,
        )
        .run(crypto.randomUUID(), sessionId),
    ).toThrow();
  });

  test('FK on session_id cascades on session delete', () => {
    insert();
    db.query('DELETE FROM sessions WHERE id = ?').run(sessionId);
    expect(listBgProcessesBySession(db, sessionId)).toEqual([]);
  });
});
