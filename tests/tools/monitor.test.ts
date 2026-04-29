import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BgManager, createBgManager } from '../../src/bg/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { monitorTool } from '../../src/tools/builtin/monitor.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

let db: DB;
let sessionId: string;
let mgr: BgManager;
const tempRoots: string[] = [];

const mktemp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'forja-monitor-tool-'));
  tempRoots.push(d);
  return d;
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  mgr = createBgManager({ db, sessionId, logDir: mktemp() });
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

describe('monitor tool: happy paths', () => {
  test('process_output_lines via tool collects events', async () => {
    const spawned = await mgr.spawn({
      command: 'echo a; echo b; sleep 0.05',
    });
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await monitorTool.execute(
      {
        condition: { kind: 'process_output_lines', process_id: spawned.id },
        duration_ms: 2000,
        poll_interval_ms: 50,
      },
      ctx,
    );
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    const lines = r.events.map((e) => (e.payload as { line: string }).line);
    expect(lines).toContain('a');
    expect(lines).toContain('b');
    expect(r.reason).toBe('process_exited');
  });

  test('process_output_pattern literal mode escapes regex meta', async () => {
    // Pattern "v1.0" as literal escapes the `.`. Should match
    // "v1.0" exactly, NOT "v100".
    const spawned = await mgr.spawn({
      command: 'echo "v1.0 release"; echo "v100 build"; sleep 0.05',
    });
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await monitorTool.execute(
      {
        condition: {
          kind: 'process_output_pattern',
          process_id: spawned.id,
          pattern: 'v1.0',
        },
        duration_ms: 2000,
        poll_interval_ms: 50,
      },
      ctx,
    );
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.events.length).toBe(1);
    expect((r.events[0]?.payload as { match: string }).match).toBe('v1.0');
  });

  test('process_output_pattern is_regex=true compiles with /g', async () => {
    const spawned = await mgr.spawn({
      command: 'echo "WARN: a"; echo "WARN: b"; echo "INFO: c"; sleep 0.05',
    });
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await monitorTool.execute(
      {
        condition: {
          kind: 'process_output_pattern',
          process_id: spawned.id,
          pattern: 'WARN:\\s+\\w+',
          is_regex: true,
        },
        duration_ms: 2000,
        poll_interval_ms: 50,
      },
      ctx,
    );
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.events.length).toBe(2);
    expect(
      r.events.every((e) => /^WARN:\s+\w+$/.test((e.payload as { match: string }).match)),
    ).toBe(true);
  });

  test('file_changes path resolves against ctx.cwd', async () => {
    const dir = mktemp();
    const fileName = 'rel-watch.txt';
    const fullPath = join(dir, fileName);
    writeFileSync(fullPath, 'a');
    const ctx = makeCtx({ cwd: dir });
    // Schedule a write 50ms in
    setTimeout(() => writeFileSync(fullPath, 'b'), 50);
    const r = await monitorTool.execute(
      {
        condition: { kind: 'file_changes', path: fileName },
        duration_ms: 400,
        poll_interval_ms: 30,
      },
      ctx,
    );
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.events.length).toBeGreaterThanOrEqual(1);
    expect((r.events[0]?.payload as { path: string }).path).toBe(fullPath);
  });
});

