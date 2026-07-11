import { accessSync, constants, statSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

// Slice 178 (hardening M3). Pin the absolute path to `git` once
// per process so subsequent worktree-gc subprocess spawns aren't
// vulnerable to mid-session PATH shadowing.
//
// Threat model: an attacker (compromised tool, malicious dotfile,
// or a buggy install hook) writes `~/bin/git` after the agent
// starts. Every `Bun.spawn({ cmd: ['git', ...] })` afterward
// resolves through PATH and may pick the shim. The shim runs with
// the agent's privileges and the inherited env. By resolving git
// once at first use and reusing the absolute path, mid-session
// shadowing has no effect — the path is captured before the shim
// existed. Pre-existing shadowing (already on PATH at startup)
// is out of scope for this defense; the operator's PATH at boot
// is part of the trust boundary.
//
// PATH-on-subprocess: paired with `safeGitEnv()`, the spawned
// git also runs with a controlled PATH so any subprocess git
// itself fork-execs (credential helpers, hooks, pagers) is
// resolved against the canonical set first; the operator's
// boot PATH appended as fallback covers Nix-style profile bins
// and asdf shims that don't live under canonical prefixes.

// Conservative canonical PATH. Excludes per-user dirs (~/bin,
// ~/.local/bin) by design — see threat model above. Includes:
//   - /opt/homebrew/{s,}bin — Apple Silicon Homebrew default
//     (the dominant install layout on macOS arm64 since 2020).
//   - /opt/local/{s,}bin — MacPorts.
//   - /usr/local/{s,}bin — Intel Homebrew + many Linux distros.
//   - /usr/{s,}bin + /{s,}bin — POSIX baseline.
// Per-user shims (~/bin, ~/.local/bin) and the operator's full
// boot PATH (Nix profile, asdf shims, ad-hoc /opt/custom/bin)
// are NOT in this set — those land in the fallback path on
// `safeGitEnv()` only when canonical resolution fails.
const CANONICAL_SAFE_PATH =
  '/opt/homebrew/sbin:/opt/homebrew/bin:/opt/local/sbin:/opt/local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

// `undefined` = not yet probed; `null` = probed and not found
// on any PATH we tried (canonical OR fallback).
let cachedGitPath: string | null | undefined;
// PATH string to ship in safeGitEnv(). Starts as canonical;
// when fallback resolution succeeded against the operator's
// boot PATH, we append the operator's PATH so subprocess of
// git (hooks, credential helpers, ssh) can still resolve
// their own tools on systems whose binaries live outside the
// canonical set (NixOS, ad-hoc /opt). Canonical entries come
// FIRST so shim resolution on names that ALSO exist in the
// canonical set picks the canonical copy (defense-in-depth
// against mid-session shadowing of git's siblings).
let cachedSpawnPath: string = CANONICAL_SAFE_PATH;

// Find `git` in a specific PATH string by walking entries with
// `fs.access(.., X_OK)` paired with `fs.statSync().isFile()`.
// Pre-fix used `Bun.spawn(['which', 'git'])` which broke on minimal
// images (busybox-based, distroless, scratch + statically-linked
// binaries) that don't ship a `which` executable. In-process
// resolution removes the external-binary dependency.
//
// Validation that goes beyond `which`:
//   - PATH entry must be ABSOLUTE. A relative entry (`.`, `./bin`,
//     `bin`) would resolve `git` relative to the agent's cwd at
//     spawn time — but `Bun.spawn` is called from many cwds across
//     the codebase (worktree-gc with parentCwd, checkpoints with
//     opts.cwd, etc.), so a relative cached path would resolve
//     differently each call. POSIX `which` also typically skips
//     relative entries; matching that behavior keeps the cache
//     deterministic.
//   - Candidate must be a REGULAR FILE. `accessSync(.., X_OK)`
//     succeeds for searchable directories too — a dir named `git`
//     in a PATH entry would slip through and later spawn calls
//     would fail with EACCES/EISDIR or worse, attempt to execute
//     something unexpected. statSync().isFile() filters those out.
//
// `path.delimiter` keeps the split portable (`:` on POSIX, `;` on
// Windows — though Forja targets POSIX).
const findGitInPathSync = (path: string): string | null => {
  if (path.length === 0) return null;
  for (const dir of path.split(delimiter)) {
    if (dir.length === 0) continue;
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, 'git');
    try {
      const st = statSync(candidate);
      if (!st.isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not executable / doesn't exist / not a regular file — try next.
    }
  }
  return null;
};

const findGitInPathAsync = async (path: string): Promise<string | null> => {
  if (path.length === 0) return null;
  for (const dir of path.split(delimiter)) {
    if (dir.length === 0) continue;
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, 'git');
    try {
      const st = await stat(candidate);
      if (!st.isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not executable / doesn't exist / not a regular file — try next.
    }
  }
  return null;
};

// Compose the spawn PATH: canonical prefix FIRST, operator boot
// PATH appended. Canonical-first means a tool name that exists in
// BOTH paths (e.g., `git` itself if a `~/bin/git` shim was planted)
// resolves to the canonical copy — PATH lookup is left-to-right.
// The operator PATH suffix is what makes git's subprocess hooks
// (post-checkout for `git worktree add`, pre-commit, etc.) find
// user-level tools that legitimately live outside canonical dirs:
// nvm shims, asdf, poetry, ~/.local/bin, custom ~/bin utilities.
// Pre-fix this only ran on the fallback branch (canonical lookup
// missed); the canonical-hit path returned with `cachedSpawnPath`
// still canonical-only, which made `git worktree add` fail on any
// repo with hooks that depend on operator-level tools — a
// functional regression from the v0 inline-spawn behavior. The
// operator's boot PATH was always trusted (it's the boundary the
// process started in) so appending it doesn't weaken the
// defense; the defense is that `git ITSELF` is pinned absolute
// and can't be shadowed mid-session.
const composeSpawnPath = (): string => {
  const operatorPath = process.env.PATH;
  if (operatorPath === undefined || operatorPath.length === 0) return CANONICAL_SAFE_PATH;
  if (operatorPath === CANONICAL_SAFE_PATH) return CANONICAL_SAFE_PATH;
  return `${CANONICAL_SAFE_PATH}:${operatorPath}`;
};

// Emit the stderr warning on the fallback branch only (canonical
// lookup missed, operator PATH made the resolution work). The
// operator should see that defense is partial — git binary
// resolves through their PATH, not from the canonical set.
const warnFallback = (resolvedGitPath: string): void => {
  process.stderr.write(
    `forja: git resolved via operator PATH fallback (${resolvedGitPath}); canonical SAFE_PATH lookup did not match — PATH-shadowing defense for git itself remains, but git was found outside the canonical set\n`,
  );
};

// Returns the absolute path to git when resolution succeeded;
// falls back to the bare command `'git'` when both canonical
// and operator-PATH lookups failed. Callers should treat the
// bare fallback as best-effort — Bun.spawn will still try PATH
// lookup at exec time, with the PATH `safeGitEnv()` supplies.
//
// IN BOTH SUCCESS BRANCHES (canonical and fallback), the cached
// spawn PATH is composed from `canonical:operator_path`. Hooks
// that git fork-execs need the operator PATH to find user-level
// tools (nvm, asdf, poetry); the canonical prefix keeps the
// shadowing defense intact for git itself and its siblings that
// happen to be in canonical dirs.
export const getGitBinary = async (): Promise<string> => {
  if (cachedGitPath !== undefined) return cachedGitPath ?? 'git';
  // First: canonical SAFE_PATH (defense against mid-session
  // ~/bin/git shadowing — that's the whole point of the helper).
  const canonical = await findGitInPathAsync(CANONICAL_SAFE_PATH);
  if (canonical !== null) {
    cachedGitPath = canonical;
    cachedSpawnPath = composeSpawnPath();
    return canonical;
  }
  // Fallback: operator's boot PATH. Required for Nix profile
  // bins (/run/current-system/sw/bin, ~/.nix-profile/bin), asdf
  // shims, /run/wrappers/bin, ad-hoc /opt/custom layouts. The
  // boot PATH is part of the trust boundary, so searching it for
  // git is no weaker than the v0 inline `cmd: ['git']` path the
  // helper was designed to harden.
  const operatorPath = process.env.PATH;
  if (operatorPath !== undefined && operatorPath !== CANONICAL_SAFE_PATH) {
    const fallback = await findGitInPathAsync(operatorPath);
    if (fallback !== null) {
      cachedGitPath = fallback;
      cachedSpawnPath = composeSpawnPath();
      warnFallback(fallback);
      return fallback;
    }
  }
  cachedGitPath = null;
  return 'git';
};

// Synchronous variant for callers that run before the event loop
// is available or in contexts where awaiting is impractical
// (memory/paths.ts:resolveRepoRoot, cli/git-context.ts). Same
// two-stage resolution shape as the async variant; populates
// the shared cache so a subsequent async caller reuses the
// result. Never throws.
export const getGitBinarySync = (): string => {
  if (cachedGitPath !== undefined) return cachedGitPath ?? 'git';
  const canonical = findGitInPathSync(CANONICAL_SAFE_PATH);
  if (canonical !== null) {
    cachedGitPath = canonical;
    cachedSpawnPath = composeSpawnPath();
    return canonical;
  }
  const operatorPath = process.env.PATH;
  if (operatorPath !== undefined && operatorPath !== CANONICAL_SAFE_PATH) {
    const fallback = findGitInPathSync(operatorPath);
    if (fallback !== null) {
      cachedGitPath = fallback;
      cachedSpawnPath = composeSpawnPath();
      warnFallback(fallback);
      return fallback;
    }
  }
  cachedGitPath = null;
  return 'git';
};

// Minimal env for `Bun.spawn`-ing git. Pairs with `getGitBinary()`:
// the binary is pinned to an absolute path resolved at first use;
// the env is locked to a controlled PATH plus the standard scrubs
// every git call wants (LC_ALL=C for parseable output,
// GIT_TERMINAL_PROMPT=0 so a creds prompt never blocks).
//
// HOME is preserved because git reads `~/.gitconfig` for the
// committer identity and ssh wrapper config; clearing it would
// break legitimate operations (e.g., `git status` against a repo
// whose remote uses ssh-with-config-file). The threat there is
// lower than mid-session PATH shadowing because $HOME is set at
// boot and rarely mutated.
//
// PATH semantics:
//   - When canonical resolution succeeded, PATH = CANONICAL_SAFE_PATH
//     (no per-user dirs).
//   - When fallback resolution succeeded against operator PATH,
//     PATH = `${CANONICAL_SAFE_PATH}:${operator_boot_PATH}` —
//     canonical entries win on duplicate names, but operator
//     dirs are reachable for subprocess git might fork (hooks,
//     credential helpers, ssh wrapper). Necessary for NixOS,
//     /run/wrappers/bin, asdf, ad-hoc layouts.
//   - When BOTH lookups failed, cachedSpawnPath stays canonical
//     and `git` itself is the bare command — exec will fail
//     visibly with ENOENT rather than silently picking a shim.
//
// ORDER MATTERS: getGitBinary() is what populates the fallback
// PATH branch. A caller that runs `const env = safeGitEnv();
// const git = await getGitBinary();` captures the env BEFORE the
// resolution can augment cachedSpawnPath — checkpoint subprocesses
// then see the canonical-only PATH even when git was found via
// fallback (NixOS, asdf). Always resolve the binary FIRST. Tests
// pin the ordering invariant; `getGitBinaryWithEnv` below couples
// the two so callers don't need to remember.
//
// NOTE: GIT_LITERAL_PATHSPECS is intentionally NOT set here.
// Some git subcommands (notably `check-ignore`) reject the
// `literal` pathspec magic with exit 128 — making it a global
// default would silently break those callers. Sites that need
// the deny-list literal-path guarantee (worktree.ts skip-
// worktree flow, worktree-gc.ts) merge it locally.
export const safeGitEnv = (): Record<string, string> => ({
  LC_ALL: 'C',
  GIT_TERMINAL_PROMPT: '0',
  PATH: cachedSpawnPath,
  HOME: process.env.HOME ?? '',
});

// Combinator that pairs `getGitBinary()` + `safeGitEnv()` in the
// correct order. Callers that don't need finer control should use
// this — it removes the ordering footgun where running the env
// builder first captures the pre-fallback canonical PATH and
// leaves subprocesses blind to whatever dir actually hosts git's
// siblings.
export const getGitBinaryWithEnv = async (): Promise<{
  git: string;
  env: Record<string, string>;
}> => {
  const git = await getGitBinary();
  return { git, env: safeGitEnv() };
};

// Synchronous variant of the combinator. Same rationale; use in
// boot-path probes (memory/paths.ts, cli/git-context.ts) that
// can't await.
export const getGitBinaryWithEnvSync = (): { git: string; env: Record<string, string> } => {
  const git = getGitBinarySync();
  return { git, env: safeGitEnv() };
};

// Test seam: reset the cached git path AND the spawn PATH.
// Production callers never need this — both are stable for the
// process lifetime — but tests that exercise the resolution
// path need to start from a clean cache state.
export const __resetGitBinaryCacheForTest = (): void => {
  cachedGitPath = undefined;
  cachedSpawnPath = CANONICAL_SAFE_PATH;
};
