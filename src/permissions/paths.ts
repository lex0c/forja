import { posix, win32 } from 'node:path';

// Pick the path module that matches the target platform, not the
// host running the code. Tests on a Linux runner need
// path.win32.isAbsolute('C:\\...') to return true; the default
// `node:path` reflects host platform and would mis-classify.
const pathMod = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);

// Path discovery for the permission hierarchy (AGENTIC_CLI §8). Each
// layer points to a single permissions.yaml; absent files are simply
// skipped. The order here doesn't dictate precedence (that's the
// hierarchy resolver's job); these are just "where to look".
//
// Platform handling:
//   - Linux/macOS: XDG-style for user, /etc/agent for enterprise.
//   - Windows: %APPDATA%\agent for user, %PROGRAMDATA%\agent for
//     enterprise. XDG_CONFIG_HOME honored on every platform if
//     explicitly set (some Windows users opt into XDG via WSL or
//     dotfile managers).
//
// The platform parameter on each function defaults to
// process.platform so tests can pin behavior without depending on
// the host running them.

// Enterprise-installed policy. Linux/macOS: well-known /etc path.
// Windows: %PROGRAMDATA%\agent\permissions.yaml (the canonical
// machine-wide config root). Returns null if the platform-specific
// env var isn't set to an absolute path.
export const enterprisePolicyPath = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null => {
  if (platform === 'win32') {
    const p = pathMod(platform);
    const programData = env.PROGRAMDATA;
    if (programData === undefined || programData.length === 0 || !p.isAbsolute(programData)) {
      return null;
    }
    return p.join(programData, 'agent', 'permissions.yaml');
  }
  return '/etc/agent/permissions.yaml';
};

// User-scope policy path. Returns null when no absolute home-rooted
// path can be derived. The resolver treats null as "user layer
// unavailable" and skips it entirely. Critical defensive measure:
// a fallback like `join('', '.config', ...)` would produce a
// relative path, which `existsSync` checks against the current
// working directory — a repo with `.config/agent/permissions.yaml`
// could silently override user layer with project-local content.
// Same problem applies to relative XDG_CONFIG_HOME / APPDATA /
// HOME values.
export const userPolicyPath = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  const p = pathMod(platform);
  // XDG honored on every platform if the user explicitly opted in
  // (WSL, dotfile managers, custom setups).
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.length > 0 && p.isAbsolute(xdg)) {
    return p.join(xdg, 'agent', 'permissions.yaml');
  }
  if (platform === 'win32') {
    // %APPDATA% is the canonical per-user config root on Windows.
    // Falls back to %USERPROFILE%\AppData\Roaming\agent (the value
    // APPDATA normally expands to) so a Windows install without
    // APPDATA set still finds a sensible path.
    const appdata = env.APPDATA;
    if (appdata !== undefined && appdata.length > 0 && p.isAbsolute(appdata)) {
      return p.join(appdata, 'agent', 'permissions.yaml');
    }
    const userprofile = env.USERPROFILE;
    if (userprofile !== undefined && userprofile.length > 0 && p.isAbsolute(userprofile)) {
      return p.join(userprofile, 'AppData', 'Roaming', 'agent', 'permissions.yaml');
    }
    return null;
  }
  // Linux/macOS: HOME/.config/agent.
  const home = env.HOME;
  if (home === undefined || home.length === 0 || !p.isAbsolute(home)) return null;
  return p.join(home, '.config', 'agent', 'permissions.yaml');
};

export const projectPolicyPath = (cwd: string): string =>
  pathMod(process.platform).join(cwd, '.agent', 'permissions.yaml');
