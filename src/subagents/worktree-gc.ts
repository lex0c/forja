// `agent --worktrees gc` engine. Reconciles three sources of
// truth:
//
//   1. The audit table (`subagent_worktrees`) — the
//      authoritative record of every worktree Forja created.
//   2. The cache filesystem (`<defaultWorktreeRoot()>/<id>/`) —
//      what's actually on disk.
//   3. Git's worktree admin (`git worktree list --porcelain` in
//      the parent repo) — what git thinks exists.
//
// In a healthy run all three agree. Drift happens when:
//   - A subagent run crashed before audit insert: dir on disk
//     + git knows + no DB row → ORPHAN.
//   - A previous cleanup pass failed at remove: row='cleaned' or
//     'preserved' but dir+git still present → STALE_CLEANED /
//     STALE_PRESERVED.
//   - The operator manually removed a worktree: row exists but
//     no dir, no git entry → MISSING.
//   - A 'preserved' row whose tree is now actually clean (the
//     operator merged or hand-cleaned) → READY_TO_REMOVE.
//
// The gc engine returns a structured plan; the CLI surface
// applies it (or just renders for `--dry-run`). Splitting plan
// from apply keeps the policy testable without filesystem
// fixtures driving every assertion.

import { type Dirent, existsSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  type DB,
  listSubagentWorktreesWithParentCwd,
  markSubagentWorktreeCleaned,
} from '../storage/index.ts';
import { defaultWorktreeRoot } from './worktree.ts';

// One entry per worktree the gc considered. The `kind`
// discriminator drives both the rendering (operator-facing
// status) and the apply step (what action, if any, to take).
export type WorktreeGcEntry =
  | {
      kind: 'orphan';
      path: string;
      branch: string | null; // null when git also has no record
      sessionId: string | null; // null when no DB row
      reason: 'no_db_row';
    }
  | {
      kind: 'stale_cleaned';
      path: string;
      branch: string;
      sessionId: string;
      reason: 'dir_on_disk_but_row_says_cleaned';
    }
  | {
      kind: 'ready_to_remove';
      path: string;
      branch: string;
      sessionId: string;
      reason: 'preserved_row_with_clean_tree';
    }
  | {
      kind: 'preserved_dirty';
      path: string;
      branch: string;
      sessionId: string;
      reason: 'preserved_row_with_dirty_tree';
    }
  | {
      kind: 'missing';
      path: string;
      branch: string;
      sessionId: string;
      reason: 'row_present_but_no_dir';
    }
  | {
      kind: 'active';
      path: string;
      branch: string;
      sessionId: string;
      reason: 'row_status_active'; // subprocess running, do not touch
    };

export interface WorktreeGcPlan {
  // Every entry observed, classified. Even no-action entries
  // (active, preserved_dirty without --force) appear so the
  // operator's `gc list`/`--dry-run` shows the full picture.
  entries: WorktreeGcEntry[];
  // The cache root that was scanned. Surfaced so error messages
  // and dry-run output can reference it precisely.
  cacheRoot: string;
  // Non-fatal anomalies discovered during plan build —
  // typically a path the engine couldn't introspect (EACCES,
  // I/O error other than ENOENT). The engine keeps the plan
  // valid by treating the path as on-disk-uncertain (which
  // routes it to a safe classification: `preserved_dirty`
  // for preserved rows, etc.), but the caller should surface
  // these so the operator knows their gc view was partial.
  warnings: string[];
}

