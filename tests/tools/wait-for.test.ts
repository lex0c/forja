import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BgManager, createBgManager } from '../../src/bg/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { waitForTool } from '../../src/tools/builtin/wait-for.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

const tempRoots: string[] = [];

const mktemp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'forja-wait-tool-'));
  tempRoots.push(d);
  return d;
};

afterEach(() => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  tempRoots.length = 0;
});

describe('wait_for tool: happy paths', () => {
  test('sleep matches at requested duration', async () => {
    const ctx = makeCtx();
    const r = await waitForTool.execute(
      { condition: { kind: 'sleep', duration_ms: 100 }, timeout_ms: 5000 },
      ctx,
    );
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.matched).toBe(true);
    expect(r.condition_met).toBe('sleep');
    expect(r.elapsed_ms).toBeGreaterThanOrEqual(80);
  });

  test('file_exists with absolute path matches when file appears', async () => {
    const dir = mktemp();
    const path = join(dir, 'x.txt');
    setTimeout(() => writeFileSync(path, 'hi'), 100);
    const ctx = makeCtx();
    const r = await waitForTool.execute(
      {
        condition: { kind: 'file_exists', path },
        timeout_ms: 5000,
        poll_interval_ms: 50,
      },
      ctx,
    );
    if (isToolError(r)) throw new Error('unexpected');
    expect(r.matched).toBe(true);
    expect(r.condition_met).toBe('file_exists');
  });

  test('file_exists with relative path resolves against ctx.cwd', async () => {
    // Lesson from bash_background commit 509f964: relative paths
    // must land in the session dir, not process.cwd(). This test
    // pins that contract for wait_for.
    const dir = mktemp();
    const fileName = 'session-relative.txt';
    writeFileSync(join(dir, fileName), 'present');
    const ctx = makeCtx({ cwd: dir });
    const r = await waitForTool.execute(
      { condition: { kind: 'file_exists', path: fileName }, timeout_ms: 1000 },
      ctx,
    );
    if (isToolError(r)) throw new Error('unexpected');
    expect(r.matched).toBe(true);
    // Payload should carry the resolved absolute path.
    expect(r.payload?.path).toBe(join(dir, fileName));
  });

  test('file_change captures previous and new mtime in payload', async () => {
    const dir = mktemp();
    const path = join(dir, 'mut.txt');
    writeFileSync(path, 'a');
    setTimeout(() => writeFileSync(path, 'b'), 150);
    const ctx = makeCtx();
    const r = await waitForTool.execute(
      {
        condition: { kind: 'file_change', path },
        timeout_ms: 5000,
        poll_interval_ms: 50,
      },
      ctx,
    );
    if (isToolError(r)) throw new Error('unexpected');
    expect(r.matched).toBe(true);
    expect(typeof r.payload?.mtime_ms).toBe('number');
  });
});

describe('wait_for tool: timeout reporting', () => {
  test('reports matched=false / condition_met=timeout', async () => {
    const ctx = makeCtx();
    const r = await waitForTool.execute(
      {
        condition: { kind: 'file_exists', path: '/nonexistent/never/matches' },
        timeout_ms: 100,
        poll_interval_ms: 50,
      },
      ctx,
    );
    if (isToolError(r)) throw new Error('unexpected');
    expect(r.matched).toBe(false);
    expect(r.condition_met).toBe('timeout');
  });
});

describe('wait_for tool: signal propagation', () => {
  test('respects ctx.signal abort', async () => {
    const ac = new AbortController();
    const ctx = makeCtx({ signal: ac.signal });
    const promise = waitForTool.execute(
      { condition: { kind: 'sleep', duration_ms: 30000 }, timeout_ms: 30000 },
      ctx,
    );
    setTimeout(() => ac.abort(), 50);
    const r = await promise;
    if (isToolError(r)) {
      // Pre-abort caught by the early-return guard
      expect(r.error_code).toBe('tool.aborted');
      return;
    }
    expect(r.matched).toBe(false);
    expect(r.condition_met).toBe('aborted');
  });

  test('returns aborted tool error when ctx.signal is already aborted at entry', async () => {
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ signal: ac.signal });
    const r = await waitForTool.execute(
      { condition: { kind: 'sleep', duration_ms: 100 }, timeout_ms: 1000 },
      ctx,
    );
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('tool.aborted');
  });
});

