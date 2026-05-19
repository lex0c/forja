// Path discovery for the permission hierarchy. Each layer points
// to a single permissions.yaml; absent files are simply skipped.
// The order here doesn't dictate precedence (that's the hierarchy
// resolver's job); these are just "where to look".
//
// The XDG / HOME / Windows APPDATA / PROGRAMDATA plumbing was
// extracted to `src/config/agent-paths.ts` so the same defensive
// envvar handling (absolute-path check, null-on-stripped-env) is
// shared across permissions, hooks, config.toml, and install_id.
// This file now owns ONLY the "permissions.yaml" filename
// mapping; behavior is unchanged for every caller.

import { enterpriseAgentPath, projectAgentPath, userAgentPath } from '../config/agent-paths.ts';

// Enterprise-installed policy. Linux/macOS: well-known /etc path.
// Windows: %PROGRAMDATA%\agent\permissions.yaml.
export const enterprisePolicyPath = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null => enterpriseAgentPath('permissions.yaml', env, platform);

// User-scope policy path. Returns null when no absolute home-rooted
// path can be derived (stripped-down env, container without $HOME).
export const userPolicyPath = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null => userAgentPath('permissions.yaml', env, platform);

// Path to the per-installation identity file. Same parent as the
// user policy file so a fresh install lands the install_id in the
// same dir the operator's policy lives in. Mode 0600 enforced by
// the writer (`install_id.ts`); this function only computes the
// path. Returns null when no home-rooted config dir is available —
// caller (`ensureInstallId`) treats that as a fatal bootstrap
// error, since the audit chain genesis derives from install_id.
//
// Shares `userAgentPath`'s root resolution with `userPolicyPath`
// above, so install_id and permissions.yaml land in the SAME
// parent — single source of truth keeps the two from drifting.
export const installIdPath = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null => userAgentPath('install_id', env, platform);

export const projectPolicyPath = (cwd: string): string => projectAgentPath(cwd, 'permissions.yaml');
