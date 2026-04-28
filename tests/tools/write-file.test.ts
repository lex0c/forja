import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileTool } from '../../src/tools/builtin/write-file.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forja-write-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeFileTool', () => {
  test('writes a new file and reports created=true', async () => {
    const path = join(dir, 'a.txt');
    const out = await writeFileTool.execute({ path, content: 'hello' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.created).toBe(true);
    expect(out.bytes_written).toBe(5);
    expect(readFileSync(path, 'utf-8')).toBe('hello');
  });

  test('overwrites existing file and reports created=false', async () => {
    const path = join(dir, 'b.txt');
    await Bun.write(path, 'old');
    const out = await writeFileTool.execute({ path, content: 'new' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.created).toBe(false);
    expect(readFileSync(path, 'utf-8')).toBe('new');
  });

  test('creates parent directories as needed', async () => {
    const path = join(dir, 'a/b/c/file.txt');
    const out = await writeFileTool.execute({ path, content: 'x' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error('unexpected error');
    expect(existsSync(path)).toBe(true);
  });

  test('honors aborted signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const out = await writeFileTool.execute(
      { path: join(dir, 'x.txt'), content: 'x' },
      makeCtx({ cwd: dir, signal: ctrl.signal }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_code).toBe('tool.aborted');
    expect(existsSync(join(dir, 'x.txt'))).toBe(false);
  });
});
