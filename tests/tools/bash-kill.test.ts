import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BgManager, createBgManager } from '../../src/bg/index.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import type { DB } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { getBgProcess } from '../../src/storage/repos/bg-processes.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { bashKillTool } from '../../src/tools/builtin/bash-kill.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

let db: DB;
let sessionId: string;
let mgr: BgManager;
const tempRoots: string[] = [];

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
  const dir = mkdtempSync(join(tmpdir(), 'forja-bg-tool-'));
  tempRoots.push(dir);
  mgr = createBgManager({ db, sessionId, logDir: dir });
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

describe('bash_kill tool', () => {
  test('terminates a long-running process and returns killed status', async () => {
    const spawned = await mgr.spawn({ command: 'sleep 30' });
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashKillTool.execute({ process_id: spawned.id, grace_period_ms: 1000 }, ctx);
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.status).toBe('killed');
    expect(r.exited_at).toBeGreaterThan(0);
  });

  test('immediate SIGKILL is fast', async () => {
    const spawned = await mgr.spawn({ command: 'sleep 30' });
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const start = Date.now();
    const r = await bashKillTool.execute({ process_id: spawned.id, signal: 'SIGKILL' }, ctx);
    const elapsed = Date.now() - start;
    if (isToolError(r)) throw new Error('unexpected');
    expect(r.status).toBe('killed');
    expect(elapsed).toBeLessThan(500);
  });

  test('idempotent on already-exited process', async () => {
    const spawned = await mgr.spawn({ command: 'true' });
    await waitForExit(spawned.id);
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashKillTool.execute({ process_id: spawned.id }, ctx);
    if (isToolError(r)) throw new Error('unexpected');
    // Whichever status it landed at — exited (natural) or killed
    // (race between exit handler and kill) — both are acceptable.
    expect(['exited', 'killed']).toContain(r.status);
  });

  test('returns bg.process_not_found on unknown id', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashKillTool.execute({ process_id: 'nope' }, ctx);
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('bg.process_not_found');
  });

  test('returns bg.manager_unavailable when ctx lacks manager', async () => {
    const ctx = makeCtx({ sessionId });
    const r = await bashKillTool.execute({ process_id: 'x' }, ctx);
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('bg.manager_unavailable');
  });

  // Validation parity with schema: the schema declares `signal` as an
  // enum and `grace_period_ms` with minimum: 0, but model JSON arrives
  // unvalidated. Without runtime checks, malformed values slip into
  // the manager's sleep path (grace_period_ms='abc' → NaN coerced to
  // ~0ms grace) or into proc.kill() (signal='SIGUSR1' → confusing
  // OS-level failure).
  test('rejects unknown signal value', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashKillTool.execute(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
      { process_id: 'x', signal: 'SIGUSR1' as any },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('signal');
  });

  test('rejects negative grace_period_ms', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashKillTool.execute({ process_id: 'x', grace_period_ms: -100 }, ctx);
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('grace_period_ms');
  });

  test('rejects non-numeric grace_period_ms', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashKillTool.execute(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
      { process_id: 'x', grace_period_ms: 'abc' as any },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
  });

  test('rejects non-integer grace_period_ms', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashKillTool.execute({ process_id: 'x', grace_period_ms: 100.5 }, ctx);
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
  });

  test('accepts grace_period_ms at the 0ms boundary', async () => {
    // Schema permits 0 (means "skip grace, escalate immediately"
    // when used with SIGTERM — operator wants fast SIGKILL fallback).
    // Validation must not over-reject the boundary.
    const spawned = await mgr.spawn({ command: 'sleep 0.05' });
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashKillTool.execute({ process_id: spawned.id, grace_period_ms: 0 }, ctx);
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(['exited', 'killed']).toContain(r.status);
  });
});
