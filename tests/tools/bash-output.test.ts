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
import { bashOutputTool } from '../../src/tools/builtin/bash-output.ts';
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

describe('bash_output tool', () => {
  test('reads stdout/stderr after spawn and reports terminal status', async () => {
    const spawned = await mgr.spawn({ command: 'echo hello-out; echo to-err 1>&2' });
    await waitForExit(spawned.id);
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashOutputTool.execute({ process_id: spawned.id }, ctx);
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.stdout).toContain('hello-out');
    expect(r.stderr).toContain('to-err');
    expect(r.status).toBe('exited');
    expect(r.exit_code).toBe(0);
    expect(r.stdout_pending).toBe(0);
    expect(r.stdout_cursor).toBeGreaterThan(0);
    expect(r.stderr_cursor).toBeGreaterThan(0);
  });

  test('returns empty on second read after caught up', async () => {
    const spawned = await mgr.spawn({ command: 'echo x' });
    await waitForExit(spawned.id);
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    await bashOutputTool.execute({ process_id: spawned.id }, ctx);
    const second = await bashOutputTool.execute({ process_id: spawned.id }, ctx);
    if (isToolError(second)) throw new Error('unexpected');
    expect(second.stdout).toBe('');
    expect(second.stdout_pending).toBe(0);
  });

  test('respects max_bytes and reports stdout_pending', async () => {
    const spawned = await mgr.spawn({ command: `printf 'x%.0s' {1..100}` });
    await waitForExit(spawned.id);
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashOutputTool.execute({ process_id: spawned.id, max_bytes: 30 }, ctx);
    if (isToolError(r)) throw new Error('unexpected');
    expect(r.stdout.length).toBe(30);
    expect(r.stdout_pending).toBe(70);
  });

  test('honors explicit since_stdout/since_stderr (replay)', async () => {
    const spawned = await mgr.spawn({ command: 'echo abcdef' });
    await waitForExit(spawned.id);
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    await bashOutputTool.execute({ process_id: spawned.id }, ctx);
    const replay = await bashOutputTool.execute(
      { process_id: spawned.id, since_stdout: 0, since_stderr: 0 },
      ctx,
    );
    if (isToolError(replay)) throw new Error('unexpected');
    expect(replay.stdout).toContain('abcdef');
  });

  test('returns bg.process_not_found on unknown id', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashOutputTool.execute({ process_id: 'nope' }, ctx);
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('bg.process_not_found');
  });

  test('returns bg.manager_unavailable when ctx lacks manager', async () => {
    const ctx = makeCtx({ sessionId });
    const r = await bashOutputTool.execute({ process_id: 'x' }, ctx);
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('bg.manager_unavailable');
  });

  test('rejects empty process_id', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashOutputTool.execute({ process_id: '' }, ctx);
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
  });
});
