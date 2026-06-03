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

  test('paginates a large file: small window + correct total_lines (not a memory test)', async () => {
    // A large file with a tiny requested window. This pins PAGINATION
    // correctness — returned content is bounded by `limit` and
    // `total_lines` reflects the whole file — and deliberately does NOT
    // claim anything about memory: the tool loads the entire file via
    // arrayBuffer (bounded by MAX_FILE_BYTES), so working memory is
    // proportional to file size, not to `limit`. (The old name implied
    // streaming; it never measured memory.)
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

  // Validation parity: schema declares offset minimum: 0 and
  // limit minimum: 1; runtime must enforce. Negative or fractional
  // values land in line-slice math; limit=0 returns empty content
  // with confusing pending semantics.
  test('rejects negative offset', async () => {
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    const out = await readFileTool.execute({ path: 'a.txt', offset: -1 }, makeCtx({ cwd: dir }));
    if (!isToolError(out)) throw new Error('expected error');
    expect(out.error_code).toBe('tool.invalid_arg');
    expect(out.error_message).toContain('offset');
  });

  test('rejects non-integer offset', async () => {
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    const out = await readFileTool.execute({ path: 'a.txt', offset: 1.5 }, makeCtx({ cwd: dir }));
    if (!isToolError(out)) throw new Error('expected error');
    expect(out.error_code).toBe('tool.invalid_arg');
  });

  test('rejects limit below 1', async () => {
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    const out = await readFileTool.execute({ path: 'a.txt', limit: 0 }, makeCtx({ cwd: dir }));
    if (!isToolError(out)) throw new Error('expected error');
    expect(out.error_code).toBe('tool.invalid_arg');
    expect(out.error_message).toContain('limit');
  });

  test('rejects non-numeric limit', async () => {
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    const out = await readFileTool.execute(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
      { path: 'a.txt', limit: 'abc' as any },
      makeCtx({ cwd: dir }),
    );
    if (!isToolError(out)) throw new Error('expected error');
    expect(out.error_code).toBe('tool.invalid_arg');
  });

  test('accepts offset=0 boundary', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    const out = await readFileTool.execute({ path: 'a.txt', offset: 0 }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(`unexpected: ${out.error_message}`);
    expect(out.content).toContain('hello');
  });

  // Binary detection (TOOL_ERGONOMICS §3: "Read tool detecta
  // automaticamente"). A NUL byte in the leading window is the
  // is-binary signal — refuse instead of decoding to mojibake.
  test('refuses a binary file (NUL byte) with fs.binary', async () => {
    const path = join(dir, 'icon.bin');
    // PNG-style header with a NUL at offset 4.
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a, 0x00]));
    const out = await readFileTool.execute({ path }, makeCtx({ cwd: dir }));
    if (!isToolError(out)) throw new Error('expected binary refusal');
    expect(out.error_code).toBe('fs.binary');
    expect(out.details?.nul_offset).toBe(4);
  });

  test('reads UTF-8 text with multibyte chars (no binary false positive)', async () => {
    const path = join(dir, 'unicode.txt');
    writeFileSync(path, 'café ☕ 🚀\nsegunda linha');
    const out = await readFileTool.execute({ path }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.content).toBe('café ☕ 🚀\nsegunda linha');
    expect(out.total_lines).toBe(2);
  });

  test('strips a leading UTF-8 BOM (decode parity with file.text/edit_file)', async () => {
    const path = join(dir, 'bom.txt');
    // EF BB BF = UTF-8 BOM, then "hi". No NUL, so not binary. The BOM
    // is stripped (TextDecoder's default), matching the file.text()
    // this replaced and edit_file's reader (which also strips it).
    writeFileSync(path, Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]));
    const out = await readFileTool.execute({ path }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.content).toBe('hi');
  });

  test('NUL beyond the scan window is not flagged (bounded 8000-byte scan)', async () => {
    const path = join(dir, 'late-nul.txt');
    // 8000 bytes of short text lines (no NUL in the scan window), then
    // a NUL at byte 8000 — just past the bound. Documents the
    // deliberate git-style cutoff: the head is conclusive, we do not
    // scan the whole file, so this reads through rather than refusing.
    const head = `${'a'.repeat(79)}\n`.repeat(100); // exactly 8000 bytes
    writeFileSync(path, Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from([0x00])]));
    const out = await readFileTool.execute({ path }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.content.includes('\u0000')).toBe(true);
  });

  test('returns fs.is_directory when the path is a directory', async () => {
    // `dir` (from beforeEach) is a real directory; reading it must not
    // masquerade as fs.not_found.
    const out = await readFileTool.execute({ path: dir }, makeCtx({ cwd: dir }));
    if (!isToolError(out)) throw new Error('expected directory refusal');
    expect(out.error_code).toBe('fs.is_directory');
  });

  test('caps total output bytes — large window trims lines and marks truncated', async () => {
    const path = join(dir, 'verbose.txt');
    // 1500 lines of ~1000 chars (~1.5 MB): far above the output byte cap,
    // but each line is under the per-line cap and the count is under the
    // per-call cap, so only the byte cap can trim this.
    const lines = Array.from({ length: 1500 }, () => 'x'.repeat(1000));
    writeFileSync(path, lines.join('\n'));
    const out = await readFileTool.execute({ path }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.total_lines).toBe(1500);
    expect(out.lines_returned).toBeLessThan(1500);
    expect(out.lines_returned).toBeGreaterThan(50);
    expect(out.truncated).toBe(true);
    // Pins the current 256 KiB cap — content bytes never exceed it.
    expect(Buffer.byteLength(out.content, 'utf8')).toBeLessThanOrEqual(256 * 1024);
  });
});
