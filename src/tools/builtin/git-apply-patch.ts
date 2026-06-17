import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { getWorktreeRoot, isGitRepo } from '../../checkpoints/git.ts';
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

// Hard cap on a single git invocation. Mirrors checkpoints/git.ts RUN_GIT
// timeout: long enough for a real apply, short enough that a wedged git (ref
// lock, stalled network mount, hung hook) can't pin the turn indefinitely.
const GIT_APPLY_TIMEOUT_MS = 30_000;

interface GitRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

// Spawn `git <args>` feeding `patch` on stdin; return exit code + stdout/stderr.
// Reuses the hardened binary/env resolution (pinned absolute git, controlled
// PATH). A 30s timeout AND ctx.signal both kill the subprocess — without either,
// a stuck git apply would hang the whole turn.
const runGitApply = async (
  git: string,
  env: Record<string, string>,
  cwd: string,
  args: string[],
  patch: string,
  signal: AbortSignal,
): Promise<GitRun> => {
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
  // Start draining stdout/stderr BEFORE writing stdin: a large patch fed to
  // stdin while git emits output would otherwise risk a pipe deadlock (git
  // blocks on a full stdout pipe while we block writing stdin). Today's probes
  // emit little, but the concurrent drain is the safe pattern.
  const stdoutP = new Response(proc.stdout).text();
  const stderrP = new Response(proc.stderr).text();
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
  const [stdout, stderr, exitCode] = await Promise.all([stdoutP, stderrP, proc.exited]);
  clearTimeout(timer);
  signal.removeEventListener('abort', onAbort);
  return { exitCode, stdout, stderr: stderr.trim(), timedOut, aborted };
};

// Canonicalize the DIRECTORY a path lives in to its realpath, keeping the
// basename literal. getWorktreeRoot() returns git's realpath-resolved root, so
// when the session cwd reaches the repo through a symlink (workspace mount,
// symlinked checkout) a lexically-resolved path would sit under the symlink and
// look like a worktree escape against the real root — falsely rejecting every
// patch with path_mismatch. Resolving the parent dir puts both the gated path
// and git's write target in the same coordinate system. The basename stays
// un-followed so the symlink-leaf reject still inspects the link itself. Mirrors
// the engine/matcher resolveSymlinks fallback; falls back to the lexical form
// when the parent doesn't exist yet (a creation in a not-yet-made dir).
const canonicalizeDir = (abs: string): string => {
  try {
    return join(realpathSync(dirname(abs)), basename(abs));
  } catch {
    return abs;
  }
};

const unsupported = (message: string, hint: string): ToolResult<never> =>
  toolError(ERROR_CODES.patchUnsupported, message, { retryable: false, hint });
const malformed = (message: string): ToolResult<never> =>
  toolError(ERROR_CODES.patchMalformed, message, { retryable: true });

type Classified =
  | { ok: true; path: string; added: number; removed: number }
  | { ok: false; error: ToolResult<never> };

