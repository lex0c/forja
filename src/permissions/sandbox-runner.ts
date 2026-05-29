// Sandbox argv synthesis for Linux/bwrap.
//
// `selectSandboxProfile` decides the profile; this module synthesizes
// the actual bwrap command line that wraps a tool's inner argv. The
// wrap is the enforcement surface — the engine's "this call gets
// profile X" decision becomes a real OS-level isolation by feeding
// `buildBwrapArgv(...)` into `Bun.spawn(...)`.
//
// Platform: Linux only. macOS uses sandbox-exec / SBPL — see
// `sandbox-runner-macos.ts`. Spawn-site dispatch by platform lives
// in `maybeWrapSandboxArgv`. Detection lives at the bootstrap layer
// (`detectSandboxAvailability`) — this module trusts the profile
// argument and never inspects environment.
//
// Profile flag rationale (mounts/network/process columns):
//
//   ro          — entire filesystem read-only. unshare-net (no
//                 network namespace). unshare-pid (no pid view of
//                 parent). die-with-parent (kernel kills child if
//                 parent goes away).
//   cwd-rw      — ro everywhere except `cwd` (writable). Network
//                 still unshared. Same pid + die-with-parent.
//   cwd-rw-net  — ro everywhere except `cwd`. Network INHERITED
//                 from parent (no unshare-net) because the call
//                 needs egress (egress filtering by nftables is a
//                 separate enforcement plane — out of scope here).
//   home-rw     — ro everywhere except `$HOME`. Network unshared.
//                 Allows secret-access by exposing $HOME's secret
//                 paths (the planner only routes calls with
//                 secret-access cap to this profile).
//   host        — no wrap. Operator explicitly opted in via
//                 `--sandbox-host` AND the resolved capability set
//                 includes `host-passthrough`. The runner returns
//                 the innerArgv unchanged.
//
// Common flags across the 4 sandboxed profiles:
//
//   --ro-bind / /         — read-only bind-mount of the host root
//                           as the base layer. Specific paths get
//                           overridden as RW below.
//   --tmpfs /tmp          — fresh /tmp; isolates ephemeral artifacts.
//   --proc /proc          — mounts a proc fs INSIDE the namespace
//                           (without it, ps/top inside the sandbox
//                           see the host's processes).
//   --dev /dev            — fresh /dev with minimal device nodes
//                           (random, null, urandom, zero, tty).
//   --unshare-pid         — pid namespace; the wrapped process can't
//                           see / signal host pids.
//   --die-with-parent     — kernel reaps child if parent exits.
//
// `--unshare-net` is added for ro, cwd-rw, home-rw (network blocked).
// cwd-rw-net OMITS it (parent network inherited).
//
// `--chdir <cwd>` is added so the wrapped process starts in the
// caller's expected working directory.

import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { defaultDataDir } from '../storage/paths.ts';
// Canonical env allowlist lives in a shared module so the macOS
// runner uses the same source of truth via `/usr/bin/env -i
// KEY=VAL ...` wrap. Without this, 3rd-party credential vars off
// the scrub denylist would leak into the sandboxed bash on darwin
// (sandbox-exec has no kernel-boundary clearenv).
import { SANDBOX_SAFE_ENV_VARS as SAFE_ENV_VARS } from './safe-env-vars.ts';
import { resolveSandboxBinary } from './sandbox-availability.ts';
import { HIDE_PATHS_DIRS, HIDE_PATHS_FILES } from './sandbox-hide-paths.ts';
import { SANDBOX_PROFILE_ORDER, type SandboxProfile, isSandboxProfile } from './sandbox-plan.ts';
import { buildSandboxExecArgv } from './sandbox-runner-macos.ts';

// Session-cached empty regular file used to mask credential FILES (the
// HIDE_PATHS_FILES loop binds it read-only over each path). Pre-fix the
// mask bound `/dev/null` (a char device) — but tools that read those
// paths as config (git 2.54: `fatal: unknown error occurred while reading
// the configuration files`; npm; pip; …) refuse a non-regular config
// file, so the mask BROKE git/npm/… inside the sandbox entirely. An empty
// REGULAR file makes the tool see an empty config (it works) while still
// hiding the real content (no PII leak) and staying read-only (no
// write-plant on home-rw). Created once host-side (bwrap reads the bind
// SOURCE before the namespace `--tmpfs /tmp` view), mode 0600 in our own
// data dir so another local user can't plant content into the mask.
let cachedSandboxMaskFile: string | null = null;
const ensureSandboxMaskFile = (): string => {
  if (cachedSandboxMaskFile !== null) return cachedSandboxMaskFile;
  const dir = defaultDataDir();
  const p = joinPath(dir, 'sandbox-mask-empty');
  try {
    if (!existsSync(p)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(p, '', { mode: 0o600 });
    }
  } catch {
    // Best-effort. If creation fails, the `--ro-bind` below errors at
    // spawn (fail-closed — a missing mask source refuses the call rather
    // than silently leaving the credential file exposed).
  }
  cachedSandboxMaskFile = p;
  return p;
};

