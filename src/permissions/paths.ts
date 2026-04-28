import { join } from 'node:path';

// Path discovery for the permission hierarchy (AGENTIC_CLI §8). Each
// layer points to a single permissions.yaml; absent files are simply
// skipped. The order here doesn't dictate precedence (that's the
// hierarchy resolver's job); these are just "where to look".
//
// XDG-style on Linux/Mac. Windows support is deferred — same shape as
// `src/storage/paths.ts` (storage uses the same XDG fallback).

export const ENTERPRISE_POLICY_PATH = '/etc/agent/permissions.yaml';

export const userPolicyPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.length > 0) {
    return join(xdg, 'agent', 'permissions.yaml');
  }
  const home = env.HOME ?? '';
  return join(home, '.config', 'agent', 'permissions.yaml');
};

export const projectPolicyPath = (cwd: string): string => join(cwd, '.agent', 'permissions.yaml');
