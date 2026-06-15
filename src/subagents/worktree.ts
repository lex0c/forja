import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getGitBinary, safeGitEnv } from './git-binary.ts';
import { type ValidationResult, validateWorktreeContents } from './worktree-validation.ts';

// Subagent worktree lifecycle (spec §11.2). When a definition
// declares `isolation: worktree`, the harness creates a dedicated
// `git worktree` for the child run before invoking the harness
// loop. The child's `cwd` points at the worktree root; every write
// tool the child invokes lands on the worktree's branch, never on
// the parent's working tree. After the run finishes, the cleanup
// pass either removes the worktree+branch (clean tree → nothing
// happened) or preserves it for the parent to inspect (dirty tree
// → the child wrote something).
//
// We deliberately keep this module thin and self-contained:
//   - No reuse of the checkpoints/git.ts helpers because their
//     `runGit` is file-private and tuned for index-isolated
//     snapshots; pulling those into a shared surface would force
//     a refactor that is not load-bearing today.
//   - No persistence here; the repo / migration owns that.
//   - SECURITY §8.4 hardening (symlink boundary + deny-list copy
//     filter) lives in `worktree-validation.ts` and runs as a
//     post-checkout step inside `createWorktree`.

// Default cache root resolves through the standard precedence:
//   1. $XDG_CACHE_HOME (per XDG Base Dir spec)
//   2. ~/.cache (Linux/macOS fallback)
//
// Tests override via `WorktreeOptions.rootDir`; production callers
// rely on the default. We deliberately avoid `/tmp` to keep
// worktrees out of tmpfs (would defeat persistence across reboots
// while a subagent is paused) and out of the system-wide tmp
// directory whose group permissions vary across systems.
export const defaultWorktreeRoot = (env: NodeJS.ProcessEnv = process.env): string => {
  const xdg = env.XDG_CACHE_HOME;
  const home = env.HOME ?? homedir();
  const cache = xdg !== undefined && xdg.length > 0 ? xdg : join(home, '.cache');
  return join(cache, 'forja', 'worktrees');
};

// Slug a free-form user prompt into a kebab-cased fragment safe
// for a git ref name. Collapses runs of non-alphanumerics, trims
// leading/trailing dashes, and caps at MAX_SLUG_CHARS so the final
// branch name stays readable. Two fallback paths to 'task':
//   - input that sanitizes to empty (`''`, `'!!!'`, all-whitespace)
//   - input whose post-truncation tail is all dashes (rare: a 41+
//     char string whose char-40 lands inside a `-`-only run, which
//     the `replace(/-+$/g, '')` then collapses to empty)
// The fallback prevents producing a refname like `agent/-<id>`
// which git would refuse with "is not a valid ref name".
const MAX_SLUG_CHARS = 40;
export const slugify = (raw: string): string => {
  const lowered = raw.toLowerCase();
  const cleaned = lowered.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (cleaned.length === 0) return 'task';
  return cleaned.slice(0, MAX_SLUG_CHARS).replace(/-+$/g, '') || 'task';
};

// Build the branch name git creates for the worktree. The suffix
// is the first 8 hex characters of the session UUID (after
// stripping dashes), giving 16^8 ≈ 4.3 billion possible suffixes.
// Birthday-collision threshold is ~65k branches before a 50% hit
// — enough headroom for any plausible per-user workload, tight
// enough that 100k+ branches in a CI fleet should switch to a
// longer suffix. Slug + suffix together stay grep-friendly when
// running `git branch --list 'agent/*'` from the parent repo.
export const branchName = (sessionId: string, prompt: string): string => {
  const slug = slugify(prompt);
  const shortId = sessionId.replace(/-/g, '').slice(0, 8);
  return `agent/${slug}-${shortId}`;
};

// Spawn helper. Mirrors the shape of checkpoints/git.ts:runGit but
// kept local so this module has no cross-package dependency. We
// don't need the temp-index machinery the checkpoint snapshot
// requires; plain `git -C <cwd> ...` is enough.
interface RunGitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const RUN_GIT_TIMEOUT_MS = 30_000;