// Resolve symlinks in the cwd path BEFORE the hide_paths check +
// mount + chdir. Without this, a literal-string `cwd.startsWith(
// hiddenAbs)` check against HIDE_PATHS_DIRS lets an attacker (with
// write access to a non-sensitive dir) plant `/tmp/work` as a
// symlink to `~/.ssh/audit/`. The guard sees the string "/tmp/work"
// — distinct from "/home/op/.ssh" — and lets it through. bwrap's
// `--bind /tmp/work /tmp/work` then follows the symlink at
// source-bind time, mounting the wrapped process's cwd ON TOP OF
// the real ~/.ssh/audit directory. The sandbox effectively gets
// write access to a path the hide_paths overlay was supposed to
// mask.
//
// realpath() the cwd at build-time so the hide_paths check, the
// `--bind`, and the `--chdir` all see the same canonical absolute
// path. The check then catches the symlink-to-hidden case via
// string match on the canonical target.
//
// Failure-mode policy (all → refuse with diagnostic message):
//   - ENOENT       cwd or an ancestor doesn't exist (e.g. broken
//                  symlink target).
//   - ELOOP        symlink chain loops back on itself.
//   - EACCES/EPERM  some ancestor isn't readable (cwd unreachable
//                  to the realpath syscall).
//   - everything else  refuse defensively; the operator sees the
//                  underlying error code in the message.
//
// Scope: cwd itself only. Symlinks INSIDE cwd (e.g. `cwd/cache →
// ~/.aws/sso/cache`) are NOT canonicalized — known limitation;
// closing it requires either a recursive realpath sweep at every
// spawn (expensive) or a bwrap-level no-follow flag (doesn't
// exist). Operators are advised to canonicalize cwd before
// launching (`cd "$(realpath .)"`).
const canonicalizeCwd = (cwd: string, realpath: (p: string) => string): string => {
  try {
    return realpath(cwd);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const code = err.code;
    let detail: string;
    switch (code) {
      case 'ENOENT':
        detail = `cwd '${cwd}' does not exist (broken symlink target?)`;
        break;
      case 'ELOOP':
        detail = `cwd '${cwd}' symlink chain loops`;
        break;
      case 'EACCES':
      case 'EPERM':
        detail = `cwd '${cwd}' cannot be canonicalized: permission denied (ancestor unreadable?)`;
        break;
      case 'ENOTDIR':
        detail = `cwd '${cwd}' or an ancestor is not a directory`;
        break;
      default:
        detail = `cwd '${cwd}' cannot be canonicalized (code=${code ?? 'unknown'}: ${err.message})`;
    }
    throw new Error(`sandbox: ${detail}`);
  }
};

// Canonicalize `home` BEFORE the HIDE_PATHS overlays and `--bind
// home home` use it. Symmetric with `canonicalizeCwd`. Without this,
// a managed-NFS-style symlink `/home/op → /data/users/op` leaves the
// canonical `.ssh` exposed via the base `--ro-bind / /` while
// HIDE_PATHS only masks the symlink-path form. Failure modes degrade
// to the literal input (best-effort — the wrap proceeds with the
// operator's stated home, the kernel resolves at exec time anyway).
// The bwrap / SBPL overlays at the literal `home` path catch the
// most common case (operator with no symlinked home) without
// breaking the symlinked-home case (because the HIDE_PATHS at
// canonical home now masks the real target).
const canonicalizeHome = (home: string, realpath: (p: string) => string): string => {
  try {
    return realpath(home);
  } catch {
    // Best-effort. Unlike cwd, we don't refuse on home-canonicalize
    // failure — the operator's home may legitimately not exist at
    // canonical-resolve time on tightly-namespaced installs.
    return home;
  }
};

