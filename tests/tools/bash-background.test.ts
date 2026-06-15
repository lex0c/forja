import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
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

  test('empty-string label is treated as omitted (stored as null, not "")', async () => {
    // A model passing label:'' means "no label", not a meaningful empty
    // name; storing '' would only pollute the tray / audit row. It must
    // behave exactly like omission.
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashBackgroundTool.execute({ command: 'true', label: '' }, ctx);
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

  test('omitted cwd defaults to ctx.cwd, not process.cwd()', async () => {
    // Session cwd is a tmp dir distinct from the harness's process
    // dir. Without the fix, the spawn falls through to process.cwd()
    // and `pwd` echoes the harness directory; with the fix it
    // echoes the session dir.
    const sessionCwd = mkdtempSync(join(tmpdir(), 'forja-bg-cwd-'));
    tempRoots.push(sessionCwd);
    const ctx = makeCtx({ sessionId, bgManager: mgr, cwd: sessionCwd });
    const r = await bashBackgroundTool.execute({ command: 'pwd' }, ctx);
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    await waitForExit(r.process_id);
    const out = await mgr.readOutput(r.process_id);
    expect(out.stdout.trim()).toBe(sessionCwd);
  });

  test('relative cwd resolves against ctx.cwd', async () => {
    // Session cwd has a `sub/` subdirectory. Passing args.cwd='sub'
    // (relative) should land in <session>/sub, not process.cwd()/sub.
    const { mkdirSync } = await import('node:fs');
    const sessionCwd = mkdtempSync(join(tmpdir(), 'forja-bg-cwd-'));
    tempRoots.push(sessionCwd);
    mkdirSync(join(sessionCwd, 'sub'));
    const ctx = makeCtx({ sessionId, bgManager: mgr, cwd: sessionCwd });
    const r = await bashBackgroundTool.execute({ command: 'pwd', cwd: 'sub' }, ctx);
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    await waitForExit(r.process_id);
    const out = await mgr.readOutput(r.process_id);
    expect(out.stdout.trim()).toBe(join(sessionCwd, 'sub'));
  });

  test('absolute cwd inside session subtree is used as-is', async () => {
    // Slice 160 (review): the pre-slice test allowed ANY absolute
    // path; that was the bypass attack closed by this slice. Updated
    // to use an absolute path INSIDE the session subtree, which is
    // the legitimate use case.
    const sessionCwd = mkdtempSync(join(tmpdir(), 'forja-bg-cwd-'));
    const innerDir = join(sessionCwd, 'inner');
    mkdirSync(innerDir, { recursive: true });
    tempRoots.push(sessionCwd);
    const ctx = makeCtx({ sessionId, bgManager: mgr, cwd: sessionCwd });
    const r = await bashBackgroundTool.execute({ command: 'pwd', cwd: innerDir }, ctx);
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    await waitForExit(r.process_id);
    const out = await mgr.readOutput(r.process_id);
    // Allow canonical form drift (e.g. /private/var/folders on darwin
    // firmlinks) — compare against the realpath of innerDir.
    const realInner = realpathSync(innerDir);
    expect(out.stdout.trim()).toBe(realInner);
  });

  test('absolute cwd OUTSIDE session subtree refuses with tool.invalid_arg (slice 160)', async () => {
    // The original threat closed by slice 160: model emits cwd
    // pointing at a directory outside the session, broker honored
    // it, exec ran outside the engine's capability attribution.
    const sessionCwd = mkdtempSync(join(tmpdir(), 'forja-bg-cwd-'));
    const otherDir = mkdtempSync(join(tmpdir(), 'forja-bg-other-'));
    tempRoots.push(sessionCwd, otherDir);
    const ctx = makeCtx({ sessionId, bgManager: mgr, cwd: sessionCwd });
    const r = await bashBackgroundTool.execute({ command: 'pwd', cwd: otherDir }, ctx);
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('outside session subtree');
  });

  // max_runtime_ms is documented in the schema as `minimum: 100`, but
  // model JSON arrives unvalidated against the schema. Without a
  // runtime check, a non-numeric value coerces to NaN inside
  // setTimeout (effective ~1ms terminate) and a numeric value <100ms
  // kills the process before any useful work — defeating the
  // documented "minimum runtime cap" semantics.
  test('rejects max_runtime_ms below the 100ms minimum', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashBackgroundTool.execute({ command: 'sleep 1', max_runtime_ms: 1 }, ctx);
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('max_runtime_ms');
  });

  test('rejects non-numeric max_runtime_ms', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashBackgroundTool.execute(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
      { command: 'sleep 1', max_runtime_ms: 'abc' as any },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
  });

  test('rejects non-integer max_runtime_ms', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashBackgroundTool.execute({ command: 'sleep 1', max_runtime_ms: 500.5 }, ctx);
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
  });

  test('accepts max_runtime_ms at the 100ms minimum', async () => {
    // Sanity: the minimum boundary itself is allowed. Tool returns
    // process_id; the manager handles termination via its own
    // SIGTERM → SIGKILL grace cycle.
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashBackgroundTool.execute({ command: 'sleep 0.05', max_runtime_ms: 100 }, ctx);
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(typeof r.process_id).toBe('string');
    await waitForExit(r.process_id);
  });

  // Slice 150 (review): type-check label and cwd. Pre-slice these
  // arrived from the LLM unvalidated and reached the manager /
  // storage layer with wrong types (label=42 landed in audit logs
  // as a non-string; cwd=42 threw ERR_INVALID_ARG_TYPE inside
  // isAbsolute and surfaced as `internalError` instead of a clean
  // tool error).
  test('rejects non-string label', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashBackgroundTool.execute(
      // biome-ignore lint/suspicious/noExplicitAny: synthesizing bad model input
      { command: 'true', label: 42 as any },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('label must be a string');
  });

  test('rejects non-string cwd', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashBackgroundTool.execute(
      // biome-ignore lint/suspicious/noExplicitAny: synthesizing bad model input
      { command: 'true', cwd: 42 as any },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('cwd must be a string');
  });

  test('accepts label as null-ish (undefined)', async () => {
    // label is optional; omitting must not trip the type check.
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashBackgroundTool.execute({ command: 'true' }, ctx);
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.label).toBeNull();
    await waitForExit(r.process_id);
  });
});
