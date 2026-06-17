import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { matchSensitivePath } from '../permissions/sensitive-paths.ts';
import { getGitBinary, safeGitEnv } from '../subagents/git-binary.ts';

// Low-level git plumbing for the checkpoint subsystem.
//
// Why we don't shell out via `git stash`:
// - `git stash` push/pop manipulates `refs/stash` (the user-visible
//   stash stack). Our checkpoints must NOT pollute the user's stash list,
//   so we build commit objects directly with `commit-tree`.
// - We also need to chain checkpoints (each new one parents off the
//   prior session checkpoint, so the ref keeps the whole history
//   reachable). `git stash create` only sets HEAD as parent.
//
// Index isolation:
// - We never touch the user's `.git/index`. Every staging operation runs
//   with `GIT_INDEX_FILE` pointing at a temp file under /tmp. The temp
//   index is seeded from HEAD's tree (or empty in a freshly-init'd repo)
//   so `git add -A` against it produces a tree that reflects the current
//   working-tree state.

interface SpawnGitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface RunGitOptions {
  cwd: string;
  env?: Record<string, string>;
  stdin?: string;
  // Some commands legitimately exit non-zero (e.g., `git diff --quiet`
  // returns 1 when there's a diff). When set, exit codes in this list
  // resolve normally instead of throwing.
  okExitCodes?: number[];
  // Hard cap on subprocess wall-clock. Default RUN_GIT_DEFAULT_TIMEOUT_MS
  // (30s) — enough for write-tree + commit-tree on a 10k-file repo per
  // CHECKPOINTS §2.8, short enough that a stuck git process (e.g., ref
  // store waiting on another git's lock) doesn't wedge a session
  // indefinitely. The harness's checkpoint snapshot wraps `runGit` in
  // its own catch-and-skip, so a timeout here surfaces as a missing
  // checkpoint, not a failed step.
  timeoutMs?: number;
}

// Default timeout for any git subprocess we spawn. The hot path is
// snapshot() → up to 5 git invocations per write step; 30s gives a
// 6s/op average ceiling, which is well above the typical millisecond-
// scale runtime but bounded enough to recover from a wedged ref lock.
const RUN_GIT_DEFAULT_TIMEOUT_MS = 30_000;