export interface BuildBwrapArgvOptions {
  profile: SandboxProfile;
  // Working directory the wrapped process should start in. For
  // cwd-rw / cwd-rw-net this is also the writable mount target.
  cwd: string;
  // Operator's home. For home-rw, this is the writable mount target.
  home: string;
  // The inner command + args the bwrap wraps. Typical bash tool
  // shape: `['bash', '-s']` — the script body is piped to the
  // child's stdin by the caller to avoid argv exposure in
  // `/proc/<pid>/cmdline`. bwrap forwards its own stdin to the
  // wrapped child by default, so the script reaches bash even
  // through the wrap. Cannot be empty.
  innerArgv: readonly string[];
  // The env from which the SAFE_ENV_VARS allowlist is extracted.
  // bwrap's `--clearenv` + `--setenv KEY VALUE` for each
  // allowlisted var enforces the env shape at the kernel boundary
  // independent of what the caller passes via `Bun.spawn({env})`.
  // Callers SHOULD still pass `scrubEnv(process.env)` — defense in
  // depth — but a missing scrub no longer leaks.
  env: NodeJS.ProcessEnv;
  // Absolute path to the bwrap binary. Default is the bare name
  // 'bwrap' (kernel resolves via $PATH at execve time — re-exposes
  // the shim attack). Production callers via maybeWrapSandboxArgv
  // pass the canonical-first resolved path. Tests building argv
  // directly can omit.
  bwrapPath?: string;
  // Test seam for `realpath()`. Production omits and uses
  // `node:fs.realpathSync`; tests inject a deterministic mapping so
  // the suite can pin a symlink-to-hidden-dir scenario without
  // creating real symlinks on the test runner's filesystem.
  realpath?: (p: string) => string;
  // Existence probe for hide_paths targets. Production omits and
  // uses `node:fs.existsSync`; tests inject a deterministic set so
  // the suite can pin "host has ~/.ssh but not ~/.aws" without
  // touching the runner's real filesystem.
  //
  // Load-bearing for correctness, not just testing. A hide_paths
  // overlay (`--tmpfs <dir>` / `--ro-bind /dev/null <file>`) masks a
  // credential path by mounting OVER it. bwrap can only mount over a
  // mountpoint that exists — for an absent target it first tries to
  // `mkdir` the mountpoint, which lands under the read-only
  // `--ro-bind / /` base and fails with EROFS ("Can't mkdir <path>:
  // Read-only file system"), aborting the ENTIRE spawn before the
  // inner command runs. Since few operators have every entry of
  // HIDE_PATHS_{DIRS,FILES} present, this broke sandbox-enforced
  // spawn-broker calls on almost every host. `shouldMask` (below)
  // gates emission on existence so absent targets under a read-only
  // parent are skipped — they're unreadable (absent) and unwritable
  // (read-only parent), so neither the credential-read nor the
  // create-and-plant threat applies. Writable-parent profiles
  // (home-rw) still mask absent targets: there bwrap CAN create the
  // mountpoint, and the create-and-plant write-tampering vector is
  // live (`~/.gitconfig` core.sshCommand RCE, policy tamper).
  pathExists?: (p: string) => boolean;
  // Test seam — the read-only bind SOURCE used to mask HIDE_PATHS_FILES.
  // Production omits and uses a session-cached empty regular file
  // (`ensureSandboxMaskFile`); tests pin a fixed path so the argv is
  // deterministic without creating a real file on the runner.
  maskFileSource?: string;
  // Forja-internal control-plane env that must survive the
  // `--clearenv` kernel boundary alongside the canonical
  // `SANDBOX_SAFE_ENV_VARS` allowlist. The runner emits one
  // `--setenv KEY VALUE` per entry AFTER the safe-list loop, so an
  // entry whose key collides with a safe-list var wins (bwrap's
  // last-setenv-wins semantics).
  //
  // Use case: the broker self-execs the same compiled binary as
  // the worker (`process.execPath` + `FORJA_BROKER_WORKER=1`); without
  // this passthrough, the env flag dies at `--clearenv` and the inner
  // binary falls through to normal CLI parsing instead of
  // `runWorkerProcess()`, silently breaking sandbox-enforced broker
  // calls on compiled installs.
  //
  // Membership rules deliberately stricter than `SAFE_ENV_VARS`:
  // entries here are forja's own control surface, NOT operator/tool
  // env. The runner verifies values do not contain NUL (same defense
  // as `appendEnvFlags` for the safe-list path) and skips silently
  // when violated. Caller is responsible for supplying only keys
  // forja owns — not a place to relax the host-env allowlist by
  // proxy.
  passthroughEnv?: Record<string, string>;
}

// The env allowlist (`SAFE_ENV_VARS`) and the membership rules
// (what's IN / what's OUT / why) live in
// `src/permissions/safe-env-vars.ts` — single source of truth
// shared with the macOS runner. See that file for the canonical
// list + rationale; this module just consumes it via the import.

// Push `--clearenv` + `--setenv KEY VALUE` for each allowed var
// present in `env`. Vars with NUL bytes are skipped (bwrap argv
// can't carry them) — defensive, since `scrubEnv` returns
// NodeJS.ProcessEnv whose values are JS strings (no embedded NUL
// in practice). Vars with empty-string values ARE forwarded —
// `LC_ALL=""` has semantic meaning in glibc.
//
// `passthroughEnv` (optional) — forja-internal control-plane entries
// appended AFTER the safe-list loop, so a colliding key wins
// (bwrap applies `--setenv` in order, last wins). NUL-byte values
// skipped same as the safe-list path. Empty keys / keys containing
// NUL or `=` are also skipped — `=` would let a value smuggle a
// second KEY=VAL pair into the argv encoding on some shells, and
// `\0` would silently truncate at execve.
const appendEnvFlags = (
  flags: string[],
  env: NodeJS.ProcessEnv,
  passthroughEnv?: Record<string, string>,
): void => {
  flags.push('--clearenv');
  for (const key of SAFE_ENV_VARS) {
    const value = env[key];
    if (value === undefined) continue;
    if (value.includes('\0')) continue;
    flags.push('--setenv', key, value);
  }
  if (passthroughEnv !== undefined) {
    for (const [key, value] of Object.entries(passthroughEnv)) {
      if (key.length === 0) continue;
      if (key.includes('\0') || key.includes('=')) continue;
      if (value.includes('\0')) continue;
      flags.push('--setenv', key, value);
    }
  }
};

