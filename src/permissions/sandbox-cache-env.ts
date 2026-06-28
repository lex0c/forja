// Cache env-var redirect for the sandbox's opt-in persistent cache
// (`[sandbox] cache_persistence`).
//
// The sandboxed bash starts under `--clearenv` (Linux) / `env -i` (macOS):
// only `SANDBOX_SAFE_ENV_VARS` survive. The model ALSO cannot redirect a
// toolchain's cache itself — the bash resolver refuses `VAR=val cmd` /
// `env VAR=val cmd` (anti-laundering; see `sandbox-cache-dirs.ts`). So when
// persistence is on, the WRAP injects the cache env (via the
// `passthroughEnv` channel on Linux, the `env -i KEY=VAL` list on macOS)
// pointing at the Forja-DEDICATED cache base (`forjaCachePersistBase()` —
// never the host's real `~/.cache`, `~/go/pkg/mod`, …). Toolchains then
// write into the persistent bind, so deps survive across spawns.
//
// Two layers, mostly LANGUAGE-AGNOSTIC:
//   1. `XDG_CACHE_HOME` catch-all (in `buildCacheRedirectEnv`) — the bulk of
//      modern tools (pip, uv, Go's BUILD cache, composer, yarn classic, and
//      anything XDG-compliant we don't even know about) read their cache dir
//      from `$XDG_CACHE_HOME`. One var redirects all of them, including
//      future toolchains, with no per-tool entry.
//   2. `CACHE_ENV_MAP` — the HOLDOUTS that ignore XDG and need a dedicated
//      env var (npm, Go's module cache, NuGet, Maven, Gradle, bun, pnpm).
//
// This is the OPPOSITE intent of `sandbox-cache-dirs.ts` (which masks the
// host cache with an EPHEMERAL tmpfs). They coexist: the tmpfs keeps the
// host cache invisible + write-blocked (default, and a fallback for tools
// that ignore both layers); this redirect steers writes into the persistent
// Forja cache when persistence is on.
//
// The wrap injects EVERY var (it doesn't know which toolchain the model will
// invoke). They're inert for tools that don't read them; no collision —
// each tool reads only its own.

import { join } from 'node:path';

export interface CacheEnvEntry {
  // The env var name the toolchain reads to locate its cache.
  readonly name: string;
  // Subdir under the Forja cache base where that cache lives. For Maven the
  // value is a `-D…` flag, not a bare path — handled in `buildCacheRedirectEnv`.
  readonly subdir: string;
}

