// Pre-spawn validator for subagent worktrees (spec §8.4 / §11.2).
// Runs after `git worktree add` but before the child gets `cwd`,
// so any unsafe state in the checked-out tree fails the run loud
// instead of letting the child resolve a malicious symlink at
// read time. Two rails enforced here:
//
//   1. **Symlink boundary.** Every symlink in the worktree is
//      resolved via realpath; if the target is outside the
//      worktree root, the slice rejects spawn with a structured
//      error. The realpath probe also catches symlinks whose
//      target doesn't exist (broken / dangling) and symlink
//      cycles — both treated as rejection because we can't prove
//      safety.
//
//   2. **Sensitive path filter.** Files matching the canonical
//      deny-list (§8.4) are deleted from the worktree before
//      spawn. Sensitive *directories* (those whose contents
//      would match the deny-list, e.g. `.ssh/**`) are removed
//      recursively. The child never sees them, so the read /
//      write tools' own §8.4 enforcement (point 1 and 2 of the
//      spec) can stay focused on paths the child explicitly
//      requests rather than racing with eager filesystem scans.
//
// Throws are the only failure path. Callers (createWorktree)
// translate them into rollback + a `worktree_create_failed`
// outcome on the run envelope. Returning a "validation report"
// with errors-as-data was rejected: a worktree with an unsafe
// symlink should not produce a child run, period; making the
// caller remember to check a flag invites accidental spawn.
//
// The walk is a TWO-PASS design:
//
//   - Pass 1 (`validateSymlinks`) — resolve and boundary-check
//     every symlink while the tree is still intact. No deletions
//     happen here.
//   - Pass 2 (`filterDenyList`) — delete deny-listed files,
//     sensitive directories, AND symlinks whose NAME matches
//     the deny-list (the resolved target is irrelevant: a child
//     reading by path gets the resolved bytes, so a `.env`
//     symlink is just as sensitive as a `.env` file regardless
//     of where it points).
//
// One-pass mixing the boundary check with deletion would be
// order-dependent: a repo that committed both `.env` and a
// symlink `link -> .env` would fail or pass spawn based purely
// on `readdirSync` iteration order (if `.env` is deleted first,
// `realpath(link)` ENOENTs and the validator throws
// `symlink_unresolvable`; if `link` is iterated first, realpath
// succeeds and the spawn proceeds). The two-pass order is
// deterministic: every symlink is validated before any file is
// removed, so a symlink pointing at a soon-to-be-deleted
// deny-listed target is allowed during validation. After the
// deletion the symlink dangles, but the child can't follow it
// (ENOENT at read time) — security is preserved without
// introducing spurious spawn failures on legitimate repos.

