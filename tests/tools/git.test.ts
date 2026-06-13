import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildModeArgs, gitTool } from '../../src/tools/builtin/git.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

const GIT_AVAILABLE = (() => {
  try {
    return Bun.spawnSync(['git', '--version']).exitCode === 0;
  } catch {
    return false;
  }
})();

// ── Security contract: pure argv construction, no spawn ────────────

describe('buildModeArgs — flag-injection rejection', () => {
  test("rejects ref starting with '-' (would be parsed as a flag)", () => {
    const r = buildModeArgs({ mode: 'log', ref: '--output=/tmp/pwned' });
    expect('error' in r).toBe(true);
  });

  test('rejects ref with shell/odd characters', () => {
    for (const ref of ['a b', 'a;rm', 'a$(x)', 'a|b', 'a&b']) {
      expect('error' in buildModeArgs({ mode: 'show', ref })).toBe(true);
    }
  });

  test("rejects path with '..', absolute path, and leading '-'", () => {
    expect('error' in buildModeArgs({ mode: 'diff', path: '../etc/passwd' })).toBe(true);
    expect('error' in buildModeArgs({ mode: 'diff', path: '/etc/passwd' })).toBe(true);
    expect('error' in buildModeArgs({ mode: 'log', path: '--all' })).toBe(true);
  });

  test('rejects git pathspec magic (leading ":") — `--` does not disable it', () => {
    for (const path of [':(top)', ':(exclude)src', ':!secret', ':/etc']) {
      expect('error' in buildModeArgs({ mode: 'diff', path })).toBe(true);
    }
    // a normal relative path is still accepted
    expect('args' in buildModeArgs({ mode: 'diff', path: 'src/a.ts' })).toBe(true);
  });

  test('blame requires a path', () => {
    expect('error' in buildModeArgs({ mode: 'blame' })).toBe(true);
    const ok = buildModeArgs({ mode: 'blame', path: 'src/a.ts' });
    expect('args' in ok).toBe(true);
  });

  test('max_count must be a positive integer', () => {
    expect('error' in buildModeArgs({ mode: 'log', max_count: 0 })).toBe(true);
    expect('error' in buildModeArgs({ mode: 'log', max_count: -3 })).toBe(true);
    expect('error' in buildModeArgs({ mode: 'log', max_count: 1.5 })).toBe(true);
  });
});

describe('buildModeArgs — per-mode argv shape', () => {
  test('diff hardens against ext-diff/textconv and separates pathspec', () => {
    const r = buildModeArgs({ mode: 'diff', path: 'src/a.ts', staged: true });
    if (!('args' in r)) throw new Error('expected args');
    expect(r.args).toContain('--no-ext-diff');
    expect(r.args).toContain('--no-textconv');
    expect(r.args).toContain('--staged');
    // path is fenced behind `--` so it can never be read as a flag.
    const sep = r.args.indexOf('--');
    expect(sep).toBeGreaterThan(-1);
    expect(r.args[sep + 1]).toBe('src/a.ts');
  });

  test('log caps and carries a compact pretty format', () => {
    const r = buildModeArgs({ mode: 'log', max_count: 5000 });
    if (!('args' in r)) throw new Error('expected args');
    // capped to MAX_LOG_COUNT
    expect(r.args[r.args.indexOf('-n') + 1]).toBe('1000');
    expect(r.args.some((a) => a.startsWith('--pretty='))).toBe(true);
  });

  test('show defaults to HEAD', () => {
    const r = buildModeArgs({ mode: 'show' });
    if (!('args' in r)) throw new Error('expected args');
    expect(r.args).toContain('HEAD');
  });
});

// ── Functional: against a real temp repo ───────────────────────────

describe.if(GIT_AVAILABLE)('gitTool — against a real repo', () => {
  let dir: string;

  const run = (cmd: string[]) => {
    const p = Bun.spawnSync(['git', ...cmd], { cwd: dir });
    if (p.exitCode !== 0) throw new Error(`git ${cmd.join(' ')} failed`);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forja-git-'));
    run(['init', '-q']);
    run(['config', 'user.email', 't@t.t']);
    run(['config', 'user.name', 'T']);
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    run(['add', 'a.ts']);
    run(['commit', '-q', '-m', 'add a']);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('log returns the commit', async () => {
    const out = await gitTool.execute({ mode: 'log' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(out.error_message);
    expect(out.output).toContain('add a');
    expect(out.exit_code).toBe(0);
  });

  test('diff/status reflect the LIVE working tree (uncommitted)', async () => {
    // mutate the file WITHOUT committing — the whole point of isolation:none.
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
    const diff = await gitTool.execute({ mode: 'diff' }, makeCtx({ cwd: dir }));
    if (isToolError(diff)) throw new Error(diff.error_message);
    expect(diff.output).toContain('-export const a = 1;');
    expect(diff.output).toContain('+export const a = 2;');

    const status = await gitTool.execute({ mode: 'status' }, makeCtx({ cwd: dir }));
    if (isToolError(status)) throw new Error(status.error_message);
    expect(status.output).toContain('a.ts');
  });

  test('blame attributes the line', async () => {
    const out = await gitTool.execute({ mode: 'blame', path: 'a.ts' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(out.error_message);
    expect(out.output).toContain('export const a = 1;');
  });

  test('caps output at OUTPUT_CAP_BYTES and flags truncated', async () => {
    // A ~230 KB file → `git show HEAD` emits a diff well past the
    // 64 KiB cap, exercising the byte-slice + SIGTERM truncation path.
    const big = `${Array.from({ length: 5000 }, (_, i) => `line ${i} padding padding padding`).join('\n')}\n`;
    writeFileSync(join(dir, 'big.txt'), big);
    run(['add', 'big.txt']);
    run(['commit', '-q', '-m', 'add big']);
    const out = await gitTool.execute({ mode: 'show', ref: 'HEAD' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(out.error_message);
    expect(out.truncated).toBe(true);
    // captured bytes never exceed the 64 KiB cap
    expect(Buffer.byteLength(out.output, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(out.output.length).toBeGreaterThan(0);
  });

  test('not-a-repo surfaces a clean error', async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'forja-nogit-'));
    try {
      const out = await gitTool.execute({ mode: 'status' }, makeCtx({ cwd: nonRepo }));
      expect(isToolError(out)).toBe(true);
      if (isToolError(out)) expect(out.error_code).toBe('git.not_a_repo');
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  test('invalid mode is rejected before spawn', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid
    const out = await gitTool.execute({ mode: 'push' as any }, makeCtx({ cwd: dir }));
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_code).toBe('tool.invalid_arg');
  });
});