// HOLDOUT toolchains that do NOT honor `$XDG_CACHE_HOME` and so need an
// explicit cache env var. Everything XDG-compliant is covered by the
// `XDG_CACHE_HOME` catch-all in `buildCacheRedirectEnv` and is deliberately
// ABSENT here (pip, uv, Go build cache, composer, yarn, …). Each holdout's
// HOST default (the path we steer it away from) is in a comment.
export const CACHE_ENV_MAP: Readonly<Record<string, readonly CacheEnvEntry[]>> = {
  npm: [{ name: 'npm_config_cache', subdir: 'npm' }], // host: ~/.npm (not XDG)
  // pnpm's content-addressable store is under XDG_DATA, not XDG_CACHE.
  pnpm: [{ name: 'npm_config_store_dir', subdir: 'pnpm-store' }], // host: ~/.local/share/pnpm/store
  bun: [{ name: 'BUN_INSTALL_CACHE_DIR', subdir: 'bun' }], // host: ~/.bun/install/cache (not XDG)
  // Go's BUILD cache (GOCACHE) IS XDG (`$XDG_CACHE_HOME/go-build`) → covered
  // by the catch-all; only the MODULE cache (GOPATH-based) needs a redirect.
  go: [{ name: 'GOMODCACHE', subdir: 'go/mod' }], // host: ~/go/pkg/mod (not XDG)
  nuget: [
    { name: 'NUGET_PACKAGES', subdir: 'nuget' }, // host: ~/.nuget/packages (not XDG)
    { name: 'NUGET_HTTP_CACHE_PATH', subdir: 'nuget-http' }, // host: ~/.local/share/NuGet/v3-cache
  ],
  // SECURITY (cross-build contamination): GRADLE_USER_HOME is NOT a pure
  // cache — it also holds `init.d/*.gradle` init scripts that run on EVERY
  // gradle build. Redirecting it to the shared persistent cache means one
  // build can plant `init.d/x.gradle` that later executes in OTHER projects'
  // builds within the sandbox. Blast radius is contained: it's the
  // Forja-DEDICATED cache (never the operator's real ~/.gradle, so builds
  // run OUTSIDE Forja are unaffected) and the script runs INSIDE the cwd-rw
  // sandbox, not on the host. Still a cross-build/cross-session channel —
  // accepted for now (Gradle has no env to isolate only the dep cache);
  // tracked in BACKLOG. Maven (below) sidesteps it (repo.local is artifacts
  // only, no executable hooks).
  gradle: [{ name: 'GRADLE_USER_HOME', subdir: 'gradle' }], // host: ~/.gradle (not XDG)
  maven: [{ name: 'MAVEN_ARGS', subdir: 'maven' }], // host: ~/.m2/repository — 3.9+ only, not XDG
  // Dart/Flutter: `dart pub` / `flutter pub` honor PUB_CACHE (host ~/.pub-cache; not XDG). Heavy
  // Flutter dep sets make persistence worth it — without the redirect they'd re-download every spawn.
  dart: [{ name: 'PUB_CACHE', subdir: 'pub-cache' }], // host: ~/.pub-cache (not XDG)
  // .NET: DOTNET_CLI_HOME relocates the CLI's USER home (first-run sentinel, telemetry, `dotnet tool`
  // global tools) away from ~/.dotnet — which may be the SDK INSTALL dir (dotnet-install.sh + PATH).
  // REDIRECTING (vs masking ~/.dotnet with a tmpfs) keeps the SDK binary execable. It does NOT relocate
  // the SDK itself (found via the dotnet apphost / DOTNET_ROOT). The NuGet PACKAGE cache is separate.
  dotnet: [{ name: 'DOTNET_CLI_HOME', subdir: 'dotnet' }], // host: ~/.dotnet (not XDG; may be the SDK)
};

// Flatten into the concrete env to inject, given the Forja cache base
// (`forjaCachePersistBase()`). Starts with the `XDG_CACHE_HOME` catch-all
// (covers every XDG-compliant tool — pip/uv/go-build/composer/yarn/…), then
// the holdout vars from `CACHE_ENV_MAP`. Every entry is `NAME=<base>/<subdir>`
// except `MAVEN_ARGS`, whose value is the `-Dmaven.repo.local=<path>` flag
// Maven expects (a bare path would be a no-op). Tools create their own subdir
// under the writable base, so no per-language pre-creation is needed.
export const buildCacheRedirectEnv = (base: string): Record<string, string> => {
  const env: Record<string, string> = { XDG_CACHE_HOME: join(base, 'xdg') };
  for (const entries of Object.values(CACHE_ENV_MAP)) {
    for (const { name, subdir } of entries) {
      const abs = join(base, subdir);
      env[name] = name === 'MAVEN_ARGS' ? `-Dmaven.repo.local=${abs}` : abs;
    }
  }
  return env;
};

// Effective operator override for the opt-in persistent cache, set once at
// boot from `[sandbox] cache_persistence` (parsed by `loadSandboxConfig`).
// Mirrors the module-level pattern of `setWritableCacheDirsOverride` in
// `sandbox-cache-dirs.ts`: a process global the runner consults so spawn
// sites (broker, bg bash, grep) don't each thread the flag. NOTE: a module
// global only covers the CURRENT process — the subagent child runs in its
// own process and re-sets this from its own config load (see
// `subagent-child.ts`).
//
// Tri-state preserved end-to-end:
//   undefined → operator said nothing  → runner treats as OFF (ephemeral)
//   false     → explicit off
//   true      → on (inject redirect env + emit the persistent bind)
let cachePersistenceOverride: boolean | undefined;

// Bootstrap-time setter. `undefined` reverts to "no override" (runner treats
// as off) — also how tests reset it.
export const setCachePersistenceOverride = (enabled: boolean | undefined): void => {
  cachePersistenceOverride = enabled;
};

// Consumed by the runner (and tests). `true` means inject the redirect env +
// emit the persistent cache bind; anything else stays ephemeral.
export const getCachePersistenceOverride = (): boolean | undefined => cachePersistenceOverride;
