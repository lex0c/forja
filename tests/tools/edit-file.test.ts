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

describe('editFileTool — single-edit batches', () => {
  test('replaces a unique occurrence', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'const x = 1;\nconst y = 2;\n');
    const out = await editFileTool.execute(
      { path, edits: [{ old_string: 'x = 1', new_string: 'x = 42' }] },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.total_replacements).toBe(1);
    expect(out.edits).toEqual([{ replacements: 1 }]);
    expect(readFileSync(path, 'utf-8')).toBe('const x = 42;\nconst y = 2;\n');
  });

  test('refuses ambiguous match without replace_all', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'foo\nfoo\nfoo');
    const out = await editFileTool.execute(
      { path, edits: [{ old_string: 'foo', new_string: 'bar' }] },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) {
      expect(out.error_code).toBe('edit.ambiguous_match');
      expect(out.details?.occurrences).toBe(3);
      // Error message names the failing edit's index — operator
      // and model both need to know WHICH edit caused the abort.
      expect(out.error_message).toContain('edits[0]');
    }
  });

  test('replace_all replaces every occurrence', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'foo\nfoo\nfoo');
    const out = await editFileTool.execute(
      { path, edits: [{ old_string: 'foo', new_string: 'bar', replace_all: true }] },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.total_replacements).toBe(3);
    expect(out.edits).toEqual([{ replacements: 3 }]);
    expect(readFileSync(path, 'utf-8')).toBe('bar\nbar\nbar');
  });

  test('returns edit.old_string_not_found if old_string missing', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'foo');
    const out = await editFileTool.execute(
      { path, edits: [{ old_string: 'bar', new_string: 'baz' }] },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_code).toBe('edit.old_string_not_found');
  });

  test('returns fs.not_found if file missing', async () => {
    const out = await editFileTool.execute(
      { path: join(dir, 'nope.txt'), edits: [{ old_string: 'a', new_string: 'b' }] },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_code).toBe('fs.not_found');
  });

  test('refuses no-op edit (old_string === new_string)', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'foo');
    const out = await editFileTool.execute(
      { path, edits: [{ old_string: 'foo', new_string: 'foo' }] },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_code).toBe('edit.old_equals_new');
  });

  test('refuses empty old_string with hint to use write_file', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'foo');
    const out = await editFileTool.execute(
      { path, edits: [{ old_string: '', new_string: 'bar' }] },
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
      { path, edits: [{ old_string: 'foo', new_string: 'bar' }] },
      makeCtx({ cwd: dir, signal: ctrl.signal }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_code).toBe('tool.aborted');
    // Original content untouched
    expect(readFileSync(path, 'utf-8')).toBe('foo');
  });
});

describe('editFileTool — batch shape validation', () => {
  test('refuses an empty edits array', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'foo');
    const out = await editFileTool.execute({ path, edits: [] }, makeCtx({ cwd: dir }));
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) {
      expect(out.error_code).toBe('tool.invalid_arg');
      expect(out.error_message).toContain('at least one edit');
    }
    // File untouched on validation failure.
    expect(readFileSync(path, 'utf-8')).toBe('foo');
  });

  test('refuses a non-array edits field', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'foo');
    // Caller passing a malformed shape — TS would catch this at the
    // caller-build site, but the model's JSON arrives unvalidated;
    // the runtime check is what stops a bad call from corrupting
    // state.
    const out = await editFileTool.execute(
      { path, edits: 'not an array' as unknown as never },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_code).toBe('tool.invalid_arg');
  });

  test('refuses batches above the 50-edit cap', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'x');
    const tooMany = Array.from({ length: 51 }, (_, i) => ({
      old_string: `${i}`,
      new_string: `${i + 1000}`,
    }));
    const out = await editFileTool.execute({ path, edits: tooMany }, makeCtx({ cwd: dir }));
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) {
      expect(out.error_code).toBe('tool.invalid_arg');
      expect(out.error_message).toContain('50');
    }
  });
});

