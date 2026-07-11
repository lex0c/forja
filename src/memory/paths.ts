import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { appDirName, projectDirName } from '../config/app-namespace.ts';
import { getGitBinarySync, safeGitEnv } from '../subagents/git-binary.ts';
import { validateName } from './frontmatter.ts';
import type { MemoryScope } from './types.ts';

// Scope path resolver + write sandbox.
//
// Spec §2 defines three scopes — user (global), project_shared
// (versioned), project_local (gitignored). This module owns the
// mapping from (scope, repoRoot) → absolute filesystem root, and
// the inverse mapping (absolute path → MemoryScope) used by the
// sandbox.
//
// Sandbox rule (spec §7.2 mitigation 6): "memória escrita só em
// `~/.config/forja/memory/` e `./.forja/memory/`. Tentativa de
// path traversal = erro fatal + audit." We enforce two layers:
//
//   1. The `name` parameter must pass frontmatter.validateName —
//      no path separators, no `..`, no leading dot. This blocks
//      99% of attacks before path joining.
//
//   2. After joining, we re-resolve the path and verify it sits
//      strictly under the scope root. This catches any future
//      regression (e.g. a name validator that accidentally
//      allows `%2e%2e`) and any operator override of the scope
//      root that sneaks in a symlink.

export class ScopeError extends Error {
  override readonly name = 'ScopeError';
}

export interface ScopeRoots {
  user: string;
  projectShared: string;
  projectLocal: string;
}

