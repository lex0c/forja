// FS walker for the code-index initial scan
// (CODE_INDEX.md §3.1 step 2). Produces the list of indexable
// files for a given project root, applying the privacy/perf
// filters the spec requires:
//   - .gitignore (when respect_gitignore is true and the dir is
//     a git repo) — implemented by shelling out to
//     `git ls-files --cached --others --exclude-standard`. The
//     subprocess overhead is fine in the scan-once budget
//     (~500ms target for 3k files); reimplementing gitignore
//     semantics is a known mistake (negation rules, nested
//     .gitignore files, etc.).
//   - CODE_INDEX_DEFAULT_EXCLUDES on top — defensive even when
//     gitignore covers most cases, since not every repo
//     gitignores `.env` or `node_modules` properly.
//   - Extension → language detection. Files with unsupported
//     extensions are dropped (no fallback to regex per
//     CODE_INDEX.md §0).
//   - max file size cap (CODE_INDEX_MAX_FILE_SIZE_BYTES).
//
// The walker does NOT read file contents — it only lists +
// stats. Reading happens in the pipeline (slice 4.3.1.b's
// pipeline.ts) where it's batched per transaction.

import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CODE_INDEX_DEFAULT_EXCLUDES, CODE_INDEX_MAX_FILE_SIZE_BYTES } from '../privacy.ts';
import { type SupportedLanguage, detectLanguage } from './language.ts';

export interface WalkOptions {
  // MUST be absolute and canonical. Caller (CodeIndex.scan) is
  // expected to resolve via `git rev-parse --show-toplevel` or
  // realpath beforehand.
  projectRoot: string;
  // Default true. When false, skip the git ls-files probe and
  // walk via fs.readdir directly. Useful for non-git project
  // roots and tests.
  respectGitignore?: boolean;
  // Patterns appended to CODE_INDEX_DEFAULT_EXCLUDES. The
  // defaults are NEVER removed — privacy guarantees compose
  // additively per CODE_INDEX.md §8.1.
  additionalExcludes?: readonly string[];
  // Default CODE_INDEX_MAX_FILE_SIZE_BYTES (5 MB).
  maxFileSizeBytes?: number;
}

export interface WalkedFile {
  // POSIX-normalized (forward slashes), relative to projectRoot.
  // Used as the `files.path` primary key — every downstream join
  // depends on this string being canonical.
  relPath: string;
  absPath: string;
  sizeBytes: number;
  // Epoch milliseconds. Persisted as `files.last_modified_at`
  // and used by stale-detection (CODE_INDEX.md §3.5).
  mtimeMs: number;
  language: SupportedLanguage;
}

export interface WalkResult {
  // Files we can index this scan — passed every filter and
  // produced a successful lstat.
  files: WalkedFile[];
  // Every project-relative path the walker observed for which
  // the prior index row should be PRESERVED across this scan.
  // Superset of `files.relPath`: also includes paths whose
  // lstat failed with a TRANSIENT error (EACCES, EBUSY,
  // ETIMEDOUT, NFS hiccup) — the file may still exist, so
  // dropping its prior row would be destructive. NOT included:
  //   - ENOENT lstat results (file definitively gone — prune
  //     removes the row, matching the operator's `rm`)
  //   - Symlinks / non-files / oversized files (intentional
  //     drops; prune cleans up any leftover row)
  // The pipeline's stale-row prune deletes `files` rows whose
  // path is NOT in this set.
  seenPaths: string[];
  // Project-relative directory paths that the fallback walk
  // could not enumerate (readdir threw EACCES, ENOENT race,
  // network FS hiccup). Same hazard class as failed lstat at
  // the file level, but at the directory level we can't list
  // the children to add them to seenPaths individually — the
  // pipeline expands these into preserved subtree prefixes
  // against the existing files table. Empty when git ls-files
  // was used (the git path either succeeds wholesale or falls
  // through to the fallback walk).
  failedDirs: string[];
}

