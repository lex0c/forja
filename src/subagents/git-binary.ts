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
// git also runs with a minimal canonical PATH so any subprocess
// git itself fork-execs (credential helpers, hooks, pagers) is
// resolved against the canonical set, not the operator's
// possibly-tainted login PATH.

// Conservative canonical PATH. Excludes per-user dirs (~/bin,
// ~/.local/bin) by design — see threat model above. Includes:
//   - /opt/homebrew/{s,}bin — Apple Silicon Homebrew default
//     (the dominant install layout on macOS arm64 since 2020).
//   - /opt/local/{s,}bin — MacPorts.
//   - /usr/local/{s,}bin — Intel Homebrew + many Linux distros.
//   - /usr/{s,}bin + /{s,}bin — POSIX baseline.
// Without /opt/homebrew, `which git` on a stock Apple Silicon
// workstation returns null and `safeGitEnv()`'s PATH cannot find
// git at exec time either — every worktree-gc spawn would
// silently fail. The directories are well-known and operator-
// installed; including them does not expose the per-user shim
// surface the threat model is concerned with.
const SAFE_PATH =
  '/opt/homebrew/sbin:/opt/homebrew/bin:/opt/local/sbin:/opt/local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

// `undefined` = not yet probed; `null` = probed and not found.
let cachedGitPath: string | null | undefined;

const resolveGitOnce = async (): Promise<string | null> => {
  // `which` itself goes through PATH. Use the safe PATH so a
  // shim of `which` doesn't poison the resolution. POSIX `which`
  // (or its shell builtin) lives in /usr/bin or /bin on every
  // supported platform — the canonical PATH includes both.
  const proc = Bun.spawn({
    cmd: ['which', 'git'],
    env: { PATH: SAFE_PATH },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) return null;
  const candidate = stdout.trim();
  return candidate.length > 0 ? candidate : null;
};

// Returns the absolute path to git when resolution succeeded;
// falls back to the bare command `'git'` when `which` failed
// (no git on PATH, or which itself missing). Callers should
// treat the fallback as best-effort — Bun.spawn will still try
// PATH lookup at exec time, with whatever PATH the caller
// supplies in `env`. `safeGitEnv()` keeps that PATH controlled.
export const getGitBinary = async (): Promise<string> => {
  if (cachedGitPath === undefined) cachedGitPath = await resolveGitOnce();
  return cachedGitPath ?? 'git';
};

// Synchronous variant for callers that run before the event loop
// is available or in contexts where awaiting is impractical
// (memory/paths.ts:resolveRepoRoot, cli/git-context.ts). Uses
// `Bun.spawnSync` against the canonical PATH the async resolver
// uses, populates the same shared cache so a subsequent async
// caller reuses the result, and never throws. Returns the bare
// command `'git'` when sync resolution fails (matches the async
// fallback shape).
export const getGitBinarySync = (): string => {
  if (cachedGitPath !== undefined) return cachedGitPath ?? 'git';
  try {
    const proc = Bun.spawnSync({
      cmd: ['which', 'git'],
      env: { PATH: SAFE_PATH },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) {
      cachedGitPath = null;
      return 'git';
    }
    const candidate = new TextDecoder().decode(proc.stdout).trim();
    cachedGitPath = candidate.length > 0 ? candidate : null;
    return cachedGitPath ?? 'git';
  } catch {
    cachedGitPath = null;
    return 'git';
  }
};

// Minimal env for `Bun.spawn`-ing git. Pairs with `getGitBinary()`:
// the binary is pinned to an absolute path resolved at first use;
// the env is locked to a canonical PATH plus the standard scrubs
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
// NOTE: GIT_LITERAL_PATHSPECS is intentionally NOT set here.
// Some git subcommands (notably `check-ignore`) reject the
// `literal` pathspec magic with exit 128 — making it a global
// default would silently break those callers. Sites that need
// the deny-list literal-path guarantee (worktree.ts skip-
// worktree flow, worktree-gc.ts) merge it locally.
export const safeGitEnv = (): Record<string, string> => ({
  LC_ALL: 'C',
  GIT_TERMINAL_PROMPT: '0',
  PATH: SAFE_PATH,
  HOME: process.env.HOME ?? '',
});

// Test seam: reset the cached git path. Production callers never
// need this — the path is stable for the process lifetime — but
// tests that exercise the resolution path need to start from a
// clean cache state.
export const __resetGitBinaryCacheForTest = (): void => {
  cachedGitPath = undefined;
};
