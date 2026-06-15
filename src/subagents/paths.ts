import { posix, win32 } from 'node:path';

// Path discovery for subagent definitions (spec §11.1). Mirrors the
// shape of `permissions/paths.ts` so the two layers stay legible
// side-by-side. Each function returns null when no absolute,
// home-rooted path can be derived — null means "this scope is
// unavailable", which the loader turns into "skip the directory".
//
// Layout:
//   user:    $XDG_CONFIG_HOME/forja/playbooks/*.md  (Linux/macOS, default ~/.config)
//            %APPDATA%\forja\forjas\*.md         (Windows)
//   project: <cwd>/.forja/playbooks/*.md
//
// We deliberately do NOT support an enterprise scope here — subagents
// are author-friendly extensibility (spec §11.1: "pluggáveis sem
// recompilar"), not a security boundary. Permission policy stays the
// guardrail; if an org wants to lock the toolset of subagents, that's
// a permissions.yaml job, not an agents directory job.

const pathMod = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);

export const userAgentsDir = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  const p = pathMod(platform);
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.length > 0 && p.isAbsolute(xdg)) {
    return p.join(xdg, 'forja', 'playbooks');
  }
  if (platform === 'win32') {
    const appdata = env.APPDATA;
    if (appdata !== undefined && appdata.length > 0 && p.isAbsolute(appdata)) {
      return p.join(appdata, 'forja', 'playbooks');
    }
    const userprofile = env.USERPROFILE;
    if (userprofile !== undefined && userprofile.length > 0 && p.isAbsolute(userprofile)) {
      return p.join(userprofile, 'AppData', 'Roaming', 'forja', 'playbooks');
    }
    return null;
  }
  const home = env.HOME;
  if (home === undefined || home.length === 0 || !p.isAbsolute(home)) return null;
  return p.join(home, '.config', 'forja', 'playbooks');
};

export const projectAgentsDir = (cwd: string): string =>
  pathMod(process.platform).join(cwd, '.forja', 'playbooks');

// Built-in subagent definitions ship inside the binary at
// `src/subagents/builtin/`. Returned as an absolute path computed at
// module-load time via `import.meta.dir`. Dev runs (`bun run dev`)
// resolve to the source path directly and the loader reads from
// disk. Compiled binaries (`bun build --compile`) instead surface a
// virtual `/$bunfs/...` path that `readdirSync` cannot enumerate —
// the loader detects the empty filesystem result and falls back to
// `EMBEDDED_BUILTINS` (Bun text imports inlined at compile time, see
// `./builtin/index.ts`). The fallback ONLY triggers for the default
// path so a custom `builtinDir` passed to `loadSubagents` keeps its
// fixture semantics (zero builtins stays zero).
export const BUILTIN_AGENTS_DIR = pathMod(process.platform).join(import.meta.dir, 'builtin');
