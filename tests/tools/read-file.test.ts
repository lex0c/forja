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

  test('streams large files without materializing the whole content', async () => {
    // Build a ~6 MB file (200_000 lines of ~30 bytes) and request a tiny
    // window. Previously, file.text() loaded all 6 MB into a string
    // before slicing — pagination did nothing for memory. The streaming
    // path keeps working memory proportional to `limit`. We verify by
    // asserting the response is small AND total_lines is correct
    // (proves the rest of the file was traversed only for counting).
    const path = join(dir, 'huge.txt');
    const lines = Array.from(
      { length: 200_000 },
      (_, i) => `line-${i.toString().padStart(10, '0')}`,
    );
    writeFileSync(path, lines.join('\n'));
    const out = await readFileTool.execute({ path, offset: 5, limit: 3 }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.lines_returned).toBe(3);
    expect(out.total_lines).toBe(200_000);
    expect(out.truncated).toBe(true);
    expect(out.content).toBe('line-0000000005\nline-0000000006\nline-0000000007');
    // Sanity: returned content is bounded by limit, not file size.
    expect(out.content.length).toBeLessThan(200);
  });

  test('file ending with newline has a trailing empty line (matches split semantics)', async () => {
    const path = join(dir, 'trailing.txt');
    writeFileSync(path, 'a\nb\n');
    const out = await readFileTool.execute({ path }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.total_lines).toBe(3);
    expect(out.content).toBe('a\nb\n');
    expect(out.lines_returned).toBe(3);
  });

  test('empty file is reported as 1 empty line', async () => {
    const path = join(dir, 'empty.txt');
    writeFileSync(path, '');
    const out = await readFileTool.execute({ path }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.total_lines).toBe(1);
    expect(out.lines_returned).toBe(1);
    expect(out.content).toBe('');
  });

  test('offset past EOF returns no lines and is not marked truncated', async () => {
    const path = join(dir, 'small.txt');
    writeFileSync(path, 'a\nb\nc');
    const out = await readFileTool.execute({ path, offset: 100, limit: 10 }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.lines_returned).toBe(0);
    expect(out.total_lines).toBe(3);
    expect(out.truncated).toBe(false);
    expect(out.content).toBe('');
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
