import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../src/cli/init.ts';
import { loadPolicyFromString } from '../../src/permissions/index.ts';

describe('runInit', () => {
  let cwd: string;
  let outBuf: string[];
  let errBuf: string[];
  const out = (s: string) => outBuf.push(s);
  const err = (s: string) => errBuf.push(s);

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'forja-init-'));
    outBuf = [];
    errBuf = [];
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test('writes .agent/permissions.yaml with strict mode by default', () => {
    const code = runInit({ cwd, force: false, mode: 'strict', out, err });
    expect(code).toBe(0);
    const target = join(cwd, '.agent', 'permissions.yaml');
    expect(existsSync(target)).toBe(true);
    const body = readFileSync(target, 'utf8');
    expect(body).toContain('mode: strict');
    expect(body).toContain('bash:');
    expect(body).toContain('read_file:');
  });

  test('written template parses as a valid Policy', () => {
    runInit({ cwd, force: false, mode: 'strict', out, err });
    const body = readFileSync(join(cwd, '.agent', 'permissions.yaml'), 'utf8');
    // Round-trip: the same loader the engine uses must accept the
    // template. Catches divergence between template syntax and
    // schema (e.g. a future deny rule format change that would
    // make `agent init` produce unparseable output).
    const policy = loadPolicyFromString(body);
    expect(policy.defaults.mode).toBe('strict');
    expect(policy.tools.bash?.allow?.length ?? 0).toBeGreaterThan(0);
    expect(policy.tools.bash?.deny?.length ?? 0).toBeGreaterThan(0);
    expect(policy.tools.read_file?.deny_paths?.length ?? 0).toBeGreaterThan(0);
  });

  test('--mode acceptEdits emits matching defaults', () => {
    runInit({ cwd, force: false, mode: 'acceptEdits', out, err });
    const body = readFileSync(join(cwd, '.agent', 'permissions.yaml'), 'utf8');
    expect(body).toContain('mode: acceptEdits');
    const policy = loadPolicyFromString(body);
    expect(policy.defaults.mode).toBe('acceptEdits');
  });

  test('refuses when file exists and --force is false', () => {
    const target = join(cwd, '.agent', 'permissions.yaml');
    runInit({ cwd, force: false, mode: 'strict', out, err });
    const original = readFileSync(target, 'utf8');
    outBuf = [];
    errBuf = [];
    const code = runInit({ cwd, force: false, mode: 'strict', out, err });
    expect(code).toBe(1);
    expect(errBuf.join('')).toContain('already exists');
    expect(errBuf.join('')).toContain('--force');
    // File must be untouched on refuse — operator's hand edits
    // survive an accidental re-run.
    expect(readFileSync(target, 'utf8')).toBe(original);
  });

  test('--force overwrites existing file', () => {
    const target = join(cwd, '.agent', 'permissions.yaml');
    runInit({ cwd, force: false, mode: 'strict', out, err });
    writeFileSync(target, '# operator hand edit\n', { encoding: 'utf8' });
    outBuf = [];
    errBuf = [];
    const code = runInit({ cwd, force: true, mode: 'strict', out, err });
    expect(code).toBe(0);
    const body = readFileSync(target, 'utf8');
    expect(body).not.toContain('operator hand edit');
    expect(body).toContain('mode: strict');
  });

  test('creates .agent/ directory if missing', () => {
    // mkdtempSync gives us a clean cwd with no .agent/ subtree —
    // the handler must mkdir -p before writing.
    expect(existsSync(join(cwd, '.agent'))).toBe(false);
    const code = runInit({ cwd, force: false, mode: 'strict', out, err });
    expect(code).toBe(0);
    expect(existsSync(join(cwd, '.agent'))).toBe(true);
  });

  test('success message points at next step', () => {
    runInit({ cwd, force: false, mode: 'strict', out, err });
    const all = outBuf.join('');
    expect(all).toContain('wrote');
    expect(all).toContain("run 'agent'");
  });
});