// Namespace isolation + new session. Without these flags, four host
// surfaces stay reachable to a sandboxed inner process:
//
//   - UTS (hostname / domainname): readable + writable. The host
//     hostname leaks identity; the writable side is mostly
//     cosmetic but unnecessary.
//   - IPC (SysV IPC + POSIX shared memory): a probe via
//     `ipcs`/`shmget` can read host shared memory segments
//     created by the operator's other processes — leak vector
//     for whatever happens to be live.
//   - cgroup: visibility into the host's cgroup hierarchy reveals
//     which containers/services are running.
//   - controlling tty: the BIG one. Without a new session, the
//     wrapped process inherits the operator's controlling tty
//     and can `ioctl(TIOCSTI)` (Linux ≤ 6.2 default) or
//     `ioctl(TIOCLINUX)` to inject keystrokes into the operator's
//     shell that fire AFTER the sandbox exits. The bwrap manpage
//     documents `--new-session` as the dedicated mitigation.
//
// `--unshare-user-try` is intentionally NOT added: on systems
// where user namespaces are sysctl-disabled (Debian default,
// some corporate kernels) it would either fail-open (the `-try`
// variant proceeds anyway) or fail-closed and break the runner
// entirely. Either way it's policy theater.
//
// `--unshare-cgroup-try` (with the `-try` suffix): cgroup
// namespaces are Linux 4.6+. The `-try` variant skips silently
// on older kernels — strictly better than fail-closed for a
// defense-in-depth feature. UTS/IPC/PID date back to Linux 3.x
// and are safe without `-try`. `--new-session` is a bwrap-level
// flag (setsid call), not a kernel feature.
const COMMON_PROFILE_FLAGS: readonly string[] = [
  '--ro-bind',
  '/',
  '/',
  '--tmpfs',
  '/tmp',
  '--proc',
  '/proc',
  '--dev',
  '/dev',
  '--unshare-pid',
  '--unshare-uts',
  '--unshare-ipc',
  '--unshare-cgroup-try',
  '--new-session',
  '--die-with-parent',
];

// hide_paths — credential dirs + files masked inside every sandbox
// profile. Every profile starts with `--ro-bind / /` which exposes
// the operator's full home read-only inside the sandbox; the LLM
// could read `~/.ssh/id_rsa` even from a `ro` profile without this
// defense. The engine-side protected paths classifier only catches
// calls that surface as resolved capabilities — a sandboxed bash
// process reading the file via `cat ~/.ssh/id_rsa` bypasses the
// engine entirely.
//
// The bwrap defense per path kind:
//   dirs  → `--tmpfs <home>/<dir>` (empty directory overlay)
//   files → `--ro-bind-try /dev/null <home>/<file>` (char device
//           bind: reads return EOF, writes are discarded; the
//           `-try` suffix avoids a hard failure if the source
//           file doesn't exist on the host).
//
// bwrap applies mount operations in argv order; both overlays
// appear AFTER the `--ro-bind / /` so they win even on the
// home-rw profile (where `--bind <home> <home>` also precedes
// the credential overlay).
//
// Canonical path lists live in `sandbox-hide-paths.ts` — shared
// with the macOS runner so the two platforms can't drift on what
// counts as a credential location.

