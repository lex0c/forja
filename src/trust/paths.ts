// Path discovery for the trusted-directories list. Spec:
// AGENTIC_CLI.md §9.1 — `~/.config/forja/trusted_dirs.json` (Linux /
// macOS) or the Windows-equivalent under %APPDATA%. The list tracks
// absolute paths the operator has explicitly approved, so subsequent
// invocations from the same cwd skip the trust prompt.
//
// Mirrors `userPolicyPath` (src/permissions/paths.ts) on platform
// handling: XDG honored on every platform if explicitly set,
// %APPDATA% / %USERPROFILE%\AppData\Roaming on Windows, ~/.config
// on Linux/macOS. Returns null when no absolute home-rooted path
// can be derived — caller treats null as "trust storage
// unavailable" and falls back to per-session trust (every boot
// re-prompts; nothing persists).

import { posix, win32 } from 'node:path';
import { appDirName } from '../config/app-namespace.ts';

const pathMod = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);

export const trustListPath = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  const p = pathMod(platform);
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.length > 0 && p.isAbsolute(xdg)) {
    return p.join(xdg, appDirName(env), 'trusted_dirs.json');
  }
  if (platform === 'win32') {
    const appdata = env.APPDATA;
    if (appdata !== undefined && appdata.length > 0 && p.isAbsolute(appdata)) {
      return p.join(appdata, appDirName(env), 'trusted_dirs.json');
    }
    const userprofile = env.USERPROFILE;
    if (userprofile !== undefined && userprofile.length > 0 && p.isAbsolute(userprofile)) {
      return p.join(userprofile, 'AppData', 'Roaming', appDirName(env), 'trusted_dirs.json');
    }
    return null;
  }
  const home = env.HOME;
  if (home === undefined || home.length === 0 || !p.isAbsolute(home)) return null;
  return p.join(home, '.config', appDirName(env), 'trusted_dirs.json');
};
