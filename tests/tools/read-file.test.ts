import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileTool } from '../../src/tools/builtin/read-file.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forja-read-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readFileTool', () => {
  test('reads a small file', async () => {
    const path = join(dir, 'a.txt');
    writeFileSync(path, 'line1\nline2\nline3');
    const out = await readFileTool.execute({ path }, makeCtx({ cwd: dir }));
    expect(isToolError(out)).toBe(false);
    if (!isToolError(out)) {
      expect(out.content).toBe('line1\nline2\nline3');
      expect(out.total_lines).toBe(3);
      expect(out.lines_returned).toBe(3);
      expect(out.truncated).toBe(false);
    }
  });

  test('respects offset and limit', async () => {
    const path = join(dir, 'big.txt');
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
    writeFileSync(path, lines.join('\n'));
    const out = await readFileTool.execute({ path, offset: 10, limit: 5 }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.content).toBe('line10\nline11\nline12\nline13\nline14');
    expect(out.lines_returned).toBe(5);
    expect(out.truncated).toBe(true);
    expect(out.total_lines).toBe(100);
  });

  test('returns fs.not_found for missing file', async () => {
    const out = await readFileTool.execute({ path: join(dir, 'nope.txt') }, makeCtx({ cwd: dir }));
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) {
      expect(out.error_code).toBe('fs.not_found');
    }
  });

  test('resolves relative path against ctx.cwd', async () => {
    writeFileSync(join(dir, 'rel.txt'), 'hello');
    const out = await readFileTool.execute({ path: 'rel.txt' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.content).toBe('hello');
  });

  test('honors aborted signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    writeFileSync(join(dir, 'a.txt'), 'x');
    const out = await readFileTool.execute(
      { path: join(dir, 'a.txt') },
      makeCtx({ cwd: dir, signal: ctrl.signal }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_code).toBe('tool.aborted');
  });
});