// Build the bwrap argv for a given profile. Pure function.
//
// For host: returns `innerArgv` unchanged. The operator already
// confirmed at the host gate AND the planner already required
// `host-passthrough` in the resolved set; the runner trusts both
// and runs without any wrap.
//
// For the four sandboxed profiles: returns `['bwrap', ...flags,
// '--', ...innerArgv]`. The `--` separator is bwrap's convention
// for "inner command starts here" — caller doesn't need to escape
// its own argv.
export const buildBwrapArgv = (options: BuildBwrapArgvOptions): string[] => {
  const { profile, innerArgv } = options;
  if (innerArgv.length === 0) {
    throw new Error('buildBwrapArgv: innerArgv must not be empty');
  }
  if (profile === 'host') return innerArgv.slice();

  // Canonicalize cwd via realpath BEFORE the hide_paths check and
  // downstream `--bind` / `--chdir`. Without this, a literal-string
  // `startsWith` against the operator-supplied cwd is bypassable
  // via a symlink like `/tmp/work` pointing at `~/.ssh/audit/`.
  // bwrap's `--bind <src> <dst>` follows symlinks at source-bind
  // time, mounting the wrapped process's cwd ON TOP OF the real
  // hidden directory. Canonicalizing here makes all downstream
  // operations (check + bind + chdir) agree on the same resolved
  // absolute path.
  const realpath = options.realpath ?? realpathSync;
  const cwd = canonicalizeCwd(options.cwd, realpath);
  // Same canonicalization for home, so HIDE_PATHS overlays +
  // `--bind home home` apply at the real path. Symlink-to-elsewhere
  // home (managed-NFS layout) leaves the canonical tree unexposed.
  const home = canonicalizeHome(options.home, realpath);

  // Cwd-inside-hidden-dir precondition. If the operator happens to
  // run Forja from `~/.ssh/audit/` (or any cwd nested under a
  // hide_paths root), the LATER `--tmpfs ~/.ssh` overlay would mask
  // the bound cwd inside the sandbox. The inner process would
  // receive a working dir that "vanishes" — opaque bwrap failure
  // with no diagnostic. Refuse at build time with a clear error.
  for (const dir of HIDE_PATHS_DIRS) {
    const hiddenAbs = joinPath(home, dir);
    if (cwd === hiddenAbs || cwd.startsWith(`${hiddenAbs}/`)) {
      throw new Error(
        `buildBwrapArgv: cwd '${cwd}' is inside hide_paths dir '${hiddenAbs}'; the sandbox would mask the cwd mount. Move to a different working directory.`,
      );
    }
  }

  // hide_paths mount-realizability gate. See `pathExists` docstring
  // for the full EROFS failure mode. A mask overlay (`--tmpfs` for
  // dirs, `--ro-bind /dev/null` for files) mounts OVER its target;
  // bwrap can realize that mount only when the target already exists
  // (mount-over works on the read-only base bind) OR its parent is
  // writable inside the sandbox so bwrap can create the mountpoint.
  //
  // Writable roots per profile mirror the `--bind` mounts emitted
  // below: cwd-rw / cwd-rw-net bind `cwd`; home-rw binds `home`; ro
  // binds nothing writable. A target under one of these roots can be
  // created by bwrap; anything else must pre-exist.
  //
  // Skipping an absent target under a read-only parent is SAFE: the
  // sandboxed process can neither read it (absent — the base
  // `--ro-bind / /` exposes only what's on disk) nor write it (parent
  // read-only). On home-rw the parent IS writable, so absent targets
  // are STILL masked — there the create-and-plant vector is real.
  const pathExists = options.pathExists ?? existsSync;
  const writableRoots: readonly string[] =
    profile === 'home-rw' ? [home] : profile === 'cwd-rw' || profile === 'cwd-rw-net' ? [cwd] : [];
  const underWritableRoot = (p: string): boolean =>
    writableRoots.some((root) =>
      // `root === '/'` is the filesystem root (a cwd-rw profile launched
      // from `/`): every absolute path is under it. The generic
      // `${root}/` form would build `//` and match nothing — a
      // segment-boundary pitfall that would skip credential masks on a
      // writable-root profile and reopen the create-and-plant vector.
      root === '/' ? p.startsWith('/') : p === root || p.startsWith(`${root}/`),
    );
  const shouldMask = (absPath: string): boolean =>
    pathExists(absPath) || underWritableRoot(absPath);

  const flags: string[] = [...COMMON_PROFILE_FLAGS];
  // Kernel-level env hygiene: `--clearenv` plus a narrow `--setenv`
  // allowlist replaces userspace-only scrubEnv as the authoritative
  // env shaper. See `appendEnvFlags` for the allowlist rationale.
  appendEnvFlags(flags, options.env, options.passthroughEnv);
  // Network policy.
  if (profile !== 'cwd-rw-net') {
    flags.push('--unshare-net');
  }
  // Writable mounts per profile.
  //
  // Known limitation: bwrap's `--bind <src> <dst>` follows symlinks
  // AT THE SOURCE before mounting. If `<cwd>` itself OR any path
  // inside cwd is a symlink whose TARGET points outside cwd (e.g.,
  // `node_modules` → shared cache, `.cache` → ~/.aws/sso/cache),
  // the inner process can write through the symlink to the
  // symlink's target — which may be OUTSIDE the declared sandbox
  // boundary. bwrap exposes no flag to refuse following symlinks at
  // bind time.
  //
  // Mitigations available to the operator:
  //   1. Don't run Forja from a cwd containing symlinks to
  //      sensitive paths.
  //   2. Use `--sandbox-host` (operator-opted-in passthrough)
  //      when symlinks are legitimate workflow tooling.
  //   3. Pre-realpath cwd before invoking Forja (`cd "$(realpath
  //      .)"`) to canonicalize any leading symlinks.
  //
  // The engine-side `symlink_escape` deny still fires on resolver-
  // detected symlink targets, but the runtime sandbox layer does
  // not duplicate that check.
  if (profile === 'cwd-rw' || profile === 'cwd-rw-net') {
    flags.push('--bind', cwd, cwd);
  } else if (profile === 'home-rw') {
    flags.push('--bind', home, home);
  }
  // hide_paths — mask credential dirs + files. Applied AFTER the
  // writable mounts so that even on home-rw (which binds the full
  // home read-write), the tmpfs / dev-null overlays mask the
  // credential paths inside the sandbox. bwrap applies mount ops
  // in order: the later flag wins.
  //
  // `--bind-try` (not `--bind`) for dirs would skip the path if
  // the source doesn't exist, but we use `--tmpfs` which always
  // creates the mount regardless of host state — every sandbox
  // gets the same shape regardless of whether the operator
  // happens to have `~/.gnupg` set up.
  for (const dir of HIDE_PATHS_DIRS) {
    const abs = joinPath(home, dir);
    if (shouldMask(abs)) flags.push('--tmpfs', abs);
  }
  // XDG_DATA_HOME unmask. `defaultDataDir()` honors $XDG_DATA_HOME
  // at runtime; when the operator sets it outside
  // `$HOME/.local/share`, the canonical `.local/share/forja` overlay
  // above covers the WRONG path — the sandboxed process on
  // `home-rw` would have writable access to the live audit DB at
  // the XDG location. Inject an extra overlay for the live data
  // dir when it differs from the home-relative default. Idempotent:
  // when XDG_DATA_HOME is unset, `liveDataDir ===
  // homeRelativeDataDir` and we skip.
  //
  // Absolute-path guard mirrors the XDG_CONFIG_HOME branch below.
  // Per XDG Base Directory Spec, implementations SHOULD ignore
  // relative values — without the guard, a relative XDG_DATA_HOME
  // produces a relative `liveDataDir` like `relative/forja`,
  // which becomes an invalid bwrap mount target and crashes the
  // sandbox at spawn time instead of falling back to the
  // home-relative default (which is already masked by the
  // HIDE_PATHS_DIRS loop above — `.local/share/forja` covers it).
  const liveDataDir = defaultDataDir();
  const homeRelativeDataDir = joinPath(home, '.local', 'share', 'forja');
  if (
    liveDataDir.startsWith('/') &&
    liveDataDir !== homeRelativeDataDir &&
    shouldMask(liveDataDir)
  ) {
    flags.push('--tmpfs', liveDataDir);
  }
  // XDG_CONFIG_HOME unmask. Analog of the XDG_DATA_HOME fix above.
  // When the operator relocates XDG_CONFIG_HOME outside `~/.config`
  // (e.g. `/srv/conf`), the canonical HIDE_PATHS_DIRS entries
  // beginning with `.config/` cover the WRONG path on disk: bwrap
  // masks `<home>/.config/{gcloud,azure,op,sops,agent,forja}` while
  // the REAL credentials live at
  // `<xdg-config>/{gcloud,azure,op,sops,agent,forja}`. Add a tmpfs
  // overlay at the relocated location for each `.config/*` entry.
  // Idempotent: when XDG_CONFIG_HOME is unset (or set to exactly
  // `<home>/.config`), the effective path matches the home-relative
  // default and we skip.
  const xdgConfig = options.env.XDG_CONFIG_HOME;
  const homeRelativeConfig = joinPath(home, '.config');
  if (
    xdgConfig !== undefined &&
    xdgConfig.length > 0 &&
    xdgConfig.startsWith('/') &&
    xdgConfig !== homeRelativeConfig
  ) {
    for (const dir of HIDE_PATHS_DIRS) {
      if (!dir.startsWith('.config/')) continue;
      const sub = dir.slice('.config/'.length);
      const abs = joinPath(xdgConfig, sub);
      if (shouldMask(abs)) flags.push('--tmpfs', abs);
    }
  }
  // Mask credential FILES with a read-only bind of an empty REGULAR
  // file (NOT `/dev/null` — a char device breaks git/npm/pip config
  // readers; see `ensureSandboxMaskFile`). The tool sees an empty
  // config (it works), the real content stays hidden (no PII leak), and
  // `--ro-bind` keeps it read-only even on home-rw (no write-plant of
  // `~/.gitconfig` core.sshCommand etc.).
  const maskSrc = options.maskFileSource ?? ensureSandboxMaskFile();
  for (const file of HIDE_PATHS_FILES) {
    const abs = joinPath(home, file);
    if (shouldMask(abs)) flags.push('--ro-bind', maskSrc, abs);
  }
  // Start the inner process in cwd.
  flags.push('--chdir', cwd);

  // The bwrap binary path is provided by the caller.
  // `maybeWrapSandboxArgv` resolves it via `resolveSandboxBinary`
  // (canonical /usr/bin/bwrap first; PATH-resolved fallback with
  // trust check). Passing the absolute path here, rather than the
  // bare name 'bwrap', means the kernel execve() loads exactly that
  // file — no re-walk of $PATH at spawn time that would re-expose a
  // shim attack. Default is the bare name for backward
  // compatibility with tests that build argv without going through
  // maybeWrapSandboxArgv.
  const bwrapPath = options.bwrapPath ?? 'bwrap';
  return [bwrapPath, ...flags, '--', ...innerArgv];
};

