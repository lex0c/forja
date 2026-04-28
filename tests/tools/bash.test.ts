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

  test('relative cwd argument is resolved against ctx.cwd', async () => {
    // Create a subdir and verify pwd resolves there.
    Bun.spawnSync(['mkdir', '-p', join(dir, 'sub')]);
    const out = await bashTool.execute({ command: 'pwd', cwd: 'sub' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.stdout.trim().endsWith(`${dir}/sub`)).toBe(true);
  });
});
