import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editFileTool } from '../../src/tools/builtin/edit-file.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forja-edit-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('editFileTool', () => {
  test('replaces a unique occurrence', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'const x = 1;\nconst y = 2;\n');
    const out = await editFileTool.execute(
      { path, old_string: 'x = 1', new_string: 'x = 42' },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.replacements).toBe(1);
    expect(readFileSync(path, 'utf-8')).toBe('const x = 42;\nconst y = 2;\n');
  });

  test('refuses ambiguous match without replace_all', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'foo\nfoo\nfoo');
    const out = await editFileTool.execute(
      { path, old_string: 'foo', new_string: 'bar' },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) {
      expect(out.error_code).toBe('edit.ambiguous_match');
      expect(out.details?.occurrences).toBe(3);
    }
  });

  test('replace_all replaces every occurrence', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'foo\nfoo\nfoo');
    const out = await editFileTool.execute(
      { path, old_string: 'foo', new_string: 'bar', replace_all: true },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.replacements).toBe(3);
    expect(readFileSync(path, 'utf-8')).toBe('bar\nbar\nbar');
  });

  test('returns edit.old_string_not_found if old_string missing', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'foo');
    const out = await editFileTool.execute(
      { path, old_string: 'bar', new_string: 'baz' },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_code).toBe('edit.old_string_not_found');
  });

  test('returns fs.not_found if file missing', async () => {
    const out = await editFileTool.execute(
      { path: join(dir, 'nope.txt'), old_string: 'a', new_string: 'b' },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_code).toBe('fs.not_found');
  });

  test('refuses no-op edit (old_string === new_string)', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'foo');
    const out = await editFileTool.execute(
      { path, old_string: 'foo', new_string: 'foo' },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_code).toBe('edit.old_equals_new');
  });

  test('refuses empty old_string with hint to use write_file', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'foo');
    const out = await editFileTool.execute(
      { path, old_string: '', new_string: 'bar' },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) {
      expect(out.error_code).toBe('edit.old_string_empty');
      expect(out.hint).toContain('write_file');
    }
    expect(readFileSync(path, 'utf-8')).toBe('foo');
  });

  test('honors aborted signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'foo');
    const out = await editFileTool.execute(
      { path, old_string: 'foo', new_string: 'bar' },
      makeCtx({ cwd: dir, signal: ctrl.signal }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_code).toBe('tool.aborted');
    // Original content untouched
    expect(readFileSync(path, 'utf-8')).toBe('foo');
  });
});