// Names whose subtrees never produce an indexable file under
// any reasonable config. Skipping at directory entry time
// avoids descending into them in the fallback walk (the
// exclude check in the main loop would still drop the files,
// but reading thousands of node_modules entries per scan is
// the kind of thing that blows the perf budget). Match the
// dependency dirs from CODE_INDEX_DEFAULT_EXCLUDES.
const FAST_SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'vendor',
  'dist',
  'build',
  'target',
  'out',
  '.next',
]);

export const walkProject = async (opts: WalkOptions): Promise<WalkResult> => {
  const projectRoot = opts.projectRoot;
  const respectGitignore = opts.respectGitignore ?? true;
  const additionalExcludes = opts.additionalExcludes ?? [];
  const maxFileSizeBytes = opts.maxFileSizeBytes ?? CODE_INDEX_MAX_FILE_SIZE_BYTES;

  // Pre-flight check on the root itself. An empty walk MUST
  // mean "no files match" — the pipeline's stale-row prune
  // treats the walker output as the complete project listing,
  // so a transient ENOENT/EACCES on the root would silently
  // wipe the entire index. Surface root failures as a hard
  // throw so the caller sees a real error instead of a
  // successful zero-file scan masquerading as data deletion.
  // `stat` (not `lstat`) follows the root if it happens to be
  // a symlink — entries beneath are still detected via lstat.
  let rootStat: Stats;
  try {
    rootStat = await stat(projectRoot);
  } catch (e) {
    throw new Error(
      `walkProject: project root '${projectRoot}' is inaccessible: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`walkProject: project root '${projectRoot}' is not a directory`);
  }

  const excludePatterns = [...CODE_INDEX_DEFAULT_EXCLUDES, ...additionalExcludes];
  const excludeGlobs = excludePatterns.map((p) => new Bun.Glob(p));
  const isExcluded = (relPath: string): boolean => {
    for (const g of excludeGlobs) {
      if (g.match(relPath)) return true;
    }
    return false;
  };

  const candidates = respectGitignore ? gitListFiles(projectRoot) : null;
  let relPaths: string[];
  let failedDirs: string[];
  if (candidates !== null) {
    relPaths = candidates;
    failedDirs = [];
  } else {
    const fb = await fallbackWalk(projectRoot);
    relPaths = fb.paths;
    failedDirs = fb.failedDirs;
  }

  // Pre-filter (cheap, in-memory) before stat — drops paths via
  // exclude pattern + extension check before paying for I/O.
  const eligible: { relPath: string; absPath: string; language: SupportedLanguage }[] = [];
  for (const relPath of relPaths) {
    if (isExcluded(relPath)) continue;
    const language = detectLanguage(relPath);
    if (language === null) continue;
    eligible.push({ relPath, absPath: join(projectRoot, relPath), language });
  }

  // Stat in parallel — sequential awaits for 3k+ paths add up
  // even on local FS (~50ms+); parallel is bounded by the FS
  // queue depth and finishes in a fraction of the time.
  // `lstat` (not stat) is required so symlinks are detected
  // and dropped — CODE_INDEX.md §8.2 sets follow_symlinks=false
  // as the default. A symlink whose target is a regular file
  // would otherwise sneak through the `s.isFile()` check.
  // Three lstat outcomes, treated differently by the caller:
  //   - 'ok'       → indexable file, write a new row
  //   - 'preserve' → transient failure (EACCES, EBUSY,
  //                   ETIMEDOUT…); file may exist, keep prior
  //                   row alive
  //   - 'drop'     → ENOENT; file definitively gone, let the
  //                   prune remove the prior row
  // Without the ENOENT distinction we'd indefinitely keep
  // working-tree-removed-but-still-tracked files queryable
  // (git ls-files surfaces them after `rm src/x.ts`; their
  // lstat fails ENOENT). Treating that as transient would mask
  // a normal edit/delete workflow.
  type StatSlot =
    | { entry: (typeof eligible)[number]; stat: Stats; outcome: 'ok' }
    | { entry: (typeof eligible)[number]; outcome: 'preserve' }
    | { entry: (typeof eligible)[number]; outcome: 'drop' };
  const stats: StatSlot[] = await Promise.all(
    eligible.map(async (e): Promise<StatSlot> => {
      try {
        return { entry: e, stat: await lstat(e.absPath), outcome: 'ok' };
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        return code === 'ENOENT'
          ? { entry: e, outcome: 'drop' }
          : { entry: e, outcome: 'preserve' };
      }
    }),
  );

  const results: WalkedFile[] = [];
  const seenPaths: string[] = [];
  for (const r of stats) {
    if (r.outcome === 'drop') {
      // File doesn't exist — let the prune remove its row.
      continue;
    }
    if (r.outcome === 'preserve') {
      seenPaths.push(r.entry.relPath);
      continue;
    }
    const { entry, stat: s } = r;
    // Symlinks / non-files / oversized: intentional drops. NOT
    // added to seenPaths so the prune deletes any leftover row
    // (e.g., a regular file replaced by a symlink should lose
    // its prior index row).
    if (s.isSymbolicLink()) continue;
    if (!s.isFile()) continue;
    if (s.size > maxFileSizeBytes) continue;
    seenPaths.push(entry.relPath);
    results.push({
      relPath: entry.relPath,
      absPath: entry.absPath,
      sizeBytes: s.size,
      mtimeMs: s.mtimeMs,
      language: entry.language,
    });
  }
  return { files: results, seenPaths, failedDirs };
};

// Run `git ls-files --cached --others --exclude-standard -z`
// in projectRoot. Returns the NUL-separated path list, or null
// when git fails (not a repo, no git binary, error).
//
// Output is repo-root-relative with forward slashes on every
// platform — matches our `relPath` contract.
const gitListFiles = (cwd: string): string[] | null => {
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(
      'git',
      ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      // 64 MiB maxBuffer covers monorepos with 100k+ paths. Default 1 MiB
      // would silently truncate output on large repos and we'd index a
      // partial slice. The buffer is freed as soon as parsing finishes.
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return null;
  }
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout.split('\0').filter((s) => s.length > 0);
};

// Manual recursive walk for non-git project roots. The full
// exclude check (Bun.Glob) still runs in walkProject's main
// loop; here we only short-circuit the descent for well-known
// noise dirs, since their subtrees can be massive
// (node_modules in a typical JS project = 50k-200k files).
//
// readdir failures on non-root directories are reported via
// `failedDirs` so the pipeline can preserve any prior index
// rows under that subtree — silently dropping would let a
// transient EACCES/ENOENT delete a whole subtree from the
// index. A failure on the root itself throws, since pre-flight
// stat already validated the root and a follow-up readdir
// error indicates a race we can't recover from without losing
// data.
const fallbackWalk = async (root: string): Promise<{ paths: string[]; failedDirs: string[] }> => {
  const out: string[] = [];
  const failedDirs: string[] = [];
  const stack: string[] = [''];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    const abs = dir === '' ? root : join(root, dir);
    let entries: Dirent[];
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (e) {
      if (dir === '') {
        // Pre-flight stat passed but readdir failed — race with
        // permissions change / FS unmount mid-walk. Treat as
        // catastrophic: throwing matches walkProject's pre-flight
        // contract (root failures don't masquerade as empty walks).
        throw new Error(
          `walkProject: failed to enumerate project root: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
      failedDirs.push(dir);
      continue;
    }
    for (const e of entries) {
      const rel = dir === '' ? e.name : `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (FAST_SKIP_DIRS.has(e.name)) continue;
        stack.push(rel);
      } else if (e.isFile()) {
        out.push(rel);
      }
      // Symlinks and other entry types intentionally skipped —
      // follow_symlinks=false is the spec default
      // (CODE_INDEX.md §8.2), and pipes/devices have no place
      // in a code index.
    }
  }
  return { paths: out, failedDirs };
};