// Classify the patch by asking GIT what it does, rather than re-parsing the
// diff ourselves (the source of repeated divergence bugs). Both probes run with
// the SAME `--recount` the apply uses and are pure patch-level (they don't read
// the worktree), so their verdict is exactly what `git apply` will touch:
//   - `--summary`: structural ops. Reject delete (delete-fs op — use the
//     shell), rename/copy (second path), mode change (chmod, not a content
//     edit). `create mode` is allowed (a creation is a write).
//   - `--numstat -z`: the file set + the write target. >1 file → multi-file;
//     `-`/`-` counts → binary; the one entry's path is git's exact write target
//     (already -p1-stripped, whitespace-preserved), which the caller pins.
const classifyPatch = async (
  git: string,
  env: Record<string, string>,
  worktreeRoot: string,
  patch: string,
  signal: AbortSignal,
): Promise<Classified> => {
  const abortedErr = (where: string): Classified => ({
    ok: false,
    error: toolError(ERROR_CODES.aborted, `aborted during ${where}`, { retryable: true }),
  });
  const timedOutErr = (where: string): Classified => ({
    ok: false,
    error: toolError(ERROR_CODES.patchApplyFailed, `${where} timed out (30s)`, { retryable: true }),
  });

  // Structural ops (delete/rename/copy/mode). Run first so a rename never
  // reaches the numstat parse (its -z output has an irregular shape).
  const summary = await runGitApply(
    git,
    env,
    worktreeRoot,
    ['apply', '--summary', '--recount', '-'],
    patch,
    signal,
  );
  if (summary.aborted) return abortedErr('git apply --summary');
  if (summary.timedOut) return timedOutErr('git apply --summary');
  if (summary.exitCode !== 0) {
    return {
      ok: false,
      error: malformed(
        `patch does not parse: ${summary.stderr || `git apply --summary exited ${summary.exitCode}`}`,
      ),
    };
  }
  for (const raw of summary.stdout.split('\n')) {
    const op = raw.trim();
    // Both forms: git-format `delete mode 100644 f` and traditional `delete f`
    // (a `+++ /dev/null` patch with no `deleted file mode` header still deletes).
    if (op.startsWith('delete ')) {
      return {
        ok: false,
        error: unsupported(
          'deletion patches are not supported',
          'Delete files with the shell (rm); git_apply_patch edits or creates content.',
        ),
      };
    }
    if (op.startsWith('rename ') || op.startsWith('copy ')) {
      return {
        ok: false,
        error: unsupported(
          'rename/copy patches touch two paths; not supported (single-file only)',
          'Use the shell to move/copy, then patch content separately.',
        ),
      };
    }
    if (op.startsWith('mode change')) {
      return {
        ok: false,
        error: unsupported(
          'mode-change (chmod) patches are not supported (content edits only)',
          'Change file modes with the shell (chmod).',
        ),
      };
    }
    // Symlink (120000) / submodule gitlink (160000) creates are NOT content —
    // write_file can't make them either, and a symlink at the gated path could
    // set up a later write-through. Allow only regular-file creates
    // (`create mode 100644`/`100755`).
    if (op.startsWith('create mode 120000') || op.startsWith('create mode 160000')) {
      return {
        ok: false,
        error: unsupported(
          'symlink/submodule creation is not supported (regular files only)',
          'Create symlinks/submodules with the shell; git_apply_patch writes file content.',
        ),
      };
    }
    // A regular-file ` create mode 100644/100755 … ` is allowed — a creation is
    // a write-fs op like write_file.
  }

  // File set + write target + binary, from git's own numstat.
  const numstat = await runGitApply(
    git,
    env,
    worktreeRoot,
    ['apply', '--numstat', '-z', '--recount', '-'],
    patch,
    signal,
  );
  if (numstat.aborted) return abortedErr('git apply --numstat');
  if (numstat.timedOut) return timedOutErr('git apply --numstat');
  if (numstat.exitCode !== 0) {
    return {
      ok: false,
      error: malformed(
        `patch does not parse: ${numstat.stderr || `git apply --numstat exited ${numstat.exitCode}`}`,
      ),
    };
  }

  const files: { path: string; added: number; removed: number }[] = [];
  for (const entry of numstat.stdout.split('\0')) {
    // Skip empties AND any whitespace-only trailer (a trailing NUL yields '',
    // and a stray trailing newline yields '\n') — never a real entry, which
    // always begins with a count.
    if (entry.trim().length === 0) continue;
    const tab1 = entry.indexOf('\t');
    const tab2 = tab1 === -1 ? -1 : entry.indexOf('\t', tab1 + 1);
    if (tab1 === -1 || tab2 === -1) {
      // Irregular entry (e.g. a rename's -z fragment). Renames are already
      // rejected above; anything else here is a shape we won't risk pinning.
      return {
        ok: false,
        error: unsupported('unrecognized patch shape', 'Use a plain single-file content diff.'),
      };
    }
    const added = entry.slice(0, tab1);
    const removed = entry.slice(tab1 + 1, tab2);
    const path = entry.slice(tab2 + 1);
    if (added === '-' || removed === '-') {
      return {
        ok: false,
        error: unsupported('binary patches are not supported', 'git_apply_patch is content-only.'),
      };
    }
    if (path.length === 0) {
      return {
        ok: false,
        error: unsupported('unrecognized patch shape', 'Use a plain single-file content diff.'),
      };
    }
    files.push({ path, added: Number(added), removed: Number(removed) });
  }

  if (files.length === 0) return { ok: false, error: malformed('patch touches no files') };
  if (files.length > 1) {
    return {
      ok: false,
      error: unsupported(
        `patch touches ${files.length} files; git_apply_patch is single-file only`,
        'Split into one patch per file, or use edit_file/write_file.',
      ),
    };
  }
  const only = files[0] as { path: string; added: number; removed: number };
  return { ok: true, path: only.path, added: only.added, removed: only.removed };
};

