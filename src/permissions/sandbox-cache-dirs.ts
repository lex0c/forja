// Writable dev-cache carve-out for the sandboxed profiles.
//
// The four sandboxed profiles start from `--ro-bind / /`; `cwd-rw` /
// `cwd-rw-net` then make ONLY the cwd writable. That leaves the whole
// `$HOME` read-only inside the sandbox — which breaks every build
// toolchain, because they write their build/module caches under
// `$HOME`, not the project tree:
//
//   go     → $GOCACHE (default ~/.cache/go-build) + $GOMODCACHE
//            (default ~/go/pkg/mod)
//   npm    → ~/.npm (cache)
//   pip/uv → ~/.cache/{pip,uv}  (under ~/.cache)
//
// A `go build` with no secret-access lands in `cwd-rw` (the planner
// only routes secret-access calls to `home-rw`), so `$HOME` never
// becomes writable and the compiler aborts with EROFS. The model
// can't redirect via `GOCACHE=… go build` either: the bash resolver
// refuses `VAR=val cmd` and `env VAR=val cmd` (anti-laundering —
// `bash.ts`), and that refusal is correct. So the fix belongs in the
// sandbox layer: give the build caches a writable home.
//
// Mechanism: mount a fresh `--tmpfs` over each cache dir inside the
// sandbox (see `sandbox-runner.ts`). This is the SAME primitive
// `HIDE_PATHS_DIRS` uses, with the opposite intent — there to mask a
// credential dir, here to grant a writable scratch dir. Three
// properties make tmpfs the safe choice (operator-selected over a
// persistent bind):
//
//   1. Writable — the toolchain can create/populate its cache.
//   2. Ephemeral — the mount is torn down with the sandbox, so a
//      compromised build can't plant anything that outlives the call.
//   3. Isolating — the tmpfs is EMPTY, so it also masks whatever the
//      host had at that path. The sandboxed process never sees the
//      host's real `~/.cache` content (no read-leak), and its writes
//      never touch the host (no write-through).
//
// Trade-off the operator accepted: ephemeral means no cross-spawn
// reuse — `go build` recompiles std, deps re-fetch each call.
//
// Two hard constraints the runner enforces (NOT just convention):
//   - EXISTENCE GATE. bwrap can mount a tmpfs only over a path that
//     already exists; for an absent target it `mkdir`s the mountpoint,
//     which lands under the read-only `--ro-bind / /` base and fails
//     with EROFS — aborting the ENTIRE spawn (not just the build). So
//     the runner emits `--tmpfs` ONLY for cache dirs that exist on the
//     host (same gate HIDE_PATHS uses). A cache dir that doesn't exist
//     is skipped: the toolchain that wanted it still can't write (as
//     before this carve-out), but every other command still runs.
//   - ORDERING. The cache mounts are emitted AFTER `--ro-bind / /` (so
//     they're writable) but BEFORE the cwd `--bind` and the
//     `HIDE_PATHS_*` overlays. bwrap applies mounts in argv order (last
//     wins), so the cwd bind wins over a cache dir that contains it AND
//     every credential overlay wins over a cache dir — a cache entry
//     can never UN-mask a hidden credential.
//
// NOT in the default set:
//   - `.cargo` — masking all of `~/.cargo` with a tmpfs hides
//     `~/.cargo/bin/cargo` itself (the rustup shim lives there), so the
//     wrap can't even exec cargo. And `~/.rustup` (the toolchain) is in
//     HIDE_PATHS_DIRS, so rustup cargo is already blocked in the
//     sandbox independent of caching. Rust needs its own treatment
//     (a `.cargo/registry`-scoped carve-out + an `.rustup` exception);
//     until then an operator can opt in via `writable_cache_dirs`.

// Default carve-out: the mainstream caches whose REAL default location
// (under the sandbox's clearenv, where GOCACHE/XDG_CACHE_HOME/etc. are
// unset so tools fall back to defaults) is exactly one of these
// $HOME-relative paths. Operators override via `.forja/config.toml`
// `[sandbox] writable_cache_dirs` (see `loadSandboxConfig`).
export const DEFAULT_WRITABLE_CACHE_DIRS: readonly string[] = [
  '.cache', // XDG cache: go-build (~/.cache/go-build), pip, uv, …
  'go/pkg/mod', // Go module cache ($GOMODCACHE default, GOPATH=~/go)
  '.npm', // npm cache (~/.npm)
];

