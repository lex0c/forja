import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(typeof r.payload?.mtimeMs).toBe('number');
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
