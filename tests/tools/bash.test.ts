import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashTool } from '../../src/tools/builtin/bash.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forja-bash-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('bashTool', () => {
  test('captures stdout, stderr, exit code', async () => {
    const out = await bashTool.execute(
      { command: 'echo hello && echo world >&2 && exit 0' },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.stdout.trim()).toBe('hello');
    expect(out.stderr.trim()).toBe('world');
    expect(out.exit_code).toBe(0);
    expect(out.timed_out).toBe(false);
    expect(out.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test('non-zero exit codes are returned (not errors)', async () => {
    const out = await bashTool.execute({ command: 'exit 17' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.exit_code).toBe(17);
  });

  test('respects ctx.cwd', async () => {
    const out = await bashTool.execute({ command: 'pwd' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    // macOS prefixes /private to tmpdir
    expect(out.stdout.trim().endsWith(dir)).toBe(true);
  });

  test('timeout returns bash.timeout error', async () => {
    const out = await bashTool.execute(
      { command: 'sleep 5', timeout_ms: 200 },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) {
      expect(out.error_code).toBe('bash.timeout');
      expect(out.error_message).toContain('200ms');
    }
  });

  test('honors pre-aborted signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const out = await bashTool.execute(
      { command: 'echo hi' },
      makeCtx({ cwd: dir, signal: ctrl.signal }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_code).toBe('tool.aborted');
  });

  test('scrubs sensitive env vars from the subprocess', async () => {
    const original = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      MY_TOKEN: process.env.MY_TOKEN,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      HARMLESS_VAR: process.env.HARMLESS_VAR,
    };
    process.env.ANTHROPIC_API_KEY = 'sk-secret-anthropic';
    process.env.MY_TOKEN = 'tok-secret';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
    process.env.HARMLESS_VAR = 'visible';
    try {
      const out = await bashTool.execute(
        {
          command:
            'echo "K=${ANTHROPIC_API_KEY:-MISSING} T=${MY_TOKEN:-MISSING} A=${AWS_SECRET_ACCESS_KEY:-MISSING} H=${HARMLESS_VAR:-MISSING}"',
        },
        makeCtx({ cwd: dir }),
      );
      if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
      expect(out.stdout).toContain('K=MISSING');
      expect(out.stdout).toContain('T=MISSING');
      expect(out.stdout).toContain('A=MISSING');
      // Non-sensitive var still passes through.
      expect(out.stdout).toContain('H=visible');
    } finally {
      for (const [k, v] of Object.entries(original)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test('streams stdout and caps it at 4 MB without buffering full output', async () => {
    // Generate ~6 MB of stdout; the cap is 4 MB. With the previous
    // implementation (Response(...).text()) the entire 6 MB landed in
    // memory before truncation. This regression asserts truncation
    // happens AT the cap — the returned text length is bounded
    // independent of how much the command produced.
    const out = await bashTool.execute(
      // dd to /dev/stdout, then tr nulls to printable bytes so the
      // text is valid UTF-8 (and the decoder doesn't mangle anything).
      {
        command: "dd if=/dev/zero bs=1048576 count=6 2>/dev/null | tr '\\0' 'a'",
        timeout_ms: 10_000,
      },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.exit_code).toBe(0);
    expect(out.truncated).toBe(true);
    // 4 MB cap + a short suffix line. Anything close to 6 MB would
    // mean the cap was applied post-buffer (the bug).
    const cap = 4 * 1024 * 1024;
    expect(out.stdout.length).toBeLessThan(cap + 200);
    expect(out.stdout).toContain('truncated');
    expect(out.stdout).toContain('bytes omitted');
  });

  test('streams stderr and caps it at 4 MB independently of stdout', async () => {
    const out = await bashTool.execute(
      {
        command: "dd if=/dev/zero bs=1048576 count=6 2>/dev/null | tr '\\0' 'b' >&2",
        timeout_ms: 10_000,
      },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.truncated).toBe(true);
    const cap = 4 * 1024 * 1024;
    expect(out.stderr.length).toBeLessThan(cap + 200);
    expect(out.stderr).toContain('bytes omitted');
  });

  test('output below the cap is returned untruncated', async () => {
    const out = await bashTool.execute({ command: "printf 'hello world'" }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.stdout).toBe('hello world');
    expect(out.truncated).toBe(false);
  });

  // Slice 117 (R7 P1): pre-slice the bash tool inferred truncation
  // by regex-testing the trailing `\n[... truncated; N bytes omitted]`
  // pattern. User output that happened to end in that exact string
  // (e.g., an echo command emitting that literal text) was falsely
  // reported as truncated. The handler now carries truthful
  // `stdoutTruncated` / `stderrTruncated` flags on BrokerResponse;
  // the tool reads them directly.
  test('output that LITERALLY ends in the truncation marker is NOT misreported (slice 117)', async () => {
    // The exact regex shape — pre-slice this would test true even
    // though the output was complete.
    const out = await bashTool.execute(
      { command: "printf 'hello\\n[... truncated; 42 bytes omitted]'" },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.stdout).toBe('hello\n[... truncated; 42 bytes omitted]');
    expect(out.truncated).toBe(false);
  });

  test('relative cwd argument is resolved against ctx.cwd', async () => {
    // Create a subdir and verify pwd resolves there.
    Bun.spawnSync(['mkdir', '-p', join(dir, 'sub')]);
    const out = await bashTool.execute({ command: 'pwd', cwd: 'sub' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.stdout.trim().endsWith(`${dir}/sub`)).toBe(true);
  });

  test('caller abort mid-exec returns tool.aborted (not exit_code 143)', async () => {
    // Bun.spawn already honors signal natively (sends SIGTERM), but
    // the tool used to surface the resulting exit_code 143 as a
    // success-shaped result. The model would see "the bash command
    // ran and returned 143" instead of "the call was cancelled".
    // Now: abort observed -> tool.aborted error.
    const ctrl = new AbortController();
    const start = Date.now();
    setTimeout(() => ctrl.abort(), 50);
    const out = await bashTool.execute(
      { command: 'sleep 5; echo nope' },
      makeCtx({ cwd: dir, signal: ctrl.signal }),
    );
    const elapsed = Date.now() - start;
    if (!isToolError(out)) throw new Error('expected aborted error');
    expect(out.error_code).toBe('tool.aborted');
    expect(out.error_message).toContain('aborted');
    // Process really died — no orphan; well under sleep duration.
    expect(elapsed).toBeLessThan(1000);
  });

  test('SIGKILL escalation when child ignores SIGTERM (timeout path)', async () => {
    // bash with SIGTERM trap that ignores — graceful kill alone
    // won't work. The escalation timer fires SIGKILL after the
    // grace window. Uses the timeout path (2s grace) to keep the
    // test fast. 'trap "" TERM' makes SIGTERM a no-op; only SIGKILL
    // stops it. Without escalation, this would hang past timeout
    // and the test would itself time out.
    const start = Date.now();
    const out = await bashTool.execute(
      {
        command: 'trap "" TERM; while true; do sleep 0.1; done',
        timeout_ms: 200,
      },
      makeCtx({ cwd: dir }),
    );
    const elapsed = Date.now() - start;
    if (!isToolError(out)) throw new Error('expected timeout error');
    expect(out.error_code).toBe('bash.timeout');
    // 200ms timeout + 2s grace -> SIGKILL fires around 2.2s. Allow
    // generous slack for CI / scheduler noise but well under 5s
    // (proves SIGKILL escalation actually happens; without it, the
    // process would survive indefinitely).
    expect(elapsed).toBeLessThan(4000);
    expect(elapsed).toBeGreaterThanOrEqual(2000);
  });

  // Validation parity: schema declares timeout_ms minimum: 100; runtime
  // must enforce. Without the check, NaN coerces inside Math.min and
  // setTimeout fires near-immediately.
  test('rejects timeout_ms below 100', async () => {
    const out = await bashTool.execute({ command: 'true', timeout_ms: 50 }, makeCtx({ cwd: dir }));
    if (!isToolError(out)) throw new Error('expected error');
    expect(out.error_code).toBe('tool.invalid_arg');
    expect(out.error_message).toContain('timeout_ms');
  });

  test('rejects non-numeric timeout_ms', async () => {
    const out = await bashTool.execute(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
      { command: 'true', timeout_ms: 'abc' as any },
      makeCtx({ cwd: dir }),
    );
    if (!isToolError(out)) throw new Error('expected error');
    expect(out.error_code).toBe('tool.invalid_arg');
  });

  test('rejects non-integer timeout_ms', async () => {
    const out = await bashTool.execute(
      { command: 'true', timeout_ms: 500.5 },
      makeCtx({ cwd: dir }),
    );
    if (!isToolError(out)) throw new Error('expected error');
    expect(out.error_code).toBe('tool.invalid_arg');
  });
});
