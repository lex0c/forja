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
import { bashListTool } from '../../src/tools/builtin/bash-list.ts';
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
  const dir = mkdtempSync(join(tmpdir(), 'forja-bg-list-'));
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

describe('bash_list tool', () => {
  test('empty session lists nothing with zero counts', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashListTool.execute({}, ctx);
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.processes).toEqual([]);
    expect(r.running).toBe(0);
    expect(r.total).toBe(0);
  });

  test('recovers a finished process id with command, status and exit code', async () => {
    const spawned = await mgr.spawn({ command: 'echo done', label: 'build' });
    await waitForExit(spawned.id);
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashListTool.execute({}, ctx);
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.total).toBe(1);
    const entry = r.processes.find((p) => p.process_id === spawned.id);
    expect(entry).toBeDefined();
    expect(entry?.command).toBe('echo done');
    expect(entry?.label).toBe('build');
    expect(entry?.status).toBe('exited');
    expect(entry?.exit_code).toBe(0);
    expect(typeof entry?.spawned_at).toBe('number');
  });

  test('status filter narrows the rows but counts reflect the full set', async () => {
    const a = await mgr.spawn({ command: 'echo a' });
    const b = await mgr.spawn({ command: 'echo b' });
    await waitForExit(a.id);
    await waitForExit(b.id);
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    // Filter to a status with no rows — list is empty, but total/running
    // reflect the full session (both exited).
    const r = await bashListTool.execute({ status: 'running' }, ctx);
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.processes).toEqual([]);
    expect(r.running).toBe(0);
    expect(r.total).toBe(2);
    // Filter to 'exited' returns both.
    const r2 = await bashListTool.execute({ status: 'exited' }, ctx);
    if (isToolError(r2)) throw new Error(`unexpected: ${r2.error_message}`);
    expect(r2.processes).toHaveLength(2);
    expect(r2.total).toBe(2);
  });

  test('errors when no bg manager is wired', async () => {
    const ctx = makeCtx({ sessionId });
    const r = await bashListTool.execute({}, ctx);
    expect(isToolError(r)).toBe(true);
    if (isToolError(r)) expect(r.error_code).toBe('bg.manager_unavailable');
  });

  test('rejects an invalid status value', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    // @ts-expect-error — exercising the runtime guard against unvalidated model JSON
    const r = await bashListTool.execute({ status: 'bogus' }, ctx);
    expect(isToolError(r)).toBe(true);
  });
});