describe('editFileTool — multi-edit batches', () => {
  test('applies edits sequentially and reports per-edit replacement counts', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    const out = await editFileTool.execute(
      {
        path,
        edits: [
          { old_string: 'a = 1', new_string: 'a = 10' },
          { old_string: 'b = 2', new_string: 'b = 20' },
          { old_string: 'c = 3', new_string: 'c = 30' },
        ],
      },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.total_replacements).toBe(3);
    expect(out.edits).toEqual([{ replacements: 1 }, { replacements: 1 }, { replacements: 1 }]);
    expect(readFileSync(path, 'utf-8')).toBe('const a = 10;\nconst b = 20;\nconst c = 30;\n');
  });

  test('later edits operate on the result of earlier edits (sequential semantic)', async () => {
    // Edit 1 introduces text that edit 2 then targets. If the
    // implementation incorrectly searched the ORIGINAL content for
    // each edit, edit 2 would fail with old_string_not_found.
    // Sequential application is the load-bearing contract — this
    // test pins it.
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'foo');
    const out = await editFileTool.execute(
      {
        path,
        edits: [
          { old_string: 'foo', new_string: 'foo bar' },
          { old_string: 'bar', new_string: 'baz' },
        ],
      },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.total_replacements).toBe(2);
    expect(readFileSync(path, 'utf-8')).toBe('foo baz');
  });

  test('all-or-nothing: a failure mid-batch leaves the file untouched', async () => {
    // Edit 1 succeeds in memory, edit 2 fails (old_string not
    // found). The original file content must remain on disk —
    // partial application would leave the working tree in a state
    // the model didn't intend.
    const path = join(dir, 'a.ts');
    const original = 'foo\nbar\n';
    writeFileSync(path, original);
    const out = await editFileTool.execute(
      {
        path,
        edits: [
          { old_string: 'foo', new_string: 'FOO' }, // would succeed
          { old_string: 'missing', new_string: 'X' }, // fails
          { old_string: 'bar', new_string: 'BAR' }, // never reached
        ],
      },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) {
      expect(out.error_code).toBe('edit.old_string_not_found');
      expect(out.error_message).toContain('edits[1]');
    }
    expect(readFileSync(path, 'utf-8')).toBe(original);
  });

  test('per-edit replace_all is honored independently', async () => {
    // Each edit decides its own ambiguity policy. Edit 1 sets
    // replace_all (3 occurrences expected), edit 2 doesn't (must
    // be unique in post-edit-1 content).
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'foo\nfoo\nfoo\nbaz\n');
    const out = await editFileTool.execute(
      {
        path,
        edits: [
          { old_string: 'foo', new_string: 'bar', replace_all: true },
          { old_string: 'baz', new_string: 'qux' },
        ],
      },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.edits).toEqual([{ replacements: 3 }, { replacements: 1 }]);
    expect(out.total_replacements).toBe(4);
    expect(readFileSync(path, 'utf-8')).toBe('bar\nbar\nbar\nqux\n');
  });

  test('uniqueness gate runs against the POST-previous-edit content', async () => {
    // After edit 1, the file has TWO occurrences of "y" (the
    // original "y" plus the "y" introduced by replacing "x" with
    // "y"). Edit 2 targeting "y" without replace_all must fail —
    // the gate operates on the live working content, not the
    // original.
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'x\ny\n');
    const out = await editFileTool.execute(
      {
        path,
        edits: [
          { old_string: 'x', new_string: 'y' },
          { old_string: 'y', new_string: 'z' }, // ambiguous after edit 1
        ],
      },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) {
      expect(out.error_code).toBe('edit.ambiguous_match');
      expect(out.error_message).toContain('edits[1]');
    }
    // File untouched — all-or-nothing.
    expect(readFileSync(path, 'utf-8')).toBe('x\ny\n');
  });

  test('round-trip batch (foo→bar→foo) is a no-op write', async () => {
    // Each individual edit passes the per-edit `old !== new`
    // gate, but the cumulative effect leaves the file textually
    // identical to the original. Without the no-op guard the
    // tool would still write — phantom mtime bump, empty diff in
    // the TUI, misleading "this call modified the file" signal
    // for FS watchers and audit. Pin the guard's behavior so a
    // future "clean up unreachable branch" refactor can't quietly
    // re-introduce the phantom write.
    const path = join(dir, 'a.ts');
    const original = 'foo';
    writeFileSync(path, original);
    const beforeMtime = (require('node:fs').statSync(path) as { mtimeMs: number }).mtimeMs;
    const out = await editFileTool.execute(
      {
        path,
        edits: [
          { old_string: 'foo', new_string: 'bar' },
          { old_string: 'bar', new_string: 'foo' },
        ],
      },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.bytes_written).toBe(0);
    expect(out.total_replacements).toBe(2);
    expect(readFileSync(path, 'utf-8')).toBe(original);
    // mtime must NOT have advanced — the guard skipped Bun.write
    // entirely. (statSync runs synchronously after the await
    // resolves, so any write would already be visible.)
    const afterMtime = (require('node:fs').statSync(path) as { mtimeMs: number }).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
  });

  test('writes once at the end (single bytes_written for the whole batch)', async () => {
    // Three edits, one write. `bytes_written` reflects the final
    // size, not the cumulative bytes touched. Pin so a future
    // refactor doesn't introduce per-edit writes (which would
    // multiply checkpoint cost and break the diff display).
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'aa\nbb\ncc');
    const out = await editFileTool.execute(
      {
        path,
        edits: [
          { old_string: 'aa', new_string: 'AA' },
          { old_string: 'bb', new_string: 'BB' },
          { old_string: 'cc', new_string: 'CC' },
        ],
      },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error('unexpected error');
    const finalContent = 'AA\nBB\nCC';
    expect(out.bytes_written).toBe(Buffer.byteLength(finalContent, 'utf8'));
    expect(readFileSync(path, 'utf-8')).toBe(finalContent);
  });
});