export const gitApplyPatchTool: Tool<GitApplyPatchInput, GitApplyPatchOutput> = {
  name: 'git_apply_patch',
  description:
    "Edit ONE file by applying a unified diff (git diff format) via `git apply` — a diff-shaped alternative to edit_file's {old_string,new_string} pairs. Pass `path` plus a `patch` whose header names that same file. Hunk line-counts are recomputed, so only the context lines must match (you need not get the @@ counts right). edit_file is the default for simple localized edits; reach for this when a diff is the natural shape — several hunks in one file, or a patch you already have. Single-file only: rejects multi-file, rename/copy, deletion, and binary patches. Requires a git work-tree (else use edit_file/write_file). All-or-nothing: the file changes only if the whole patch applies. Returns { path, added, removed }.",
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

    // Ask git what the patch touches (single file? which path? structural ops?)
    // rather than re-parse the diff — git is the source of truth and runs the
    // same --recount the apply uses.
    const cls = await classifyPatch(git, env, worktreeRoot, args.patch, ctx.signal);
    if (!cls.ok) return cls.error;

    // Path pinning: git apply writes `<worktreeRoot>/<numstat path>`. Require
    // that to be the SAME absolute file the engine gated (args.path), inside the
    // worktree. This keeps the single-path gate sufficient — git can only touch
    // the one authorized file, and the path comes from git itself (no parser
    // divergence from what apply will write).
    //
    // Both sides go through canonicalizeDir so a symlink ANYWHERE in the path
    // (a symlinked cwd/checkout, a symlinked subdir, /tmp→/private/tmp on macOS)
    // resolves identically — without it, git's realpath'd worktreeRoot vs a
    // lexically-resolved gatedAbs would falsely read as an escape.
    //
    // Deliberately NOT tilde-expanded (unlike the engine's fs resolver, which
    // maps `~` via its resolved `ctx.home`). ToolContext carries no `home`, so
    // expanding here would have to use a DIFFERENT source (homedir/env) than the
    // engine used; if the engine ran with an injected `options.home`, a homedir-
    // based gatedAbs could coincidentally equal writeAbs and let git write a file
    // the engine authorized under a different home — weakening the pin. A `~`
    // path instead resolves to a literal `<cwd>/~/…`, never matches the tilde-
    // free worktree-relative writeAbs, and fails the pin closed. (git's own patch
    // paths are worktree-relative and never carry `~`, so this rejects nothing
    // real.) Do not "fix" this with homedir() — the safe expansion needs the
    // engine's exact home plumbed through ToolContext.
    const gatedAbs = canonicalizeDir(
      isAbsolute(pathArg) ? resolve(pathArg) : resolve(ctx.cwd, pathArg),
    );
    const writeAbs = canonicalizeDir(resolve(worktreeRoot, cls.path));
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
    if (writeAbs !== gatedAbs) {
      // The file git WILL write differs from the file the engine gated. This
      // also bites when cwd is a SUBDIR of the repo: git resolves the patch
      // header relative to the worktree root while `path` resolves from cwd, so
      // they only coincide when cwd is the repo root.
      const cwdNote =
        relative(worktreeRoot, ctx.cwd) !== ''
          ? ' (note: cwd is not the repo root; git resolves the patch path relative to the worktree root)'
          : '';
      return toolError(
        ERROR_CODES.patchPathMismatch,
        `patch writes '${cls.path}' but the path arg gates '${relative(worktreeRoot, gatedAbs)}'${cwdNote}`,
        {
          retryable: true,
          hint: 'Set `path` so it resolves (from cwd) to the same file the patch writes (relative to the repo root).',
        },
      );
    }

    // The patch must edit REGULAR-file content. If the gated path is already a
    // symlink, `git apply` rewrites the LINK TARGET in place (mode stays 120000,
    // so neither --summary nor --numstat flags it — numstat reports a normal 1/1
    // text change), repointing it anywhere, e.g. `link -> ../../etc/passwd`. That
    // escapes the regular-files-only contract the symlink-CREATE reject already
    // enforces, so reject editing an existing symlink (or any non-regular file:
    // gitlink, fifo, device) too. lstat (not stat) so we inspect the link itself,
    // not its target. A missing target is a creation — the classifier already
    // proved it's `create mode 100644/100755`, not 120000/160000.
    let targetStat: ReturnType<typeof lstatSync> | null = null;
    try {
      targetStat = lstatSync(writeAbs);
    } catch (e) {
      // ENOENT → safe creation. Any other lstat failure (ELOOP from a symlink
      // cycle, EACCES on an ancestor) means we cannot confirm a regular file —
      // refuse rather than hand the path to `git apply` blind.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        return unsupported(
          `cannot stat the patch target: ${(e as Error).message}`,
          'Ensure the path points at a regular file inside the work-tree.',
        );
      }
    }
    if (targetStat !== null && !targetStat.isFile()) {
      return unsupported(
        'patch target is a symlink or other non-regular file (regular-file content only)',
        'git_apply_patch edits regular files; recreate links or special files with the shell.',
      );
    }

    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before apply', { retryable: true });
    }

    // Dry-run first: `git apply --check` validates the patch against the current
    // file (context match) without writing — a failure here leaves it untouched.
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

    // Before-image, read pre-apply. Feeds the display diff AND the deletion
    // guard below (so restore doesn't depend on emitDiff being wired). One
    // small read; '' for a creation (the file doesn't exist yet).
    const existedBefore = targetStat !== null;
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

    // Deletion guard, defense-in-depth and INDEPENDENT of `git apply --summary`
    // text. classifyPatch rejects deletions by matching the summary's `delete `
    // line, but --numstat can't corroborate it (a deletion reports `0\tN\tpath`,
    // identical to an edit that removes lines). If some git version's --summary
    // failed to emit `delete`, a deletion (a delete-fs op) would slip through
    // under the write-fs gate. A file that EXISTED before and is gone after can
    // only have been deleted — restore it from the before-image and refuse.
    // (A creation never trips this: existedBefore is false; a content edit
    // always leaves the file in place.)
    if (existedBefore && !existsSync(writeAbs)) {
      await Bun.write(gatedAbs, before);
      return unsupported(
        'patch deletes the file; deletion is not supported (delete-fs is out of scope)',
        'Delete files with the shell (rm); git_apply_patch edits or creates content.',
      );
    }

    // Display diff (when a TUI consumer is wired) from lineDiff so the card —
    // gutter, snippet, colors — matches write_file/edit_file. The model-facing
    // RESULT counts come from git's numstat instead: lineDiff strips the
    // trailing newline, so a newline-only change reports 0/0 there while git
    // (and the user's intent) counts it. numstat is the authoritative count.
    if (ctx.emitDiff !== undefined) {
      const after = await Bun.file(gatedAbs)
        .text()
        .catch(() => '');
      const fileDiff = lineDiff(before, after);
      if (fileDiff.added + fileDiff.removed > 0) ctx.emitDiff(fileDiff);
    }
    return { path: pathArg, added: cls.added, removed: cls.removed };
  },
};
