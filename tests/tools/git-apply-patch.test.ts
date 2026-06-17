import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileDiff } from '../../src/diff/line-diff.ts';
import { gitApplyPatchTool } from '../../src/tools/builtin/git-apply-patch.ts';
import { ERROR_CODES, isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

const gitInit = (cwd: string): void => {
  const r = Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd, stdout: 'ignore', stderr: 'ignore' });
  if (!r.success) throw new Error('git init failed (is git installed?)');
};

// Modify line 2 of a 3-line file. Valid git-apply unified diff (a/ b/ prefixes).
const modifyPatch = `--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,3 @@
 a
-b
+B
 c
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forja-gap-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('gitApplyPatchTool', () => {
  test('applies a single-file patch, mutates the file, and emits a FileDiff', async () => {
    gitInit(dir);
    writeFileSync(join(dir, 'f.txt'), 'a\nb\nc\n');
    const diffs: FileDiff[] = [];
    const res = await gitApplyPatchTool.execute(
      { path: 'f.txt', patch: modifyPatch },
      makeCtx({ cwd: dir, emitDiff: (d) => diffs.push(d) }),
    );
    expect(isToolError(res)).toBe(false);
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('a\nB\nc\n');
    if (!isToolError(res)) {
      expect(res.path).toBe('f.txt');
      expect(res.added).toBe(1);
      expect(res.removed).toBe(1);
    }
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.added).toBe(1);
  });

  test('applies a patch with WRONG @@ line counts (--recount recomputes)', async () => {
    gitInit(dir);
    writeFileSync(join(dir, 'f.txt'), 'a\nb\nc\n');
    // Header says -1,9 +1,9 (wrong; real is -1,3 +1,3). With --recount git
    // recomputes from the body, so only the context lines need to match.
    const wrongCounts = '--- a/f.txt\n+++ b/f.txt\n@@ -1,9 +1,9 @@\n a\n-b\n+B\n c\n';
    const res = await gitApplyPatchTool.execute(
      { path: 'f.txt', patch: wrongCounts },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(res)).toBe(false);
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('a\nB\nc\n');
  });

  test('rejects an appended metadata section that would touch another path (no confinement bypass)', async () => {
    gitInit(dir);
    writeFileSync(join(dir, 'allowed.txt'), 'hello\n');
    // Content edit of the gated file + an appended empty-create of a path the
    // permission engine never saw. git apply --recount would create it.
    const attack =
      '--- a/allowed.txt\n+++ b/allowed.txt\n@@ -1 +1 @@\n-hello\n+HELLO\ndiff --git a/created.txt b/created.txt\nnew file mode 100644\nindex 0000000..0000000\n';
    const res = await gitApplyPatchTool.execute(
      { path: 'allowed.txt', patch: attack },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(res)).toBe(true);
    if (isToolError(res)) expect(res.error_code).toBe(ERROR_CODES.patchUnsupported);
    // The out-of-scope path was NOT created, and the gated file is untouched.
    expect(existsSync(join(dir, 'created.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'allowed.txt'), 'utf8')).toBe('hello\n');
  });

  test('prefix-less header: the pin catches git -p1 stripping to a different file', async () => {
    gitInit(dir);
    // git apply -p1 strips `src/` from `--- src/f.txt`, so numstat reports the
    // real write target `f.txt` — which the pin rejects against the gated
    // `src/f.txt`. The root file git would have written stays untouched.
    writeFileSync(join(dir, 'f.txt'), 'old\n');
    const attack = '--- src/f.txt\n+++ src/f.txt\n@@ -1 +1 @@\n-old\n+HACKED\n';
    const res = await gitApplyPatchTool.execute(
      { path: 'src/f.txt', patch: attack },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(res)).toBe(true);
    if (isToolError(res)) expect(res.error_code).toBe(ERROR_CODES.patchPathMismatch);
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('old\n');
  });

  test('applies a patch whose hunk ends with content lines that look like headers', async () => {
    // Regression: trailing `-- a/X`/`++ b/X` content (rendered `--- a/X`/`+++
    // b/X`) must not be miscounted as a second file. git (and now the tool, via
    // numstat) sees ONE file.
    gitInit(dir);
    writeFileSync(join(dir, 'f.txt'), 'line1\n-- a/not-header\n');
    const patch =
      'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n line1\n--- a/not-header\n+++ b/not-header\n';
    const res = await gitApplyPatchTool.execute({ path: 'f.txt', patch }, makeCtx({ cwd: dir }));
    expect(isToolError(res)).toBe(false);
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('line1\n++ b/not-header\n');
  });

  test('filename whitespace is significant — gated "foo" cannot touch sibling "foo " (trailing space)', async () => {
    gitInit(dir);
    writeFileSync(join(dir, 'foo '), 'A\n'); // sibling git would write via the spaced header
    // Gated for 'foo', but the header names 'foo ' (trailing space) — git applies to 'foo '.
    const attack = '--- a/foo \n+++ b/foo \n@@ -1 +1 @@\n-A\n+HACKED\n';
    const res = await gitApplyPatchTool.execute(
      { path: 'foo', patch: attack },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(res)).toBe(true);
    if (isToolError(res)) expect(res.error_code).toBe(ERROR_CODES.patchPathMismatch);
    expect(readFileSync(join(dir, 'foo '), 'utf8')).toBe('A\n'); // sibling untouched
  });

  test('rejects a deletion patch and leaves the file in place (delete-fs is out of scope)', async () => {
    gitInit(dir);
    writeFileSync(join(dir, 'gone.ts'), 'export const x = 1;\n');
    const del = '--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const x = 1;\n';
    const res = await gitApplyPatchTool.execute(
      { path: 'gone.ts', patch: del },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(res)).toBe(true);
    if (isToolError(res)) expect(res.error_code).toBe(ERROR_CODES.patchUnsupported);
    expect(existsSync(join(dir, 'gone.ts'))).toBe(true); // not deleted
  });

  test('creates a regular file (create is allowed; counts come from numstat)', async () => {
    gitInit(dir);
    const create =
      'diff --git a/new.ts b/new.ts\nnew file mode 100644\nindex 0000000..abc1234\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+export const x = 1;\n';
    const res = await gitApplyPatchTool.execute(
      { path: 'new.ts', patch: create },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(res)).toBe(false);
    expect(readFileSync(join(dir, 'new.ts'), 'utf8')).toBe('export const x = 1;\n');
    if (!isToolError(res)) {
      expect(res.added).toBe(1);
      expect(res.removed).toBe(0);
    }
  });

  test('rejects a symlink create (regular files only, like write_file)', async () => {
    gitInit(dir);
    const sym =
      'diff --git a/link b/link\nnew file mode 120000\nindex 0000000..abc1234\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n';
    const res = await gitApplyPatchTool.execute(
      { path: 'link', patch: sym },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(res)).toBe(true);
    if (isToolError(res)) expect(res.error_code).toBe(ERROR_CODES.patchUnsupported);
    expect(existsSync(join(dir, 'link'))).toBe(false);
  });

  test('rejects editing an EXISTING symlink (git would repoint the link target, escaping the work-tree)', async () => {
    gitInit(dir);
    // A symlink `link -> old`. Editing its blob via a content patch keeps mode
    // 120000, so --summary emits nothing and --numstat reports a normal 1/1 text
    // change on `link` (both are pure patch-level — they never read the
    // work-tree). Without the lstat guard, `git apply` would rewrite the link
    // target to `../../etc/passwd`, outside the repo.
    symlinkSync('old', join(dir, 'link'));
    const repoint =
      'diff --git a/link b/link\nindex 0000000..1111111 120000\n--- a/link\n+++ b/link\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+../../etc/passwd\n\\ No newline at end of file\n';
    const res = await gitApplyPatchTool.execute(
      { path: 'link', patch: repoint },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(res)).toBe(true);
    if (isToolError(res)) expect(res.error_code).toBe(ERROR_CODES.patchUnsupported);
    // The symlink is untouched — still points at the original target.
    expect(readlinkSync(join(dir, 'link'))).toBe('old');
  });

  test('applies from a symlinked cwd (worktreeRoot is realpath, cwd is the symlink)', async () => {
    // A real repo plus a symlink pointing at it; run with cwd = the symlink —
    // a symlinked checkout / workspace mount. `git rev-parse --show-toplevel`
    // canonicalizes to the real path, so without canonicalizeDir the gated path
    // (under the symlink) reads as a worktree escape → false patch.path_mismatch.
    const real = join(dir, 'realrepo');
    const link = join(dir, 'linkrepo');
    mkdirSync(real);
    gitInit(real);
    writeFileSync(join(real, 'f.txt'), 'a\nb\nc\n');
    symlinkSync(real, link);
    const res = await gitApplyPatchTool.execute(
      { path: 'f.txt', patch: modifyPatch },
      makeCtx({ cwd: link }),
    );
    expect(isToolError(res)).toBe(false);
    expect(readFileSync(join(real, 'f.txt'), 'utf8')).toBe('a\nB\nc\n');
  });

  test('refuses outside a git work-tree (git.not_a_repo)', async () => {
    // No git init.
    writeFileSync(join(dir, 'f.txt'), 'a\nb\nc\n');
    const res = await gitApplyPatchTool.execute(
      { path: 'f.txt', patch: modifyPatch },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(res)).toBe(true);
    if (isToolError(res)) expect(res.error_code).toBe(ERROR_CODES.gitNotRepo);
  });

  test('context mismatch fails the apply and leaves the file untouched (all-or-nothing)', async () => {
    gitInit(dir);
    writeFileSync(join(dir, 'f.txt'), 'totally\ndifferent\ncontent\n');
    const res = await gitApplyPatchTool.execute(
      { path: 'f.txt', patch: modifyPatch },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(res)).toBe(true);
    if (isToolError(res)) expect(res.error_code).toBe(ERROR_CODES.patchContextMismatch);
    // Untouched.
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('totally\ndifferent\ncontent\n');
  });

  test('multi-file patch is rejected (patch.unsupported)', async () => {
    gitInit(dir);
    // Two `diff --git` sections → numstat reports two files. (A prefix-less
    // traditional two-file patch instead collapses to one under --recount and
    // fails the context check — also rejected, just via a different path.)
    const twoFiles = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1 +1 @@
-a
+A
diff --git a/g.txt b/g.txt
--- a/g.txt
+++ b/g.txt
@@ -1 +1 @@
-x
+y
`;
    const res = await gitApplyPatchTool.execute(
      { path: 'f.txt', patch: twoFiles },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(res)).toBe(true);
    if (isToolError(res)) expect(res.error_code).toBe(ERROR_CODES.patchUnsupported);
  });

  test('path arg that disagrees with the patch header is rejected (patch.path_mismatch)', async () => {
    gitInit(dir);
    writeFileSync(join(dir, 'f.txt'), 'a\nb\nc\n');
    const res = await gitApplyPatchTool.execute(
      { path: 'other.txt', patch: modifyPatch },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(res)).toBe(true);
    if (isToolError(res)) expect(res.error_code).toBe(ERROR_CODES.patchPathMismatch);
  });

  test('a path escaping the work-tree is rejected', async () => {
    gitInit(dir);
    const res = await gitApplyPatchTool.execute(
      { path: '../escape.txt', patch: modifyPatch },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(res)).toBe(true);
    if (isToolError(res)) expect(res.error_code).toBe(ERROR_CODES.patchPathMismatch);
  });

  test('missing/empty args are clean invalid-arg errors', async () => {
    gitInit(dir);
    const noPatch = await gitApplyPatchTool.execute(
      { path: 'f.txt', patch: '' },
      makeCtx({ cwd: dir }),
    );
    expect(isToolError(noPatch)).toBe(true);
    if (isToolError(noPatch)) expect(noPatch.error_code).toBe(ERROR_CODES.invalidArg);
  });

  test('honors an already-aborted signal', async () => {
    gitInit(dir);
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await gitApplyPatchTool.execute(
      { path: 'f.txt', patch: modifyPatch },
      makeCtx({ cwd: dir, signal: ctrl.signal }),
    );
    expect(isToolError(res)).toBe(true);
    if (isToolError(res)) expect(res.error_code).toBe(ERROR_CODES.aborted);
  });
});