const runGit = async (args: string[], cwd: string): Promise<RunGitResult> => {
  // Pinned git binary + canonical PATH closes the `~/bin/git`
  // shim vector (slice 178 hardening C2). safeGitEnv carries
  // LC_ALL=C and GIT_TERMINAL_PROMPT=0; GIT_LITERAL_PATHSPECS=1
  // is merged locally (NOT in safeGitEnv globally because it
  // breaks `git check-ignore` with exit 128) and is load-bearing
  // here: the skip-worktree flow passes deny-listed paths to
  // `git ls-files` and `git update-index`, both of which parse
  // positional arguments as pathspecs by default; a deny-listed
  // file like `[abc].pem` (legal Linux filename, matches `*.pem`
  // in the deny-list) would be interpreted as a bracket character
  // class matching `a.pem`/`b.pem`/`c.pem`, the literal file
  // would not be marked, and unrelated tracked files would be —
  // masking any real child edits to those files. Setting it
  // globally for THIS helper is inert for the path-typed args of
  // `git worktree add` / `branch -D`.
  const git = await getGitBinary();
  const proc = Bun.spawn({
    cmd: [git, '-C', cwd, ...args],
    env: { ...safeGitEnv(), GIT_LITERAL_PATHSPECS: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // proc may already be exited
    }
  }, RUN_GIT_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (timedOut) {
    throw new Error(`git ${args.join(' ')} timed out after ${RUN_GIT_TIMEOUT_MS}ms`);
  }
  return { stdout, stderr, exitCode };
};

export interface CreateWorktreeOptions {
  // The session id of the child run. Becomes the worktree's
  // directory name AND seeds the branch suffix; together they
  // give a 1:1 mapping between session row and worktree on disk.
  sessionId: string;
  // The user prompt the parent passed in. Drives the slug portion
  // of the branch name for human readability (`git branch --list
  // 'agent/*'` shows what each worktree was for).
  prompt: string;
  // Repository root (or any path inside it). All `git worktree`
  // commands run with this as their cwd.
  parentCwd: string;
  // Override for the worktree storage root. Tests pass a tmpdir
  // here so they don't pollute the user's real $XDG_CACHE_HOME.
  // Production callers omit it and inherit the default.
  rootDir?: string;
  // Override for environment variable resolution (XDG_CACHE_HOME
  // / HOME). Same purpose as rootDir but at a finer grain. Tests
  // typically use `rootDir`; this is a backstop.
  env?: NodeJS.ProcessEnv;
}

export interface WorktreeHandle {
  path: string;
  branch: string;
  // Paths the validator removed from this worktree at create
  // time and masked from `git status` via `--skip-worktree`.
  // cleanupWorktree stats each before running status — without
  // that re-check, a child that re-creates or modifies a
  // masked path (e.g. writes a new `.env`) would be hidden by
  // the skip-worktree flag, classified as a clean worktree,
  // and silently removed along with the child's writes.
  // Empty array when the validator removed nothing — most
  // worktrees end up with a zero-length list and the lstat
  // sweep is a no-op.
  maskedPaths: string[];
}

// Create a fresh git worktree for a subagent run. Throws on:
//   - parent cwd not inside a git repo (`git rev-parse` fails)
//   - target path already exists (orphan from a prior crash;
//     the user should `forja worktree gc` it before retrying)
//   - `git worktree add` itself fails (refname collision, disk
//     full, permissions). The error message preserves git's
//     stderr so diagnostics survive.
//
// The caller (runtime.ts) catches and maps the throw to a
// `spawn_failed` SpawnSubagentResult so the parent model gets a
// clean tool error rather than an uncaught exception.
export const createWorktree = async (opts: CreateWorktreeOptions): Promise<WorktreeHandle> => {
  const root = opts.rootDir ?? defaultWorktreeRoot(opts.env);
  // Ensure the cache root exists with `0700`. mkdirSync with
  // recursive:true is a no-op when the directory exists (mode is
  // ignored on the no-op path); chmod afterwards normalizes
  // permissions on pre-existing directories created by an
  // unrelated process. We do NOT chmod ancestor directories —
  // only our own root, so a user with a looser ~/.cache stays
  // unaffected outside the agent subtree.
  //
  // Race window: between mkdirSync (creates with the umask-derived
  // mode if the dir didn't exist) and chmodSync there's a brief
  // interval where another process could open the dir under the
  // looser permissions. Real attack requires local filesystem
  // access AND timing-precise opportunism — not a credible threat
  // for a per-user cache. The post-chmod statSync below verifies
  // the final mode and refuses the create if the perms are still
  // group/other-readable, so the worktree never lands inside a
  // permissively-mode'd root. Any caller-visible failure is the
  // caller's cue to investigate (custom umask, restricted FS).
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    chmodSync(root, 0o700);
  } catch {
    // chmod failure (e.g., a remount with restricted ops) is
    // non-fatal at this line — the post-chmod stat below decides
    // whether the resulting mode is acceptable. Swallowing here
    // keeps the failure mode singular: refused at the stat check,
    // not at the chmod call.
  }
  // Verify the mode actually landed at 0700. On most filesystems
  // the chmod above succeeds; on remounts that strip mode bits
  // (network mounts, exotic permissions), or when the umask
  // somehow won out, this catches the divergence before any
  // worktree gets created underneath.
  try {
    const mode = statSync(root).mode & 0o777;
    if (mode !== 0o700) {
      throw new Error(
        `worktree root '${root}' has mode ${mode.toString(8)} after chmod (expected 700); refusing to create worktree under group/other-readable cache. Fix the parent dir's permissions or override via WorktreeOptions.rootDir.`,
      );
    }
  } catch (e) {
    // statSync itself throwing is unusual (we just created the
    // dir) but possible on a remount-mid-operation race; surface
    // a wrapper error rather than the raw ENOENT/EACCES.
    if (e instanceof Error && e.message.startsWith("worktree root '")) throw e;
    throw new Error(
      `worktree root '${root}' could not be stat'd after chmod: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const path = join(root, opts.sessionId);
  if (existsSync(path)) {
    throw new Error(
      `worktree path '${path}' already exists; an earlier run may have crashed before cleanup. Remove it manually or wait for 'forja worktree gc'.`,
    );
  }
  const branch = branchName(opts.sessionId, opts.prompt);
  // Orphan detection on the git side: a stale worktree entry can
  // exist in `.git/worktrees/<id>/` even when the working tree was
  // deleted out from under git. `git worktree list --porcelain`
  // surfaces it; we refuse rather than silently overwriting.
  const list = await runGit(['worktree', 'list', '--porcelain'], opts.parentCwd);
  if (list.exitCode !== 0) {
    throw new Error(
      `git worktree list failed (exit ${list.exitCode}): ${list.stderr.trim() || list.stdout.trim()}`,
    );
  }
  if (list.stdout.includes(`worktree ${path}\n`) || list.stdout.includes(`worktree ${path}\0`)) {
    throw new Error(
      `worktree '${path}' is already registered with git (orphan from a prior run); run 'git worktree prune' or 'forja worktree gc' before retrying`,
    );
  }
  // Make sure parent dir of the worktree path exists. `git
  // worktree add` creates the leaf directory itself.
  mkdirSync(dirname(path), { recursive: true });
  const add = await runGit(['worktree', 'add', path, '-b', branch], opts.parentCwd);
  if (add.exitCode !== 0) {
    // `git worktree add` may have made it past the admin-state
    // creation (`.git/worktrees/<id>/`) before failing on the
    // working-tree checkout — disk-full mid-checkout is the
    // canonical case. The retry on the same id would then trip
    // on git's own "already registered" refusal even though our
    // pre-check (`worktree list --porcelain`) had been clean,
    // because git's view changed between the two calls. `git
    // worktree prune` reconciles by dropping any admin entries
    // whose working tree no longer exists. Best-effort: a prune
    // failure doesn't change the outcome (we still propagate the
    // original add error) but a successful prune lets the caller
    // retry without manual intervention. We also rm the leaf
    // dir if git left it behind partial — `--force` semantics
    // would be wrong here because the dir might hold the user's
    // own data if the path collision check above was bypassed
    // somehow; this is best-effort rmSync against the dir we
    // just attempted to create.
    await runGit(['worktree', 'prune'], opts.parentCwd).catch(() => undefined);
    if (existsSync(path)) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // leave it — operator's gc sweep handles persistent leftovers
      }
    }
    throw new Error(
      `git worktree add failed (exit ${add.exitCode}): ${add.stderr.trim() || add.stdout.trim()}`,
    );
  }
  // Post-checkout validation (spec §8.4). The worktree is on
  // disk with HEAD's tree checked out — any symlink committed
  // to the parent repo is now an active symlink in the child's
  // filesystem view. Two failures are possible:
  //   (a) symlink whose realpath escapes the worktree boundary
  //       — host-secrets exfil vector. Validator throws; we
  //       roll back the worktree + branch so the run as a whole
  //       reports `worktree_create_failed` rather than a half-
  //       constructed sandbox.
  //   (b) deny-listed file inside the tree (`.env`, `*.pem`,
  //       etc.) — validator deletes silently; the run proceeds.
  // Either way, the orphan-defense / branch cleanup mirrors the
  // `git worktree add` failure path above so the cache state
  // and the git refs stay consistent regardless of which step
  // tripped.
  let validation: ValidationResult;
  try {
    validation = validateWorktreeContents({ worktreePath: path });
  } catch (e) {
    await runGit(['worktree', 'remove', '--force', path], opts.parentCwd).catch(() => undefined);
    await runGit(['branch', '-D', branch], opts.parentCwd).catch(() => undefined);
    if (existsSync(path)) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // leave it — operator's gc sweep handles persistent leftovers
      }
    }
    throw e;
  }
  // Mark the validator's deletions as `--skip-worktree` in the
  // worktree's index so subsequent `git status` runs treat the
  // worktree as clean even though tracked files (e.g. a
  // committed `.env`) are now physically absent. Without this
  // step, every cleanup pass would see ` D <file>` lines from
  // the deny-list filter, classify the worktree as dirty, and
  // preserve it indefinitely — the cache root would fill with
  // leftovers and orphan agent branches on every run against
  // any repo that commits deny-listed files.
  //
  // Why skip-worktree (and not `git rm`, status filtering, or
  // chmod): see the slice's BACKLOG entry. Skip-worktree is
  // surgical (only the deleted paths are affected), local to
  // the worktree (no history mutation that would propagate via
  // merge), and dies with `git worktree remove` so there is
  // nothing to clean up later.
  //
  // Untracked deny-listed deletions (e.g. a `.env.local` the
  // user wrote but never committed) don't show up in
  // `git status --porcelain` after deletion — they were never
  // in the index, so `git ls-files` returns empty for them and
  // we skip the `update-index` call.
  if (validation.deniedRemoved.length > 0) {
    await markValidatorDeletionsSkipWorktree(path, validation.deniedRemoved);
  }
  return {
    path,
    branch,
    // Surface the validator's removals so cleanupWorktree can
    // detect child re-writes that skip-worktree would otherwise
    // hide. We thread the canonical relative paths from the
    // validator (a single entry per top-level removal — `.ssh`
    // for the directory case, not its expanded tracked
    // children) because the cleanup-side check only needs to
    // know "did this entry come back" and lstat'ing a single
    // dir is enough to detect any re-creation under it.
    maskedPaths: validation.deniedRemoved.map((d) => d.path),
  };
};