export interface BuildGcPlanOptions {
  db: DB;
  // Parent repo cwd; `git worktree list --porcelain` runs there.
  parentCwd: string;
  // Override the cache root (tests). Production omits → default
  // resolves via `defaultWorktreeRoot()`.
  cacheRoot?: string;
  // Override the env reading for `defaultWorktreeRoot`. Tests
  // pass a pinned env so XDG_CACHE_HOME variants are explicit.
  env?: NodeJS.ProcessEnv;
  // Test seam: substitute the git worktree-list runner. The
  // production runner shells `git -C <parent> worktree list
  // --porcelain`; tests inject a stub returning canned output
  // so the plan logic can be exercised without a real repo.
  runGitWorktreeList?: (parentCwd: string) => Promise<string>;
  // Test seam: substitute the worktree status check. Production
  // runs `git -C <worktree> status --porcelain`; tests pin
  // clean/dirty per path.
  worktreeStatus?: (path: string) => Promise<'clean' | 'dirty' | 'unreadable'>;
  // Test seam: substitute the repo-root resolver. Production
  // runs `git -C <parentCwd> rev-parse --show-toplevel`; tests
  // pin a literal path so the repo-scoping filter exercises
  // deterministically without a real git repo. Returning null
  // signals "not a git repo" — the engine then keeps the
  // unscoped behavior would be unsafe, so it falls back to
  // an empty plan with a warning.
  resolveRepoRoot?: (parentCwd: string) => Promise<string | null>;
}