import { type Dirent, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { SENSITIVE_PATH_DENY_LIST, matchSensitivePath } from './sensitive-paths.ts';

export interface ValidateWorktreeOptions {
  // Absolute path to the worktree root. Must exist; this module
  // doesn't create or chmod, only reads + selectively deletes.
  worktreePath: string;
  // Override deny-list patterns. Tests use this to exercise the
  // walker without depending on the canonical set; production
  // never overrides.
  denyListPatterns?: readonly string[];
}

export interface ValidationResult {
  // Files / directories deleted because they (or their contents)
  // matched the deny-list. Relative to `worktreePath`, posix
  // separators. The pattern that triggered the deletion is kept
  // for diagnostics and future audit-row enrichment.
  deniedRemoved: { path: string; pattern: string }[];
  // Number of symlinks observed and accepted (target stayed
  // inside the worktree boundary). Surfaced for visibility — a
  // worktree with hundreds of in-bounds symlinks is unusual and
  // worth an operator's attention even if individually safe.
  symlinksAllowed: number;
}

export class WorktreeValidationError extends Error {
  // Discriminator for callers that want to distinguish "validator
  // rejected something" from a generic Error. createWorktree maps
  // either to the same rollback path, but downstream telemetry
  // benefits from the structured shape.
  readonly code: 'symlink_escapes_worktree' | 'symlink_unresolvable' | 'walk_failed';
  // Path that caused the failure, relative to worktree root.
  // Useful in the error message; the caller's audit insert can
  // also surface it.
  readonly path: string;
  constructor(code: WorktreeValidationError['code'], path: string, message: string) {
    super(message);
    this.name = 'WorktreeValidationError';
    this.code = code;
    this.path = path;
  }
}

// Probe whether the deny-list considers `<dirRel>` a sensitive
// directory — i.e., would any file inside this dir match the
// deny-list. We synthesize a probe filename that's unlikely to
// match anything specific (`_probe`), append it as a child of
// the directory, and ask the matcher. Patterns like `.ssh/**`
// trip on `.ssh/_probe`; patterns like `**/credentials*.json`
// don't (they target files of a specific name, not a directory's
// contents wholesale), so those still get caught file-by-file in
// the regular walk. This split keeps "delete the whole tree" as
// the response only when the spec literally says the directory
// is sensitive.
const isSensitiveDirectory = (dirRel: string, patterns: readonly string[]): string | null =>
  matchSensitivePath(`${dirRel}/_probe`, patterns);

// Posix-normalize a relative path. The walker stitches paths via
// `${rel}/${name}` directly so we don't need full join semantics
// here, but we do strip platform separators so the matcher (which
// expects posix slashes) gets a clean input.
const toPosix = (p: string): string => p.split(sep).join('/');

// Determine whether `target` is `worktreeReal` or a descendant.
// Both inputs MUST already be canonical (realpath'd). The check
// is byte-prefix on `worktreeReal + sep` to avoid the classic
// `/foo/bar` vs `/foo/bar2` confusion: a target of `/foo/bar2`
// must NOT count as inside `/foo/bar`. The equality branch
// covers the rare case of a symlink to the worktree root itself.
const isInsideWorktree = (target: string, worktreeReal: string): boolean => {
  if (target === worktreeReal) return true;
  return target.startsWith(worktreeReal + sep);
};

export const validateWorktreeContents = (opts: ValidateWorktreeOptions): ValidationResult => {
  const { worktreePath } = opts;
  const patterns = opts.denyListPatterns ?? SENSITIVE_PATH_DENY_LIST;
  // Realpath the worktree root once: the boundary check on every
  // symlink target is a string-prefix on this canonical form, so
  // resolving once is correct (and faster) than per-symlink.
  // realpath also collapses any redundant symlinks the cache root
  // itself might have (e.g. a tmpfs mount via a symlink).
  let worktreeReal: string;
  try {
    worktreeReal = realpathSync(worktreePath);
  } catch (e) {
    throw new WorktreeValidationError(
      'walk_failed',
      '',
      `worktree root '${worktreePath}' could not be resolved: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const deniedRemoved: { path: string; pattern: string }[] = [];
  let symlinksAllowed = 0;

  // Shared per-directory readdir helper. The two passes both walk
  // the same structure; centralizing the read+error shape keeps
  // them in lockstep and the error code consistent.
  // We `readdirSync` per directory rather than using the
  // `recursive: true` option because we need
  //   (a) per-entry symlink detection (the recursive form follows
  //       directory symlinks silently — a symlink-as-dir attack
  //       would walk straight out of the worktree before we ever
  //       inspect it), and
  //   (b) the option to skip a subtree (sensitive dir in pass 2)
  //       without partially iterating it.
  const readDir = (relDir: string): Dirent<string>[] => {
    const absDir = relDir === '' ? worktreeReal : join(worktreeReal, relDir);
    try {
      return readdirSync(absDir, { withFileTypes: true });
    } catch (e) {
      throw new WorktreeValidationError(
        'walk_failed',
        relDir,
        `failed to read worktree directory '${relDir || '.'}': ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  // Pass 1: validate every symlink against the worktree boundary
  // while the tree is still intact. No deletions; recursion enters
  // every regular subdirectory (we don't shortcut on sensitive
  // directories here because a malicious symlink committed *inside*
  // `.ssh/` should still surface a clear error rather than be
  // silently swallowed by pass-2 directory removal). Sensitive
  // *directories themselves* don't escape validation either — they
  // get caught by pass 2; if a symlink-as-directory pointed inside
  // such a dir, pass 1 already accepted it and the dangling
  // outcome after pass 2 is harmless (child can't traverse).
  const validateSymlinks = (relDir: string): void => {
    const entries = readDir(relDir);
    for (const entry of entries) {
      const name = entry.name;
      // Skip the git plumbing pointer. In a linked worktree
      // (`git worktree add` output), `.git` is a FILE pointing
      // at the admin dir under the parent repo. We never want
      // to recurse, validate, or filter it: nothing under it
      // belongs to the user's tracked tree, and it's the parent
      // repo's responsibility to keep the admin dir clean.
      if (name === '.git') continue;
      const relPath = relDir === '' ? name : `${relDir}/${name}`;
      const absPath = join(relDir === '' ? worktreeReal : join(worktreeReal, relDir), name);

      if (entry.isSymbolicLink()) {
        // realpath resolves the chain transitively. Any failure
        // (broken target, cycle, permission denied) is rejection:
        // we can't prove the target is safe.
        let target: string;
        try {
          target = realpathSync(absPath);
        } catch (e) {
          throw new WorktreeValidationError(
            'symlink_unresolvable',
            toPosix(relPath),
            `symlink '${toPosix(relPath)}' could not be resolved (broken, cyclic, or inaccessible): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        if (!isInsideWorktree(target, worktreeReal)) {
          // Resolved target is intentionally NOT inlined into
          // the message: it's the host-side path of the secret
          // the symlink was trying to read, and an error that
          // bubbles up to logs / audit / telemetry shouldn't
          // leak it. The operator has the symlink path in
          // `error.path` and full FS access to `readlink` it
          // themselves if forensic investigation is needed.
          // Spec §6 redaction principle applied defensively
          // even though the validator's caller doesn't currently
          // log the message.
          throw new WorktreeValidationError(
            'symlink_escapes_worktree',
            toPosix(relPath),
            `symlink '${toPosix(relPath)}' resolves outside the worktree boundary (defense in depth — see SECURITY_GUIDELINE.md §8.4)`,
          );
        }
        symlinksAllowed += 1;
        continue;
      }
      if (entry.isDirectory()) {
        validateSymlinks(relPath);
      }
      // Regular files / sockets / FIFOs: nothing to validate in
      // pass 1.
    }
  };

  // Pass 2: delete deny-listed files and sensitive directories.
  // Symlinks whose TARGET escapes the boundary were already
  // rejected by pass 1; symlinks whose target stays inside are
  // valid for boundary purposes but their NAMES still need a
  // deny-list check here — otherwise a committed `.env -> secrets.txt`
  // bypasses the filter (boundary OK, name never inspected, child
  // reads `.env` and gets the secret content).
  //
  // For symlinks the deletion target is the symlink ENTRY, not
  // the resolved file: the resolved file lives elsewhere in the
  // worktree and gets evaluated by the walker on its own. We
  // never recurse THROUGH a symlink in pass 2 — sensitive
  // directories that are themselves symlinks get the symlink
  // entry removed, and the underlying directory (which may or
  // may not have a sensitive name itself) is processed when the
  // walker reaches it as a regular dir.
  const filterDenyList = (relDir: string): void => {
    const entries = readDir(relDir);
    for (const entry of entries) {
      const name = entry.name;
      if (name === '.git') continue;
      const relPath = relDir === '' ? name : `${relDir}/${name}`;
      const absPath = join(relDir === '' ? worktreeReal : join(worktreeReal, relDir), name);

      if (entry.isSymbolicLink()) {
        // Match the symlink's name against the deny-list as if
        // it were a regular file (`.env` symlink → file pattern
        // `.env`) AND as a potential sensitive directory (`.ssh`
        // symlink → directory pattern `.ssh/**` via the probe).
        // Either trip removes the symlink itself; the target is
        // not resolved here (pass 1 already proved boundary
        // safety, and the resolved target — if inside the
        // worktree — is processed by the walker independently).
        const fileMatch = matchSensitivePath(toPosix(relPath), patterns);
        const dirMatch =
          fileMatch === null ? isSensitiveDirectory(toPosix(relPath), patterns) : null;
        const matched = fileMatch ?? dirMatch;
        if (matched !== null) {
          try {
            // `force: true` swallows ENOENT (in case some other
            // pass already removed it); `recursive: false` is the
            // default and matters here — `rmSync` on a symlink
            // unlinks the symlink entry without following it,
            // which is exactly the semantic we want even when
            // the symlink targets a directory.
            rmSync(absPath, { force: true });
          } catch (e) {
            throw new WorktreeValidationError(
              'walk_failed',
              toPosix(relPath),
              `failed to remove deny-listed symlink '${toPosix(relPath)}': ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          deniedRemoved.push({ path: toPosix(relPath), pattern: matched });
        }
        continue;
      }

      if (entry.isDirectory()) {
        // Directories whose contents are wholesale sensitive
        // (`.ssh/**`, `.gnupg/**`) get removed without
        // recursion. This is both faster and more honest than
        // walking in to delete each file: if the spec says the
        // whole dir is sensitive, an empty-but-present `.ssh/`
        // would still be a confusing leftover.
        const dirPattern = isSensitiveDirectory(toPosix(relPath), patterns);
        if (dirPattern !== null) {
          try {
            rmSync(absPath, { recursive: true, force: true });
          } catch (e) {
            throw new WorktreeValidationError(
              'walk_failed',
              toPosix(relPath),
              `failed to remove sensitive directory '${toPosix(relPath)}': ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          deniedRemoved.push({ path: toPosix(relPath), pattern: dirPattern });
          continue;
        }
        filterDenyList(relPath);
        continue;
      }

      if (entry.isFile()) {
        const matchedPattern = matchSensitivePath(toPosix(relPath), patterns);
        if (matchedPattern !== null) {
          try {
            rmSync(absPath, { force: true });
          } catch (e) {
            throw new WorktreeValidationError(
              'walk_failed',
              toPosix(relPath),
              `failed to remove deny-listed file '${toPosix(relPath)}': ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          deniedRemoved.push({ path: toPosix(relPath), pattern: matchedPattern });
        }
      }

      // Sockets, FIFOs, devices, etc. Not expected in a git
      // checkout (git stores blobs, not special files) but if
      // one shows up we treat it like a no-op and let the child
      // hit it through normal tool calls if it actually matters.
    }
  };

  validateSymlinks('');
  filterDenyList('');
  return { deniedRemoved, symlinksAllowed };
};

// Re-export so callers depending on the validator don't also
// have to import sensitive-paths. The matcher and constant stay
// in their own module for read/write tool consumers (§8.4 points
// 1 and 2) that don't need the worktree walker.
export { SENSITIVE_PATH_DENY_LIST, matchSensitivePath };
