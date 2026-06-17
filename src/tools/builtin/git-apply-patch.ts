import { isAbsolute, relative, resolve } from 'node:path';
import { getWorktreeRoot, isGitRepo } from '../../checkpoints/git.ts';
import { type PatchRejectReason, parseSingleFilePatch } from '../../diff/git-patch.ts';
import { lineDiff } from '../../diff/line-diff.ts';
import { getGitBinaryWithEnv } from '../../subagents/git-binary.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';
import { pathArgOf } from './_path-arg.ts';

export interface GitApplyPatchInput {
  path: string;
  patch: string;
}

export interface GitApplyPatchOutput {
  path: string;
  added: number;
  removed: number;
}

// Same 10 MiB ceiling as write_file's content cap — a patch shouldn't be
// larger than the file it edits, and an unbounded blob would pin the spawn.
const MAX_PATCH_BYTES = 10 * 1024 * 1024;

// Map a parser reject onto a ToolError. `malformed` shapes are retryable (the
// model can re-emit a valid patch); `unsupported` shapes are not (the operation
// is out of scope for the single-file tool — switch to edit_file/write_file).
const rejectToError = (reason: PatchRejectReason, message: string): ToolResult<never> => {
  if (reason === 'deletion') {
    // File removal is a delete-fs op the engine gates separately; route it to
    // the shell rather than perform a delete under this tool's write-fs gate.
    return toolError(ERROR_CODES.patchUnsupported, message, {
      retryable: false,
      hint: 'Delete files with the shell (rm); git_apply_patch edits or creates content.',
    });
  }
  if (
    reason === 'multi_file' ||
    reason === 'rename_or_copy' ||
    reason === 'binary' ||
    reason === 'mode_change'
  ) {
    return toolError(ERROR_CODES.patchUnsupported, message, {
      retryable: false,
      hint: 'git_apply_patch is single-file and content-only. Use edit_file/write_file, or split into one patch per file.',
    });
  }
  return toolError(ERROR_CODES.patchMalformed, message, { retryable: true });
};

// Hard cap on a single git invocation. Mirrors checkpoints/git.ts RUN_GIT
// timeout: long enough for a real apply, short enough that a wedged git (ref
// lock, stalled network mount, hung hook) can't pin the turn indefinitely.
const GIT_APPLY_TIMEOUT_MS = 30_000;