// Normalize ONE cache-dir entry to a clean `$HOME`-relative path, or
// return null if it's unsafe / empty. Single source of truth shared by
// the config sanitizer AND the runner's per-entry guard, so the two can
// never diverge (a prior bug: the runner's ad-hoc guard missed `.`,
// which `joinPath(home, '.')` collapses to `$HOME` itself → a tmpfs
// over the ENTIRE home).
//
// Rejects (→ null): non-string, empty/whitespace, NUL byte, absolute
// (leading `/`), any `..` segment (escapes $HOME once joined), and an
// entry that normalizes to nothing (`.`, `./`, `.//.` → would be $HOME).
// `.` and empty segments are dropped; the result is the POSIX-joined
// remainder. Backslash is a normal char on POSIX (kept verbatim).
export const normalizeCacheDir = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes('\0')) return null;
  if (trimmed.startsWith('/')) return null;
  const segments = trimmed.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return null; // was `.` / `./` etc → $HOME
  if (segments.some((s) => s === '..')) return null;
  return segments.join('/');
};

export interface SanitizeWritableCacheDirsResult {
  dirs: string[];
  warnings: string[];
  // True iff `input` was an array at all. Lets the loader distinguish a
  // type error (`writable_cache_dirs = "foo"` → fall back to DEFAULT)
  // from an intentional empty array (`= []` → disable the carve-out)
  // from an array whose entries were all rejected (→ DEFAULT).
  wasArray: boolean;
}

// Validate a writable-cache-dir list coming from operator config. The
// entries become `--tmpfs <home>/<entry>` mount targets, so a hostile
// or fat-fingered value must NOT escape `$HOME` (e.g. `../../etc` →
// `--tmpfs /etc`, a DoS that blanks /etc inside the sandbox). Each entry
// goes through `normalizeCacheDir`; rejects warn + drop, keeping the
// rest. Duplicates (after normalization) are de-duped, first wins.
export const sanitizeWritableCacheDirs = (input: unknown): SanitizeWritableCacheDirsResult => {
  if (!Array.isArray(input)) {
    return {
      dirs: [],
      warnings: ['[sandbox] writable_cache_dirs must be an array of strings; ignoring'],
      wasArray: false,
    };
  }
  const warnings: string[] = [];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const raw of input) {
    const normalized = normalizeCacheDir(raw);
    if (normalized === null) {
      warnings.push(
        `[sandbox] writable_cache_dirs: ignoring invalid entry ${JSON.stringify(raw)} (must be a non-empty, $HOME-relative path with no leading '/' or '..')`,
      );
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    dirs.push(normalized);
  }
  return { dirs, warnings, wasArray: true };
};

// Effective operator override for the carve-out, set once at boot from
// `[sandbox] writable_cache_dirs` (parsed + sanitized by
// `loadSandboxConfig`). The runner consults it when a call site doesn't
// pass `writableCacheDirs` explicitly — the same module-level-default
// pattern `setRecapCacheTtlOverride` uses, so the threading stays at the
// bootstrap call site instead of churning every spawn site (bash
// broker, bg bash, grep). NOTE: a module global only covers the CURRENT
// process — the subagent child runs in its own process and sets the
// override from its own config load (see `subagent-child.ts`).
//
// Tri-state is deliberate and must be preserved end-to-end:
//   undefined → operator said nothing       → runner uses DEFAULT_*
//   []        → operator set an empty array → carve-out DISABLED
//   [..]      → operator's explicit list
// So the setter stores the value as-is (it does NOT collapse undefined
// to the default); the `?? DEFAULT` resolution happens in the runner.
let writableCacheDirsOverride: readonly string[] | undefined;

// Bootstrap-time setter. `undefined` reverts to "no override" (runner
// falls back to DEFAULT_WRITABLE_CACHE_DIRS) — also how tests reset it.
export const setWritableCacheDirsOverride = (dirs: readonly string[] | undefined): void => {
  writableCacheDirsOverride = dirs;
};

// Consumed by the runner (and tests). Returns the raw tri-state — the
// caller applies `?? DEFAULT_WRITABLE_CACHE_DIRS`.
export const getWritableCacheDirsOverride = (): readonly string[] | undefined =>
  writableCacheDirsOverride;
