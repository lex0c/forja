import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import {
  getProcessRecord,
  listOrphanedProcesses,
  listProcessesByParent,
  markIpcHandshakeOk,
  recordProcessExit,
  recordProcessSpawn,
} from '../../src/storage/repos/subagent-processes.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

const seedSession = (cwd = '/p'): string => createSession(db, { model: 'm', cwd }).id;

describe('subagent_processes repo', () => {
  test('recordProcessSpawn + getProcessRecord round-trip', () => {
    const parent = seedSession();
    const child = seedSession();
    recordProcessSpawn(db, {
      sessionId: child,
      parentSessionId: parent,
      pid: 12_345,
      argvHash: 'a'.repeat(64),
      spawnedAt: 1_700_000_000_000,
      stderrLogPath: '/tmp/agent/bg/subagents/child/stderr.log',
    });
    const row = getProcessRecord(db, child);
    expect(row).not.toBeNull();
    expect(row?.sessionId).toBe(child);
    expect(row?.parentSessionId).toBe(parent);
    expect(row?.pid).toBe(12_345);
    expect(row?.spawnedAt).toBe(1_700_000_000_000);
    // Pre-handshake state.
    expect(row?.ipcHandshakeOk).toBe(false);
    expect(row?.exitedAt).toBeNull();
    expect(row?.exitCode).toBeNull();
    expect(row?.exitSignal).toBeNull();
    expect(row?.exitReason).toBeNull();
  });

  test('recordProcessSpawn allows null parentSessionId + null stderrLogPath', () => {
    // Top-level runs (no parent) and headless / test fixtures
    // (no log dir) should still be recordable. Without nullable
    // columns the audit table couldn't represent these shapes.
    const child = seedSession();
    recordProcessSpawn(db, {
      sessionId: child,
      parentSessionId: null,
      pid: 1,
      argvHash: 'b'.repeat(64),
      spawnedAt: 1,
      stderrLogPath: null,
    });
    const row = getProcessRecord(db, child);
    expect(row?.parentSessionId).toBeNull();
    expect(row?.stderrLogPath).toBeNull();
  });

  test('markIpcHandshakeOk flips the flag and is idempotent', () => {
    const child = seedSession();
    recordProcessSpawn(db, {
      sessionId: child,
      parentSessionId: null,
      pid: 1,
      argvHash: 'c'.repeat(64),
      spawnedAt: 1,
      stderrLogPath: null,
    });
    markIpcHandshakeOk(db, child);
    expect(getProcessRecord(db, child)?.ipcHandshakeOk).toBe(true);
    // Second call: no-op (the WHERE clause short-circuits). The
    // outward state is identical — pinned so a regression that
    // makes this throw on a re-handshake surfaces as a test
    // failure rather than a runtime exception.
    markIpcHandshakeOk(db, child);
    expect(getProcessRecord(db, child)?.ipcHandshakeOk).toBe(true);
  });

  test('markIpcHandshakeOk on an unknown session_id is a silent no-op', () => {
    // No row, no throw. Audit writes never break the spawn path.
    markIpcHandshakeOk(db, 'sess-does-not-exist');
    expect(getProcessRecord(db, 'sess-does-not-exist')).toBeNull();
  });

  test('recordProcessExit fills exit_* columns and sets exit_reason', () => {
    const child = seedSession();
    recordProcessSpawn(db, {
      sessionId: child,
      parentSessionId: null,
      pid: 1,
      argvHash: 'd'.repeat(64),
      spawnedAt: 1,
      stderrLogPath: null,
    });
    recordProcessExit(db, {
      sessionId: child,
      exitedAt: 1_700_000_005_000,
      exitCode: 0,
      exitSignal: null,
      exitReason: 'normal',
    });
    const row = getProcessRecord(db, child);
    expect(row?.exitedAt).toBe(1_700_000_005_000);
    expect(row?.exitCode).toBe(0);
    expect(row?.exitSignal).toBeNull();
    expect(row?.exitReason).toBe('normal');
  });

  test('recordProcessExit with signal + null exit_code persists the signal exit shape', () => {
    // POSIX: signal-killed processes have no meaningful exit code.
    // The repo persists exit_code as NULL so audit queries can
    // filter signal exits via WHERE exit_signal IS NOT NULL
    // without false-positive on exitCode=0 normal exits.
    const child = seedSession();
    recordProcessSpawn(db, {
      sessionId: child,
      parentSessionId: null,
      pid: 1,
      argvHash: 'e'.repeat(64),
      spawnedAt: 1,
      stderrLogPath: null,
    });
    recordProcessExit(db, {
      sessionId: child,
      exitedAt: 2,
      exitCode: null,
      exitSignal: 'SIGSEGV',
      exitReason: 'signal',
    });
    const row = getProcessRecord(db, child);
    expect(row?.exitCode).toBeNull();
    expect(row?.exitSignal).toBe('SIGSEGV');
    expect(row?.exitReason).toBe('signal');
  });

  test('listProcessesByParent orders by spawned_at ASC and only includes direct children', () => {
    const parentA = seedSession();
    const parentB = seedSession();
    const c1 = seedSession();
    const c2 = seedSession();
    const c3 = seedSession();
    recordProcessSpawn(db, {
      sessionId: c1,
      parentSessionId: parentA,
      pid: 100,
      argvHash: '1'.repeat(64),
      spawnedAt: 200,
      stderrLogPath: null,
    });
    recordProcessSpawn(db, {
      sessionId: c2,
      parentSessionId: parentA,
      pid: 101,
      argvHash: '2'.repeat(64),
      spawnedAt: 100, // earlier
      stderrLogPath: null,
    });
    recordProcessSpawn(db, {
      sessionId: c3,
      parentSessionId: parentB,
      pid: 102,
      argvHash: '3'.repeat(64),
      spawnedAt: 50,
      stderrLogPath: null,
    });
    const list = listProcessesByParent(db, parentA);
    expect(list.map((r) => r.sessionId)).toEqual([c2, c1]);
  });

  test('listOrphanedProcesses returns rows with no exit and skips exited ones', () => {
    const c1 = seedSession();
    const c2 = seedSession();
    recordProcessSpawn(db, {
      sessionId: c1,
      parentSessionId: null,
      pid: 1,
      argvHash: 'x'.repeat(64),
      spawnedAt: 1,
      stderrLogPath: null,
    });
    recordProcessSpawn(db, {
      sessionId: c2,
      parentSessionId: null,
      pid: 2,
      argvHash: 'y'.repeat(64),
      spawnedAt: 2,
      stderrLogPath: null,
    });
    recordProcessExit(db, {
      sessionId: c2,
      exitedAt: 3,
      exitCode: 0,
      exitSignal: null,
      exitReason: 'normal',
    });
    const orphans = listOrphanedProcesses(db);
    expect(orphans.map((r) => r.sessionId)).toEqual([c1]);
  });

  test('CASCADE on session_id: deleting the child session drops the row', () => {
    const child = seedSession();
    recordProcessSpawn(db, {
      sessionId: child,
      parentSessionId: null,
      pid: 1,
      argvHash: 'z'.repeat(64),
      spawnedAt: 1,
      stderrLogPath: null,
    });
    db.query('DELETE FROM sessions WHERE id = ?').run(child);
    expect(getProcessRecord(db, child)).toBeNull();
  });

  test('parent_session_id ON DELETE SET NULL: deleting parent keeps the child row', () => {
    const parent = seedSession();
    const child = seedSession();
    recordProcessSpawn(db, {
      sessionId: child,
      parentSessionId: parent,
      pid: 1,
      argvHash: 'w'.repeat(64),
      spawnedAt: 1,
      stderrLogPath: null,
    });
    db.query('DELETE FROM sessions WHERE id = ?').run(parent);
    const row = getProcessRecord(db, child);
    // Child evidence survives parent purge — operator deleted the
    // top-level session but the subprocess audit still stands.
    expect(row).not.toBeNull();
    expect(row?.parentSessionId).toBeNull();
  });

  test('tolerant read: corrupt exit_reason value reads as null without throwing', () => {
    const child = seedSession();
    recordProcessSpawn(db, {
      sessionId: child,
      parentSessionId: null,
      pid: 1,
      argvHash: 'q'.repeat(64),
      spawnedAt: 1,
      stderrLogPath: null,
    });
    db.query(`UPDATE subagent_processes SET exit_reason = 'bogus' WHERE session_id = ?`).run(child);
    const row = getProcessRecord(db, child);
    expect(row).not.toBeNull();
    expect(row?.exitReason).toBeNull();
  });
});
