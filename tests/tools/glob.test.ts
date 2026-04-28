import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globTool } from '../../src/tools/builtin/glob.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forja-glob-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/a.ts'), '');
  writeFileSync(join(dir, 'src/b.ts'), '');
  writeFileSync(join(dir, 'src/c.md'), '');
  mkdirSync(join(dir, 'src/sub'), { recursive: true });
  writeFileSync(join(dir, 'src/sub/d.ts'), '');
  writeFileSync(join(dir, 'README.md'), '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('globTool', () => {
  test('matches files in subtree', async () => {
    const out = await globTool.execute({ pattern: 'src/**/*.ts' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.matches.sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/sub/d.ts']);
    expect(out.count).toBe(3);
    expect(out.truncated).toBe(false);
  });

  test('matches at root', async () => {
    const out = await globTool.execute({ pattern: '*.md' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.matches).toEqual(['README.md']);
  });

  test('respects custom cwd', async () => {
    const out = await globTool.execute({ pattern: '**/*.ts', cwd: 'src' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.matches.sort()).toEqual(['a.ts', 'b.ts', 'sub/d.ts']);
  });

  test('returns empty matches with count=0 when nothing matches', async () => {
    const out = await globTool.execute({ pattern: '**/*.go' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.matches).toEqual([]);
    expect(out.count).toBe(0);
  });

  test('rejects non-string pattern with a clean validation error', async () => {
    // Cast bypasses TS — model JSON args are runtime-untyped.
    for (const bogus of [123, null, { not: 'string' }, ['array'], undefined]) {
      const out = await globTool.execute(
        { pattern: bogus } as unknown as Parameters<typeof globTool.execute>[0],
        makeCtx({ cwd: dir }),
      );
      expect(isToolError(out)).toBe(true);
      if (isToolError(out)) {
        // Must be a structured validation error, NOT a tool.exception
        // from a downstream throw inside isAbsolute/split.
        expect(out.error_code).toBe('tool.invalid_arg');
        expect(out.error_message).toContain('non-empty string');
      }
    }
  });

  test('rejects parent-traversal patterns (would bypass policy)', async () => {
    const out = await globTool.execute(
      { pattern: '../secret/*.txt', cwd: 'src' },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) {
      expect(out.error_code).toBe('glob.pattern_escapes_root');
      expect(out.hint).toContain('..');
    }
  });

  test('rejects parent-traversal in mid-pattern segments', async () => {
    const out = await globTool.execute({ pattern: 'src/../README.md' }, makeCtx({ cwd: dir }));
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) {
      expect(out.error_code).toBe('glob.pattern_escapes_root');
    }
  });

  test('rejects absolute patterns', async () => {
    const out = await globTool.execute({ pattern: '/etc/*' }, makeCtx({ cwd: dir }));
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) {
      expect(out.error_code).toBe('glob.pattern_escapes_root');
    }
  });

  test('honors aborted signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const out = await globTool.execute(
      { pattern: '**/*' },
      makeCtx({ cwd: dir, signal: ctrl.signal }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_code).toBe('tool.aborted');
  });
});