// Apply `--skip-worktree` to every tracked file under each path
// the validator removed. For single files the `git ls-files`
// query returns the path itself; for directory removals
// (`.ssh/`, `.gnupg/`) it expands to every tracked file inside
// — we mark them in batches via the `--stdin` form so we don't
// blow argv on big directories. Failures here are NOT fatal:
// the run already passed validation and the worktree is in a
// secure state; the worst case from a skip-worktree failure is
// a preserved-but-cleanable worktree at end of run, which the
// operator's `forja worktree gc` reconciles.
const markValidatorDeletionsSkipWorktree = async (
  worktreePath: string,
  deniedRemoved: ReadonlyArray<{ path: string; pattern: string }>,
): Promise<void> => {
  const tracked: string[] = [];
  for (const { path: removedPath } of deniedRemoved) {
    const ls = await runGit(['ls-files', '-z', '--', removedPath], worktreePath);
    if (ls.exitCode !== 0) continue;
    for (const file of ls.stdout.split('\0')) {
      if (file.length > 0) tracked.push(file);
    }
  }
  if (tracked.length === 0) return;
  // `--stdin` + `-z` so paths with spaces / newlines work
  // unchanged from `ls-files -z` output.
  const git = await getGitBinary();
  const proc = Bun.spawn({
    cmd: [git, '-C', worktreePath, 'update-index', '--skip-worktree', '-z', '--stdin'],
    env: { ...safeGitEnv(), GIT_LITERAL_PATHSPECS: '1' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.write(tracked.join('\0'));
  proc.stdin.end();
  await proc.exited;
};

export interface CleanupWorktreeOptions {
  handle: WorktreeHandle;
  // Repository root for the parent. `git worktree remove` and
  // `git branch -D` both run against it.
  parentCwd: string;
}

export interface CleanupResult {
  // True when the worktree had any working-tree change (tracked
  // or untracked). Drives the preserve-vs-remove decision.
  dirty: boolean;
  // True when the worktree was left on disk for the parent /
  // user to inspect. False when we removed it. Mutually exclusive
  // with `removed`.
  preserved: boolean;
  // True when the worktree directory + branch were deleted.
  // Mutually exclusive with `preserved`.
  removed: boolean;
}

// Decide what to do with a worktree at end-of-run:
//   - Clean tree (no diff, no untracked) → remove the worktree
//     directory + the agent branch. The child made no changes,
//     so there's nothing to keep.
//   - Dirty tree → preserve. The parent gets `path` + `branch`
//     in the result envelope; user/model decides whether to
//     merge, discard, or open a PR.
//
// We never throw on cleanup failures — the run already finished
// and the result is authoritative. Failures during remove leave
// the worktree on disk (preserved: true) with the failure
// captured on stderr; the operator deals with it through
// `forja worktree gc` later.
export const cleanupWorktree = async (opts: CleanupWorktreeOptions): Promise<CleanupResult> => {
  const { handle, parentCwd } = opts;
  // First check: did the child re-create or modify any path
  // the validator removed at create time? Those paths are
  // skip-worktree'd in the index, so `git status --porcelain`
  // would NOT report a re-write — the worktree would look
  // clean and the cleanup pass would silently drop the
  // child's work along with the worktree.
  //
  // We `lstatSync` (not `existsSync`) so a child re-creating
  // the path as a dangling symlink is also caught: existsSync
  // dereferences and returns false for broken symlinks, but
  // a broken symlink ENTRY is still a mutation the child
  // performed that the operator should inspect.
  for (const masked of handle.maskedPaths) {
    const absPath = join(handle.path, masked);
    try {
      lstatSync(absPath);
      // Path exists in some form — child mutated it.
      return { dirty: true, preserved: true, removed: false };
    } catch {
      // ENOENT: still gone. Continue checking the rest.
    }
  }

  // `git status --porcelain` against the worktree itself. Empty
  // stdout means a clean tree (no tracked diff, no untracked
  // files). Any line of output means dirty.
  let dirty = true;
  try {
    const status = await runGit(['status', '--porcelain'], handle.path);
    if (status.exitCode === 0) {
      dirty = status.stdout.length > 0;
    }
    // A non-zero exit (the worktree was deleted out from under us,
    // or git is broken) leaves `dirty=true` defensively — we'd
    // rather preserve a worktree we can't inspect than risk
    // removing one that holds work.
  } catch {
    dirty = true;
  }
  if (dirty) {
    return { dirty: true, preserved: true, removed: false };
  }
  // Clean tree → remove. We use --force because the worktree may
  // hold transient files git considers "would be lost" (any file
  // in `.gitignore` that the child wrote); the cleanup contract
  // is "if the run produced no tracked or untracked diff, drop
  // the worktree", and ignored files don't survive that bar.
  const remove = await runGit(['worktree', 'remove', '--force', handle.path], parentCwd);
  if (remove.exitCode !== 0) {
    // Fall through to preserve: a remove failure (someone is `cd`'d
    // into the worktree, an FS-level lock) shouldn't crash the
    // post-run path. The worktree is now in a "logically clean
    // but not removed" state; the operator's gc sweep will collect
    // it later.
    return { dirty: false, preserved: true, removed: false };
  }
  // Branch delete is best-effort. The branch had no commits beyond
  // HEAD (clean tree), so `-D` is safe; failures here (concurrent
  // user fetch grabbed it as a tracking ref?) are diagnostics, not
  // outcome-affecting.
  await runGit(['branch', '-D', handle.branch], parentCwd).catch(() => undefined);
  return { dirty: false, preserved: false, removed: true };
};