// Per-spawn-site consume primitive (sandbox runtime wire-up).
// Encapsulates the gate every spawn site has to apply identically.
// The wrap fires only when:
//
//   1. `profile` was set by the planner (engine wired with sandbox).
//   2. `profile` isn't `host` (operator-opted-in passthrough).
//   3. The host platform supports a sandbox tool:
//        Linux  → bwrap available on $PATH
//        darwin → sandbox-exec available on $PATH
//        other  → never (Windows + BSD + etc fall through to passthrough)
//
// Otherwise the helper returns `innerArgv.slice()` (defensive copy
// — caller can mutate without poisoning source data) and the spawn
// proceeds with the inner argv directly. Same degraded-passthrough
// posture across both platforms.
//
// The defensive Bun.which() call is a single PATH lookup — cheap
// enough to live in the hot path. We'd rather pay the lookup per
// spawn than cache + invalidate across session lifetime.
//
// `home` defaults to `process.env.HOME ?? cwd` — in CI containers /
// sandboxed test runs $HOME may be unset, and the `home-rw` profile
// needs SOMETHING to bind. Falling back to cwd keeps the wrap valid
// without throwing or accidentally binding `/root`.
//
// Test seams (`platform`, `which`) override the live probes so the
// suite can pin macOS scenarios from a Linux runner and vice versa.
// Production callers leave both undefined.
//
// `profile` is `string | undefined` so callers don't need a `value
// as SandboxProfile` cast at the wire boundary — the runner
// validates membership at the gate and throws on unknown values.
// The narrowing happens inside, not upstream.
export interface MaybeWrapSandboxArgvOptions {
  profile?: string;
  cwd: string;
  home?: string;
  innerArgv: readonly string[];
  // Env handed to the kernel-level allowlist (bwrap `--clearenv` +
  // `--setenv` on Linux; `/usr/bin/env -i KEY=VAL ... --` wrap of
  // the inner argv on macOS — sandbox-exec doesn't have a native
  // clearenv flag, so we userland-clear right before the inner
  // exec). When unset the helper falls back to `process.env`, which
  // the caller is expected to have already scrubbed via `scrubEnv`
  // before reaching here. Defense in depth: even if the caller
  // forgets to scrub, only the SAFE_ENV_VARS allowlist is forwarded
  // into the wrapped inner process on EITHER platform.
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  which?: (name: string) => string | null;
  // Test seams for the canonical-first resolver. Production callers
  // omit; tests pin `exists` to force the PATH-resolved fallback
  // path (without having to remove /usr/bin/bwrap from the host)
  // and `stat` to exercise the trust-check branches.
  stat?: (path: string) => { uid: number; mode: number } | null;
  exists?: (path: string) => boolean;
  // Test seam for realpath. Production omits (uses
  // `node:fs.realpathSync`); tests pass identity `(p) => p` to skip
  // canonicalization OR a custom mapping to exercise the symlink-
  // to-hidden-dir Refuse path.
  realpath?: (p: string) => string;
  // Existence probe forwarded to `buildBwrapArgv` for the hide_paths
  // mount-realizability gate (Linux only — see
  // BuildBwrapArgvOptions.pathExists). macOS SBPL deny rules don't
  // create mountpoints, so the EROFS failure mode doesn't exist there
  // and the seam is ignored on darwin. Production omits (uses
  // `node:fs.existsSync`).
  pathExists?: (p: string) => boolean;
  // Per-sandbox tmpdir subpath. Only consumed on darwin (Linux's
  // `--tmpfs /tmp` already provides per-sandbox isolation; on
  // Linux this option is a no-op). When set, the macOS SBPL
  // profile's `file-write*` allow on the tmp tree is restricted
  // to this subpath rather than blanket `/tmp` + `/private/tmp`.
  //
  // Caller responsibility:
  //   1. Pre-create the directory (mode 0o700 recommended).
  //   2. Override `TMPDIR=<tmpdir>` in the wrapped process's
  //      env so `mktemp` / `NSTemporaryDirectory` honor the
  //      restricted scope.
  //   3. Clean up post-spawn (or rely on /tmp reboot cleanup).
  //
  // Production callers default to the unrestricted /tmp allow;
  // session-scoped tmpdirs are wired in opt-in.
  tmpdir?: string;
  // Forja-internal control-plane env to forward through the kernel-
  // boundary clearenv. Forwarded verbatim to both the Linux runner
  // (extra `--setenv` flags) and the macOS runner (extra
  // `KEY=VAL` entries inside the `/usr/bin/env -i` wrap). Not for
  // operator/tool env — that goes through `SAFE_ENV_VARS`. See the
  // BuildBwrapArgvOptions.passthroughEnv docstring for the threat
  // shape + membership rules.
  passthroughEnv?: Record<string, string>;
}