// Resolve the repo root for a given cwd via
// `git rev-parse --show-toplevel`. Returns the cwd unchanged when
// the cwd isn't inside a git working tree (or git itself is
// missing) — in that case the operator's invocation cwd IS the
// project anchor. Sync because bootstrap is sync; the spawn cost
// is one-shot per session and dominated by SQLite migrate.
//
// Why we need this: project memory is per-REPO, not per-cwd. An
// operator invoking `forja` from `src/components/` inside a
// repo at `/repo` must still see memories at
// `/repo/.forja/memory/{shared,local}/` — without resolving the
// repo root, we'd look under `/repo/src/components/.forja/...`
// (which doesn't exist) and silently miss every project memory.
// The user scope is unaffected because it lives outside the repo
// (at `~/.config/forja/memory/` or `$XDG_CONFIG_HOME/forja/memory/`).
export const resolveRepoRoot = (cwd: string): string => {
  try {
    // Pinned git binary + canonical PATH (slice 178 hardening C2).
    // Spawned sync because resolveRepoRoot is called during bootstrap
    // before the event loop owns dispatching.
    const git = getGitBinarySync();
    const proc = Bun.spawnSync({
      cmd: [git, '-C', cwd, 'rev-parse', '--show-toplevel'],
      env: safeGitEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) return cwd;
    const trimmed = proc.stdout.toString().trim();
    return trimmed.length === 0 ? cwd : trimmed;
  } catch {
    // git binary missing or spawn failure. Fall back to cwd —
    // operator running outside a repo gets per-cwd memory which
    // is the same fallback behavior `resolveScopeRoots` had
    // before this helper existed.
    return cwd;
  }
};

// User-scope root. Spec uses `~/.config/forja/memory/` literally;
// that path follows the XDG convention, so we honor
// `XDG_CONFIG_HOME` when set. Falls back to `~/.config` otherwise.
// We deliberately do NOT use XDG_DATA_HOME or the project's
// `defaultDataDir()` — memory is curated config, not generated
// data, and the spec's path is canonical.
export const userScopeRoot = (env: NodeJS.ProcessEnv = process.env): string => {
  const xdg = env.XDG_CONFIG_HOME;
  const base =
    xdg !== undefined && xdg.length > 0 && isAbsolute(xdg) ? xdg : join(homedir(), '.config');
  return join(base, appDirName(env), 'memory');
};

// Project-scope roots, derived from the current repo root. The
// caller passes the absolute repoRoot (resolved via
// `git rev-parse --show-toplevel` upstream) — this module does
// not run git. When the operator runs the agent outside any
// repo, the caller should pass the cwd itself; project memory
// then lives in the working directory's `.forja/memory/` tree
// just like sessions.db does today.
export const projectScopeRoots = (repoRoot: string): { shared: string; local: string } => ({
  shared: join(repoRoot, projectDirName(), 'memory', 'shared'),
  local: join(repoRoot, projectDirName(), 'memory', 'local'),
});

export const resolveScopeRoots = (
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ScopeRoots => {
  const project = projectScopeRoots(repoRoot);
  return {
    user: userScopeRoot(env),
    projectShared: project.shared,
    projectLocal: project.local,
  };
};

// Pick the scope's root directory. Exported for callers that need
// the directory itself (e.g. the loader's orphan walker, the writer's
// mkdirSync target) without going through memoryFilePath. Returns
// the un-resolved root verbatim — callers that need normalization
// must resolve themselves; in this module we resolve right before
// the sandbox check.
export const rootForScope = (roots: ScopeRoots, scope: MemoryScope): string => {
  switch (scope) {
    case 'user':
      return roots.user;
    case 'project_shared':
      return roots.projectShared;
    case 'project_local':
      return roots.projectLocal;
  }
};

// Strict prefix check on already-normalized absolute paths. We
// append `sep` so a root of `/cache` doesn't accept paths under
// `/cache2/`. The candidate must NOT equal the root itself (we
// never write at the root path; the file would BE the directory).
//
// Both inputs must be already path-normalized via `resolve()` so
// that a non-canonical caller-supplied root (e.g. `/repo/.forja/..`)
// doesn't break the prefix comparison against a normalized
// candidate. Callers in this module always do that before calling
// in.
//
// Symlink defense is NOT this layer's job — `resolve()` is pure
// path-shape normalization (collapses `..` and `.` segments), not
// `realpathSync`, so symlinks under the scope root would still
// appear "inside". The writer (5.3) is responsible for refusing
// to follow symlinks at write time, mirroring the worktree
// validator's two-pass walker (subagents/worktree.ts).
const isUnderRoot = (candidate: string, root: string): boolean => {
  if (candidate === root) return false;
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(rootWithSep);
};

// Build the absolute file path for a memory `name` in `scope`,
// validating both the name and the resulting path. The filename
// is `<name>.md` — no scope prefix, no per-type prefix. The spec
// examples (`feedback_commit_style.md`, `user_role.md`) suggest
// type-prefixed filenames; we keep that as a convention the
// human/operator can follow when picking the `name`, not a
// storage-layer enforcement. Forcing it would require the layer
// to read the frontmatter `type` to compute the path, creating a
// chicken-and-egg with the writer.
export const memoryFilePath = (roots: ScopeRoots, scope: MemoryScope, name: string): string => {
  validateName(name);
  // Normalize BOTH the root and the candidate before the prefix
  // check. The caller's repoRoot might be non-canonical
  // (e.g. `/repo/.forja/..`); without resolving the root, the
  // sandbox would reject a semantically-correct path because the
  // candidate (post-resolve) wouldn't share the unnormalized
  // prefix. Resolve also collapses any leftover `..`/`.` from a
  // hypothetical future regression in validateName.
  const resolvedRoot = resolve(rootForScope(roots, scope));
  const candidate = resolve(join(resolvedRoot, `${name}.md`));
  if (!isUnderRoot(candidate, resolvedRoot)) {
    throw new ScopeError(
      `memory path escapes scope root: name=${JSON.stringify(name)} scope=${scope}`,
    );
  }
  return candidate;
};

// Path of the per-scope MEMORY.md index file.
export const indexFilePath = (roots: ScopeRoots, scope: MemoryScope): string =>
  join(rootForScope(roots, scope), 'MEMORY.md');

// Seed layout (spec §5.7.4). Seeds live in a dedicated subdirectory
// `seeds/` under the user-scope root. They are NOT a separate
// MemoryScope value — `scopeOfPath` still returns 'user' for any
// path under `<user>/seeds/`, because seeds participate in the
// user scope's lifecycle (eager-load + UI listing + audit attribution
// against the operator's machine, not against a project). The
// subdir is purely a filesystem affordance so the vendor catalog
// can be installed/upgraded as a unit without entangling with the
// operator's hand-authored user memories.
//
// The slice-2 primitives below mirror the top-level helpers
// (memoryFilePath / indexFilePath / tombstonePath) so that callers
// touching seeds don't reimplement the sandbox check. Slice 3 used
// these to install the vendor catalog; slice 4 added the upgrade-
// hash primitives; slice 5b added `disabledSeedsPath` for the per-
// seed opt-out sentinel.
export const SEEDS_SUBDIR = 'seeds';

// Absolute path to `<user>/seeds/`. Callers that need to readdir or
// mkdir the directory itself (e.g. the catalog installer in slice
// 3) hit this; everything else goes through the typed helpers below.
export const seedsRoot = (roots: ScopeRoots): string => join(roots.user, SEEDS_SUBDIR);

// `<user>/seeds/<name>.md` with the same sandbox contract as
// `memoryFilePath`: validate the name first, then re-resolve to
// catch any future regression that lets a traversal slip past the
// name validator. The error type mirrors the parent (ScopeError)
// so callers can catch uniformly across top-level + seeds paths.
export const seedMemoryFilePath = (roots: ScopeRoots, name: string): string => {
  validateName(name);
  const resolvedRoot = resolve(seedsRoot(roots));
  const candidate = resolve(join(resolvedRoot, `${name}.md`));
  if (!isUnderRoot(candidate, resolvedRoot)) {
    throw new ScopeError(`seed path escapes seeds/ root: name=${JSON.stringify(name)}`);
  }
  return candidate;
};

// `<user>/seeds/MEMORY.md` — the seed catalog's own index file,
// kept separate from the user scope's MEMORY.md so the catalog can
// be regenerated on upgrade without disturbing operator-authored
// entries.
export const seedIndexFilePath = (roots: ScopeRoots): string => join(seedsRoot(roots), 'MEMORY.md');

// `<user>/seeds/.tombstones/` — eviction storage for seeds removed
// from the vendor catalog on upgrade (spec §5.7.5: removed seeds
// go to `seeds/archived/`, but the eviction lifecycle reuses the
// same tombstone semantics as the top-level user scope, so we
// land them under `.tombstones/` for parity with the rest of the
// subsystem. Slice 4 will additionally mirror these into
// `seeds/archived/` for the operator-visible archive surface
// described by the spec).
export const seedTombstonesDir = (roots: ScopeRoots): string =>
  join(seedsRoot(roots), '.tombstones');

// `<user>/seeds/.tombstones/<name>.<unix_ms>.md` — same shape as
// `tombstonePath`. Re-validates the name and applies the sandbox
// check; ts is trusted but parseTombstoneFilename rejects junk on
// the read side (shared with the rest of the subsystem).
export const seedTombstonePath = (roots: ScopeRoots, name: string, ts: number): string => {
  validateName(name);
  const resolvedRoot = resolve(seedTombstonesDir(roots));
  const candidate = resolve(join(resolvedRoot, `${name}.${ts}.md`));
  if (!isUnderRoot(candidate, resolvedRoot)) {
    throw new ScopeError(
      `seed tombstone path escapes seeds/ root: name=${JSON.stringify(name)} ts=${ts}`,
    );
  }
  return candidate;
};

// `<user>/seeds/.installed.json` — manifest of the last-installed
// {version, hash} per canonical seed. Owned by the upgrade
// lifecycle (spec §5.7.5): on each boot, the installer reads this
// to decide which seeds need write (fresh / vendor-bumped /
// user-edited) vs. skip (unchanged), and rewrites it at the end.
// Dot-prefixed so the seeds-subdir orphan walker (slice 2)
// silently ignores it — the manifest is agent-owned state, not a
// memory body.
export const seedManifestPath = (roots: ScopeRoots): string =>
  join(seedsRoot(roots), '.installed.json');

// `<user>/seeds/.disabled.json` — operator opt-out sentinel (spec
// §5.7.6). Persisted shape mirrors the install manifest's plain-JSON
// object: { "<seed-name>": { "disabled_at": "<ISO-8601>" }, ... }.
// Dot-prefixed so the seeds-subdir orphan walker silently ignores it
// (same rationale as the install manifest). Survives a vendor catalog
// bump (the installer honors the sentinel and routes the seed through
// the new `disabled` action instead of `vendor_updated`), so an
// operator's opt-out doesn't silently regress when the binary
// upgrades.
export const disabledSeedsPath = (roots: ScopeRoots): string =>
  join(seedsRoot(roots), '.disabled.json');

// `<user>/seeds/archived/` — destination for seeds the new vendor
// catalog dropped but the previous manifest still listed (spec
// §5.7.5: "Seeds removidas no novo catálogo viram
// seeds/archived/, não delete (reversível)."). Distinct from
// `.tombstones/` (which is the general memory-subsystem eviction
// store) because seed archival is a vendor-driven removal, not a
// state-machine eviction; keeping the two separate keeps the
// audit trail of each motivation legible.
export const seedArchivedDir = (roots: ScopeRoots): string => join(seedsRoot(roots), 'archived');

// `<user>/seeds/archived/<name>.<unix_ms>.md` — timestamped archive
// destination. The timestamp prevents the second archival of the
// same name from overwriting the first (which would break the spec's
// "reversível" promise: an operator's prior restore-and-edit cycle
// would be lost on the second vendor-side removal). Same filename
// shape as `tombstonePath` so `parseTombstoneFilename` can be reused
// when a future `/memory seeds restore <name>` slash command lands
// (slice 5+); the parser is shared across both eviction surfaces.
export const seedArchivedFilePath = (roots: ScopeRoots, name: string, ts: number): string => {
  validateName(name);
  const resolvedRoot = resolve(seedArchivedDir(roots));
  const candidate = resolve(join(resolvedRoot, `${name}.${ts}.md`));
  if (!isUnderRoot(candidate, resolvedRoot)) {
    throw new ScopeError(
      `seed archive path escapes archived/ root: name=${JSON.stringify(name)} ts=${ts}`,
    );
  }
  return candidate;
};

// `.tombstones/` directory inside a scope. Per MEMORY.md §6.5.3,
// every eviction moves the body file here (preserving the
// original frontmatter with `state: evicted`) so restore is a
// cheap rename and the retention window has a single GC root.
//
// User scope: `~/.config/forja/memory/.tombstones/` — fully out
// of any tree the operator might commit.
// Project shared: `./.forja/memory/shared/.tombstones/` —
// versioned in git (per §6.5.4) so eviction history is
// observable cross-team; restore-via-git works past the
// retention window.
// Project local: `./.forja/memory/local/.tombstones/` —
// gitignored by inheritance from the project default
// `.gitignore` entry `memory/local/` (a prefix match catches
// `memory/local/.tombstones/`). See MEMORY.md §2.5 for the
// default gitignore layout.
export const tombstonesDir = (roots: ScopeRoots, scope: MemoryScope): string =>
  join(rootForScope(roots, scope), '.tombstones');

// Tombstone file path for a (name, timestamp) pair. The filename
// shape is `<name>.<unix_ms>.md` — repeats of the same name in a
// single session (rare, but possible after a restore-then-evict
// cycle) get distinct files because `Date.now()` advances. Even
// when two evictions land in the same millisecond (test fixtures
// with `now` injection), the operator can disambiguate via
// `eviction_events.recorded_at` because each tombstone carries
// the timestamp in its filename.
//
// The name is re-validated as a frontmatter `name` to keep this
// path on the same sandbox surface as the main body file. ts is
// not validated beyond the type system — a caller that passes
// non-finite or negative timestamps gets a path with the
// stringified bad value (and parseTombstoneFilename rejects on
// the way back). We don't preempt that here because the only
// production caller computes ts from Date.now()/options.
export const tombstonePath = (
  roots: ScopeRoots,
  scope: MemoryScope,
  name: string,
  ts: number,
): string => {
  validateName(name);
  const resolvedRoot = resolve(tombstonesDir(roots, scope));
  const candidate = resolve(join(resolvedRoot, `${name}.${ts}.md`));
  if (!isUnderRoot(candidate, resolvedRoot)) {
    throw new ScopeError(
      `tombstone path escapes scope root: name=${JSON.stringify(name)} scope=${scope} ts=${ts}`,
    );
  }
  return candidate;
};

// Parse a tombstone filename back into (name, ts). Returns null
// for anything that doesn't match the canonical shape — that
// includes plain memory files (no embedded ts), index files
// (`MEMORY.md`), and operator-dropped junk. Listing code uses
// the null return as a filter on `readdir` output.
//
// Regex shape: `^<name>.<digits>.md$` with the standard
// validateName character class. ts is unsigned integer (no sign,
// no decimal, no exponent) — Date.now() values are positive
// integers up to ~year 287,000 in ms, so the 1..n digit window
// covers any realistic timestamp without overflow risk.
const TOMBSTONE_RE = /^([a-z0-9][a-z0-9_-]*)\.(\d+)\.md$/;
export const parseTombstoneFilename = (filename: string): { name: string; ts: number } | null => {
  const m = TOMBSTONE_RE.exec(filename);
  if (m === null) return null;
  const name = m[1];
  const tsStr = m[2];
  if (name === undefined || tsStr === undefined) return null;
  const ts = Number.parseInt(tsStr, 10);
  if (!Number.isFinite(ts) || ts < 0) return null;
  return { name, ts };
};

// Inverse mapping: given an absolute path, identify which scope
// (if any) owns it. Used by the audit + UI layers to render a
// memory's scope without re-deriving from name. Returns null
// when the path sits outside every scope root — the caller
// treats null as a sandbox violation when the path was supposed
// to be inside.
export const scopeOfPath = (roots: ScopeRoots, absolutePath: string): MemoryScope | null => {
  const resolved = resolve(absolutePath);
  // Resolve roots too so a non-canonical caller-supplied roots
  // object (e.g. `roots.user = '/x/agent/memory/'` with a trailing
  // slash, or paths assembled with `..` segments) compares
  // correctly against the resolved candidate.
  const resolvedLocal = resolve(roots.projectLocal);
  const resolvedShared = resolve(roots.projectShared);
  const resolvedUser = resolve(roots.user);
  if (isUnderRoot(resolved, resolvedLocal)) return 'project_local';
  if (isUnderRoot(resolved, resolvedShared)) return 'project_shared';
  if (isUnderRoot(resolved, resolvedUser)) return 'user';
  return null;
};
