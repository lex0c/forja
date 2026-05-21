import { join, posix, resolve, sep, win32 } from 'node:path';
import { agentConfigDir } from '../config/agent-paths.ts';
import { validateName } from './frontmatter.ts';
import type { SkillScope } from './types.ts';

// Scope path resolver + write sandbox for the skills subsystem
// (spec SKILLS.md §3).
//
// §3.1–3.3 define three scopes for v1: user (global per machine),
// project_shared (committed), project_local (gitignored). This
// module maps (scope, repoRoot) → absolute filesystem root and
// enforces the sandbox: a resolved skill path must sit strictly
// under its scope root, and the `name` must pass `validateName`
// (no path separators, no `..`, no leading dot) before joining.
//
// The `imported` scope (§3.4) is v2 — not modeled here.
//
// Repo-root resolution (`git rev-parse --show-toplevel`) is the
// CALLER's job: bootstrap already resolves it once for the memory
// subsystem and hands the same `repoRoot` here, so skills add no
// second git spawn and introduce no skills→memory coupling.

export class ScopeError extends Error {
  override readonly name = 'ScopeError';
}

// The user-scope root can be UNRESOLVABLE: `agentConfigDir` returns
// null on a stripped-down env with no derivable home (containers,
// CI workers with no `$HOME`) rather than fall back to a cwd-
// relative path. `null` here means "the user scope is unavailable
// this run" — the loader skips it and only the project scopes
// contribute. The project roots always resolve from the caller-
// supplied `repoRoot`.
export interface SkillScopeRoots {
  user: string | null;
  projectShared: string;
  projectLocal: string;
}

const pathMod = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);

// User-scope root: `<agent config dir>/skills` (spec §3.1
// `~/.config/agent/skills/`). The config-root resolution delegates
// to `config/agent-paths.ts:agentConfigDir` — the codebase's single
// source of truth for the XDG / Windows `APPDATA` dance. Hand-
// rolling that resolution (as an earlier draft of this file did) is
// exactly the multi-copy drift `agent-paths.ts` was created to end,
// and the copies it replaced silently missed Windows user paths.
// Returns null when no absolute config root exists (`agentConfigDir`
// contract): callers treat null as "no user scope", never as a
// cwd-relative fallback.
export const userScopeRoot = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  const configDir = agentConfigDir(env, platform);
  return configDir === null ? null : pathMod(platform).join(configDir, 'skills');
};

// Project-scope roots, derived from the absolute repo root. Spec
// §3.2/§3.3: shared lives in `.agent/skills/shared/` (versioned),
// local in `.agent/skills/local/` (gitignored). When the agent runs
// outside a git repo, the caller passes the cwd itself as `repoRoot`.
export const projectScopeRoots = (repoRoot: string): { shared: string; local: string } => ({
  shared: join(repoRoot, '.agent', 'skills', 'shared'),
  local: join(repoRoot, '.agent', 'skills', 'local'),
});

export const resolveScopeRoots = (
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SkillScopeRoots => {
  const project = projectScopeRoots(repoRoot);
  return {
    user: userScopeRoot(env, platform),
    projectShared: project.shared,
    projectLocal: project.local,
  };
};

// Pick a scope's root directory, or null when the scope is
// unavailable — only the user scope can be null (see
// `SkillScopeRoots`). Returns the un-resolved root verbatim;
// `skillFilePath` resolves it right before the sandbox check.
export const rootForScope = (roots: SkillScopeRoots, scope: SkillScope): string | null => {
  switch (scope) {
    case 'user':
      return roots.user;
    case 'project_shared':
      return roots.projectShared;
    case 'project_local':
      return roots.projectLocal;
  }
};

// Strict prefix check on already-normalized absolute paths. The
// `sep` append stops a root of `/a/skills` from accepting paths
// under `/a/skills2/`. The candidate must NOT equal the root — a
// skill file is never the directory itself. Symlink defense is not
// this layer's job: `resolve()` is pure path-shape normalization
// (collapses `..`/`.`), not `realpathSync`; the loader lstat-refuses
// symlinks at read time.
const isUnderRoot = (candidate: string, root: string): boolean => {
  if (candidate === root) return false;
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(rootWithSep);
};

// Absolute path of a skill `name` in `scope`: `<root>/<name>.md`.
// Throws `ScopeError` when the scope has no root (the user scope on
// a homeless env). `name` is validated first — `validateName`
// already makes a traversal name (a `/`, a `..`, a leading dot)
// structurally impossible, so the `isUnderRoot` re-check below is
// pure defense-in-depth: it is unreachable with the current
// `NAME_RE` and exists only to fail closed if that regex regresses.
export const skillFilePath = (roots: SkillScopeRoots, scope: SkillScope, name: string): string => {
  validateName(name);
  const root = rootForScope(roots, scope);
  if (root === null) {
    throw new ScopeError(`skill scope ${scope} has no root (no home directory derivable)`);
  }
  const resolvedRoot = resolve(root);
  const candidate = resolve(join(resolvedRoot, `${name}.md`));
  if (!isUnderRoot(candidate, resolvedRoot)) {
    throw new ScopeError(
      `skill path escapes scope root: name=${JSON.stringify(name)} scope=${scope}`,
    );
  }
  return candidate;
};