// Resolve `innerArgv[0]` to an absolute path AT WRAP TIME using the
// OUTER process's $PATH (trusted by the operator). The kernel inside
// the sandbox then execve's the resolved absolute path verbatim — no
// $PATH re-walk, no shim hijack.
//
// Threat: cwd-rw profiles grant write to cwd; if cwd happens to be
// on PATH (uncommon, but possible — operators with cwd=`/tmp` +
// `PATH=/tmp:...` exist), a prior sandboxed call could plant
// `/tmp/bash` and the next call's bare-name `bash` resolves to the
// shim via the kernel's execve $PATH re-walk inside the sandbox.
//
// Best-effort: if `which` can't resolve (rare; the `availability`
// probe already validated the wrap can succeed), fall back to the
// literal argv — the sandboxed exec will fail loudly rather than
// silently picking a shim. Absolute paths are passed through
// unchanged.
const canonicalizeInnerArgv = (
  innerArgv: readonly string[],
  which: (name: string) => string | null,
): readonly string[] => {
  if (innerArgv.length === 0) return innerArgv;
  const head = innerArgv[0] ?? '';
  if (head.length === 0 || head.startsWith('/')) return innerArgv;
  const resolved = which(head);
  if (resolved === null || !resolved.startsWith('/')) return innerArgv;
  return [resolved, ...innerArgv.slice(1)];
};

