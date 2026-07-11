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
import type { FileDiff } from '../../src/diff/line-diff.ts';
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

  // Engine/tool path-arg parity (see _path-arg.ts).
  test('accepts file_path alias (engine/tool parity)', async () => {
    const path = join(dir, 'fp.txt');
    const out = await writeFileTool.execute(
      { file_path: path, content: 'aliased' } as never,
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(readFileSync(path, 'utf-8')).toBe('aliased');
  });

  test('missing both path and file_path → clean invalid_arg (no crash)', async () => {
    const out = await writeFileTool.execute({ content: 'x' } as never, makeCtx({ cwd: dir }));
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_message).toContain('path');
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

  test('writes through a DANGLING symlink to create its target, link preserved', async () => {
    const target = join(dir, 'not-yet.txt'); // does not exist yet
    const link = join(dir, 'link.txt');
    symlinkSync(target, link); // dangling — target missing
    expect(existsSync(target)).toBe(false);
    const out = await writeFileTool.execute(
      { path: link, content: 'created' },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    // The link's target was CREATED; the link is NOT replaced by a file.
    expect(readFileSync(target, 'utf-8')).toBe('created');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test('dangling symlink with a RELATIVE target resolves against the link dir', async () => {
    const link = join(dir, 'link.txt');
    symlinkSync('sub/later.txt', link); // relative + dangling (sub/ absent)
    const out = await writeFileTool.execute({ path: link, content: 'rel' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(readFileSync(join(dir, 'sub', 'later.txt'), 'utf-8')).toBe('rel');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test('writes through a dangling symlink CHAIN to the final leaf, all links preserved', async () => {
    const leaf = join(dir, 'leaf.txt'); // missing
    const mid = join(dir, 'mid.txt');
    const head = join(dir, 'head.txt');
    symlinkSync(leaf, mid); // mid -> leaf (dangling)
    symlinkSync(mid, head); // head -> mid -> leaf
    const out = await writeFileTool.execute(
      { path: head, content: 'leaf!' },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    // The final leaf is created; the rename did NOT replace the intermediate link.
    expect(readFileSync(leaf, 'utf-8')).toBe('leaf!');
    expect(lstatSync(head).isSymbolicLink()).toBe(true);
    expect(lstatSync(mid).isSymbolicLink()).toBe(true);
  });

  test('emits a display diff for a real change, but not for a zero-change overwrite', async () => {
    const path = join(dir, 'a.ts');
    await Bun.write(path, 'const x = 1;\n');
    const diffs: FileDiff[] = [];
    const ctx = makeCtx({ cwd: dir, emitDiff: (d) => diffs.push(d) });
    // Changed content → exactly one diff with non-zero counts.
    let out = await writeFileTool.execute({ path, content: 'const x = 2;\n' }, ctx);
    if (isToolError(out)) throw new Error('unexpected error');
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.added).toBeGreaterThan(0);
    expect(diffs[0]?.removed).toBeGreaterThan(0);
    // Overwrite with identical content → empty diff is NOT emitted
    // (no `(+0 -0)` card, no batch bypass).
    out = await writeFileTool.execute({ path, content: 'const x = 2;\n' }, ctx);
    if (isToolError(out)) throw new Error('unexpected error');
    expect(diffs).toHaveLength(1);
  });
});
