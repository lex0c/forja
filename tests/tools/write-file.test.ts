import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
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

  // Slice 129 (R5 P1 disk-fill): mirror read_file's 10 MiB cap on
  // the write side. The cap is on encoded UTF-8 bytes, so even an
  // input that's short in JS chars but big in UTF-8 (multi-byte
  // codepoints) gets blocked.
  test('refuses content above MAX_CONTENT_BYTES (10 MiB) and does NOT write the file', async () => {
    // 10 MiB + 1 byte of ASCII → fails the cap by exactly one byte.
    const oversized = 'a'.repeat(10 * 1024 * 1024 + 1);
    const path = join(dir, 'too-big.txt');
    const out = await writeFileTool.execute({ path, content: oversized }, makeCtx({ cwd: dir }));
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) {
      expect(out.error_code).toBe('fs.write_failed');
      expect(out.error_message).toMatch(/content too large/);
    }
    expect(existsSync(path)).toBe(false);
  });

  test('accepts exactly MAX_CONTENT_BYTES (boundary)', async () => {
    const exactCap = 'a'.repeat(10 * 1024 * 1024);
    const path = join(dir, 'cap.txt');
    const out = await writeFileTool.execute({ path, content: exactCap }, makeCtx({ cwd: dir }));
    expect(isToolError(out)).toBe(false);
    if (!isToolError(out)) expect(out.bytes_written).toBe(10 * 1024 * 1024);
  });

  test('refuses a directory target with fs.is_directory', async () => {
    const out = await writeFileTool.execute({ path: dir, content: 'x' }, makeCtx({ cwd: dir }));
    if (!isToolError(out)) throw new Error('expected directory refusal');
    expect(out.error_code).toBe('fs.is_directory');
  });

  test('atomic overwrite preserves the file mode (executable bit kept)', async () => {
    const path = join(dir, 'script.sh');
    await Bun.write(path, '#!/bin/sh\necho old\n');
    chmodSync(path, 0o755);
    const out = await writeFileTool.execute(
      { path, content: '#!/bin/sh\necho new\n' },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(readFileSync(path, 'utf-8')).toBe('#!/bin/sh\necho new\n');
    // Mode survives the temp+rename (a naive new inode would reset it).
    expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  test('atomic overwrite leaves no temp file behind', async () => {
    const path = join(dir, 'c.txt');
    await Bun.write(path, 'old');
    const out = await writeFileTool.execute({ path, content: 'new' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error('unexpected error');
    // Only the target remains — the temp was renamed away, not left.
    expect(readdirSync(dir)).toEqual(['c.txt']);
  });

  test('writes through a symlink to its target (link preserved)', async () => {
    const target = join(dir, 'real.txt');
    const link = join(dir, 'link.txt');
    await Bun.write(target, 'old');
    symlinkSync(target, link);
    const out = await writeFileTool.execute({ path: link, content: 'new' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    // Target content updated; link is still a symlink (not replaced).
    expect(readFileSync(target, 'utf-8')).toBe('new');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});
