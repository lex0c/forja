import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMPTY_BOOT_CONTEXT,
  evaluateBootTriggers,
  shouldEagerLoadByTriggers,
} from '../../src/memory/triggers.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-mem-triggers-'));
  tmpDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('evaluateBootTriggers', () => {
  test('empty cwd: no triggers fire', () => {
    const cwd = makeTmp();
    const ctx = evaluateBootTriggers(cwd);
    expect(ctx.triggers.size).toBe(0);
  });

  test('git trigger fires when .git directory exists', () => {
    const cwd = makeTmp();
    mkdirSync(join(cwd, '.git'));
    expect(evaluateBootTriggers(cwd).triggers.has('git')).toBe(true);
  });

  test('env trigger fires when .env file exists', () => {
    const cwd = makeTmp();
    writeFileSync(join(cwd, '.env'), 'KEY=value');
    expect(evaluateBootTriggers(cwd).triggers.has('env')).toBe(true);
  });

  test('package trigger fires for package.json', () => {
    const cwd = makeTmp();
    writeFileSync(join(cwd, 'package.json'), '{}');
    expect(evaluateBootTriggers(cwd).triggers.has('package')).toBe(true);
  });

  test('agents-md trigger fires for AGENTS.md', () => {
    const cwd = makeTmp();
    writeFileSync(join(cwd, 'AGENTS.md'), '# repo notes');
    expect(evaluateBootTriggers(cwd).triggers.has('agents-md')).toBe(true);
  });

  test('multiple triggers fire when multiple files present', () => {
    const cwd = makeTmp();
    mkdirSync(join(cwd, '.git'));
    writeFileSync(join(cwd, 'package.json'), '{}');
    writeFileSync(join(cwd, 'tsconfig.json'), '{}');
    const ctx = evaluateBootTriggers(cwd);
    expect(ctx.triggers.has('git')).toBe(true);
    expect(ctx.triggers.has('package')).toBe(true);
    expect(ctx.triggers.has('tsconfig')).toBe(true);
    expect(ctx.triggers.has('env')).toBe(false);
  });

  test('does NOT recurse into subdirectories', () => {
    const cwd = makeTmp();
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', '.env'), 'X=Y');
    expect(evaluateBootTriggers(cwd).triggers.has('env')).toBe(false);
  });
});

describe('shouldEagerLoadByTriggers', () => {
  test('memory without triggers: unconditional load', () => {
    expect(shouldEagerLoadByTriggers(undefined, EMPTY_BOOT_CONTEXT)).toBe(true);
    expect(shouldEagerLoadByTriggers([], EMPTY_BOOT_CONTEXT)).toBe(true);
  });

  test('memory with single matching well-known trigger loads', () => {
    const ctx = { triggers: new Set(['git'] as const) };
    expect(shouldEagerLoadByTriggers(['git'], ctx)).toBe(true);
  });

  test('memory with non-matching well-known trigger does NOT load', () => {
    const ctx = { triggers: new Set(['git'] as const) };
    expect(shouldEagerLoadByTriggers(['env'], ctx)).toBe(false);
  });

  test('memory with multiple triggers loads if ANY match', () => {
    const ctx = { triggers: new Set(['git'] as const) };
    expect(shouldEagerLoadByTriggers(['env', 'git', 'cargo'], ctx)).toBe(true);
  });

  test('all-operator-defined triggers: unconditional load (rule 2)', () => {
    // Operator tags with runtime-only labels (e.g., `bash`, `secrets`
    // — listed in the spec for runtime triggers but not yet
    // implemented as boot triggers). Rule 2: don't silently hide.
    const ctx = EMPTY_BOOT_CONTEXT;
    expect(shouldEagerLoadByTriggers(['bash'], ctx)).toBe(true);
    expect(shouldEagerLoadByTriggers(['secrets', 'custom-tag'], ctx)).toBe(true);
  });

  test('mixed well-known + operator-defined: matches on well-known half', () => {
    // Memory with both: behaves like its well-known list.
    const ctxNoGit = EMPTY_BOOT_CONTEXT;
    expect(shouldEagerLoadByTriggers(['git', 'bash'], ctxNoGit)).toBe(false);
    const ctxGit = { triggers: new Set(['git'] as const) };
    expect(shouldEagerLoadByTriggers(['git', 'bash'], ctxGit)).toBe(true);
  });
});
