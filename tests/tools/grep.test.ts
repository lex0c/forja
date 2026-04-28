import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grepTool } from '../../src/tools/builtin/grep.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

const RG_AVAILABLE = (() => {
  try {
    const proc = Bun.spawnSync(['rg', '--version']);
    return proc.exitCode === 0;
  } catch {
    return false;
  }
})();

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forja-grep-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/a.ts'), 'function login() {}\nconst x = 1;\n');
  writeFileSync(join(dir, 'src/b.ts'), 'function logout() {}\nlogin();\n');
  writeFileSync(join(dir, 'README.md'), '# Login docs\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.if(RG_AVAILABLE)('grepTool (with ripgrep)', () => {
  test('finds matches across files', async () => {
    const out = await grepTool.execute({ pattern: 'login' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.count).toBeGreaterThanOrEqual(2);
    const files = out.matches.map((m) => m.file);
    expect(files.some((f) => f.endsWith('a.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('b.ts'))).toBe(true);
  });

  test('case_insensitive matches "Login"', async () => {
    const out = await grepTool.execute(
      { pattern: 'login', case_insensitive: true, path: 'README.md' },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.count).toBe(1);
    expect(out.matches[0]?.text).toContain('Login');
  });

  test('glob filter narrows files', async () => {
    const out = await grepTool.execute({ pattern: 'login', glob: '*.ts' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.matches.every((m) => m.file.endsWith('.ts'))).toBe(true);
  });

  test('returns count=0 (no error) when no matches', async () => {
    const out = await grepTool.execute(
      { pattern: 'definitely_not_present_xyz' },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.count).toBe(0);
    expect(out.matches).toEqual([]);
  });

  test('match objects contain file, line, text', async () => {
    const out = await grepTool.execute({ pattern: 'function' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.matches.length).toBeGreaterThan(0);
    for (const m of out.matches) {
      expect(typeof m.file).toBe('string');
      expect(typeof m.line).toBe('number');
      expect(m.line).toBeGreaterThan(0);
      expect(m.text).toContain('function');
    }
  });

  test('max_results is a global cap across files (not per-file like rg --max-count)', async () => {
    // Create N files each with 5 hits. Without a global cap, rg's
    // per-file --max-count would let through up to N*5 matches even
    // when max_results is small.
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(dir, `src/multi-${i}.ts`), Array(5).fill('needle here').join('\n'));
    }
    const out = await grepTool.execute(
      { pattern: 'needle', max_results: 3 },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.count).toBe(3);
    expect(out.matches).toHaveLength(3);
    expect(out.truncated).toBe(true);
  });

  test('honors aborted signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const out = await grepTool.execute(
      { pattern: 'login' },
      makeCtx({ cwd: dir, signal: ctrl.signal }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_code).toBe('tool.aborted');
  });
});

describe.if(!RG_AVAILABLE)('grepTool (ripgrep absent)', () => {
  test('SKIPPED: ripgrep is not installed in this environment', () => {
    expect(RG_AVAILABLE).toBe(false);
  });
});
