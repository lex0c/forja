import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
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
// `~/.config/agent/memory/` e `./.agent/memory/`. Tentativa de
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

// User-scope root. Spec uses `~/.config/agent/memory/` literally;
// that path follows the XDG convention, so we honor
// `XDG_CONFIG_HOME` when set. Falls back to `~/.config` otherwise.
// We deliberately do NOT use XDG_DATA_HOME or the project's
// `defaultDataDir()` — memory is curated config, not generated
// data, and the spec's path is canonical.
export const userScopeRoot = (env: NodeJS.ProcessEnv = process.env): string => {
  const xdg = env.XDG_CONFIG_HOME;
  const base =
    xdg !== undefined && xdg.length > 0 && isAbsolute(xdg) ? xdg : join(homedir(), '.config');
  return join(base, 'agent', 'memory');
};

// Project-scope roots, derived from the current repo root. The
// caller passes the absolute repoRoot (resolved via
// `git rev-parse --show-toplevel` upstream) — this module does
// not run git. When the operator runs the agent outside any
// repo, the caller should pass the cwd itself; project memory
// then lives in the working directory's `.agent/memory/` tree
// just like sessions.db does today.
export const projectScopeRoots = (repoRoot: string): { shared: string; local: string } => ({
  shared: join(repoRoot, '.agent', 'memory', 'shared'),
  local: join(repoRoot, '.agent', 'memory', 'local'),
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
// that a non-canonical caller-supplied root (e.g. `/repo/.agent/..`)
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
  // (e.g. `/repo/.agent/..`); without resolving the root, the
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