describe('wait_for tool: input validation', () => {
  test('rejects unknown kind', async () => {
    const ctx = makeCtx();
    const r = await waitForTool.execute(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
      { condition: { kind: 'bogus' } as any, timeout_ms: 100 },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('unknown condition.kind');
  });

  test('rejects missing required field per kind', async () => {
    const ctx = makeCtx();
    const r = await waitForTool.execute(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
      { condition: { kind: 'port_open' } as any, timeout_ms: 100 },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
  });

  test('rejects negative timeout_ms', async () => {
    const ctx = makeCtx();
    const r = await waitForTool.execute(
      { condition: { kind: 'sleep', duration_ms: 100 }, timeout_ms: 0 },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
  });

  test('rejects invalid redirect mode', async () => {
    const ctx = makeCtx();
    // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
    const cond = { kind: 'http_response', url: 'http://x', redirect: 'bogus' } as any;
    const r = await waitForTool.execute({ condition: cond, timeout_ms: 100 }, ctx);
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('redirect');
  });

  test('rejects port out of range', async () => {
    const ctx = makeCtx();
    const r = await waitForTool.execute(
      { condition: { kind: 'port_open', host: 'x', port: 70000 }, timeout_ms: 100 },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
  });

  test('rejects relative path with .. traversal', async () => {
    const ctx = makeCtx({ cwd: mktemp() });
    const r = await waitForTool.execute(
      {
        condition: { kind: 'file_exists', path: '../../etc/passwd' },
        timeout_ms: 100,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain("must not contain '..'");
  });

  test('rejects absolute path with .. traversal', async () => {
    const ctx = makeCtx({ cwd: mktemp() });
    const r = await waitForTool.execute(
      {
        condition: { kind: 'file_change', path: '/foo/../etc/passwd' },
        timeout_ms: 100,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
  });

  test('accepts filename containing literal `..` (not a segment)', async () => {
    // `foo..txt` is a single filename with two literal dots — NOT a
    // path traversal. The split-by-separator check should not reject
    // this since `..` is part of the filename, not a standalone
    // segment.
    const dir = mktemp();
    const path = join(dir, 'foo..txt');
    writeFileSync(path, 'hi');
    const ctx = makeCtx({ cwd: dir });
    const r = await waitForTool.execute(
      { condition: { kind: 'file_exists', path: 'foo..txt' }, timeout_ms: 1000 },
      ctx,
    );
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.matched).toBe(true);
  });
});

describe('wait_for tool: composition (all_of / any_of)', () => {
  test('any_of via tool surface — empty array waits out timeout', async () => {
    const ctx = makeCtx();
    const r = await waitForTool.execute(
      { condition: { kind: 'any_of', conditions: [] }, timeout_ms: 100 },
      ctx,
    );
    if (isToolError(r)) throw new Error('unexpected');
    expect(r.matched).toBe(false);
    expect(r.condition_met).toBe('timeout');
  });

  test('all_of via tool surface — empty array matches immediately', async () => {
    const ctx = makeCtx();
    const r = await waitForTool.execute(
      { condition: { kind: 'all_of', conditions: [] }, timeout_ms: 5000 },
      ctx,
    );
    if (isToolError(r)) throw new Error('unexpected');
    expect(r.matched).toBe(true);
    expect(r.condition_met).toBe('all_of');
  });

  test('any_of recursive validation — bad nested kind rejected', async () => {
    const ctx = makeCtx();
    const r = await waitForTool.execute(
      {
        condition: {
          kind: 'any_of',
          conditions: [
            { kind: 'sleep', duration_ms: 100 },
            // biome-ignore lint/suspicious/noExplicitAny: testing invalid nested
            { kind: 'bogus' } as any,
          ],
        },
        timeout_ms: 100,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('any_of.conditions[1]');
  });

  test('depth limit rejects deeply nested composition', async () => {
    // 6 levels of nesting — exceeds MAX_COMPOSITION_DEPTH (5).
    const nested = (depth: number): unknown =>
      depth === 0
        ? { kind: 'sleep', duration_ms: 1 }
        : { kind: 'all_of', conditions: [nested(depth - 1)] };
    const ctx = makeCtx();
    const r = await waitForTool.execute(
      // biome-ignore lint/suspicious/noExplicitAny: testing depth limit
      { condition: nested(7) as any, timeout_ms: 100 },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('depth');
  });

  test('process_* nested in any_of surfaces bg.manager_unavailable when ctx lacks manager', async () => {
    // Critical: the top-level kind is any_of (NOT process_*), so the
    // simple top-level check would miss this. The deep walk via
    // containsProcessCondition catches it.
    const ctx = makeCtx(); // no bgManager
    const r = await waitForTool.execute(
      {
        condition: {
          kind: 'any_of',
          conditions: [
            { kind: 'sleep', duration_ms: 5000 },
            { kind: 'process_exit', process_id: 'x' },
          ],
        },
        timeout_ms: 1000,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('bg.manager_unavailable');
  });

  test('any_of races sleep against file_exists via tool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-wait-tool-comp-'));
    tempRoots.push(dir);
    const path = join(dir, 'present.txt');
    writeFileSync(path, 'x');
    const ctx = makeCtx();
    const r = await waitForTool.execute(
      {
        condition: {
          kind: 'any_of',
          conditions: [
            { kind: 'sleep', duration_ms: 5000 },
            { kind: 'file_exists', path },
          ],
        },
        timeout_ms: 10000,
        poll_interval_ms: 50,
      },
      ctx,
    );
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.matched).toBe(true);
    expect(r.condition_met).toBe('any_of');
    expect(r.payload?.matched_index).toBe(1);
  });
});

describe('wait_for tool: process_* conditions', () => {
  let db: DB;
  let sessionId: string;
  let mgr: BgManager;
  const procRoots: string[] = [];

  beforeEach(() => {
    db = openMemoryDb();
    migrate(db);
    sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
    const dir = mkdtempSync(join(tmpdir(), 'forja-wait-tool-proc-'));
    procRoots.push(dir);
    mgr = createBgManager({ db, sessionId, logDir: dir });
  });

  afterEach(async () => {
    await mgr.cleanup();
    for (const root of procRoots) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {}
    }
    procRoots.length = 0;
  });

  test('process_exit reports exit code in payload', async () => {
    const spawned = await mgr.spawn({ command: 'sleep 0.1; exit 13' });
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await waitForTool.execute(
      {
        condition: { kind: 'process_exit', process_id: spawned.id },
        timeout_ms: 5000,
        poll_interval_ms: 50,
      },
      ctx,
    );
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.matched).toBe(true);
    expect(r.condition_met).toBe('process_exit');
    expect(r.payload?.exit_code).toBe(13);
  });

  test('process_output literal pattern (default is_regex=false)', async () => {
    // Pattern contains regex meta `.` — literal mode escapes it so
    // it matches "1.0" only, not "100".
    const spawned = await mgr.spawn({ command: 'sleep 0.1; echo "version 1.0"' });
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await waitForTool.execute(
      {
        condition: { kind: 'process_output', process_id: spawned.id, pattern: 'version 1.0' },
        timeout_ms: 5000,
        poll_interval_ms: 50,
      },
      ctx,
    );
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.matched).toBe(true);
    expect(r.payload?.match).toBe('version 1.0');
  });

  test('process_output literal does NOT match wildcard interpretations', async () => {
    // Pattern "1.0" as literal escapes the `.`. With is_regex=false
    // (default), this should NOT match "100".
    const spawned = await mgr.spawn({ command: 'echo "version 100"; sleep 0.05' });
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await waitForTool.execute(
      {
        condition: { kind: 'process_output', process_id: spawned.id, pattern: '1.0' },
        timeout_ms: 200,
        poll_interval_ms: 50,
      },
      ctx,
    );
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.matched).toBe(false);
    expect(r.payload?.process_exited).toBe(true);
  });

  test('process_output is_regex=true compiles pattern as regex', async () => {
    const spawned = await mgr.spawn({ command: 'sleep 0.1; echo "ERROR: code 42"' });
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await waitForTool.execute(
      {
        condition: {
          kind: 'process_output',
          process_id: spawned.id,
          pattern: 'ERROR:\\s+code\\s+\\d+',
          is_regex: true,
        },
        timeout_ms: 5000,
        poll_interval_ms: 50,
      },
      ctx,
    );
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.matched).toBe(true);
    expect(r.payload?.match).toMatch(/^ERROR:\s+code\s+\d+$/);
  });

  test('rejects invalid regex when is_regex=true', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await waitForTool.execute(
      {
        condition: {
          kind: 'process_output',
          process_id: 'x',
          pattern: '[unclosed',
          is_regex: true,
        },
        timeout_ms: 100,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('not a valid regex');
  });

  test('rejects empty pattern', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await waitForTool.execute(
      {
        condition: { kind: 'process_output', process_id: 'x', pattern: '' },
        timeout_ms: 100,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('pattern');
  });

  test('returns bg.process_not_found on unknown process_id', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await waitForTool.execute(
      {
        condition: { kind: 'process_exit', process_id: 'no-such-id' },
        timeout_ms: 1000,
        poll_interval_ms: 50,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('bg.process_not_found');
  });

  test('returns bg.manager_unavailable when ctx lacks manager', async () => {
    // Ctx without bgManager — common case is plain harness without
    // bg subsystem wired up.
    const ctx = makeCtx({ sessionId });
    const r = await waitForTool.execute(
      {
        condition: { kind: 'process_exit', process_id: 'x' },
        timeout_ms: 1000,
        poll_interval_ms: 50,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('bg.manager_unavailable');
  });

  test('rejects empty process_id', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await waitForTool.execute(
      {
        condition: { kind: 'process_exit', process_id: '' },
        timeout_ms: 100,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
  });
});