describe('monitor tool: validation', () => {
  test('rejects unknown kind', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await monitorTool.execute(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
      { condition: { kind: 'bogus' } as any, duration_ms: 100 },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
  });

  test('rejects empty pattern', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await monitorTool.execute(
      {
        condition: {
          kind: 'process_output_pattern',
          process_id: 'x',
          pattern: '',
        },
        duration_ms: 100,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
  });

  test('rejects invalid regex when is_regex=true', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await monitorTool.execute(
      {
        condition: {
          kind: 'process_output_pattern',
          process_id: 'x',
          pattern: '[unclosed',
          is_regex: true,
        },
        duration_ms: 100,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('not a valid regex');
  });

  test("rejects '..' in file_changes path", async () => {
    const ctx = makeCtx({ sessionId, cwd: mktemp() });
    const r = await monitorTool.execute(
      {
        condition: { kind: 'file_changes', path: '../../etc/passwd' },
        duration_ms: 100,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain("must not contain '..'");
  });

  test('rejects duration_ms above the 30min cap', async () => {
    const ctx = makeCtx({ sessionId });
    const r = await monitorTool.execute(
      {
        condition: { kind: 'file_changes', path: '/tmp/x' },
        duration_ms: 31 * 60 * 1000,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('30min');
  });

  test('rejects non-integer duration_ms', async () => {
    // Schema declares integer; runtime must enforce so the cap
    // and timer-boundary semantics stay deterministic.
    const ctx = makeCtx({ sessionId });
    const r = await monitorTool.execute(
      {
        condition: { kind: 'file_changes', path: '/tmp/x' },
        duration_ms: 100.5,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('integer');
  });

  test('rejects negative duration_ms', async () => {
    const ctx = makeCtx({ sessionId });
    const r = await monitorTool.execute(
      {
        condition: { kind: 'file_changes', path: '/tmp/x' },
        duration_ms: 0,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
  });

  test('rejects poll_interval_ms below 10', async () => {
    const ctx = makeCtx({ sessionId });
    const r = await monitorTool.execute(
      {
        condition: { kind: 'file_changes', path: '/tmp/x' },
        duration_ms: 1000,
        poll_interval_ms: 0,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('poll_interval_ms');
  });

  test('rejects max_events below 1', async () => {
    const ctx = makeCtx({ sessionId });
    const r = await monitorTool.execute(
      {
        condition: { kind: 'file_changes', path: '/tmp/x' },
        duration_ms: 1000,
        max_events: 0,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('max_events');
  });

  test('rejects non-integer max_events', async () => {
    const ctx = makeCtx({ sessionId });
    const r = await monitorTool.execute(
      {
        condition: { kind: 'file_changes', path: '/tmp/x' },
        duration_ms: 1000,
        max_events: 5.5,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
  });
});

describe('monitor tool: bg manager dependency', () => {
  test('bg.manager_unavailable when ctx lacks manager and condition is process_*', async () => {
    const ctx = makeCtx(); // no bgManager
    const r = await monitorTool.execute(
      {
        condition: { kind: 'process_output_lines', process_id: 'x' },
        duration_ms: 100,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('bg.manager_unavailable');
  });

  test('bg.process_not_found on unknown process_id', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await monitorTool.execute(
      {
        condition: { kind: 'process_output_lines', process_id: 'no-such-id' },
        duration_ms: 1000,
        poll_interval_ms: 50,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('bg.process_not_found');
  });

  test('file_changes does NOT require bgManager', async () => {
    const dir = mktemp();
    const path = join(dir, 'no-mgr.txt');
    writeFileSync(path, 'x');
    const ctx = makeCtx({ cwd: dir }); // no bgManager
    const r = await monitorTool.execute(
      {
        condition: { kind: 'file_changes', path: 'no-mgr.txt' },
        duration_ms: 100,
        poll_interval_ms: 50,
      },
      ctx,
    );
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.reason).toBe('duration');
  });
});

describe('monitor tool: per-leaf policy gate', () => {
  // monitor is category='misc'; file_changes self-gates through
  // the existing tools.read_file fs.read policy. process_output_*
  // leaves are not re-gated (process was authorized at spawn).
  test('file_changes is gated through read_file path policy', async () => {
    const denyAll = (): { kind: 'deny'; reason: string } => ({
      kind: 'deny',
      reason: 'denied by test',
    });
    const ctx = makeCtx({
      sessionId,
      bgManager: mgr,
      permissionCheck: denyAll,
    });
    const r = await monitorTool.execute(
      {
        condition: { kind: 'file_changes', path: '/etc/shadow' },
        duration_ms: 200,
        poll_interval_ms: 50,
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected deny');
    expect(r.error_code).toBe('permission.denied');
    expect(r.error_message).toContain('file_changes');
  });

  test('process_output_* leaves are NOT re-gated', async () => {
    // Same rationale as wait_for — the bg process was authorized at
    // spawn time. monitor reading its log should not trigger the
    // policy callback.
    let called = false;
    const denyButTrack = (): { kind: 'deny'; reason: string } => {
      called = true;
      return { kind: 'deny', reason: 'should not be called' };
    };
    const spawned = await mgr.spawn({ command: 'echo a; sleep 0.05' });
    const ctx = makeCtx({
      sessionId,
      bgManager: mgr,
      permissionCheck: denyButTrack,
    });
    const r = await monitorTool.execute(
      {
        condition: { kind: 'process_output_lines', process_id: spawned.id },
        duration_ms: 1000,
        poll_interval_ms: 50,
      },
      ctx,
    );
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(called).toBe(false);
    expect(r.reason).toBe('process_exited');
  });
});
