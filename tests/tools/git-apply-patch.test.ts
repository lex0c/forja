import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  test('multi-file patch is rejected before touching git (patch.unsupported)', async () => {
    gitInit(dir);
    const twoFiles = `${modifyPatch}--- a/g.txt
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
