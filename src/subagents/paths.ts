import { posix, win32 } from 'node:path';

// Path discovery for subagent definitions (spec §11.1). Mirrors the
// shape of `permissions/paths.ts` so the two layers stay legible
// side-by-side. Each function returns null when no absolute,
// home-rooted path can be derived — null means "this scope is
// unavailable", which the loader turns into "skip the directory".
//
// Layout:
//   user:    $XDG_CONFIG_HOME/agent/agents/*.md  (Linux/macOS, default ~/.config)
//            %APPDATA%\agent\agents\*.md         (Windows)
//   project: <cwd>/.agent/agents/*.md
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
    return p.join(xdg, 'agent', 'agents');
  }
  if (platform === 'win32') {
    const appdata = env.APPDATA;
    if (appdata !== undefined && appdata.length > 0 && p.isAbsolute(appdata)) {
      return p.join(appdata, 'agent', 'agents');
    }
    const userprofile = env.USERPROFILE;
    if (userprofile !== undefined && userprofile.length > 0 && p.isAbsolute(userprofile)) {
      return p.join(userprofile, 'AppData', 'Roaming', 'agent', 'agents');
    }
    return null;
  }
  const home = env.HOME;
  if (home === undefined || home.length === 0 || !p.isAbsolute(home)) return null;
  return p.join(home, '.config', 'agent', 'agents');
};

export const projectAgentsDir = (cwd: string): string =>
  pathMod(process.platform).join(cwd, '.agent', 'agents');

// Built-in subagent definitions ship inside the binary at
// `src/subagents/builtin/`. Returned as an absolute path computed at
// module-load time via `import.meta.dir`. Dev runs (`bun run dev`)
// resolve to the source path directly. Compiled binaries
// (`bun build --compile`) instead surface a virtual `/$bunfs/...`
// path that `readdirSync` cannot enumerate — meaning built-ins are
// effectively LOST in compile mode under the current loader. The
// harness loop emits `verify_semantic_disabled` when an opt-in
// flag is set without a resolvable definition, so the operator
// surface flags the gap loudly instead of silently no-opping.
//
// Compile-safe distribution is tracked as deferred work
// (`docs/TODO.md` — embedded builtin definitions via TS const +
// loader fallback). Until that ships, S11 in compiled binaries
// requires the operator to ship a user / project shadow of
// `verify-semantic.md` to substitute the built-in.
export const BUILTIN_AGENTS_DIR = pathMod(process.platform).join(import.meta.dir, 'builtin');
