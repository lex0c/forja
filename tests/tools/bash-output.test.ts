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

  // Validation parity with schema: since_* declares minimum: 0 and
  // max_bytes declares minimum: 1, but model JSON arrives unvalidated.
  // Negative cursors produce overlapping reads; max_bytes<=0 returns
  // empty chunks with nonzero pending forever (busy-wait loop bait);
  // non-integer values land in slice math.
  test('rejects negative since_stdout', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashOutputTool.execute({ process_id: 'x', since_stdout: -1 }, ctx);
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('since_stdout');
  });

  test('rejects negative since_stderr', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashOutputTool.execute({ process_id: 'x', since_stderr: -42 }, ctx);
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('since_stderr');
  });

  test('rejects non-integer since_stdout', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashOutputTool.execute({ process_id: 'x', since_stdout: 1.5 }, ctx);
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
  });

  test('rejects non-numeric since_stdout', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashOutputTool.execute(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
      { process_id: 'x', since_stdout: 'abc' as any },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
  });

  test('rejects max_bytes below 1', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashOutputTool.execute({ process_id: 'x', max_bytes: 0 }, ctx);
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('max_bytes');
  });

  test('rejects non-integer max_bytes', async () => {
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashOutputTool.execute({ process_id: 'x', max_bytes: 100.5 }, ctx);
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
  });

  test('accepts since_stdout=0 boundary', async () => {
    // 0 means "from the beginning" — schema permits and so does the
    // manager (read from byte 0). Validation must not over-reject
    // the documented boundary.
    const spawned = await mgr.spawn({ command: 'echo hello' });
    await waitForExit(spawned.id);
    const ctx = makeCtx({ sessionId, bgManager: mgr });
    const r = await bashOutputTool.execute({ process_id: spawned.id, since_stdout: 0 }, ctx);
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.stdout).toContain('hello');
  });

  describe('grep mode', () => {
    test('returns only matching lines from the whole log', async () => {
      const spawned = await mgr.spawn({
        command: 'echo "line FAIL one"; echo "line ok"; echo "another FAIL here"',
      });
      await waitForExit(spawned.id);
      const ctx = makeCtx({ sessionId, bgManager: mgr });
      const r = await bashOutputTool.execute({ process_id: spawned.id, grep: 'FAIL' }, ctx);
      if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
      expect(r.grep_matches).toBe(2);
      expect(r.stdout).toContain('line FAIL one');
      expect(r.stdout).toContain('another FAIL here');
      expect(r.stdout).not.toContain('line ok');
      expect(r.stdout_cursor).toBe(0); // grep does not advance the cursor
      expect(r.grep_truncated).toBe(false);
    });

    test('ignore_case matches regardless of case', async () => {
      const spawned = await mgr.spawn({ command: 'echo "ERROR: boom"; echo "fine"' });
      await waitForExit(spawned.id);
      const ctx = makeCtx({ sessionId, bgManager: mgr });
      const r = await bashOutputTool.execute(
        { process_id: spawned.id, grep: 'error', grep_ignore_case: true },
        ctx,
      );
      if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
      expect(r.grep_matches).toBe(1);
      expect(r.stdout).toContain('ERROR: boom');
    });

    test('case-sensitive by default misses a different-case match', async () => {
      const spawned = await mgr.spawn({ command: 'echo "ERROR: boom"' });
      await waitForExit(spawned.id);
      const ctx = makeCtx({ sessionId, bgManager: mgr });
      const r = await bashOutputTool.execute({ process_id: spawned.id, grep: 'error' }, ctx);
      if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
      expect(r.grep_matches).toBe(0);
    });

    test('empty grep string is rejected', async () => {
      const ctx = makeCtx({ sessionId, bgManager: mgr });
      const r = await bashOutputTool.execute({ process_id: 'whatever', grep: '' }, ctx);
      expect(isToolError(r)).toBe(true);
    });

    test('caps matches and flags truncation (manager-level, exercises the streaming early-stop)', async () => {
      const spawned = await mgr.spawn({ command: 'echo "FAIL a"; echo "FAIL b"; echo "FAIL c"' });
      await waitForExit(spawned.id);
      const r = await mgr.grepOutput(spawned.id, { pattern: 'FAIL', maxMatches: 2 });
      expect(r.stdoutMatches.length).toBe(2);
      expect(r.truncated).toBe(true);
    });

    test('clips an overlong matched line around the match instead of returning it whole', async () => {
      // Regression: matched lines were returned at full length — a single
      // minified multi-KB line containing the needle would land whole in
      // the tool result, bypassing the byte discipline the cursor path
      // enforces. The clip is match-centered: a head-anchored cut could
      // hide the needle itself when it sits deep in the line.
      const spawned = await mgr.spawn({
        command: `printf 'x%.0s' {1..6000}; printf 'NEEDLE'; printf 'y%.0s' {1..6000}; echo`,
      });
      await waitForExit(spawned.id);
      const r = await mgr.grepOutput(spawned.id, { pattern: 'NEEDLE' });
      expect(r.stdoutMatches.length).toBe(1);
      const line = r.stdoutMatches[0] ?? '';
      expect(line).toContain('NEEDLE'); // the match survives the clip
      expect(line.length).toBeLessThan(2500); // ~GREP_LINE_CLIP + markers
      expect(line).toContain('line clipped');
    });

    test('per-stream byte budget stops the read early and flags truncation', async () => {
      // 100 matching lines of ~1KB each = ~100KB of matches; the 64KB
      // stream budget must stop the return well short of all of them.
      const spawned = await mgr.spawn({
        command: `for i in $(seq 1 100); do printf 'FAIL '; printf 'z%.0s' {1..1000}; echo; done`,
      });
      await waitForExit(spawned.id);
      const r = await mgr.grepOutput(spawned.id, { pattern: 'FAIL' });
      expect(r.truncated).toBe(true);
      expect(r.stdoutMatches.length).toBeLessThan(100);
      const total = r.stdoutMatches.reduce((n, l) => n + l.length, 0);
      expect(total).toBeLessThanOrEqual(66 * 1024); // budget + one line of slack
    });

    test('finds a needle deep in a giant newline-less line (bounded memory path)', async () => {
      // A stream with no newline (progress bars, minified one-liners) used
      // to grow the pending carry without bound. The synthetic break at
      // the pending cap must keep scanning — a needle past the cap still
      // matches (the overlap carry preserves cut-straddling occurrences).
      const spawned = await mgr.spawn({
        command: `printf 'x%.0s' {1..80000}; printf 'DEEP-NEEDLE'; printf 'y%.0s' {1..2000}`,
      });
      await waitForExit(spawned.id);
      const r = await mgr.grepOutput(spawned.id, { pattern: 'DEEP-NEEDLE' });
      expect(r.stdoutMatches.length).toBeGreaterThanOrEqual(1);
      expect(r.stdoutMatches.some((l) => l.includes('DEEP-NEEDLE'))).toBe(true);
    });
  });
});