// Spawn `git <args>` feeding `patch` on stdin; return exit code + stderr. Reuses
// the hardened binary/env resolution (pinned absolute git, controlled PATH). A
// 30s timeout AND ctx.signal both kill the subprocess — without either, a stuck
// git apply would hang the whole turn (the gap the bespoke spawn had vs runGit).
const runGitApply = async (
  git: string,
  env: Record<string, string>,
  cwd: string,
  args: string[],
  patch: string,
  signal: AbortSignal,
): Promise<{ exitCode: number; stderr: string; timedOut: boolean; aborted: boolean }> => {
  const proc = Bun.spawn({
    cmd: [git, ...args],
    cwd,
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  let aborted = false;
  const kill = (): void => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, GIT_APPLY_TIMEOUT_MS);
  const onAbort = (): void => {
    aborted = true;
    kill();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const sink = proc.stdin;
  if (sink !== undefined) {
    try {
      sink.write(patch);
      await sink.end();
    } catch {
      // Broken pipe (git refused stdin + exited) — the exit/stderr below
      // carries the real cause.
    }
  }
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  signal.removeEventListener('abort', onAbort);
  return { exitCode, stderr: stderr.trim(), timedOut, aborted };
};

export const gitApplyPatchTool: Tool<GitApplyPatchInput, GitApplyPatchOutput> = {
  name: 'git_apply_patch',
  description:
    "Edit ONE file by applying a unified diff (git diff format) via `git apply` — a diff-shaped alternative to edit_file's {old_string,new_string} pairs. Pass `path` plus a `patch` whose header names that same file. Hunk line-counts are recomputed, so only the context lines must match (you need not get the @@ counts right). edit_file is the default for simple localized edits; reach for this when a diff is the natural shape — several hunks in one file, or a patch you already have. Single-file only: rejects multi-file, rename/copy, and binary patches. Requires a git work-tree (else use edit_file/write_file). All-or-nothing: the file changes only if the whole patch applies. Returns { path, added, removed }.",
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Target file path (absolute or relative to cwd). Must resolve to the SAME file the patch headers name (the headers are relative to the repo root, as `git diff` emits). When cwd is the repo root these coincide; from a subdirectory, adjust `path` so it points at the header file.',
      },
      patch: {
        type: 'string',
        description: 'Unified diff (git diff format) touching exactly the one file in `path`.',
      },
    },
    required: ['path', 'patch'],
  },
  metadata: {
    category: 'fs.write',
    writes: true,
    idempotent: false,
    display: 'diff',
    cost: { latency_ms_typical: 20 },
  },
  async execute(args, ctx): Promise<ToolResult<GitApplyPatchOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before apply', { retryable: true });
    }
    // Same path precedence the engine gated on, so we act on exactly the file
    // the permission check authorized (see _path-arg.ts).
    const pathArg = pathArgOf(args);
    if (pathArg === null) {
      return toolError(ERROR_CODES.invalidArg, "missing or non-string 'path' argument");
    }
    if (typeof args.patch !== 'string' || args.patch.length === 0) {
      return toolError(ERROR_CODES.invalidArg, "missing or empty 'patch' argument");
    }
    if (Buffer.byteLength(args.patch, 'utf8') > MAX_PATCH_BYTES) {
      return toolError(
        ERROR_CODES.patchMalformed,
        `patch too large (cap ${MAX_PATCH_BYTES} bytes)`,
      );
    }

    // Validate the patch shape BEFORE touching git: single file, no
    // rename/copy/binary, a real hunk, and a resolvable target path.
    const parsed = parseSingleFilePatch(args.patch);
    if (!parsed.ok) return rejectToError(parsed.reason, parsed.message);

    // git availability. `getGitBinary` returns the bare 'git' (non-absolute)
    // only when neither the canonical nor the operator PATH resolved it.
    const { git, env } = await getGitBinaryWithEnv();
    if (!isAbsolute(git)) {
      return toolError(ERROR_CODES.gitMissing, 'git not found in PATH', {
        retryable: false,
        hint: 'Install git, or use edit_file/write_file (no git required).',
      });
    }
    if (!(await isGitRepo(ctx.cwd))) {
      return toolError(ERROR_CODES.gitNotRepo, 'git_apply_patch requires a git work-tree', {
        retryable: false,
        hint: 'Run inside a git repository, or use edit_file/write_file.',
      });
    }
    const worktreeRoot = (await getWorktreeRoot(ctx.cwd)) ?? ctx.cwd;

    // Path pinning: git apply runs at the worktree root, so it writes to
    // `<root>/<header path>`. Require that to resolve to the SAME absolute file
    // the engine gated (args.path), and to stay inside the worktree. This is
    // what keeps a single-path gate sufficient — git can only touch the one
    // authorized file.
    const gatedAbs = isAbsolute(pathArg) ? resolve(pathArg) : resolve(ctx.cwd, pathArg);
    const headerAbs = resolve(worktreeRoot, parsed.path);
    const relToRoot = relative(worktreeRoot, gatedAbs);
    if (relToRoot.startsWith('..') || isAbsolute(relToRoot)) {
      return toolError(
        ERROR_CODES.patchPathMismatch,
        `path escapes the git work-tree: ${pathArg}`,
        {
          retryable: false,
        },
      );
    }
    if (headerAbs !== gatedAbs) {
      // The file git WILL write (header path resolved at the worktree root)
      // differs from the file the engine gated (path arg resolved at cwd). This
      // also bites when cwd is a SUBDIR of the repo: the patch header is
      // worktree-root-relative (as `git diff` emits) while `path` resolves from
      // cwd, so they only coincide when cwd is the repo root. Surface both
      // resolved paths so the caller can correct the `path` arg.
      const cwdNote =
        worktreeRoot !== gatedAbs && relative(worktreeRoot, ctx.cwd) !== ''
          ? ' (note: cwd is not the repo root; the patch header is resolved relative to the worktree root)'
          : '';
      return toolError(
        ERROR_CODES.patchPathMismatch,
        `patch writes '${relative(worktreeRoot, headerAbs)}' but the path arg gates '${relative(worktreeRoot, gatedAbs)}'${cwdNote}`,
        {
          retryable: true,
          hint: 'Set `path` so it resolves (from cwd) to the same file the patch header names (relative to the repo root).',
        },
      );
    }

    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before apply', { retryable: true });
    }

    // Dry-run first: `git apply --check` validates the whole patch against the
    // current file without writing. A failure here means the file is untouched.
    // `--recount`: don't trust the `@@` line counts — recompute them from the
    // hunk body. Models reliably get context lines right but often miscount the
    // hunk header; this removes that failure mode so only the context must
    // match (lets the patch be used as a general edit format, not just a
    // pre-made diff). git still validates context, so confinement is unchanged.
    const check = await runGitApply(
      git,
      env,
      worktreeRoot,
      ['apply', '--check', '--recount', '-'],
      args.patch,
      ctx.signal,
    );
    if (check.aborted) {
      return toolError(ERROR_CODES.aborted, 'aborted during git apply --check', {
        retryable: true,
      });
    }
    if (check.timedOut) {
      return toolError(ERROR_CODES.patchApplyFailed, 'git apply --check timed out (30s)', {
        retryable: true,
      });
    }
    if (check.exitCode !== 0) {
      return toolError(
        ERROR_CODES.patchContextMismatch,
        `patch does not apply cleanly: ${check.stderr || `git apply --check exited ${check.exitCode}`}`,
        {
          retryable: true,
          hint: 'The file changed since the diff was generated, or the context lines do not match. Re-read the file and regenerate the patch.',
        },
      );
    }

    // Before-image (for the counts in the result AND the display diff). A
    // creation patch has no prior content → empty.
    const before = await Bun.file(gatedAbs)
      .text()
      .catch(() => '');

    const apply = await runGitApply(
      git,
      env,
      worktreeRoot,
      ['apply', '--recount', '-'],
      args.patch,
      ctx.signal,
    );
    if (apply.aborted) {
      return toolError(ERROR_CODES.aborted, 'aborted during git apply', { retryable: true });
    }
    if (apply.timedOut) {
      return toolError(ERROR_CODES.patchApplyFailed, 'git apply timed out (30s)', {
        retryable: true,
      });
    }
    if (apply.exitCode !== 0) {
      // Passed --check but failed to apply (e.g. a concurrent write between the
      // two calls). git apply is atomic per file, so the file is untouched.
      return toolError(
        ERROR_CODES.patchApplyFailed,
        `git apply failed after --check passed: ${apply.stderr || `exited ${apply.exitCode}`}`,
        { retryable: true },
      );
    }

    // after-image → counts (always) + display diff (when a TUI consumer is
    // wired). Reuses lineDiff so the card matches write_file/edit_file exactly.
    const after = await Bun.file(gatedAbs)
      .text()
      .catch(() => '');
    const fileDiff = lineDiff(before, after);
    if (ctx.emitDiff !== undefined && fileDiff.added + fileDiff.removed > 0) ctx.emitDiff(fileDiff);
    return { path: pathArg, added: fileDiff.added, removed: fileDiff.removed };
  },
};
