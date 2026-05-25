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

// Run `which git` against a specific PATH. Pure helper used by
// both the async and sync entry points. Returns the trimmed
// stdout when which exits 0 with non-empty output; null
// otherwise. Never throws.
const whichGitAsync = async (path: string): Promise<string | null> => {
  try {
    const proc = Bun.spawn({
      cmd: ['which', 'git'],
      env: { PATH: path },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return null;
    const candidate = stdout.trim();
    return candidate.length > 0 ? candidate : null;
  } catch {
    return null;
  }
};

const whichGitSync = (path: string): string | null => {
  try {
    const proc = Bun.spawnSync({
      cmd: ['which', 'git'],
      env: { PATH: path },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) return null;
    const candidate = new TextDecoder().decode(proc.stdout).trim();
    return candidate.length > 0 ? candidate : null;
  } catch {
    return null;
  }
};

// Augment `cachedSpawnPath` with the operator's boot PATH when
// fallback resolution succeeded. Logs once to stderr so an
// operator running on an non-canonical layout sees the partial
// defense (PATH-pinning defends against mid-session shadowing
// of git itself, not against shadowing of git's subprocess
// tools — the operator's PATH at boot is part of the trust
// boundary as documented in SECURITY_GUIDELINE §8.6).
const applyFallbackSpawnPath = (resolvedGitPath: string): void => {
  const operatorPath = process.env.PATH;
  if (operatorPath === undefined || operatorPath.length === 0) return;
  if (operatorPath === CANONICAL_SAFE_PATH) return;
  // Append unconditionally; the canonical prefix wins on any
  // name that exists in both (PATH lookup is left-to-right).
  cachedSpawnPath = `${CANONICAL_SAFE_PATH}:${operatorPath}`;
  process.stderr.write(
    `forja: git resolved via operator PATH fallback (${resolvedGitPath}); canonical SAFE_PATH lookup did not match — PATH-shadowing defense for git itself remains, but git's subprocess tools resolve through operator PATH\n`,
  );
};

// Returns the absolute path to git when resolution succeeded;
// falls back to the bare command `'git'` when both canonical
// and operator-PATH lookups failed. Callers should treat the
// bare fallback as best-effort — Bun.spawn will still try PATH
// lookup at exec time, with the PATH `safeGitEnv()` supplies.
export const getGitBinary = async (): Promise<string> => {
  if (cachedGitPath !== undefined) return cachedGitPath ?? 'git';
  // First: canonical SAFE_PATH (defense against mid-session
  // ~/bin/git shadowing — that's the whole point of the helper).
  const canonical = await whichGitAsync(CANONICAL_SAFE_PATH);
  if (canonical !== null) {
    cachedGitPath = canonical;
    return canonical;
  }
  // Fallback: operator's boot PATH. Required for Nix profile
  // bins (/run/current-system/sw/bin, ~/.nix-profile/bin), asdf
  // shims, /run/wrappers/bin, ad-hoc /opt/custom layouts. The
  // boot PATH is part of the trust boundary, so a `which git`
  // against it is no weaker than the v0 inline `cmd: ['git']`
  // path the helper was designed to harden.
  const operatorPath = process.env.PATH;
  if (operatorPath !== undefined && operatorPath !== CANONICAL_SAFE_PATH) {
    const fallback = await whichGitAsync(operatorPath);
    if (fallback !== null) {
      cachedGitPath = fallback;
      applyFallbackSpawnPath(fallback);
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
  const canonical = whichGitSync(CANONICAL_SAFE_PATH);
  if (canonical !== null) {
    cachedGitPath = canonical;
    return canonical;
  }
  const operatorPath = process.env.PATH;
  if (operatorPath !== undefined && operatorPath !== CANONICAL_SAFE_PATH) {
    const fallback = whichGitSync(operatorPath);
    if (fallback !== null) {
      cachedGitPath = fallback;
      applyFallbackSpawnPath(fallback);
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