const runGit = async (args: string[], opts: RunGitOptions): Promise<SpawnGitResult> => {
  // Pin the absolute git path + a canonical PATH so a mid-session
  // shim of `~/bin/git` cannot hijack a checkpoint commit (slice
  // 178 hardening C2). safeGitEnv provides the standard scrubs
  // checkpoints already wanted (LC_ALL=C, GIT_TERMINAL_PROMPT=0,
  // PATH=canonical, HOME=inherited). GIT_LITERAL_PATHSPECS is
  // intentionally NOT set — `git check-ignore` (used by
  // hasIgnoredCheckpointCollision below) rejects it with exit
  // 128, and the checkpoint write-path doesn't pass user-typed
  // pathspecs anyway (all paths are NUL-separated from `git
  // ls-tree` output, which check-ignore reads via --stdin -z).
  // Caller's `opts.env` overrides anything we set (commit
  // identity, GIT_INDEX_FILE).
  //
  // ORDER MATTERS: getGitBinary() may augment cachedSpawnPath via
  // the operator-PATH fallback (NixOS, asdf, etc.). safeGitEnv()
  // reads that cache, so it must run AFTER the first getGitBinary
  // call in the process. Constructing `env` before resolving the
  // binary captures the pre-fallback canonical PATH and leaves
  // checkpoint subprocesses blind to whatever bin dir actually
  // hosts git's siblings (credential helpers, ssh wrapper, hooks).
  const git = await getGitBinary();
  const env: Record<string, string> = {
    ...safeGitEnv(),
    ...(opts.env ?? {}),
  };
  const proc = Bun.spawn({
    cmd: [git, ...args],
    cwd: opts.cwd,
    env,
    stdin: opts.stdin !== undefined ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Sentinel: did the timeout fire? We can't distinguish a manual kill
  // from a natural exit through proc.exited alone (both resolve), so we
  // track it explicitly to surface a meaningful error.
  let timedOut = false;
  const timeoutMs = opts.timeoutMs ?? RUN_GIT_DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // proc may already be exited; kill() throws — ignore.
    }
  }, timeoutMs);
  // Stdin failure must NOT leak the subprocess. A broken pipe during
  // sink.write or end (e.g., git refused stdin and exited) leaves
  // proc.exited unresolved without this defensive kill — the await
  // below would then hang for the full timeoutMs. We swallow the kill
  // error (proc may already be gone) and let the exit path surface
  // whatever git actually said on stderr.
  if (opts.stdin !== undefined) {
    const sink = proc.stdin;
    if (sink === undefined) {
      clearTimeout(timer);
      throw new Error('git subprocess opened with stdin pipe returned no sink');
    }
    try {
      sink.write(opts.stdin);
      await sink.end();
    } catch (e) {
      try {
        proc.kill();
      } catch {
        // already dead
      }
      clearTimeout(timer);
      throw e;
    }
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (timedOut) {
    throw new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`);
  }
  if (exitCode !== 0 && !(opts.okExitCodes ?? []).includes(exitCode)) {
    throw new Error(`git ${args.join(' ')} exited ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  return { stdout, stderr, exitCode };
};

// True iff `cwd` is inside a git work-tree. `rev-parse --is-inside-work-tree`
// is the canonical probe; it exits 0 with `true` on stdout when in a tree,
// non-zero otherwise. We swallow the error and report false rather than
// surfacing a confusing `git rev-parse exited 128` to the caller.
export const isGitRepo = async (cwd: string): Promise<boolean> => {
  try {
    const { stdout } = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
};

// Absolute path of the worktree root for `cwd`, or null when `cwd`
// isn't inside a git work-tree. `--show-toplevel` is the canonical
// probe; it prints the worktree root (resolving the `.git` pointer of
// a linked worktree). The checkpoint manager anchors every git
// invocation here instead of the invocation cwd so snapshot (`add -A`)
// and restore (`read-tree --reset -u`) both operate on the whole
// worktree — a snapshot taken from a subdirectory must capture the
// same tree the worktree-wide restore will later reset (CHECKPOINTS
// §2.6). We swallow the error and report null rather than surfacing a
// raw `git rev-parse exited 128`.
export const getWorktreeRoot = async (cwd: string): Promise<string | null> => {
  try {
    const { stdout } = await runGit(['rev-parse', '--show-toplevel'], { cwd });
    const root = stdout.trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
};

// Returns the SHA of the current HEAD commit, or null when the repo is
// freshly initialized and HEAD points at an unborn branch. The unborn
// case is legitimate (user just `git init`-ed and edited a file) so we
// don't throw — snapshot() handles a null parent by writing a root
// commit.
export const getHeadSha = async (cwd: string): Promise<string | null> => {
  try {
    const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
};

// Resolves a ref to a SHA, returning null when the ref doesn't exist.
// Distinguishes "no ref" (null, expected on first checkpoint of a session)
// from "git command failed" (throws). Used by snapshot() to find the
// chain's head.
export const resolveRef = async (cwd: string, ref: string): Promise<string | null> => {
  // `git rev-parse --verify <ref>` exits 128 with "fatal: bad revision"
  // when the ref is missing; that's what we want to treat as "null".
  const git = await getGitBinary();
  const proc = Bun.spawn({
    cmd: [git, 'rev-parse', '--verify', '--quiet', ref],
    cwd,
    env: safeGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) return null;
  const sha = stdout.trim();
  return sha.length > 0 ? sha : null;
};

// Conventional ref name for a session's checkpoint chain head.
// `refs/forja/checkpoints/<session>` puts it in a namespace ignored by
// `git log` and friends — invisible to the user's normal git workflow,
// per CHECKPOINTS §2.4.
export const sessionRef = (sessionId: string): string => `refs/forja/checkpoints/${sessionId}`;

// Namespace for working-tree preservation commits created when
// restore() can't use git stash. Two cases route here:
//   1. Unborn HEAD — git stash refuses without an initial commit.
//   2. Ignored↔checkpoint path collision — `stash push -a` would
//      capture the ignored file, but `git stash pop` then refuses
//      to write it because read-tree already placed the checkpoint
//      version at that path. The custom recovery (`git read-tree
//      --reset -u <ref>`) overwrites unconditionally.
// Suffix is `<timestampMs>-<8-char-uuid>`: the timestamp drives
// the lazy retention sweep (drop refs older than cutoff), the UUID
// slice avoids collisions when two restores land in the same ms.
export const RESTORE_SAVED_REF_PREFIX = 'refs/forja/restore-saved/';

const restoreSavedRefName = (): string => {
  const uuid = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `${RESTORE_SAVED_REF_PREFIX}${Date.now()}-${uuid}`;
};

// Parse the timestamp prefix out of a restore-saved ref name. Returns
// null when the ref doesn't match the expected `<ms>-<uuid>` shape —
// callers treat null as "skip retention; can't decide" rather than
// guessing. Lives here so the ref-name format stays a single concern.
export const parseRestoreSavedTimestamp = (ref: string): number | null => {
  if (!ref.startsWith(RESTORE_SAVED_REF_PREFIX)) return null;
  const tail = ref.slice(RESTORE_SAVED_REF_PREFIX.length);
  const dash = tail.indexOf('-');
  const tsStr = dash === -1 ? tail : tail.slice(0, dash);
  const ts = Number.parseInt(tsStr, 10);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return ts;
};

export interface SnapshotInput {
  cwd: string;
  sessionId: string;
  // Step id this snapshot belongs to. Embedded in the commit message so
  // a human running `git log refs/forja/checkpoints/<session>` sees the
  // chain annotated with the originating step.
  stepId: string;
  // Absolute timestamp baked into the commit message for human grep.
  // Kept separate from the commit's own author/committer timestamp
  // (which we do NOT override — git fills both with the current time)
  // so the message reads naturally regardless of clock skew between
  // the harness and the repo.
  iso: string;
  // Optional explicit step number for a more readable message ("pre-step
  // 17 …"). Pure cosmetic.
  stepN?: number;
}

export interface SnapshotResult {
  // Commit SHA of the new snapshot, or null when the working tree was
  // clean (no diff vs the prior chain head). Callers MUST treat null
  // as "no checkpoint to record" — do not insert a row, do not move
  // the ref.
  sha: string | null;
}

const tempIndexPath = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'forja-ckpt-'));
  return join(dir, 'index');
};

const cleanupTempIndex = async (indexFile: string): Promise<void> => {
  try {
    // The index file lives in a directory we created (mkdtemp'd under
    // os.tmpdir); remove the whole directory so we don't leave a
    // `forja-ckpt-XXXX` shell behind. dirname() over `join(..., '..')`
    // because the latter doesn't normalize trailing-slash quirks on
    // every platform.
    await rm(dirname(indexFile), { recursive: true, force: true });
  } catch {
    // Best-effort cleanup — leaking a /tmp directory is preferable to
    // masking the real result of a snapshot.
  }
};

// Build a commit object that captures the working tree (tracked + untracked,
// ignoring `.gitignore`'d paths via the default git semantics) and chain
// it onto the prior checkpoint of this session.
//
// Returns sha=null when the working tree's content is identical to the
// parent commit's tree (the harness skip-on-noop check). The caller
// uses null to avoid inserting a redundant row.
export const snapshot = async (input: SnapshotInput): Promise<SnapshotResult> => {
  const { cwd, sessionId, stepId, iso, stepN } = input;
  const headSha = await getHeadSha(cwd);
  const priorRef = await resolveRef(cwd, sessionRef(sessionId));
  // Parent for the new commit:
  // - prior session checkpoint exists → chain on it (so the whole
  //   history stays reachable via the ref)
  // - else if HEAD exists → parent off HEAD (anchors the snapshot to
  //   the user's current branch tip; nice for `git log` readability
  //   in tooling that does walk the history)
  // - else (unborn HEAD) → root commit, no parent.
  const parent = priorRef ?? headSha;

  const indexFile = await tempIndexPath();
  try {
    const env = { GIT_INDEX_FILE: indexFile };
    // Seed temp index with whatever HEAD has so `git add -A` produces
    // an accurate diff against working tree. In an unborn repo we just
    // start from an empty index (read-tree of an empty tree).
    if (headSha !== null) {
      await runGit(['read-tree', headSha], { cwd, env });
    }
    // Capture the set of paths already tracked at HEAD *before* `add -A`
    // mutates the temp index. The sensitive-path filter below uses it to
    // narrow itself to UNTRACKED secrets only (see rationale there). We
    // read it with the same `ls-files` against the same temp index that
    // the post-`add` listing uses, so both sets share one path
    // convention and `.has(p)` matches per-path. (The manager anchors
    // `cwd` at the worktree root, so both listings are toplevel-relative
    // anyway; the same-listing invariant holds even in the defensive
    // subdir fallback.) On an unborn HEAD there is nothing tracked, so
    // every secret is untracked and the filter degrades to its prior
    // all-removing behavior.
    let trackedAtHead: Set<string> | null = null;
    if (headSha !== null) {
      const headFiles = await runGit(['ls-files', '-z'], { cwd, env });
      trackedAtHead = new Set(headFiles.stdout.split('\0').filter((s) => s.length > 0));
    }
    // `add -A` records the full working-tree state into the temp index:
    // tracked modifications, untracked files, deletions. The user's
    // real index stays untouched because GIT_INDEX_FILE points
    // elsewhere.
    await runGit(['add', '-A', '.'], { cwd, env });
    // Slice 172 (review — information-leak P1). `git add -A .`
    // captures EVERY file in the working tree including untracked
    // `.env`, `.aws/credentials`, `*.pem`, `id_rsa*` that the
    // operator has in cwd. Without filtering, these flow into loose
    // git objects under `.git/objects/` reachable via
    // `refs/forja/checkpoints/<session>/`. The objects stay even if
    // the ref is later deleted (until `git gc` fires; `git log
    // --all` and `git fsck` find them; repo backups capture them).
    //
    // SEC §8.4 sensitive-paths patterns identify the canonical
    // secret-shaped files. Walk the temp index, drop any matched
    // entries via `update-index --force-remove --` before the
    // write-tree.
    //
    // BUT only for paths that are NOT already tracked at HEAD. SEC §8.4
    // is explicit that the checkpoint "precisa preservar conteúdo
    // literal pra /undo funcionar". Stripping a *tracked* secret breaks
    // restore: `read-tree --reset -u` would delete it from the working
    // tree (it's in HEAD but absent from the checkpoint tree), and an
    // unmodified tracked file isn't dirty so it was never stashed →
    // silent local loss. So tracked secrets must stay in the tree.
    //
    // Leak-lifetime caveat (honest accounting): the *unmodified* tracked
    // blob is already reachable from HEAD, so keeping it costs nothing.
    // But if the step MODIFIED a tracked secret, the new blob is genuinely
    // novel and the checkpoint ref now pins it (it survives a HEAD-history
    // scrub — filter-repo/BFG + gc — until the ref expires or is purged).
    // We accept this: it is the same property every modified file in the
    // checkpoint has, and the file is one the user chose to version. The
    // mitigation is retention (CHECKPOINTS §2.5) plus
    // `--checkpoints purge <session>`, which operators scrubbing a
    // committed secret must run alongside the history rewrite. Stripping
    // the modified case instead is NOT a fix — it reintroduces the
    // restore data-loss above and also loses the user's edit on /undo.
    //
    // The leak this filter actually guards against is the operator's
    // UNTRACKED secrets sitting in cwd (`.aws/credentials`, `id_rsa`) —
    // exactly the paths not in `trackedAtHead`. Scoping here closes the
    // restore data-loss edge without weakening that guard.
    const lsRes = await runGit(['ls-files', '-z'], { cwd, env });
    const indexed = lsRes.stdout.split('\0').filter((s) => s.length > 0);
    const sensitiveEntries = indexed.filter(
      (p) => matchSensitivePath(p) !== null && !(trackedAtHead?.has(p) ?? false),
    );
    if (sensitiveEntries.length > 0) {
      // `update-index --force-remove --` takes paths as positionals.
      // Batch in chunks of 512 to stay under argv limits on
      // pathological repos.
      const chunkSize = 512;
      for (let i = 0; i < sensitiveEntries.length; i += chunkSize) {
        const chunk = sensitiveEntries.slice(i, i + chunkSize);
        await runGit(['update-index', '--force-remove', '--', ...chunk], { cwd, env });
      }
    }
    const treeRes = await runGit(['write-tree'], { cwd, env });
    const tree = treeRes.stdout.trim();
    if (tree.length === 0) {
      throw new Error('git write-tree produced empty output');
    }
    // Skip when the new tree matches the parent's tree — there were no
    // writes worth recording. Cheaper than a full commit-tree.
    if (parent !== null) {
      const parentTreeRes = await runGit(['rev-parse', `${parent}^{tree}`], { cwd });
      if (parentTreeRes.stdout.trim() === tree) {
        return { sha: null };
      }
    }
    const stepLabel = stepN !== undefined ? `step ${stepN}` : `step ${stepId}`;
    const message = `forja: pre-${stepLabel} ${iso}`;
    const commitArgs = ['commit-tree', tree];
    if (parent !== null) {
      commitArgs.push('-p', parent);
    }
    const commitEnv: Record<string, string> = {
      // Identity for the snapshot commits. We override deliberately so
      // the user's `git log` filters (e.g., `--author`) can isolate
      // checkpoint commits, and so a missing `user.name`/`user.email`
      // config doesn't fail the run.
      GIT_AUTHOR_NAME: 'forja',
      GIT_AUTHOR_EMAIL: 'forja@local',
      GIT_COMMITTER_NAME: 'forja',
      GIT_COMMITTER_EMAIL: 'forja@local',
    };
    const commitRes = await runGit(commitArgs, {
      cwd,
      env: commitEnv,
      stdin: message,
    });
    const sha = commitRes.stdout.trim();
    if (sha.length === 0) {
      throw new Error('git commit-tree produced empty output');
    }
    // Update the session's chain head ref so the new commit (and via
    // its parent links, the whole prior chain) stays reachable from
    // the ref namespace and survives git GC.
    await runGit(['update-ref', sessionRef(sessionId), sha], { cwd });
    return { sha };
  } finally {
    await cleanupTempIndex(indexFile);
  }
};

// True iff `git status --porcelain` reports any line. The porcelain
// format is the documented stable interface for "has uncommitted
// content" (--include-untracked is implicit in the default format).
// Empty output means clean.
export const isWorkingTreeDirty = async (cwd: string): Promise<boolean> => {
  const { stdout } = await runGit(['status', '--porcelain'], { cwd });
  return stdout.length > 0;
};

export interface RestoreResult {
  // True when we saved the user's pending working tree before
  // resetting. False when the working tree was already clean.
  stashed: boolean;
  // Recovery handle — present iff stashed=true. Two shapes:
  //   - `stash@{0}` when the regular `git stash push` path ran
  //     (born HEAD). Recover with `git stash pop`.
  //   - `refs/forja/restore-saved/<ts>` when HEAD was unborn and
  //     git stash isn't available; we built our own preservation
  //     commit. Recover with `git read-tree --reset -u <ref>` or
  //     `git checkout <ref> -- .`.
  stashRef?: string;
  // Distinguishes the two shapes above so the CLI can render the
  // right recovery hint instead of telling an unborn-HEAD user to
  // `git stash pop` (which would also fail). Undefined when not
  // stashed.
  stashKind?: 'git-stash' | 'agent-ref';
}

// True when the checkpoint commit contains at least one path that
// currently exists locally as an ignored file. That collision is the
// data-loss case `stash push -u` doesn't cover — `-u` excludes
// ignored files, so without escalation the read-tree below overwrites
// the user's local copy with no recovery handle. We escalate to
// `--all` only when collisions actually exist; the common case (no
// ignored↔ckpt path overlap) keeps the cheap `-u` path.
//
// Implementation: list the ckpt's tree once, hand the paths to
// `git check-ignore --stdin` (NUL-separated for path-with-spaces
// safety), narrow to those that physically exist on disk. The
// check-ignore probe is bounded by tree size (one fork, lines
// streamed); list-tree is sub-second on the project sizes the SLO
// targets.
const hasIgnoredCheckpointCollision = async (cwd: string, commitSha: string): Promise<boolean> => {
  let lsOut: string;
  try {
    const res = await runGit(['ls-tree', '-r', '-z', '--name-only', commitSha], { cwd });
    lsOut = res.stdout;
  } catch {
    // If listing the tree fails, we can't tell. Conservative call:
    // assume no collision and let the caller's regular path run.
    // The caller has its own commit-existence probe that will surface
    // the underlying error if the sha is genuinely bad.
    return false;
  }
  const paths = lsOut.split('\0').filter((p) => p.length > 0);
  if (paths.length === 0) return false;
  // `git check-ignore --stdin -z` reads NUL-separated paths and emits
  // matched ones on stdout. Exit code 0 = at least one matched, 1 =
  // none matched, 128 = error (no .gitignore at all is fine, returns 1).
  const git = await getGitBinary();
  const proc = Bun.spawn({
    cmd: [git, 'check-ignore', '--stdin', '-z'],
    cwd,
    env: safeGitEnv(),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const sink = proc.stdin;
  if (sink === undefined) return false;
  sink.write(paths.join('\0'));
  await sink.end();
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0 && exitCode !== 1) return false;
  if (exitCode === 1) return false;
  // At least one path is ignored. Check if any of them physically
  // exists on disk — only existing files cause data loss; ignored
  // patterns matching nothing are harmless.
  const ignored = stdout.split('\0').filter((p) => p.length > 0);
  for (const p of ignored) {
    try {
      await access(join(cwd, p));
      return true;
    } catch {
      // path doesn't exist on disk; not a collision
    }
  }
  return false;
};

// In-progress git operation markers. Restore is destructive against
// the index + working tree; running it on top of a paused merge /
// rebase / cherry-pick / revert / bisect would clobber the user's
// resolution state and leave them with no way back. Detect the
// canonical marker (file or dir) under .git, refuse with a hint
// pointing at the specific abort/reset command.
//
// `dirOnly: true` flags entries that are directories rather than
// files (interactive rebase uses .git/rebase-merge/ as a directory;
// non-interactive rebase / git-am uses .git/rebase-apply/). Plain
// fs.access works for both files and dirs but the distinction is
// useful documentation.
interface InProgressMarker {
  readonly path: string;
  readonly op: string;
  readonly abortHint: string;
  // `git <op> --continue` exists for merge/rebase/cherry-pick/revert
  // but NOT for bisect (which uses good/bad/reset). When undefined,
  // the error message omits the "or --continue" alternative.
  readonly continueHint?: string;
  readonly dirOnly?: boolean;
}

const IN_PROGRESS_MARKERS: readonly InProgressMarker[] = [
  {
    path: 'MERGE_HEAD',
    op: 'merge',
    abortHint: 'git merge --abort',
    continueHint: 'git merge --continue',
  },
  {
    path: 'CHERRY_PICK_HEAD',
    op: 'cherry-pick',
    abortHint: 'git cherry-pick --abort',
    continueHint: 'git cherry-pick --continue',
  },
  {
    path: 'REVERT_HEAD',
    op: 'revert',
    abortHint: 'git revert --abort',
    continueHint: 'git revert --continue',
  },
  // `rebase-merge` is the dir for interactive / am-style rebase;
  // `rebase-apply` covers non-interactive rebase + `git am`. Either
  // present means the user is mid-rebase.
  {
    path: 'rebase-merge',
    op: 'rebase',
    abortHint: 'git rebase --abort',
    continueHint: 'git rebase --continue',
    dirOnly: true,
  },
  {
    path: 'rebase-apply',
    op: 'rebase',
    abortHint: 'git rebase --abort',
    continueHint: 'git rebase --continue',
    dirOnly: true,
  },
  // bisect uses a different recovery primitive — neither --abort
  // nor --continue apply; the user runs `git bisect reset` or one
  // of `good`/`bad`/`skip`. continueHint is omitted so the error
  // message doesn't suggest a non-existent subcommand.
  { path: 'BISECT_LOG', op: 'bisect', abortHint: 'git bisect reset' },
];

// Returns the operation name + recovery hints when an in-progress
// git op is detected; null when the working tree is in a normal
// state. Resolves .git lazily — on a worktree-pointer setup, `.git`
// is a file pointing at the real dir, so we use `rev-parse --git-dir`
// which handles both shapes.
export interface InProgressOperation {
  op: string;
  abortHint: string;
  continueHint?: string;
}

export const getInProgressOperation = async (cwd: string): Promise<InProgressOperation | null> => {
  let gitDir: string;
  try {
    const { stdout } = await runGit(['rev-parse', '--git-dir'], { cwd });
    gitDir = stdout.trim();
  } catch {
    // Not a git repo at all — by convention we say "no op in
    // progress" since there's no operation to be in. Restore's own
    // git checks will surface the missing repo error if needed.
    return null;
  }
  if (gitDir.length === 0) return null;
  const dir = isAbsolute(gitDir) ? gitDir : join(cwd, gitDir);
  for (const marker of IN_PROGRESS_MARKERS) {
    try {
      await access(join(dir, marker.path));
      const out: InProgressOperation = { op: marker.op, abortHint: marker.abortHint };
      if (marker.continueHint !== undefined) out.continueHint = marker.continueHint;
      return out;
    } catch {
      // marker not present; try next
    }
  }
  return null;
};

// Restore the working tree + index to match a checkpoint commit's tree.
// HEAD is left untouched: the user's branch pointer doesn't move, and
// any commits they made stay intact. Only file contents revert.
//
// Pre-step: if the working tree has uncommitted changes, `git stash
// push -u` saves them first. The stash is reported in the result so
// the caller can echo a recovery hint.
export const restore = async (cwd: string, commitSha: string): Promise<RestoreResult> => {
  // Refuse outright when the user is mid-merge / rebase / cherry-pick /
  // revert / bisect. read-tree --reset -u below would clobber the
  // resolution state (.git/MERGE_HEAD, rebase-merge/, etc.) and leave
  // the user with no way to abort or continue cleanly. The check has
  // to fire BEFORE every other side effect — the probe below, the
  // stash, the read-tree — so a refused restore leaves zero traces.
  const inProgress = await getInProgressOperation(cwd);
  if (inProgress !== null) {
    // continueHint is undefined for ops that have no `--continue`
    // form (notably bisect — recovery is reset/good/bad). Build the
    // hint text dynamically so we never suggest a non-existent
    // subcommand.
    const hints =
      inProgress.continueHint !== undefined
        ? `\`${inProgress.abortHint}\` or \`${inProgress.continueHint}\``
        : `\`${inProgress.abortHint}\``;
    throw new Error(
      `cannot restore: a git ${inProgress.op} is in progress. Resolve it (${hints}) before retrying.`,
    );
  }
  // Validate the commit object exists BEFORE stashing. A GC'd or
  // corrupt commit would otherwise leave a stash orphan tied to a
  // failed restore: we'd push the user's working tree to stash,
  // then fail on read-tree, and the caller would have already told
  // the operator the restore succeeded. `^{commit}` forces the
  // peel — a tree or blob with the same sha would still fail here.
  // The probe goes through runGit so timeout + okExitCodes apply.
  await runGit(['rev-parse', '--verify', `${commitSha}^{commit}`], { cwd });
  const headBefore = await getHeadSha(cwd);
  const dirty = await isWorkingTreeDirty(cwd);
  // Collision detection MUST run before deciding to preserve, NOT
  // after the dirty gate. `isWorkingTreeDirty` uses `git status
  // --porcelain` which excludes ignored files by default — a tree
  // that's clean by that signal can still contain an ignored file
  // colliding with a checkpoint path. Skipping preservation in that
  // case lets read-tree --reset -u below silently overwrite the
  // user's ignored copy. The probe is cheap (one ls-tree + one
  // check-ignore) and answers whether a collision exists; we then
  // OR with `dirty` to decide whether to preserve at all.
  const collision = await hasIgnoredCheckpointCollision(cwd, commitSha);
  let stashed = false;
  let stashRef: string | undefined;
  let stashKind: 'git-stash' | 'agent-ref' | undefined;
  if (dirty || collision) {
    // Decide between two preservation paths:
    //   - regular `git stash push -u` (cheap, recovery via stash pop)
    //   - custom commit-tree under refs/forja/restore-saved/
    //     (recovery via `git read-tree --reset -u <ref>`)
    //
    // The custom path is required when:
    //   1. HEAD is unborn — git stash refuses ("no initial commit").
    //   2. A path in the checkpoint exists locally as an ignored
    //      file. `stash push -u` skips ignored entries; `stash push
    //      -a` would capture them but `git stash pop` then refuses
    //      to write the file (read-tree --reset -u below already
    //      placed the checkpoint's version at that path, and pop
    //      treats the ignored entry as untracked → "file already
    //      exists"). The custom ref-based recovery uses read-tree
    //      which overwrites unconditionally.
    const useCustomRef = headBefore === null || collision;
    if (!useCustomRef) {
      // Regular path: HEAD born, no ignored↔ckpt collision. `-u`
      // captures tracked + untracked-non-ignored. -m tags the
      // entry so the user can identify it in `git stash list`.
      const res = await runGit(['stash', 'push', '-u', '-m', 'forja: pre-restore working tree'], {
        cwd,
      });
      // `git stash push` prints "No local changes to save" if
      // nothing was stashed (race: dirty between status and push).
      // Detect via stdout so we don't lie about stashRef.
      if (!res.stdout.includes('No local changes to save')) {
        stashed = true;
        stashRef = 'stash@{0}';
        stashKind = 'git-stash';
      }
    } else {
      // Custom path: build a preservation commit capturing the
      // ENTIRE working tree (tracked + untracked + ignored) via
      // a temp index. Anchored under refs/forja/restore-saved/<ts>
      // so it survives git gc; recovery via `git read-tree --reset
      // -u <ref>` overrides whatever the checkpoint wrote.
      //
      // Used both for unborn HEAD (where stash refuses) AND for
      // ignored↔checkpoint collisions (where stash captures but
      // pop can't apply). `-f` forces add to include ignored
      // files — load-bearing in the collision case, but
      // potentially expensive in the unborn case (would drag
      // node_modules / build artifacts into the preservation
      // commit). Only enable -f when a real collision exists; the
      // unborn-only path uses plain `-A`, matching the snapshot
      // behavior (read-tree won't touch ignored files that aren't
      // in the checkpoint tree, so they don't need preserving).
      const indexFile = await tempIndexPath();
      try {
        const env = { GIT_INDEX_FILE: indexFile };
        const addArgs = collision ? ['add', '-A', '-f', '.'] : ['add', '-A', '.'];
        await runGit(addArgs, { cwd, env });
        const treeRes = await runGit(['write-tree'], { cwd, env });
        const tree = treeRes.stdout.trim();
        if (tree.length === 0) {
          throw new Error('git write-tree produced empty output (restore preserve)');
        }
        const commitEnv: Record<string, string> = {
          GIT_AUTHOR_NAME: 'forja',
          GIT_AUTHOR_EMAIL: 'forja@local',
          GIT_COMMITTER_NAME: 'forja',
          GIT_COMMITTER_EMAIL: 'forja@local',
        };
        const commitRes = await runGit(['commit-tree', tree], {
          cwd,
          env: commitEnv,
          stdin: 'forja: pre-restore working tree',
        });
        const sha = commitRes.stdout.trim();
        if (sha.length === 0) {
          throw new Error('git commit-tree produced empty output (restore preserve)');
        }
        // Timestamp + UUID slice keeps multiple unborn-HEAD restores
        // distinguishable. Plain `Date.now()` would collide silently
        // when two restores land in the same ms (rare in practice but
        // possible in scripted/test scenarios) — `update-ref` then
        // overwrites the prior ref, leaving the first preservation
        // commit unreachable. The UUID slice closes that window.
        const ref = restoreSavedRefName();
        await runGit(['update-ref', ref, sha], { cwd });
        stashed = true;
        stashRef = ref;
        stashKind = 'agent-ref';
      } finally {
        await cleanupTempIndex(indexFile);
      }
    }
  }
  // `read-tree --reset -u <commit>`: rewrite both index and working tree
  // to match the commit's tree, leave HEAD at the user's branch tip
  // (or unset, on unborn HEAD). This is the same primitive
  // `git checkout <sha> -- .` uses internally but without the side
  // effects of touching HEAD or the reflog.
  await runGit(['read-tree', '--reset', '-u', commitSha], { cwd });
  // Re-sync the index with HEAD (when HEAD is born). After the read-tree
  // above, the index matches the checkpoint's tree, NOT HEAD — so the
  // user's `git status` would show every file that differs between HEAD
  // and the checkpoint as "staged for commit". For users who hadn't
  // committed during the forja run, HEAD already matches the checkpoint
  // and this is a no-op; for users who had, this collapses the surprise
  // "you have N staged files" message into the natural "you have N
  // unstaged changes vs HEAD" view. Skipped on unborn HEAD where
  // there's nothing to re-sync against.
  //
  // `read-tree HEAD` (no -u, no --reset) updates only the index.
  const headAfter = await getHeadSha(cwd);
  if (headAfter !== null) {
    await runGit(['read-tree', headAfter], { cwd });
  }
  if (stashed && stashRef !== undefined && stashKind !== undefined) {
    return { stashed, stashRef, stashKind };
  }
  return { stashed: false };
};

// Diff between the working tree and a checkpoint. Used by
// `--checkpoints diff` for human inspection BEFORE committing to a
// restore.
//
// We don't use `git diff <sha>` directly because that walks tracked
// files only — untracked files added since the checkpoint don't show
// up. Instead we materialize a tree of the CURRENT working state
// (same temp-index trick as snapshot) and diff tree-to-tree, which
// covers tracked + untracked uniformly.
export const diff = async (cwd: string, commitSha: string): Promise<string> => {
  const headSha = await getHeadSha(cwd);
  const indexFile = await tempIndexPath();
  try {
    const env = { GIT_INDEX_FILE: indexFile };
    if (headSha !== null) {
      await runGit(['read-tree', headSha], { cwd, env });
    }
    await runGit(['add', '-A', '.'], { cwd, env });
    const treeRes = await runGit(['write-tree'], { cwd, env });
    const wtTree = treeRes.stdout.trim();
    // `diff <ckpt-tree> <wt-tree>` reads "what changes if we go from
    // checkpoint to current working state" — a positive diff line is
    // present in current but missing in checkpoint. The user reading
    // `--checkpoints diff` typically wants to know what `--undo` would
    // revert; that's exactly this direction.
    const { stdout } = await runGit(['diff', `${commitSha}^{tree}`, wtTree], { cwd });
    return stdout;
  } finally {
    await cleanupTempIndex(indexFile);
  }
};

// Delete a session's checkpoint ref. The underlying commits become
// unreferenced and git GC will reclaim them on the next maintenance
// pass. We do NOT force GC here — that would be expensive and could
// surprise the user; lazy cleanup is fine for KB-scale objects.
export const deleteSessionRef = async (cwd: string, sessionId: string): Promise<void> => {
  // `update-ref -d` is idempotent: deleting a missing ref exits 0
  // silently in modern git. okExitCodes covers the rare case where
  // an older git refuses with a non-zero exit on an absent ref.
  await runGit(['update-ref', '-d', sessionRef(sessionId)], { cwd, okExitCodes: [1] });
};

// Re-point a session's checkpoint ref at a different commit. Used by
// the lazy-purge sweep when older rows in a session's chain age out
// but newer ones survive — the chain's head ref needs to follow the
// surviving newest commit so future snapshots don't try to parent off
// a deleted ancestor. Runs through the same `runGit` wrapper as the
// rest of the surface (consistency, env scrubbing, timeout).
export const setSessionRef = async (cwd: string, sessionId: string, sha: string): Promise<void> => {
  await runGit(['update-ref', sessionRef(sessionId), sha], { cwd });
};

// Read a commit's tree sha. Used by the retention rewrite path —
// when severing aged ancestry from a surviving chain, the survivor's
// tree stays the same, only the parent pointer changes.
export const getCommitTree = async (cwd: string, commitSha: string): Promise<string> => {
  const { stdout } = await runGit(['rev-parse', `${commitSha}^{tree}`], { cwd });
  return stdout.trim();
};

// Read a commit's full message body. Same path: rewrites preserve
// the original message verbatim so `git log refs/forja/checkpoints`
// stays human-grep-able with the original "forja: pre-step N <iso>"
// shape, and audit tooling indexed by message stays stable.
export const getCommitMessage = async (cwd: string, commitSha: string): Promise<string> => {
  const { stdout } = await runGit(['log', '-1', '--format=%B', commitSha], { cwd });
  return stdout.trimEnd();
};

// Build a commit object from an existing tree with an explicit
// (possibly null) parent. Distinct from `snapshot()` because the
// tree is given (not derived from the working tree) and there's no
// temp-index dance. Used by retention to re-parent surviving
// checkpoints onto current HEAD, severing reachability of aged
// commits so git gc can reclaim them — without this, the chain's
// parent links keep aged commits alive forever even after their DB
// rows are deleted (CHECKPOINTS.md §2.5).
export const rewriteCheckpointCommit = async (
  cwd: string,
  treeSha: string,
  parentSha: string | null,
  message: string,
): Promise<string> => {
  const args = ['commit-tree', treeSha];
  if (parentSha !== null) {
    args.push('-p', parentSha);
  }
  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: 'forja',
    GIT_AUTHOR_EMAIL: 'forja@local',
    GIT_COMMITTER_NAME: 'forja',
    GIT_COMMITTER_EMAIL: 'forja@local',
  };
  const { stdout } = await runGit(args, { cwd, env, stdin: message });
  const sha = stdout.trim();
  if (sha.length === 0) {
    throw new Error('git commit-tree produced empty output (retention rewrite)');
  }
  return sha;
};

// Enumerate every restore-saved preservation ref, with its parsed
// timestamp and full ref name. Drives the lazy retention sweep —
// these refs aren't tied to a session and there's no DB row to
// gate against, so the timestamp baked into the ref name is the
// only retention signal. Refs whose timestamp doesn't parse
// (older format pre-L2 fix, or hand-created) come back with
// `timestampMs: null` and are skipped by the sweep.
export const listRestoreSavedRefs = async (
  cwd: string,
): Promise<{ ref: string; sha: string; timestampMs: number | null }[]> => {
  const { stdout } = await runGit(
    ['for-each-ref', '--format=%(refname) %(objectname)', RESTORE_SAVED_REF_PREFIX.slice(0, -1)],
    { cwd },
  );
  const lines = stdout.split('\n').filter((l) => l.length > 0);
  const out: { ref: string; sha: string; timestampMs: number | null }[] = [];
  for (const line of lines) {
    const [ref, sha] = line.split(' ');
    if (ref === undefined || sha === undefined) continue;
    if (!ref.startsWith(RESTORE_SAVED_REF_PREFIX)) continue;
    out.push({ ref, sha, timestampMs: parseRestoreSavedTimestamp(ref) });
  }
  return out;
};

// Delete a single restore-saved ref by its full name. Idempotent
// (deleting a missing ref is a no-op in modern git; the okExitCodes
// fallback covers older versions). Used by both the lazy sweep and
// any future explicit recovery flow.
export const deleteRestoreSavedRef = async (cwd: string, ref: string): Promise<void> => {
  await runGit(['update-ref', '-d', ref], { cwd, okExitCodes: [1] });
};

// Enumerate every session id that currently has a checkpoint ref.
// `for-each-ref` is the right primitive — it iterates the ref store
// without parsing reflogs or loose-vs-packed details.
export const listSessionRefs = async (
  cwd: string,
): Promise<{ sessionId: string; sha: string }[]> => {
  const { stdout } = await runGit(
    ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/forja/checkpoints'],
    { cwd },
  );
  const lines = stdout.split('\n').filter((l) => l.length > 0);
  const out: { sessionId: string; sha: string }[] = [];
  for (const line of lines) {
    const [ref, sha] = line.split(' ');
    if (ref === undefined || sha === undefined) continue;
    const prefix = 'refs/forja/checkpoints/';
    if (!ref.startsWith(prefix)) continue;
    const sessionId = ref.slice(prefix.length);
    if (sessionId.length === 0) continue;
    out.push({ sessionId, sha });
  }
  return out;
};