const defaultRunGitWorktreeList = async (parentCwd: string): Promise<string> => {
  const proc = Bun.spawn({
    cmd: ['git', '-C', parentCwd, 'worktree', 'list', '--porcelain'],
    env: {
      LC_ALL: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GIT_LITERAL_PATHSPECS: '1',
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) return ''; // not a git repo, or git error → treat git as silent
  return stdout;
};

const defaultWorktreeStatus = async (path: string): Promise<'clean' | 'dirty' | 'unreadable'> => {
  const proc = Bun.spawn({
    cmd: ['git', '-C', path, 'status', '--porcelain'],
    env: {
      LC_ALL: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GIT_LITERAL_PATHSPECS: '1',
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) return 'unreadable';
  return stdout.length === 0 ? 'clean' : 'dirty';
};

// Resolve the repo-root for the cwd gc was invoked from.
// Production: `git rev-parse --show-toplevel`. Returns null if
// the cwd isn't inside a git working tree (gc is meaningless
// without git context — the engine surfaces that as a warning
// and returns an empty plan rather than risking unscoped
// removal).
const defaultResolveRepoRoot = async (parentCwd: string): Promise<string | null> => {
  const proc = Bun.spawn({
    cmd: ['git', '-C', parentCwd, 'rev-parse', '--show-toplevel'],
    env: {
      LC_ALL: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GIT_LITERAL_PATHSPECS: '1',
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) return null;
  const trimmed = stdout.trim();
  return trimmed.length === 0 ? null : trimmed;
};

// Parse `git worktree list --porcelain` into a Map<path, branch>.
// Format groups records by blank line; relevant fields are
// `worktree <abs path>` and `branch <ref>` (refs/heads/foo or
// `(no branch)` for detached). We treat detached worktrees as
// branchless — `agent worktree gc` only operates on `agent/*`
// branches that the spawn lifecycle guaranteed.
const parseWorktreeList = (raw: string): Map<string, string | null> => {
  const out = new Map<string, string | null>();
  let currentPath: string | null = null;
  let currentBranch: string | null = null;
  for (const line of raw.split('\n')) {
    if (line.length === 0) {
      if (currentPath !== null) out.set(currentPath, currentBranch);
      currentPath = null;
      currentBranch = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length);
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      currentBranch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    }
  }
  // Trailing record without final blank line.
  if (currentPath !== null) out.set(currentPath, currentBranch);
  return out;
};

// Canonicalize a path for cross-source comparison. The DB
// stores literal paths from `createWorktree`; git's worktree
// list output uses git's own normalization; the cache scan
// returns whatever the FS gives us. On macOS specifically,
// `/var` is a symlink to `/private/var`, so the same worktree
// can show up as `/var/folders/.../session-id` (DB) vs
// `/private/var/folders/.../session-id` (git/cache after
// realpath). Without normalization, the gc unions these as
// separate entries, classifies each independently, and emits
// confusing duplicate output (one `missing` and one `orphan`
// for the same worktree).
//
// `realpathSync` resolves the chain; if the path doesn't exist
// (the `missing` case), realpath throws ENOENT and we fall back
// to the literal. The fallback preserves the path so the
// `missing` detection still fires for rows whose worktree was
// deleted out from under us.
const canonicalize = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

// Guard: is `path` a proper child of `root`? Used by gc to
// confine candidate paths to the cache root (Forja's worktree
// territory) so that the parent repo's main worktree — which
// `git worktree list --porcelain` ALWAYS includes — never
// enters the plan. Without this filter, the parent repo's
// own checkout shows up as `orphan`; `--force` then routes
// it to `defaultRunRemove`, which falls back to `rmSync` if
// `git worktree remove` refuses (and it WILL refuse for the
// main worktree). The fallback would recursively delete the
// operator's repository.
//
// Implementation pins `root + sep` so `/cache` doesn't accept
// `/cache2/...` (the classic prefix-match pitfall) and
// rejects `path === root` so a caller can't blow away the
// cache root itself by passing it as a worktree path.
const isUnderRoot = (path: string, root: string): boolean => {
  if (path === root) return false;
  return path.startsWith(root + sep);
};

// Walk the cache root to discover directories on disk. Returns
// absolute paths of immediate children that are directories.
// Sub-namespaces (e.g. `bg/`) under the cache root are out of
// scope here — the worktree root convention is one directory
// per session at the top level.
const listCacheDirs = (cacheRoot: string): string[] => {
  if (!existsSync(cacheRoot)) return [];
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    out.push(join(cacheRoot, entry.name));
  }
  return out;
};

// Compose the full plan. Pure function in spirit — the only
// side effects are the read calls (filesystem + git). Returns
// classification only; no rows updated, no dirs removed. Apply
// happens in `applyGcPlan`.
export const buildGcPlan = async (opts: BuildGcPlanOptions): Promise<WorktreeGcPlan> => {
  const cacheRoot = opts.cacheRoot ?? defaultWorktreeRoot(opts.env);
  const runWorktreeList = opts.runGitWorktreeList ?? defaultRunGitWorktreeList;
  const checkStatus = opts.worktreeStatus ?? defaultWorktreeStatus;
  const resolveRepoRoot = opts.resolveRepoRoot ?? defaultResolveRepoRoot;

  // Repo scoping: the DB and the cache root are global
  // resources shared across every repository the operator
  // works in. An unscoped query (the original implementation)
  // would surface worktrees from OTHER repos as candidates;
  // `--force` (or even auto-removal of clean preserved
  // entries via the rmSync fallback) would silently destroy
  // preserved work from repo B while operator runs gc in
  // repo A.
  //
  // Resolve the parent's repo root via `git rev-parse
  // --show-toplevel` and filter rows by their parent session's
  // cwd. If git can't resolve (parentCwd not inside a git
  // working tree, git not on PATH, etc.), fall back to the
  // literal parentCwd as the scoping key — still scoped, just
  // less precise. We surface that fallback as a warning so
  // operators in non-git contexts know rows that come from
  // sibling cwds aren't visible to this gc invocation.
  let repoRoot = await resolveRepoRoot(opts.parentCwd);
  const warnings: string[] = [];
  if (repoRoot === null) {
    repoRoot = opts.parentCwd;
    warnings.push(
      `gc: '${opts.parentCwd}' is not inside a git repository; scoping audit query to literal cwd. Sessions whose parent cwd doesn't match exactly won't be visible.`,
    );
  }
  // Canonicalize the repo root once so the per-row check
  // collapses symlink-equivalent paths (`/var` ↔ `/private/var`,
  // `/home/user/symlink-to-projA` ↔ `/home/user/projA`).
  const canonicalRepoRoot = canonicalize(repoRoot);

  // Fetch ALL audit rows joined with their parent session's
  // cwd, then filter at the JS layer via canonicalized
  // comparison. SQL-only filtering would miss
  // symlink-equivalent rows: `sessions.cwd` stores the literal
  // path passed at session creation (often a symlink), while
  // `git rev-parse --show-toplevel` returns the canonical
  // path. A direct string match excludes legitimate rows;
  // they're then mis-classified as `orphan` by downstream
  // logic and audit drift accumulates.
  //
  // For typical operator scale (≤100 worktree rows over the
  // DB's lifetime) the linear filter is negligible. If row
  // count ever explodes, we can prefilter via prefix-match
  // SQL + final canonical check — but premature optimization
  // for an audit-table sweep that runs on operator demand.
  const allRows = listSubagentWorktreesWithParentCwd(opts.db);
  const dbRows = allRows.filter((row) => {
    const canonicalParentCwd = canonicalize(row.parentCwd);
    if (canonicalParentCwd === canonicalRepoRoot) return true;
    return canonicalParentCwd.startsWith(`${canonicalRepoRoot}${sep}`);
  });
  // Build the path-keyed maps using canonicalized keys so all
  // three sources (DB, git, cache) collapse to the same path
  // string when they refer to the same worktree. Without this,
  // a /var ↔ /private/var symlink (macOS) or any operator-side
  // symlink in the cache root would split a single worktree
  // into multiple plan entries with conflicting kinds.
  const dbByPath = new Map<string, (typeof dbRows)[number]>();
  for (const row of dbRows) dbByPath.set(canonicalize(row.path), row);

  const canonicalCacheRoot = canonicalize(cacheRoot);

  const gitOutput = await runWorktreeList(opts.parentCwd);
  const gitByPathRaw = parseWorktreeList(gitOutput);
  const gitByPath = new Map<string, string | null>();
  for (const [path, branch] of gitByPathRaw) gitByPath.set(canonicalize(path), branch);

  // Build the union of candidate paths — but DON'T blindly
  // include everything `git worktree list --porcelain` returns.
  // That output ALWAYS contains the parent repo's main
  // worktree, plus any unrelated linked worktrees the operator
  // created outside Forja. Including those would surface them
  // as `orphan` (no DB row) and `--force` would route them to
  // `defaultRunRemove`. `git worktree remove` correctly
  // refuses to remove the main worktree, but the rmSync
  // fallback would still execute — recursively deleting the
  // operator's entire repository.
  //
  // Filter rule: a candidate path enters the plan only if
  //   (a) the audit DB (now scoped to the current repo) knows
  //       the path — the authoritative "this is a Forja
  //       worktree from THIS repo" signal, OR
  //   (b) the current repo's git lists the path (path lives
  //       under the cache root AND the parent's git knows it
  //       as a linked worktree).
  // Cache dirs that don't satisfy (a) or (b) are categorically
  // out of scope: they may belong to other repos that share
  // this cache root — emitting them would let `--force`
  // destroy preserved work from another repository's gc
  // surface. Operator runs gc per-repo to clean up each
  // repo's leftovers; truly-orphan dirs from a deleted repo
  // (no git, no DB anywhere) need manual operator action.
  const cacheDirs = listCacheDirs(cacheRoot);
  const allPaths = new Set<string>();
  for (const row of dbRows) allPaths.add(canonicalize(row.path));
  for (const path of gitByPath.keys()) {
    if (dbByPath.has(path) || isUnderRoot(path, canonicalCacheRoot)) {
      allPaths.add(path);
    }
  }
  for (const path of cacheDirs) {
    const canonical = canonicalize(path);
    // Only include cache dirs that the current repo's audit
    // OR git knows about. Foreign repos sharing the cache
    // root would otherwise leak into the plan.
    if (dbByPath.has(canonical) || gitByPath.has(canonical)) {
      allPaths.add(canonical);
    }
  }

  const entries: WorktreeGcEntry[] = [];

  for (const path of allPaths) {
    const dbRow = dbByPath.get(path);
    const gitBranch = gitByPath.get(path) ?? null;
    // Single stat probe inside try/catch. The earlier
    // `existsSync(path) && lstatSync(path).isDirectory()`
    // shape was racy: between the two syscalls another
    // process (a parallel gc run, the harness's own cleanup
    // pass, or operator-side rm) could remove the path,
    // causing lstat to throw ENOENT and aborting the entire
    // buildGcPlan with an unhandled exception.
    //
    // We distinguish error kinds:
    //   - ENOENT → path truly gone; onDisk=false. For
    //     preserved/cleaned rows this routes correctly to the
    //     `missing` / silently-consistent classification, with
    //     audit flip authorized (the row's process IS gone).
    //   - Anything else (EACCES on a setuid'd path, EIO on a
    //     flaky mount, etc.) → we genuinely can't tell. Treat
    //     as onDisk=true so downstream classification does NOT
    //     route to `missing` (which would auto-flip the audit
    //     to cleaned). The status check that follows will also
    //     fail and surface as `preserved_dirty` /
    //     `stale_cleaned`, which apply skips without --force.
    //     Operator gets a stderr warning via the plan's
    //     `warnings` so they know the view was partial.
    const onDisk = ((): boolean => {
      try {
        return lstatSync(path).isDirectory();
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return false;
        warnings.push(
          `gc: lstat('${path}') failed with ${code ?? 'unknown error'}; classification may be partial. Investigate via OS tools.`,
        );
        return true;
      }
    })();

    // Active rows are off-limits. The subprocess path inserts
    // 'active' before spawn; gc must never touch a
    // worktree whose subagent is still running.
    if (dbRow?.status === 'active') {
      entries.push({
        kind: 'active',
        path,
        branch: dbRow.branch,
        sessionId: dbRow.sessionId,
        reason: 'row_status_active',
      });
      continue;
    }

    // No DB row → orphan. Could be a Forja crash before audit
    // insert, OR a non-Forja directory under our cache root
    // (operator put it there manually), OR a stale git admin
    // entry whose working tree was removed externally. Any of
    // those is worth surfacing — the operator may want to
    // `git worktree prune` the admin entry, hand-investigate
    // the cache dir, or re-run with `--force`. We DON'T touch
    // by default; --force lifts the dir/admin removal.
    //
    // Earlier draft skipped emission when the path was neither
    // on disk NOR carried a git branch ("defensive cache-root
    // self-skip"), but that hid genuine inconsistencies — a
    // `git worktree list` record without a `branch` line (rare
    // git output shapes) plus a deleted working tree IS an
    // orphan worth reporting. The path made it into `allPaths`
    // through some source (DB, git, or cache); whichever it was
    // is enough signal to surface the row.
    if (dbRow === undefined) {
      entries.push({
        kind: 'orphan',
        path,
        branch: gitBranch,
        sessionId: null,
        reason: 'no_db_row',
      });
      continue;
    }

    // Row says 'cleaned' but dir is still here → previous
    // cleanup pass partially failed (removed branch but not
    // dir, or vice versa). gc retries unconditionally — the
    // operator already authorized cleanup for this row.
    if (dbRow.status === 'cleaned') {
      if (!onDisk && gitBranch === null) {
        // Fully consistent already: row=cleaned, no dir, no
        // git entry. Don't emit; nothing to do.
        continue;
      }
      entries.push({
        kind: 'stale_cleaned',
        path,
        branch: dbRow.branch,
        sessionId: dbRow.sessionId,
        reason: 'dir_on_disk_but_row_says_cleaned',
      });
      continue;
    }

    // Row says 'preserved' but dir is missing → operator
    // already cleaned manually; reconcile audit.
    if (dbRow.status === 'preserved' && !onDisk && gitBranch === null) {
      entries.push({
        kind: 'missing',
        path,
        branch: dbRow.branch,
        sessionId: dbRow.sessionId,
        reason: 'row_present_but_no_dir',
      });
      continue;
    }

    // Row says 'preserved' AND dir exists. Decide based on
    // current dirty state. Re-checking is the whole point of
    // gc — the original run may have left changes that the
    // operator since merged or discarded.
    if (dbRow.status === 'preserved') {
      const status = await checkStatus(path);
      if (status === 'clean') {
        entries.push({
          kind: 'ready_to_remove',
          path,
          branch: dbRow.branch,
          sessionId: dbRow.sessionId,
          reason: 'preserved_row_with_clean_tree',
        });
      } else {
        // 'dirty' or 'unreadable' both surface as preserved_dirty —
        // operator decides; --force can blow them away.
        entries.push({
          kind: 'preserved_dirty',
          path,
          branch: dbRow.branch,
          sessionId: dbRow.sessionId,
          reason: 'preserved_row_with_dirty_tree',
        });
      }
    }
  }

  // Stable ordering: by path, ascending. Mirrors the audit
  // table's createdAt order in practice (cache subdirs are
  // session-id-named UUIDs, lexically ordered) and avoids
  // operator confusion when re-running gc on the same state.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { entries, cacheRoot, warnings };
};

export interface ApplyGcPlanOptions {
  db: DB;
  parentCwd: string;
  plan: WorktreeGcPlan;
  // When true, the apply step also removes `preserved_dirty`
  // worktrees and `orphan` entries. Without it, those classes
  // are skipped — operator must inspect first.
  force: boolean;
  // Override the rmSync-safety check. Production should never
  // pass this; tests that exercise non-cache paths against a
  // mocked runRemove can use it to relax the guard.
  allowPathOutsideCacheRoot?: boolean;
  // Test seam for the actual git removal. Production runs
  // `git worktree remove --force <path>` and `git branch -D
  // <branch>`. Tests pass a stub that records calls without
  // touching the real git.
  runRemove?: RunRemoveFn;
}

export interface RemoveResult {
  // True when the worktree directory + git admin entry are
  // both gone after the operation. False when removal failed
  // (e.g., a process is still cwd'd inside on Windows / NFS).
  // Failure leaves state for `agent worktree gc` retry.
  removed: boolean;
  // True when the agent branch was deleted. Independent of
  // `removed` because branch deletion is best-effort.
  branchDeleted: boolean;
  // Empty on success; populated when removal failed (e.g.,
  // git error message). Surfaced in the apply summary so the
  // operator can diagnose without re-running with --verbose.
  error?: string;
}

export interface ApplyGcSummary {
  // Per-entry outcome, in the same order as the input plan.
  outcomes: Array<{
    path: string;
    sessionId: string | null;
    action: 'removed' | 'skipped' | 'failed' | 'reconciled-audit';
    detail: string;
  }>;
  removedCount: number;
  skippedCount: number;
  failedCount: number;
  reconciledCount: number;
}

// Runner is invoked with (path, branch, parentCwd, cacheRoot).
// `cacheRoot` is needed by the production runner's rmSync
// fallback — without it, a `git worktree remove` failure on
// the parent repo's path would let the fallback recursively
// delete the whole repository. The buildGcPlan filter SHOULD
// have prevented that path from reaching here, but we
// belt-and-suspenders the check inside the runner too.
//
// Tests passing a custom runRemove can ignore the cacheRoot
// argument; the type signature stays compatible because TS
// allows fewer-parameter callbacks at the call site.
type RunRemoveFn = (
  path: string,
  branch: string | null,
  parentCwd: string,
  cacheRoot: string,
) => Promise<RemoveResult>;

const defaultRunRemove: RunRemoveFn = async (
  path,
  branch,
  parentCwd,
  cacheRoot,
): Promise<RemoveResult> => {
  // `git worktree remove --force <path>` removes the dir + admin
  // entry. We follow with `git branch -D <branch>` for the
  // agent/* branch — best-effort because the branch may already
  // be gone, or the operator may have intentionally kept it.
  const remove = Bun.spawn({
    cmd: ['git', '-C', parentCwd, 'worktree', 'remove', '--force', path],
    env: {
      LC_ALL: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GIT_LITERAL_PATHSPECS: '1',
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [removeStderr, removeExit] = await Promise.all([
    new Response(remove.stderr).text(),
    remove.exited,
  ]);
  // Fallback: if `git worktree remove` failed and the dir
  // still exists, try a plain rmSync. Covers the case where
  // git's admin entry was already pruned but the working tree
  // wasn't cleaned (orphans from crashed runs).
  //
  // SAFETY: rmSync only runs when the path is provably under
  // the cache root. The buildGcPlan filter blocks non-cache
  // paths from reaching here, so this guard is defense-in-depth
  // — but it's the LAST line before a recursive disk delete, so
  // we double-check. Without this, a malicious or corrupted DB
  // row pointing at the parent repo would slip through if the
  // upstream filter ever regressed; rmSync would then wipe the
  // operator's repository.
  let removed = removeExit === 0;
  if (!removed && existsSync(path) && isUnderRoot(canonicalize(path), canonicalize(cacheRoot))) {
    try {
      rmSync(path, { recursive: true, force: true });
      removed = !existsSync(path);
    } catch {
      // leave for next gc pass
    }
  }
  // Branch delete: only attempt if remove succeeded. A failed
  // remove leaves the working tree linked to the branch and
  // git refuses to delete it.
  let branchDeleted = false;
  if (removed && branch !== null) {
    const del = Bun.spawn({
      cmd: ['git', '-C', parentCwd, 'branch', '-D', branch],
      env: {
        LC_ALL: 'C',
        GIT_TERMINAL_PROMPT: '0',
        GIT_LITERAL_PATHSPECS: '1',
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await del.exited;
    branchDeleted = del.exitCode === 0;
  }
  if (removed) return { removed: true, branchDeleted };
  return {
    removed: false,
    branchDeleted: false,
    error: removeStderr.trim() || `git worktree remove exited ${removeExit}`,
  };
};

export const applyGcPlan = async (opts: ApplyGcPlanOptions): Promise<ApplyGcSummary> => {
  const runRemove = opts.runRemove ?? defaultRunRemove;
  const outcomes: ApplyGcSummary['outcomes'] = [];
  let removedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let reconciledCount = 0;

  for (const entry of opts.plan.entries) {
    // active rows: never touched.
    if (entry.kind === 'active') {
      outcomes.push({
        path: entry.path,
        sessionId: entry.sessionId,
        action: 'skipped',
        detail: 'subagent still running (status=active); refused to gc',
      });
      skippedCount += 1;
      continue;
    }

    // missing: row says preserved/cleaned but no dir on disk.
    // The ONLY work for this kind is the audit flip — if the
    // DB write fails, we did nothing; the action MUST reflect
    // that. Capturing the helper's boolean (true = flipped,
    // false = already terminal) and any thrown error keeps the
    // outcome honest.
    if (entry.kind === 'missing') {
      let flipped = false;
      let dbError: string | undefined;
      try {
        flipped = markSubagentWorktreeCleaned(opts.db, entry.sessionId);
      } catch (e) {
        dbError = e instanceof Error ? e.message : String(e);
      }
      if (dbError !== undefined) {
        outcomes.push({
          path: entry.path,
          sessionId: entry.sessionId,
          action: 'failed',
          detail: `audit flip failed: ${dbError}`,
        });
        failedCount += 1;
      } else {
        outcomes.push({
          path: entry.path,
          sessionId: entry.sessionId,
          action: 'reconciled-audit',
          detail: flipped
            ? 'worktree gone from disk; row marked cleaned'
            : 'worktree gone from disk; row was already terminal',
        });
        reconciledCount += 1;
      }
      continue;
    }

    // ready_to_remove: clean preserved row. Disk state is the
    // primary outcome — `removed` means the dir + branch are
    // gone. Audit drift is secondary: if `markSubagentWorktreeCleaned`
    // throws (DB write error), surface that in the detail
    // string so the operator knows audit lags reality, but
    // keep action='removed' because the disk-side work
    // succeeded.
    if (entry.kind === 'ready_to_remove') {
      const result = await runRemove(entry.path, entry.branch, opts.parentCwd, opts.plan.cacheRoot);
      if (result.removed) {
        let dbError: string | undefined;
        try {
          markSubagentWorktreeCleaned(opts.db, entry.sessionId);
        } catch (e) {
          dbError = e instanceof Error ? e.message : String(e);
        }
        const baseDetail = result.branchDeleted
          ? `removed worktree + branch ${entry.branch}`
          : `removed worktree (branch ${entry.branch} kept or already gone)`;
        outcomes.push({
          path: entry.path,
          sessionId: entry.sessionId,
          action: 'removed',
          detail: dbError === undefined ? baseDetail : `${baseDetail}; AUDIT DRIFT: ${dbError}`,
        });
        removedCount += 1;
      } else {
        outcomes.push({
          path: entry.path,
          sessionId: entry.sessionId,
          action: 'failed',
          detail: result.error ?? 'unknown removal error',
        });
        failedCount += 1;
      }
      continue;
    }

    // stale_cleaned: row says cleaned but dir is back.
    // Always retry (audit already authorized cleanup).
    if (entry.kind === 'stale_cleaned') {
      const result = await runRemove(entry.path, entry.branch, opts.parentCwd, opts.plan.cacheRoot);
      if (result.removed) {
        outcomes.push({
          path: entry.path,
          sessionId: entry.sessionId,
          action: 'removed',
          detail: 'cleaned-status retry succeeded',
        });
        removedCount += 1;
      } else {
        outcomes.push({
          path: entry.path,
          sessionId: entry.sessionId,
          action: 'failed',
          detail: result.error ?? 'unknown removal error',
        });
        failedCount += 1;
      }
      continue;
    }

    // preserved_dirty + orphan: gated on --force. Default
    // skips with a clear message; --force removes.
    if (entry.kind === 'preserved_dirty' || entry.kind === 'orphan') {
      if (!opts.force) {
        outcomes.push({
          path: entry.path,
          sessionId: entry.sessionId,
          action: 'skipped',
          detail:
            entry.kind === 'preserved_dirty'
              ? 'dirty tree (uncommitted changes); pass --force to discard'
              : 'no audit row (orphan or non-Forja dir); pass --force to remove',
        });
        skippedCount += 1;
        continue;
      }
      const result = await runRemove(entry.path, entry.branch, opts.parentCwd, opts.plan.cacheRoot);
      if (result.removed) {
        let dbError: string | undefined;
        if (entry.sessionId !== null) {
          try {
            markSubagentWorktreeCleaned(opts.db, entry.sessionId);
          } catch (e) {
            dbError = e instanceof Error ? e.message : String(e);
          }
        }
        const baseDetail =
          entry.kind === 'preserved_dirty'
            ? 'forced removal of dirty preserved worktree'
            : 'forced removal of orphan';
        outcomes.push({
          path: entry.path,
          sessionId: entry.sessionId,
          action: 'removed',
          detail: dbError === undefined ? baseDetail : `${baseDetail}; AUDIT DRIFT: ${dbError}`,
        });
        removedCount += 1;
      } else {
        outcomes.push({
          path: entry.path,
          sessionId: entry.sessionId,
          action: 'failed',
          detail: result.error ?? 'unknown removal error',
        });
        failedCount += 1;
      }
    }
  }

  return { outcomes, removedCount, skippedCount, failedCount, reconciledCount };
};
