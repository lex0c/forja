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

  test('drops matches from policy-denied files (no read-around via grep)', async () => {
    // Non-hidden secret file (ripgrep skips dotfiles by default, so a
    // `.env` would be a vacuous assertion) matched by the same pattern.
    writeFileSync(join(dir, 'secret.txt'), 'login_token = SECRET\n');
    writeFileSync(join(dir, 'src/c.ts'), 'login();\n');
    const denyEnv = makeCtx({
      cwd: dir,
      permissions: {
        mode: 'strict',
        posture: 'supervised',
        canReadPath: (p) => !p.endsWith('secret.txt'),
      },
    });
    const out = await grepTool.execute({ pattern: 'login' }, denyEnv);
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    const files = out.matches.map((m) => m.file);
    expect(files.some((f) => f.endsWith('secret.txt'))).toBe(false);
    // allowed files still match
    expect(files.some((f) => f.endsWith('.ts'))).toBe(true);
    // The hidden secret.txt match is DISCLOSED, not silently dropped.
    expect(out.policy_note).toBeDefined();
    expect(out.policy_note).toContain('read_file');
  });

  test('an all-hidden grep surfaces policy_note instead of a silent count: 0', async () => {
    // The finding's case: a policy authorizes the grep CALL (grep section) but
    // denies the matched content under read_file → every match is gated out.
    // Without the note the result reads as a bogus "no matches", and the
    // operator can't tell a real empty search from a policy-hidden one.
    writeFileSync(join(dir, 'only.txt'), 'login here\n');
    const denyAll = makeCtx({
      cwd: dir,
      permissions: { mode: 'strict', posture: 'supervised', canReadPath: () => false },
    });
    const hidden = await grepTool.execute({ pattern: 'login', path: 'only.txt' }, denyAll);
    if (isToolError(hidden)) throw new Error(`unexpected error: ${hidden.error_message}`);
    expect(hidden.count).toBe(0);
    expect(hidden.policy_note).toBeDefined();
    expect(hidden.policy_note).toContain('read_file');

    // Control: allow-all → real matches, and NO note (nothing was hidden).
    const allow = await grepTool.execute(
      { pattern: 'login', path: 'only.txt' },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(allow)) throw new Error(`unexpected error: ${allow.error_message}`);
    expect(allow.count).toBeGreaterThan(0);
    expect(allow.policy_note).toBeUndefined();
  });

  test('denied matches do not consume the cap (readable matches are not starved)', async () => {
    // A denied file with far more hits than the cap, plus an allowed
    // file with a couple. Denied hits must NOT count toward max_results
    // or kill rg, or the allowed matches would be lost.
    writeFileSync(join(dir, 'secret.txt'), `${Array(50).fill('NEEDLE x').join('\n')}\n`);
    writeFileSync(join(dir, 'src/keep.ts'), 'NEEDLE one\nNEEDLE two\n');
    const denyEnv = makeCtx({
      cwd: dir,
      permissions: {
        mode: 'strict',
        posture: 'supervised',
        canReadPath: (p) => !p.endsWith('secret.txt'),
      },
    });
    const out = await grepTool.execute({ pattern: 'NEEDLE', max_results: 3 }, denyEnv);
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    const files = out.matches.map((m) => m.file);
    expect(files.every((f) => !f.endsWith('secret.txt'))).toBe(true);
    expect(files.filter((f) => f.endsWith('keep.ts')).length).toBe(2);
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
