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

describe('editFileTool — whitespace-tolerant fallback + actionable errors', () => {
  test('unique uniform-indent near-match applies, re-indented to the file', async () => {
    const path = join(dir, 'a.ts');
    const file = ['class A {', '    foo() {', '        return 1;', '    }', '}', ''].join('\n');
    writeFileSync(path, file);
    // Model dropped the class indentation — old_string at top level.
    const oldString = ['foo() {', '    return 1;', '}'].join('\n');
    const newString = ['foo() {', '    return 2;', '}'].join('\n');
    const out = await editFileTool.execute(
      { path, edits: [{ old_string: oldString, new_string: newString }] },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.edits).toEqual([{ replacements: 1, whitespace_tolerant: true }]);
    // new_string re-indented by the file's +4 shift (not the model's).
    expect(readFileSync(path, 'utf-8')).toBe(
      ['class A {', '    foo() {', '        return 2;', '    }', '}', ''].join('\n'),
    );
  });

  test('uniform strip (model over-indented) applies with the file indentation', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, ['foo() {', '    return 1;', '}', ''].join('\n'));
    const oldString = ['    foo() {', '        return 1;', '    }'].join('\n'); // +4 vs file
    const newString = ['    foo() {', '        return 2;', '    }'].join('\n');
    const out = await editFileTool.execute(
      { path, edits: [{ old_string: oldString, new_string: newString }] },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.edits[0]?.whitespace_tolerant).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe(['foo() {', '    return 2;', '}', ''].join('\n'));
  });

  test('trailing-whitespace-only near-match applies', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, ['if (x) {', '  doThing();   ', '}', ''].join('\n')); // trailing spaces
    const oldString = ['if (x) {', '  doThing();', '}'].join('\n');
    const newString = ['if (x) {', '  doThing2();', '}'].join('\n');
    const out = await editFileTool.execute(
      { path, edits: [{ old_string: oldString, new_string: newString }] },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.edits[0]?.whitespace_tolerant).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe(['if (x) {', '  doThing2();', '}', ''].join('\n'));
  });

  test('non-uniform indentation is NOT auto-applied; error names the near-match span', async () => {
    const path = join(dir, 'a.ts');
    const file = ['    a();', '        b();', '    c();'].join('\n');
    writeFileSync(path, file);
    // Indentation drifts non-uniformly vs the file (+4, +4, -4).
    const oldString = ['a();', '    b();', '        c();'].join('\n');
    const out = await editFileTool.execute(
      { path, edits: [{ old_string: oldString, new_string: 'x();' }] },
      makeCtx({ cwd: dir }),
    );
    if (!isToolError(out)) throw new Error('expected old_string_not_found');
    expect(out.error_code).toBe('edit.old_string_not_found');
    expect(out.details?.near_match).toEqual({ start_line: 1, end_line: 3, text: file });
    expect(readFileSync(path, 'utf-8')).toBe(file); // untouched
  });

  test('tabs-vs-spaces indentation is treated as unsafe (not applied)', async () => {
    const path = join(dir, 'a.ts');
    const file = '\tfoo();'; // tab-indented
    writeFileSync(path, file);
    const out = await editFileTool.execute(
      { path, edits: [{ old_string: '    foo();', new_string: '    bar();' }] }, // space-indented
      makeCtx({ cwd: dir }),
    );
    if (!isToolError(out)) throw new Error('expected old_string_not_found');
    expect(out.error_code).toBe('edit.old_string_not_found');
    expect(out.details?.near_match).toBeDefined();
    expect(readFileSync(path, 'utf-8')).toBe(file);
  });

  test('multiple whitespace near-matches report their line numbers', async () => {
    const path = join(dir, 'a.ts');
    // Two tab-indented lines trim-match the space-indented needle; neither
    // matches exactly → no exact match, two near-matches.
    const file = ['\t\tfoo();', '\tfoo();'].join('\n');
    writeFileSync(path, file);
    const out = await editFileTool.execute(
      { path, edits: [{ old_string: '  foo();', new_string: '  bar();' }] },
      makeCtx({ cwd: dir }),
    );
    if (!isToolError(out)) throw new Error('expected old_string_not_found');
    expect(out.error_code).toBe('edit.old_string_not_found');
    expect(out.details?.near_match_lines).toEqual([1, 2]);
    expect(readFileSync(path, 'utf-8')).toBe(file);
  });

  test('ambiguous exact match reports occurrence line numbers (actionable)', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'foo\nfoo\nfoo\n');
    const out = await editFileTool.execute(
      { path, edits: [{ old_string: 'foo', new_string: 'bar' }] },
      makeCtx({ cwd: dir }),
    );
    if (!isToolError(out)) throw new Error('expected ambiguous_match');
    expect(out.error_code).toBe('edit.ambiguous_match');
    expect(out.details?.occurrences).toBe(3);
    expect(out.details?.lines).toEqual([1, 2, 3]);
  });

  test('exact match still applies with no whitespace_tolerant flag', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, '  const x = 1;\n'); // indented; exact substring still matches
    const out = await editFileTool.execute(
      { path, edits: [{ old_string: 'const x = 1;', new_string: 'const x = 2;' }] },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.edits).toEqual([{ replacements: 1 }]); // no whitespace_tolerant key
    expect(readFileSync(path, 'utf-8')).toBe('  const x = 2;\n');
  });

  test('CRLF file is not matched by an LF old_string (no line-ending corruption)', async () => {
    const path = join(dir, 'a.ts');
    const file = 'function foo() {\r\n  return 1;\r\n}\r\n'; // CRLF
    writeFileSync(path, file);
    const out = await editFileTool.execute(
      {
        path,
        edits: [
          {
            old_string: 'function foo() {\n  return 1;\n}', // LF (what the model emits)
            new_string: 'function foo() {\n  return 2;\n}',
          },
        ],
      },
      makeCtx({ cwd: dir }),
    );
    // Must NOT silently fall back — that would rewrite \r\n → \n.
    if (!isToolError(out))
      throw new Error('CRLF must not whitespace-fallback onto an LF old_string');
    expect(out.error_code).toBe('edit.old_string_not_found');
    expect(readFileSync(path, 'utf-8')).toBe(file); // line endings untouched
  });

  test('whitespace-only old_string does not fall back onto a blank line', async () => {
    const path = join(dir, 'a.ts');
    const file = 'a();\n\nb();\n'; // contains a blank line
    writeFileSync(path, file);
    const out = await editFileTool.execute(
      { path, edits: [{ old_string: '   ', new_string: 'INSERTED' }] }, // whitespace-only
      makeCtx({ cwd: dir }),
    );
    if (!isToolError(out)) throw new Error('expected old_string_not_found');
    expect(out.error_code).toBe('edit.old_string_not_found');
    expect(readFileSync(path, 'utf-8')).toBe(file);
  });

  test('fallback runs as a later batch edit, against the post-previous-edit content', async () => {
    // edit 1 (exact) changes the file; edit 2 falls into the whitespace
    // fallback against the RESULT of edit 1. Pins both: fallback at N>1
    // operating on `working`, and the mixed per-edit flag array.
    const path = join(dir, 'a.ts');
    writeFileSync(
      path,
      ['let v = 1;', 'class C {', '    run() {', '        return v;', '    }', '}', ''].join('\n'),
    );
    const out = await editFileTool.execute(
      {
        path,
        edits: [
          { old_string: 'let v = 1;', new_string: 'let v = 2;' }, // exact
          {
            old_string: ['run() {', '    return v;', '}'].join('\n'), // dedented — fallback
            new_string: ['run() {', '    return v * 2;', '}'].join('\n'),
          },
        ],
      },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(out.edits).toEqual([
      { replacements: 1 },
      { replacements: 1, whitespace_tolerant: true },
    ]);
    expect(readFileSync(path, 'utf-8')).toBe(
      ['let v = 2;', 'class C {', '    run() {', '        return v * 2;', '    }', '}', ''].join(
        '\n',
      ),
    );
  });

  test('fallback error line numbers are relative to the post-previous-edit content', async () => {
    // edit 1 deletes the first line, shifting everything up; edit 2's
    // unsafe near-match must report lines against the SHIFTED content.
    const path = join(dir, 'a.ts');
    const file = ['DELETE_ME', '    a();', '        b();', '    c();', ''].join('\n');
    writeFileSync(path, file);
    const out = await editFileTool.execute(
      {
        path,
        edits: [
          { old_string: 'DELETE_ME\n', new_string: '' }, // removes line 1
          // non-uniform indent (+4/+4/-4) → unsafe near-match
          { old_string: ['a();', '    b();', '        c();'].join('\n'), new_string: 'x();' },
        ],
      },
      makeCtx({ cwd: dir }),
    );
    if (!isToolError(out)) throw new Error('expected old_string_not_found');
    expect(out.error_code).toBe('edit.old_string_not_found');
    // a();/b();/c(); sit at lines 1-3 AFTER edit 1 removed DELETE_ME
    // (they'd be 2-4 in the original) — proves the search ran on `working`.
    expect(out.details?.near_match).toMatchObject({ start_line: 1, end_line: 3 });
    expect(readFileSync(path, 'utf-8')).toBe(file); // all-or-nothing: untouched
  });

  test('re-indent handles new_string with more lines than old_string', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, ['    if (x) {', '        a();', '    }', ''].join('\n'));
    const out = await editFileTool.execute(
      {
        path,
        edits: [
          {
            old_string: ['if (x) {', '    a();', '}'].join('\n'), // 3 lines, dedented
            new_string: ['if (x) {', '    a();', '    b();', '}'].join('\n'), // 4 lines
          },
        ],
      },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    expect(readFileSync(path, 'utf-8')).toBe(
      ['    if (x) {', '        a();', '        b();', '    }', ''].join('\n'),
    );
  });

  test('re-indent leaves a blank line in new_string empty (no stray indentation)', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, ['    foo() {', '        a();', '    }', ''].join('\n'));
    const out = await editFileTool.execute(
      {
        path,
        edits: [
          {
            old_string: ['foo() {', '    a();', '}'].join('\n'),
            new_string: ['foo() {', '    a();', '', '    b();', '}'].join('\n'), // blank line
          },
        ],
      },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    // The blank line is truly empty, NOT indented to '        '.
    expect(readFileSync(path, 'utf-8')).toBe(
      ['    foo() {', '        a();', '', '        b();', '    }', ''].join('\n'),
    );
  });

  test('re-indent (strip) leaves a too-shallow new line untouched rather than guessing', async () => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, ['foo() {', '    a();', '}', ''].join('\n')); // top-level
    const out = await editFileTool.execute(
      {
        path,
        edits: [
          {
            old_string: ['    foo() {', '        a();', '    }'].join('\n'), // over-indented (+4)
            // new line 'weird' has only 2-space indent, shallower than the 4-space strip
            new_string: ['    foo() {', '        a();', '  weird();', '    }'].join('\n'),
          },
        ],
      },
      makeCtx({ cwd: dir }),
    );
    if (isToolError(out)) throw new Error(`unexpected error: ${out.error_message}`);
    // strip '    ': aligned lines de-indent; the 2-space line can't strip 4 → left as-is.
    expect(readFileSync(path, 'utf-8')).toBe(
      ['foo() {', '    a();', '  weird();', '}', ''].join('\n'),
    );
  });
});
