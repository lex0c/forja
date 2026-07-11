// Per-project `.forja/config.toml` path resolvers (currently
// consumed by memory governance, providers, budget
// loaders). Path-resolution plumbing centralized in
// `src/config/agent-paths.ts` so the XDG / HOME / Windows
// APPDATA / USERPROFILE / PROGRAMDATA dance is shared across
// every operator-facing artifact (config.toml, permissions.yaml,
// hooks.toml, install_id). Pre-consolidation this file only
// handled XDG + POSIX HOME — Windows users without explicit
// XDG_CONFIG_HOME silently missed the user-layer config.toml.

import { projectAgentPath, userAgentPath } from './agent-paths.ts';

// User-layer path for `~/.config/forja/config.toml` (or the
// platform/XDG equivalent). Returns null on a stripped-down env
// where no absolute root can be derived; the loaders treat null as
// "no user file" and proceed with project-only resolution.
export const userConfigPath = (env: NodeJS.ProcessEnv = process.env): string | null =>
  userAgentPath('config.toml', env);

// Project-layer path. Always derivable from cwd; loader treats
// absent file as empty layer.
export const projectConfigPath = (cwd: string): string => projectAgentPath(cwd, 'config.toml');
