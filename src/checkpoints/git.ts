import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
  const env: Record<string, string> = {
    // Strip locale-dependent output so parsing stays stable across
    // environments. `LC_ALL=C` is the standard scrub.
    LC_ALL: 'C',
    // Avoid prompting for credentials / GPG passphrases under any
    // circumstance — checkpoint creation must never block on stdin.
    GIT_TERMINAL_PROMPT: '0',
    // Inherit minimal environment by default; caller's env overrides
    // anything we specified (commit identity, GIT_INDEX_FILE).
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    ...(opts.env ?? {}),
  };
  const proc = Bun.spawn({
    cmd: ['git', ...args],
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
  const proc = Bun.spawn({
    cmd: ['git', 'rev-parse', '--verify', '--quiet', ref],
    cwd,
    env: { LC_ALL: 'C', PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) return null;
  const sha = stdout.trim();
  return sha.length > 0 ? sha : null;
};

// Conventional ref name for a session's checkpoint chain head.
// `refs/agent/checkpoints/<session>` puts it in a namespace ignored by
// `git log` and friends — invisible to the user's normal git workflow,
// per CHECKPOINTS §2.4.
export const sessionRef = (sessionId: string): string => `refs/agent/checkpoints/${sessionId}`;

export interface SnapshotInput {
  cwd: string;
  sessionId: string;
  // Step id this snapshot belongs to. Embedded in the commit message so
  // a human running `git log refs/agent/checkpoints/<session>` sees the
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
    // `add -A` records the full working-tree state into the temp index:
    // tracked modifications, untracked files, deletions. The user's
    // real index stays untouched because GIT_INDEX_FILE points
    // elsewhere.
    await runGit(['add', '-A', '.'], { cwd, env });
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
  // True when we issued a `git stash push` to save the user's pending
  // changes before resetting. False when the working tree was already
  // clean.
  stashed: boolean;
  // `stash@{0}` when stashed=true. The user can `git stash pop` to
  // recover their changes. Absent on a clean reset.
  stashRef?: string;
}

// Restore the working tree + index to match a checkpoint commit's tree.
// HEAD is left untouched: the user's branch pointer doesn't move, and
// any commits they made stay intact. Only file contents revert.
//
// Pre-step: if the working tree has uncommitted changes, `git stash
// push -u` saves them first. The stash is reported in the result so
// the caller can echo a recovery hint.
export const restore = async (cwd: string, commitSha: string): Promise<RestoreResult> => {
  // Validate the commit object exists BEFORE stashing. A GC'd or
  // corrupt commit would otherwise leave a stash orphan tied to a
  // failed restore: we'd push the user's working tree to stash,
  // then fail on read-tree, and the caller would have already told
  // the operator the restore succeeded. `^{commit}` forces the
  // peel — a tree or blob with the same sha would still fail here.
  // The probe goes through runGit so timeout + okExitCodes apply.
  await runGit(['rev-parse', '--verify', `${commitSha}^{commit}`], { cwd });
  const dirty = await isWorkingTreeDirty(cwd);
  let stashed = false;
  let stashRef: string | undefined;
  if (dirty) {
    // -u keeps untracked files in the stash; -m tags the entry so the
    // user can identify it in `git stash list`.
    const res = await runGit(['stash', 'push', '-u', '-m', 'forja: pre-restore working tree'], {
      cwd,
    });
    // `git stash push` prints "No local changes to save" if nothing was
    // stashed (race: dirty between status and push). Detect via stdout
    // so we don't lie about stashRef.
    if (!res.stdout.includes('No local changes to save')) {
      stashed = true;
      stashRef = 'stash@{0}';
    }
  }
  // `read-tree --reset -u <commit>`: rewrite both index and working tree
  // to match the commit's tree, leave HEAD at the user's branch tip.
  // This is the same primitive `git checkout <sha> -- .` uses internally
  // but without the side effects of touching HEAD or the reflog.
  await runGit(['read-tree', '--reset', '-u', commitSha], { cwd });
  // Re-sync the index with HEAD (when HEAD is born). After the read-tree
  // above, the index matches the checkpoint's tree, NOT HEAD — so the
  // user's `git status` would show every file that differs between HEAD
  // and the checkpoint as "staged for commit". For users who hadn't
  // committed during the agent run, HEAD already matches the checkpoint
  // and this is a no-op; for users who had, this collapses the surprise
  // "you have N staged files" message into the natural "you have N
  // unstaged changes vs HEAD" view.
  //
  // `read-tree HEAD` (no -u, no --reset) updates only the index.
  const headAfter = await getHeadSha(cwd);
  if (headAfter !== null) {
    await runGit(['read-tree', headAfter], { cwd });
  }
  if (stashed && stashRef !== undefined) return { stashed, stashRef };
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

// Enumerate every session id that currently has a checkpoint ref.
// `for-each-ref` is the right primitive — it iterates the ref store
// without parsing reflogs or loose-vs-packed details.
export const listSessionRefs = async (
  cwd: string,
): Promise<{ sessionId: string; sha: string }[]> => {
  const { stdout } = await runGit(
    ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/agent/checkpoints'],
    { cwd },
  );
  const lines = stdout.split('\n').filter((l) => l.length > 0);
  const out: { sessionId: string; sha: string }[] = [];
  for (const line of lines) {
    const [ref, sha] = line.split(' ');
    if (ref === undefined || sha === undefined) continue;
    const prefix = 'refs/agent/checkpoints/';
    if (!ref.startsWith(prefix)) continue;
    const sessionId = ref.slice(prefix.length);
    if (sessionId.length === 0) continue;
    out.push({ sessionId, sha });
  }
  return out;
};
