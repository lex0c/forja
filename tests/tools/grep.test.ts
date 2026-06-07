import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGrepSpawnEnv, grepTool } from '../../src/tools/builtin/grep.ts';
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

  // Validation parity: schema declares max_results minimum: 1; runtime
  // must enforce. Bad values would otherwise reach ripgrep's CLI flag
  // and surface as a messy --max-count parse error.
  test('rejects max_results below 1', async () => {
    const out = await grepTool.execute({ pattern: 'x', max_results: 0 }, makeCtx({ cwd: dir }));
    if (!isToolError(out)) throw new Error('expected error');
    expect(out.error_code).toBe('tool.invalid_arg');
    expect(out.error_message).toContain('max_results');
  });

  test('rejects non-integer max_results', async () => {
    const out = await grepTool.execute({ pattern: 'x', max_results: 5.5 }, makeCtx({ cwd: dir }));
    if (!isToolError(out)) throw new Error('expected error');
    expect(out.error_code).toBe('tool.invalid_arg');
  });

  test('rejects non-numeric max_results', async () => {
    const out = await grepTool.execute(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
      { pattern: 'x', max_results: 'abc' as any },
      makeCtx({ cwd: dir }),
    );
    if (!isToolError(out)) throw new Error('expected error');
    expect(out.error_code).toBe('tool.invalid_arg');
  });
});

// Credential hygiene for the spawned ripgrep. In degraded / host mode there
// is no sandbox `--clearenv` to shape the env at the kernel boundary, so
// whatever `Bun.spawn({ env })` passes is exactly what rg — or a PATH shim
// impersonating rg — sees in `/proc/self/environ`. Pre-fix, grep inherited
// the raw `process.env`, which inside a subagent child carries the provider
// API key (kept so the child can reach its model) plus every other operator
// secret. These tests pin the scrub so a regression that reverts to raw
// inheritance fails loudly.
describe('buildGrepSpawnEnv (credential scrub)', () => {
  const saved = new Map<string, string | undefined>();
  const stub = (key: string, value: string): void => {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    process.env[key] = value;
  };
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  test('strips provider API keys so a ripgrep PATH shim cannot recover them', () => {
    stub('ANTHROPIC_API_KEY', 'sk-ant-secret');
    stub('OPENAI_API_KEY', 'sk-openai-secret');
    stub('GEMINI_API_KEY', 'gemini-secret');
    const env = buildGrepSpawnEnv(undefined);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  test('strips generic operator secrets but keeps PATH so rg still resolves', () => {
    stub('AWS_SECRET_ACCESS_KEY', 'aws-secret');
    stub('GITHUB_TOKEN', 'ghp_secret');
    const env = buildGrepSpawnEnv(undefined);
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
  });

  test('overlays a sandbox TMPDIR only when one is provided', () => {
    expect(buildGrepSpawnEnv(undefined).TMPDIR).toBe(process.env.TMPDIR);
    expect(buildGrepSpawnEnv('/run/forja/tmp/abc').TMPDIR).toBe('/run/forja/tmp/abc');
  });
});

describe.if(!RG_AVAILABLE)('grepTool (ripgrep absent)', () => {
  test('SKIPPED: ripgrep is not installed in this environment', () => {
    expect(RG_AVAILABLE).toBe(false);
  });
});
