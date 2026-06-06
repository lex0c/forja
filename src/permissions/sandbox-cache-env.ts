// Per-language cache env-var redirect map for the sandbox's opt-in
// persistent cache (`[sandbox] cache_persistence`).
//
// The sandboxed bash starts under `--clearenv` (Linux) / `env -i`
// (macOS): only `SANDBOX_SAFE_ENV_VARS` survive. The model ALSO cannot
// redirect a toolchain's cache itself — the bash resolver refuses
// `VAR=val cmd` / `env VAR=val cmd` (anti-laundering; see
// `sandbox-cache-dirs.ts`). So when persistence is on, the WRAP injects
// each toolchain's cache env var (via the `passthroughEnv` channel on
// Linux, the `env -i KEY=VAL` list on macOS) pointing at a subdir of the
// Forja-DEDICATED cache base (`forjaCachePersistBase()` — never the
// host's real `~/.cache`, `~/go/pkg/mod`, …). The toolchain then writes
// its cache into the persistent bind, so deps survive across spawns.
//
// This is the OPPOSITE intent of `sandbox-cache-dirs.ts` (which masks the
// host cache with an EPHEMERAL tmpfs). The two coexist: the tmpfs keeps
// the host cache invisible + write-blocked (default, and a fallback for
// tools that ignore the env var); this redirect steers new writes into
// the persistent Forja cache when persistence is on.
//
// The wrap injects EVERY language's vars (it doesn't know which toolchain
// the model will invoke). They're inert for tools that don't read them,
// and there's no collision — each tool reads only its own.

import { join } from 'node:path';

export interface CacheEnvEntry {
  // The env var name the toolchain reads to locate its cache.
  readonly name: string;
  // Subdir under the Forja cache base where that cache lives. For Maven
  // the value is a `-D…` flag, not a bare path — handled in
  // `buildCacheRedirectEnv`.
  readonly subdir: string;
}

// toolKey → cache env vars. Each toolchain's HOST default (the path we're
// steering it AWAY from) is in a comment. Multi-var tools (go, nuget)
// list every var. Maven has no clean cache env var: `MAVEN_ARGS` is read
// only by Maven 3.9+ — older Maven silently ignores it and falls back to
// the read-only `~/.m2` (kept in the tmpfs carve-out as a safety net).
export const CACHE_ENV_MAP: Readonly<Record<string, readonly CacheEnvEntry[]>> = {
  npm: [{ name: 'npm_config_cache', subdir: 'npm' }], // host: ~/.npm
  yarn: [{ name: 'YARN_CACHE_FOLDER', subdir: 'yarn' }], // host: ~/.cache/yarn
  pnpm: [{ name: 'npm_config_store_dir', subdir: 'pnpm-store' }], // host: ~/.local/share/pnpm/store
  bun: [{ name: 'BUN_INSTALL_CACHE_DIR', subdir: 'bun' }], // host: ~/.bun/install/cache
  pip: [{ name: 'PIP_CACHE_DIR', subdir: 'pip' }], // host: ~/.cache/pip
  uv: [{ name: 'UV_CACHE_DIR', subdir: 'uv' }], // host: ~/.cache/uv
  go: [
    { name: 'GOCACHE', subdir: 'go/build' }, // host: ~/.cache/go-build (build cache)
    { name: 'GOMODCACHE', subdir: 'go/mod' }, // host: ~/go/pkg/mod (module cache)
  ],
  nuget: [
    { name: 'NUGET_PACKAGES', subdir: 'nuget' }, // host: ~/.nuget/packages
    { name: 'NUGET_HTTP_CACHE_PATH', subdir: 'nuget-http' }, // host: ~/.local/share/NuGet/v3-cache
  ],
  composer: [{ name: 'COMPOSER_CACHE_DIR', subdir: 'composer' }], // host: ~/.cache/composer
  // SECURITY (cross-build contamination): GRADLE_USER_HOME is NOT a pure
  // cache — it also holds `init.d/*.gradle` init scripts that run on EVERY
  // gradle build. Redirecting it to the shared persistent cache means one
  // build can plant `init.d/x.gradle` that later executes in OTHER projects'
  // builds within the sandbox. Blast radius is contained: it's the
  // Forja-DEDICATED cache (never the operator's real ~/.gradle, so builds
  // run OUTSIDE Forja are unaffected) and the script runs INSIDE the
  // cwd-rw sandbox, not on the host. Still a cross-build/cross-session
  // channel — accepted for now (Gradle has no env to isolate only the dep
  // cache); tracked in BACKLOG. Maven (below) sidesteps it (repo.local is
  // artifacts only, no executable hooks).
  gradle: [{ name: 'GRADLE_USER_HOME', subdir: 'gradle' }], // host: ~/.gradle
  maven: [{ name: 'MAVEN_ARGS', subdir: 'maven' }], // host: ~/.m2/repository — 3.9+ only
};

// Flatten the map into the concrete env to inject, given the Forja cache
// base (`forjaCachePersistBase()`). Every entry becomes
// `NAME=<base>/<subdir>`, except `MAVEN_ARGS`, whose value is the
// `-Dmaven.repo.local=<path>` flag Maven expects (a bare path would be a
// no-op). Tools create their own subdir under the writable base, so no
// per-language pre-creation is needed.
export const buildCacheRedirectEnv = (base: string): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const entries of Object.values(CACHE_ENV_MAP)) {
    for (const { name, subdir } of entries) {
      const abs = join(base, subdir);
      env[name] = name === 'MAVEN_ARGS' ? `-Dmaven.repo.local=${abs}` : abs;
    }
  }
  return env;
};

// Effective operator override for the opt-in persistent cache, set once
// at boot from `[sandbox] cache_persistence` (parsed by
// `loadSandboxConfig`). Mirrors the module-level pattern of
// `setWritableCacheDirsOverride` in `sandbox-cache-dirs.ts`: a process
// global the runner consults so spawn sites (broker, bg bash, grep) don't
// each thread the flag. NOTE: a module global only covers the CURRENT
// process — the subagent child runs in its own process and re-sets this
// from its own config load (see `subagent-child.ts`).
//
// Tri-state preserved end-to-end:
//   undefined → operator said nothing  → runner treats as OFF (ephemeral)
//   false     → explicit off
//   true      → on (inject redirect env + emit the persistent bind)
let cachePersistenceOverride: boolean | undefined;

// Bootstrap-time setter. `undefined` reverts to "no override" (runner
// treats as off) — also how tests reset it.
export const setCachePersistenceOverride = (enabled: boolean | undefined): void => {
  cachePersistenceOverride = enabled;
};

// Consumed by the runner (and tests). `true` means inject the redirect
// env + emit the persistent cache bind; anything else stays ephemeral.
export const getCachePersistenceOverride = (): boolean | undefined => cachePersistenceOverride;
