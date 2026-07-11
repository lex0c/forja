// Slice 130: bg/manager mid-session-loss probe.
//
// Test seam pattern: pass `sandboxWhich` to createBgManager so the
// probe can simulate boot-vs-spawn-time divergence without
// depending on the host's PATH state.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBgManager } from '../../src/bg/index.ts';
import { createSqliteFailureSink } from '../../src/failures/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/index.ts';
import { listFailureEventsByCode } from '../../src/storage/repos/failure-events.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

// Passthrough sandbox wrap. These tests assert the mid-session-loss
// PROBE, which runs in `spawn()` BEFORE the sandbox wrap. The real
// wrap (`maybeWrapSandboxArgv`) fail-closes when a boot tool was
// present but no longer resolves — exactly the state these tests set
// up (`sandboxWhich: () => null` + `sandboxBootTool: 'bwrap'`). On a
// host WITH bwrap the wrap succeeded (canonical /usr/bin/bwrap) and
// the spawn ran; on a host WITHOUT it (CI ubuntu-latest) the wrap
// threw and `mgr.spawn()` rejected before the assertions. Pinning a
// passthrough runs the inner argv directly, so the probe assertions
// stand independent of whether the runner has bubblewrap.
const PASSTHROUGH_WRAP = (o: { innerArgv: readonly string[] }): string[] => [...o.innerArgv];

let db: DB;
let sessionId: string;
let logDir: string;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  logDir = mkdtempSync(join(tmpdir(), 'forja-bg-loss-'));
});

afterEach(() => {
  rmSync(logDir, { recursive: true, force: true });
});

describe('bg manager — sandbox.mid_session_loss probe', () => {
  test('emits when boot tool present but spawn-time which returns null', async () => {
    const failureSink = createSqliteFailureSink({ db });
    let whichCallCount = 0;
    const mgr = createBgManager({
      db,
      sessionId,
      logDir,
      failureSink,
      wrapArgv: PASSTHROUGH_WRAP,
      sandboxBootTool: 'bwrap',
      sandboxWhich: () => {
        whichCallCount++;
        // Simulate tool present at boot probe, then missing.
        return null;
      },
    });
    try {
      await mgr.spawn({
        command: 'echo hi',
        sandboxProfile: 'cwd-rw',
      });
      // Probe ran exactly once per spawn.
      expect(whichCallCount).toBe(1);
      const rows = listFailureEventsByCode(db, 'sandbox.mid_session_loss', 0, 10);
      expect(rows.length).toBe(1);
      expect(rows[0]?.session_id).toBe(sessionId);
      const payload = JSON.parse(rows[0]?.payload_json as string);
      expect(payload.tool).toBe('bwrap');
      expect(payload.planned_profile).toBe('cwd-rw');
      expect(payload.detected_at_site).toBe('bg_manager.spawn');
    } finally {
      await mgr.cleanup();
    }
  });

  test('suppresses duplicate emits within the same loss window', async () => {
    const failureSink = createSqliteFailureSink({ db });
    const mgr = createBgManager({
      db,
      sessionId,
      logDir,
      failureSink,
      wrapArgv: PASSTHROUGH_WRAP,
      sandboxBootTool: 'bwrap',
      sandboxWhich: () => null,
    });
    try {
      await mgr.spawn({ command: 'echo a', sandboxProfile: 'cwd-rw' });
      await mgr.spawn({ command: 'echo b', sandboxProfile: 'cwd-rw' });
      await mgr.spawn({ command: 'echo c', sandboxProfile: 'cwd-rw' });
      const rows = listFailureEventsByCode(db, 'sandbox.mid_session_loss', 0, 10);
      expect(rows.length).toBe(1);
    } finally {
      await mgr.cleanup();
    }
  });

  test('resumes emitting after tool reappears + disappears again', async () => {
    const failureSink = createSqliteFailureSink({ db });
    // Sequence: lost → present → lost. Two events expected.
    const responses: Array<string | null> = [null, '/usr/bin/bwrap', null];
    let i = 0;
    const mgr = createBgManager({
      db,
      sessionId,
      logDir,
      failureSink,
      wrapArgv: PASSTHROUGH_WRAP,
      sandboxBootTool: 'bwrap',
      sandboxWhich: () => responses[i++] ?? null,
    });
    try {
      await mgr.spawn({ command: 'echo 1', sandboxProfile: 'cwd-rw' });
      await mgr.spawn({ command: 'echo 2', sandboxProfile: 'cwd-rw' }); // recovers
      await mgr.spawn({ command: 'echo 3', sandboxProfile: 'cwd-rw' });
      const rows = listFailureEventsByCode(db, 'sandbox.mid_session_loss', 0, 10);
      expect(rows.length).toBe(2);
    } finally {
      await mgr.cleanup();
    }
  });

  test('does NOT emit when sandboxProfile is host', async () => {
    const failureSink = createSqliteFailureSink({ db });
    const mgr = createBgManager({
      db,
      sessionId,
      logDir,
      failureSink,
      wrapArgv: PASSTHROUGH_WRAP,
      sandboxBootTool: 'bwrap',
      sandboxWhich: () => null,
    });
    try {
      await mgr.spawn({
        command: 'echo h',
        sandboxProfile: 'host',
      });
      const rows = listFailureEventsByCode(db, 'sandbox.mid_session_loss', 0, 10);
      expect(rows.length).toBe(0);
    } finally {
      await mgr.cleanup();
    }
  });

  test('does NOT emit when sandboxBootTool is undefined (legacy callers)', async () => {
    const failureSink = createSqliteFailureSink({ db });
    const mgr = createBgManager({
      db,
      sessionId,
      logDir,
      failureSink,
      wrapArgv: PASSTHROUGH_WRAP,
      // sandboxBootTool omitted — pre-slice-130 behavior.
      sandboxWhich: () => null,
    });
    try {
      await mgr.spawn({ command: 'echo z', sandboxProfile: 'cwd-rw' });
      const rows = listFailureEventsByCode(db, 'sandbox.mid_session_loss', 0, 10);
      expect(rows.length).toBe(0);
    } finally {
      await mgr.cleanup();
    }
  });

  test('does NOT emit when tool is still available (happy path)', async () => {
    const failureSink = createSqliteFailureSink({ db });
    const mgr = createBgManager({
      db,
      sessionId,
      logDir,
      failureSink,
      wrapArgv: PASSTHROUGH_WRAP,
      sandboxBootTool: 'bwrap',
      sandboxWhich: () => '/usr/bin/bwrap',
    });
    try {
      await mgr.spawn({ command: 'echo n', sandboxProfile: 'cwd-rw' });
      const rows = listFailureEventsByCode(db, 'sandbox.mid_session_loss', 0, 10);
      expect(rows.length).toBe(0);
    } finally {
      await mgr.cleanup();
    }
  });
});