export const maybeWrapSandboxArgv = (options: MaybeWrapSandboxArgvOptions): string[] => {
  const { profile, cwd, home, innerArgv } = options;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const which = options.which ?? ((name) => Bun.which(name));
  const stat = options.stat;
  const exists = options.exists;
  const realpath = options.realpath;

  // Wire-validation gate. The TypeScript `SandboxProfile`
  // annotation is erased at runtime — any caller that runs a
  // `value as SandboxProfile` cast on attacker-controlled input
  // would slip an unknown string past the type checker. Validate
  // that every defined profile is in the enum BEFORE any branch
  // can act on it. Throws (the broker maps to `'sandbox wrap
  // failed: unknown profile'`) rather than silently passing
  // through, so a hostile `BrokerRequest.sandboxProfile =
  // 'attacker'` doesn't pivot through the platform fallback into an
  // unsandboxed exec.
  if (profile !== undefined && !isSandboxProfile(profile)) {
    throw new Error(
      `sandbox: unknown profile '${String(profile)}' (expected one of: ${SANDBOX_PROFILE_ORDER.join(', ')})`,
    );
  }

  if (profile === undefined || profile === 'host') return innerArgv.slice();

  // Use the canonical-first resolver. /usr/bin/<tool> wins by
  // default; PATH-resolved fallback applies stat-check + trust
  // marker. The resolved absolute path becomes argv[0] of the
  // spawn, so the kernel's execve doesn't re-walk $PATH at exec
  // time and a shim earlier in PATH no longer hijacks the wrap.
  const resolveOpts: Parameters<typeof resolveSandboxBinary>[1] = { which };
  if (stat !== undefined) resolveOpts.stat = stat;
  if (exists !== undefined) resolveOpts.exists = exists;

  // Refuse the wrap when home cannot be resolved. A silent fallback
  // chain `home ?? env.HOME ?? cwd` would land on `cwd` when no
  // caller passes `home` AND `env.HOME` is unset (Docker `CMD`
  // without `-e HOME`, systemd-run --user one-shot, GitHub Actions
  // with `HOME` explicitly unset). The downstream `buildBwrapArgv`
  // / `buildSandboxExecArgv` would then construct HIDE_PATHS
  // overlays at `joinPath(cwd, '.ssh')` (empty paths inside cwd)
  // while the REAL `/home/operator/.ssh/id_rsa` stays exposed via
  // the base `--ro-bind / /` overlay. An LLM-driven bash inside the
  // sandbox could `cat /home/operator/.ssh/id_rsa` and exfiltrate.
  //
  // Operators who actually want to run without a home dir set
  // (extremely rare) get a clear refuse with a diagnostic instead
  // of a silent demotion.
  const resolvedHome = home ?? env.HOME ?? process.env.HOME;
  if (resolvedHome === undefined || resolvedHome.length === 0) {
    throw new Error(
      'sandbox: cannot resolve operator home (no `home` option, no $HOME env). Refusing wrap to avoid HIDE_PATHS landing in the wrong tree.',
    );
  }

  // Pin innerArgv[0] to an absolute path BEFORE the builders see
  // it, so the kernel-side execve inside the sandbox doesn't
  // re-walk $PATH and pick up a shim from a writable profile-mount.
  // See canonicalizeInnerArgv docstring above.
  const canonicalInner = canonicalizeInnerArgv(innerArgv, which);

  if (platform === 'linux') {
    const r = resolveSandboxBinary('bwrap', resolveOpts);
    if (r.path !== null) {
      const bwrapOpts: Parameters<typeof buildBwrapArgv>[0] = {
        profile: profile as Exclude<SandboxProfile, 'host'>,
        cwd,
        home: resolvedHome,
        innerArgv: canonicalInner,
        env,
        bwrapPath: r.path,
      };
      if (realpath !== undefined) bwrapOpts.realpath = realpath;
      if (options.pathExists !== undefined) bwrapOpts.pathExists = options.pathExists;
      if (options.passthroughEnv !== undefined) bwrapOpts.passthroughEnv = options.passthroughEnv;
      return buildBwrapArgv(bwrapOpts);
    }
  }

  if (platform === 'darwin') {
    const r = resolveSandboxBinary('sandbox-exec', resolveOpts);
    if (r.path !== null) {
      const macOpts: Parameters<typeof buildSandboxExecArgv>[0] = {
        profile: profile as Exclude<SandboxProfile, 'host'>,
        cwd,
        home: resolvedHome,
        innerArgv: canonicalInner,
        sandboxExecPath: r.path,
      };
      if (realpath !== undefined) macOpts.realpath = realpath;
      // Forward tmpdir to restrict SBPL write allow to that subpath
      // on macOS. Linux ignores tmpdir entirely (--tmpfs /tmp
      // already gives isolation).
      if (options.tmpdir !== undefined) macOpts.tmpdir = options.tmpdir;
      // Forward the (already-resolved) env so `buildSandboxExecArgv`
      // can wrap the inner argv with `/usr/bin/env -i KEY=VAL ... --`
      // and emulate Linux's `--clearenv` kernel boundary.
      macOpts.env = env;
      if (options.passthroughEnv !== undefined) macOpts.passthroughEnv = options.passthroughEnv;
      return buildSandboxExecArgv(macOpts);
    }
  }

  // No sandbox tool available — degraded passthrough. The engine's
  // sandbox-plan stage is responsible for routing to host (or
  // refusing) when sandboxing is required; this helper only
  // enforces the wrap when both the profile AND the platform/
  // tooling agree.
  return innerArgv.slice();
};
