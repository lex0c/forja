import { isAbsolute, join } from 'node:path';

// Path discovery for the permission hierarchy (AGENTIC_CLI §8). Each
// layer points to a single permissions.yaml; absent files are simply
// skipped. The order here doesn't dictate precedence (that's the
// hierarchy resolver's job); these are just "where to look".
//
// XDG-style on Linux/Mac. Windows support is deferred — same shape as
// `src/storage/paths.ts` (storage uses the same XDG fallback).

export const ENTERPRISE_POLICY_PATH = '/etc/agent/permissions.yaml';

// Return null when no absolute home-rooted path can be derived. The
// resolver treats null as "user layer unavailable" and skips it
// entirely. Critical defensive measure: a fallback like
// `join('', '.config', ...)` would produce a relative path, which
// `existsSync` checks against the current working directory — a
// repo with `.config/agent/permissions.yaml` would silently
// override user layer with project-local content. Same problem
// applies to relative XDG_CONFIG_HOME values (XDG spec says they
// must be absolute or be treated as unset).
export const userPolicyPath = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.length > 0 && isAbsolute(xdg)) {
    return join(xdg, 'agent', 'permissions.yaml');
  }
  const home = env.HOME;
  if (home === undefined || home.length === 0 || !isAbsolute(home)) return null;
  return join(home, '.config', 'agent', 'permissions.yaml');
};

export const projectPolicyPath = (cwd: string): string => join(cwd, '.agent', 'permissions.yaml');
