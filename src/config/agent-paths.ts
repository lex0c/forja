// Shared filesystem-path resolvers for agent artifacts under the
// three operator-facing scopes (enterprise, user, project). Each
// subsystem (permissions, hooks, config.toml, install_id) had its
// own copy of the XDG / HOME / Windows APPDATA / PROGRAMDATA dance
// before this consolidation — four ~30-LOC implementations with
// slightly different completeness:
//
//   - `permissions/paths.ts` had the most thorough impl (XDG +
//     APPDATA + USERPROFILE\AppData\Roaming + HOME .config).
//   - `hooks/paths.ts` covered XDG + HOME .config + enterprise
//     PROGRAMDATA but MISSED Windows user paths (APPDATA /
//     USERPROFILE) — operator running `forja` on Windows without
//     XDG_CONFIG_HOME silently failed to find user hooks.
//   - `config/paths.ts` covered XDG + HOME but missed Windows
//     entirely — same latent bug as hooks for any windows user.
//
// Centralizing on the permissions shape closes both gaps. Each
// subsystem's existing public API (e.g., `userPolicyPath`,
// `userHooksPath`, `userConfigPath`) stays unchanged — they
// delegate here and append their own filename.
//
// Path-platform handling: every helper takes an explicit `platform`
// parameter (default: `process.platform`) so tests on a POSIX
// runner can pin Windows path semantics without depending on the
// host. `pathMod` selects `node:path/win32` for win32, `node:path/posix`
// otherwise — `path.win32.isAbsolute('C:\\...')` returns true on a
// Linux runner where the default `node:path.isAbsolute` would
// reject it.

import { posix, win32 } from 'node:path';
import { appDirName, projectDirName } from './app-namespace.ts';

const pathMod = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);

// Resolve the per-user agent config root directory. Returns null
// when no absolute root can be derived — operator running on a
// stripped-down env (containers, CI workers without $HOME, …)
// gets a `null` and consumer treats that as "user layer
// unavailable" rather than producing a relative path that would
// resolve against cwd (security: a repo with `.config/forja/`
// could otherwise silently shadow the real user layer).
//
// Precedence on every platform:
//   1. XDG_CONFIG_HOME (absolute) — explicit operator opt-in,
//      honored even on Windows for WSL / dotfile-manager users.
//   2. Windows only: APPDATA (absolute) → `<APPDATA>\forja`.
//   3. Windows only: USERPROFILE (absolute) →
//      `<USERPROFILE>\AppData\Roaming\forja`.
//   4. POSIX only: HOME (absolute) → `<HOME>/.config/forja`.
//   5. Otherwise → null.
export const agentConfigDir = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  const p = pathMod(platform);
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.length > 0 && p.isAbsolute(xdg)) {
    return p.join(xdg, appDirName(env));
  }
  if (platform === 'win32') {
    const appdata = env.APPDATA;
    if (appdata !== undefined && appdata.length > 0 && p.isAbsolute(appdata)) {
      return p.join(appdata, appDirName(env));
    }
    const userprofile = env.USERPROFILE;
    if (userprofile !== undefined && userprofile.length > 0 && p.isAbsolute(userprofile)) {
      return p.join(userprofile, 'AppData', 'Roaming', appDirName(env));
    }
    return null;
  }
  const home = env.HOME;
  if (home === undefined || home.length === 0 || !p.isAbsolute(home)) return null;
  return p.join(home, '.config', appDirName(env));
};

// Per-user path for an artifact named `filename` inside the agent
// config root. Returns null when no absolute root is available.
// Critical defensive measure: a fallback like `join('', filename)`
// would produce a relative path that `existsSync` resolves against
// cwd — a repo with a same-named file under `.config/forja/` could
// silently override the real user layer.
export const userAgentPath = (
  filename: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  const dir = agentConfigDir(env, platform);
  if (dir === null) return null;
  return pathMod(platform).join(dir, filename);
};

// Enterprise-installed path for `filename` under the machine-wide
// agent config root.
//   - Windows: PROGRAMDATA (absolute) → `<PROGRAMDATA>\forja\<filename>`.
//   - POSIX: hardcoded `/etc/forja/<filename>`.
//
// Returns null on Windows when PROGRAMDATA is missing or
// non-absolute — operator running in a stripped-down container.
// POSIX always returns a concrete path because `/etc/forja/` is
// the canonical location regardless of env state.
//
// Both branches use `path.join` rather than string interpolation
// even when the result is mechanically the same — this normalizes
// any `..` segments a caller might pass in `filename` (defense in
// depth; today's callers all pass hardcoded literals like
// `'permissions.yaml'`, but a future consumer could end up with
// operator-influenced input and the symmetric defense closes the
// traversal window).
export const enterpriseAgentPath = (
  filename: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  const p = pathMod(platform);
  if (platform === 'win32') {
    const programData = env.PROGRAMDATA;
    if (programData === undefined || programData.length === 0 || !p.isAbsolute(programData)) {
      return null;
    }
    return p.join(programData, appDirName(env), filename);
  }
  return p.join(`/etc/${appDirName(env)}`, filename);
};

// Project-scope path for `filename` under the per-repo `.forja/`
// dir. Always derivable from `repoRoot`; the loader treats absent
// file as an empty layer. Platform-aware join so a Windows
// `repoRoot` of `C:\repo\proj` produces `C:\repo\proj\.forja\<filename>`
// on a Linux test runner (where the host `node:path` would
// otherwise mis-join with `/` separators).
export const projectAgentPath = (
  repoRoot: string,
  filename: string,
  platform: NodeJS.Platform = process.platform,
): string => pathMod(platform).join(repoRoot, projectDirName(), filename);
