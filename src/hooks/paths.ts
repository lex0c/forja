// Hook config file discovery (spec AGENTIC_CLI.md §10.2).
//
// Three layers, looked up at boot in execution-priority order
// (enterprise first):
//   1. enterprise: `/etc/agent/hooks.toml` (Linux/macOS) or
//      `%PROGRAMDATA%\agent\hooks.toml` (Windows). Locked rules
//      live here.
//   2. user:       `~/.config/agent/hooks.toml` per XDG_CONFIG_HOME
//      convention. Now ALSO honors Windows APPDATA / USERPROFILE
//      via the shared agent-paths helper — pre-consolidation this
//      file only handled POSIX, leaving Windows users without
//      XDG_CONFIG_HOME silently missing the user layer.
//   3. project:    `<repo>/.agent/hooks.toml`. Tracked by git
//      (operator decides what to commit; locked-shared semantics
//      land if/when team-shared trust storage matures).
//
// Discovery returns paths verbatim — they may not exist; the
// loader treats absent files as empty layers (zero hooks). This
// matches `permissions/hierarchy.ts` LayerInput shape.
//
// SECURITY CONTRACT: paths derived from env-vars are validated
// (`isAbsolute`) before use. A user setting
// `XDG_CONFIG_HOME=../etc` would otherwise let a project file
// shadow the enterprise layer. The same defense lives in
// `memory/paths.ts:userScopeRoot`. Plumbing centralized in
// `src/config/agent-paths.ts` post-consolidation.

import { enterpriseAgentPath, projectAgentPath, userAgentPath } from '../config/agent-paths.ts';

export interface HookConfigPaths {
  enterprise: string | null;
  user: string | null;
  project: string;
}

// Enterprise path. POSIX hardcodes /etc; Windows uses
// %PROGRAMDATA% (typically `C:\ProgramData`). Returns null when
// the platform's expected env var is missing — operator running
// agent on a stripped-down system without the standard
// directories falls through to user/project layers only.
export const enterpriseHooksPath = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null => enterpriseAgentPath('hooks.toml', env, platform);

// User-layer path. Honors XDG_CONFIG_HOME first, then
// platform-specific roots (Windows APPDATA / USERPROFILE; POSIX
// HOME/.config). Returns null on a stripped-down env where no
// absolute root can be derived — caller treats null as "user
// layer unavailable" rather than producing a relative path that
// would resolve against cwd (path-traversal defense documented
// in `agent-paths.ts:agentConfigDir`).
export const userHooksPath = (env: NodeJS.ProcessEnv = process.env): string | null =>
  userAgentPath('hooks.toml', env);

// Project-layer path. Always derivable from the repo root; the
// loader treats absent file as empty layer.
export const projectHooksPath = (repoRoot: string): string =>
  projectAgentPath(repoRoot, 'hooks.toml');

// Resolve all three layer paths for a session. `repoRoot` is the
// caller's responsibility to compute (typically via
// `resolveRepoRoot` in `src/memory/paths.ts`); we don't run git
// here to keep the module pure / sync.
export const resolveHookPaths = (
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): HookConfigPaths => ({
  enterprise: enterpriseHooksPath(env, platform),
  user: userHooksPath(env),
  project: projectHooksPath(repoRoot),
});
