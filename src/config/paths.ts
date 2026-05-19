// Shared config-file path resolvers for `.agent/config.toml` consumers
// (currently critique, memory, providers, budget — and any future
// loader that targets the same per-project TOML).
//
// Why this lives in `src/config/` and not next to a specific
// consumer: with four loaders (and counting) all reading the SAME
// file via the SAME path resolution, leaving the helpers under
// `critique/` made the import graph awkward (memory/providers/budget
// reach into critique's surface for plumbing they don't conceptually
// own). The cross-consumer re-export from critique/config-loader.ts
// stays in place for backward-compat with existing import sites.

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

// User-layer path. XDG_CONFIG_HOME wins when set + absolute, else
// `$HOME/.config`. Returns null on a stripped-down env where neither
// yields a usable absolute path (containers, CI workers with $HOME
// unset); the loaders treat null as "no user file" and proceed with
// project-only resolution.
//
// Non-absolute XDG_CONFIG_HOME is treated as if unset — a relative
// value could shadow user files via path traversal (security:
// `XDG_CONFIG_HOME=../../some/path` should not redirect lookups).
export const userConfigPath = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.length > 0 && isAbsolute(xdg)) {
    return join(xdg, 'agent', 'config.toml');
  }
  const home = env.HOME ?? homedir();
  if (home.length === 0 || !isAbsolute(home)) return null;
  return join(home, '.config', 'agent', 'config.toml');
};

// Project-layer path. Always derivable from cwd; loaders treat
// absent file as empty layer.
export const projectConfigPath = (cwd: string): string => join(cwd, '.agent', 'config.toml');
