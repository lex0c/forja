import { homedir } from 'node:os';
import { isAbsolute, join, win32 as winPath } from 'node:path';

// Hook config file discovery (spec AGENTIC_CLI.md §10.2).
//
// Three layers, looked up at boot in execution-priority order
// (enterprise first):
//   1. enterprise: `/etc/agent/hooks.toml` (Linux/macOS) or
//      `%PROGRAMDATA%\agent\hooks.toml` (Windows). Locked rules
//      live here.
//   2. user:       `~/.config/agent/hooks.toml` per XDG_CONFIG_HOME
//      convention. Mirrors `userScopeRoot` in
//      `src/memory/paths.ts`.
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
// `memory/paths.ts:userScopeRoot`.

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
): string | null => {
  if (platform === 'win32') {
    const programData = env.PROGRAMDATA;
    // Use win32 path semantics for the absoluteness check —
    // when the test runtime is POSIX, `path.isAbsolute` rejects
    // `C:\\ProgramData` (no `/` prefix) but it IS a valid
    // absolute Windows path. The platform arg already gates
    // the branch so reaching here means we WANT win32 rules.
    if (programData === undefined || programData.length === 0 || !winPath.isAbsolute(programData)) {
      return null;
    }
    // Same reason for `winPath.join` — keeps backslash
    // separators when building on a POSIX test runtime that
    // simulates Windows paths.
    return winPath.join(programData, 'agent', 'hooks.toml');
  }
  return '/etc/agent/hooks.toml';
};

// User-layer path. Mirrors `memory/paths.ts:userScopeRoot` —
// honor `XDG_CONFIG_HOME` when set + absolute, fall back to
// `$HOME/.config`. Spec uses `~/.config/agent/hooks.toml`
// literally; this implementation respects XDG so dotfile
// managers / portable installs work.
//
// The `env` arg is the canonical source for HOME — using
// `os.homedir()` would ignore the parameter (it reads
// process.env at call time, not the passed-in dict), breaking
// tests that inject a fixture env. Falls back to homedir() only
// when env.HOME is missing AND XDG is missing (which on a
// real machine means we're on a stripped-down environment with
// no usual home; null is the right marker).
export const userHooksPath = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.length > 0 && isAbsolute(xdg)) {
    return join(xdg, 'agent', 'hooks.toml');
  }
  const home = env.HOME ?? homedir();
  if (home.length === 0 || !isAbsolute(home)) return null;
  return join(home, '.config', 'agent', 'hooks.toml');
};

// Project-layer path. Always derivable from the repo root; the
// loader treats absent file as empty layer.
export const projectHooksPath = (repoRoot: string): string =>
  join(repoRoot, '.agent', 'hooks.toml');

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
