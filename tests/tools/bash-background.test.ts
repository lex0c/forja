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
import { bashBackgroundTool } from '../../src/tools/builtin/bash-background.ts';
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

describe('bash_background tool', () => {
  test('spawns and returns process metadata', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashBackgroundTool.execute({ command: 'true', label: 'unit' }, ctx);
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    expect(r.process_id).toBeString();
    expect(r.os_pid).toBeGreaterThan(0);
    expect(r.label).toBe('unit');
    expect(r.spawned_at).toBeGreaterThan(0);
    await waitForExit(r.process_id);
  });

  test('label is null when omitted', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashBackgroundTool.execute({ command: 'true' }, ctx);
    if (isToolError(r)) throw new Error('expected success');
    expect(r.label).toBeNull();
    await waitForExit(r.process_id);
  });

  test('returns clean error when bgManager missing from ctx', async () => {
    const ctx = makeCtx({ sessionId });
    const r = await bashBackgroundTool.execute({ command: 'true' }, ctx);
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('bg.manager_unavailable');
  });

  test('returns clean error on aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ sessionId, bgManager: mgr, signal: ac.signal });
    const r = await bashBackgroundTool.execute({ command: 'true' }, ctx);
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('tool.aborted');
  });

  test('rejects empty command', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashBackgroundTool.execute({ command: '' }, ctx);
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('tool.invalid_arg');
  });
});
