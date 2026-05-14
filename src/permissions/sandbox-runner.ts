// Sandbox argv synthesis per PERMISSION_ENGINE.md §6.5 (Linux/bwrap).
//
// Slice 10 picked the profile (`selectSandboxProfile`); this slice
// synthesizes the actual bwrap command line that wraps a tool's
// inner argv. The wrap is the enforcement surface — the engine's
// "this call gets profile X" decision becomes a real OS-level
// isolation by feeding `buildBwrapArgv(...)` into `Bun.spawn(...)`.
//
// Out of scope for THIS slice: wiring the builder into the bash
// tool's spawn site. Decision shape, ctx threading, and the spawn-
// site change land in the next slice. This file is pure-function
// today; one helper per profile, all returning string[] for the
// caller to hand to Bun.spawn.
//
// Platform: Linux only. macOS uses sandbox-exec / SBPL — see
// `sandbox-runner-macos.ts` (slice 47). Spawn-site dispatch by
// platform lives in `maybeWrapSandboxArgv` (currently Linux-only;
// a follow-up slice updates it to route to the macOS builder
// when `process.platform === 'darwin'`). Detection lives at the
// bootstrap layer (`detectSandboxAvailability`) — this module
// trusts the profile argument and never inspects environment.
//
// Profile flag rationale (spec §6.5 mounts/network/process columns):
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

import { realpathSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { defaultDataDir } from '../storage/paths.ts';
import { resolveSandboxBinary } from './sandbox-availability.ts';
import { HIDE_PATHS_DIRS, HIDE_PATHS_FILES } from './sandbox-hide-paths.ts';
import { SANDBOX_PROFILE_ORDER, type SandboxProfile, isSandboxProfile } from './sandbox-plan.ts';
import { buildSandboxExecArgv } from './sandbox-runner-macos.ts';

// Slice 155 (review — symlink canonicalization for cwd guard):
// resolve symlinks in the cwd path BEFORE the hide_paths check +
// mount + chdir. Pre-slice the runner did a literal-string
// `cwd.startsWith(hiddenAbs)` check against HIDE_PATHS_DIRS. An
// operator (or attacker with write access to a non-sensitive dir)
// could plant `/tmp/work` as a symlink to `~/.ssh/audit/`. The
// guard saw the string "/tmp/work" — distinct from "/home/op/.ssh"
// — and let it through. bwrap's `--bind /tmp/work /tmp/work` then
// followed the symlink at source-bind time, mounting the wrapped
// process's cwd ON TOP OF the real ~/.ssh/audit directory. The
// sandbox effectively had write access to a path the hide_paths
// overlay was supposed to mask.
//
// Fix: realpath() the cwd at build-time so the hide_paths check,
// the `--bind`, and the `--chdir` all see the same canonical
// absolute path. The check then catches the symlink-to-hidden
// case via string match on the canonical target.
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
// ~/.aws/sso/cache`) are NOT canonicalized — that's a known
// limitation documented in the slice 125 comment block, and
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

export interface BuildBwrapArgvOptions {
  profile: SandboxProfile;
  // Working directory the wrapped process should start in. For
  // cwd-rw / cwd-rw-net this is also the writable mount target.
  cwd: string;
  // Operator's home. For home-rw, this is the writable mount target.
  home: string;
  // The inner command + args the bwrap wraps. Typical bash tool
  // shape: `['bash', '-c', '<command>']`. Cannot be empty.
  innerArgv: readonly string[];
  // Slice 145 (S2 — env-scrub defense in depth): the env from which
  // the SAFE_ENV_VARS allowlist is extracted. Pre-slice the wrap
  // had no env input — bwrap inherited the parent's env verbatim
  // via `Bun.spawn({env})`, making userspace `scrubEnv` the SOLE
  // defense against `LD_PRELOAD`/`NODE_OPTIONS`/etc. If a future
  // spawn site forgets to call `scrubEnv`, the kernel boundary
  // collapsed silently. Now `--clearenv` + `--setenv KEY VALUE`
  // for each allowlisted var means bwrap enforces the env shape
  // independent of what the caller passes via `Bun.spawn({env})`.
  // Callers SHOULD still pass `scrubEnv(process.env)` here
  // — defense in depth — but a missing scrub no longer leaks.
  env: NodeJS.ProcessEnv;
  // Slice 154 (review — PATH-shim resistance): absolute path to
  // the bwrap binary. Default is the bare name 'bwrap' (kernel
  // resolves via $PATH at execve time — re-exposes the shim
  // attack). Production callers via maybeWrapSandboxArgv pass the
  // canonical-first resolved path. Tests building argv directly
  // can omit (passthrough = legacy behavior).
  bwrapPath?: string;
  // Slice 155 (review — symlink canonicalization): test seam for
  // `realpath()`. Production omits and uses `node:fs.realpathSync`;
  // tests inject a deterministic mapping so the suite can pin a
  // symlink-to-hidden-dir scenario without creating real symlinks
  // on the test runner's filesystem.
  realpath?: (p: string) => string;
}

// Slice 145 (S2): env vars the sandboxed inner process is allowed
// to inherit. Everything else is blocked at the kernel boundary
// via `--clearenv`. This is INTENTIONALLY a narrow list — the
// goal is "enough for bash + common posix tooling to function",
// not "convenient for arbitrary scripts".
//
// What's IN:
//   PATH        — binary lookup
//   HOME        — tilde expansion + tools that read $HOME
//   USER/LOGNAME— identity for tools that look it up
//   SHELL       — bash uses $SHELL for sub-shell invocation
//   TERM        — terminal type; mostly cosmetic but cheap
//   LANG/LC_*   — locale; affects sort order, date format, etc.
//   TZ          — timezone for date/time output
//   TMPDIR      — temp dir; bash + many tools honor this
//
// What's OUT (and why):
//   LD_*, DYLD_*  — linker injection (sanitize/env.ts blocks too)
//   NODE_OPTIONS  — Node code injection
//   PYTHON*       — Python module / startup injection
//   PERL5*, RUBY* — same threat for those interpreters
//   BASH_ENV, ENV — bash auto-source on every non-interactive shell
//   HTTPS_PROXY, HTTP_PROXY, ALL_PROXY — egress MITM redirect
//   XDG_*         — user dirs; defaults are fine
//   DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR — host service access
//   GIT_*         — git config-via-env injection
//   SSH_AUTH_SOCK, GPG_AGENT_INFO, etc. — agent socket access
//   *_TOKEN, *_KEY, *_PASS, *_SECRET    — credentials
//
// Adding a new entry requires explicit justification in this
// comment block + a corresponding test in sandbox-runner.test.ts.
const SAFE_ENV_VARS: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_COLLATE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
  'LC_MONETARY',
  'TZ',
  'TMPDIR',
];

// Push `--clearenv` + `--setenv KEY VALUE` for each allowed var
// present in `env`. Vars with NUL bytes are skipped (bwrap argv
// can't carry them) — defensive, since `scrubEnv` returns
// NodeJS.ProcessEnv whose values are JS strings (no embedded NUL
// in practice). Vars with empty-string values ARE forwarded —
// `LC_ALL=""` has semantic meaning in glibc.
const appendEnvFlags = (flags: string[], env: NodeJS.ProcessEnv): void => {
  flags.push('--clearenv');
  for (const key of SAFE_ENV_VARS) {
    const value = env[key];
    if (value === undefined) continue;
    if (value.includes('\0')) continue;
    flags.push('--setenv', key, value);
  }
};

// Slice 145 (S1 — sandbox hardening): namespace isolation + new
// session. Pre-slice the wrapper unshared only pid (and net,
// conditionally) — leaving four host surfaces reachable to a
// sandboxed inner process:
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

// §9 hide_paths — credential dirs + files masked inside every
// sandbox profile (slice 118 dirs, slice 118 files, R4). Every
// profile starts with `--ro-bind / /` which exposes the
// operator's full home read-only inside the sandbox; the LLM
// could read `~/.ssh/id_rsa` even from a `ro` profile without
// this defense. Slice 97 hardened the engine-side §11 protected
// paths classifier, but that only catches calls that surface as
// resolved capabilities — a sandboxed bash process reading the
// file via `cat ~/.ssh/id_rsa` bypasses the engine entirely.
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
// with the macOS runner (slice 119, R4) so the two platforms
// can't drift on what counts as a credential location.

// Build the bwrap argv for a given profile. Pure function.
//
// For host: returns `innerArgv` unchanged. The operator already
// confirmed at the §6.5 host gate AND the planner already required
// `host-passthrough` in the resolved set; the runner trusts both
// and runs without any wrap.
//
// For the four sandboxed profiles: returns `['bwrap', ...flags,
// '--', ...innerArgv]`. The `--` separator is bwrap's convention
// for "inner command starts here" — caller doesn't need to escape
// its own argv.
export const buildBwrapArgv = (options: BuildBwrapArgvOptions): string[] => {
  const { profile, home, innerArgv } = options;
  if (innerArgv.length === 0) {
    throw new Error('buildBwrapArgv: innerArgv must not be empty');
  }
  if (profile === 'host') return innerArgv.slice();

  // Slice 155 (review — symlink canonicalization for cwd guard):
  // canonicalize the cwd via realpath BEFORE the hide_paths check
  // and downstream `--bind` / `--chdir`. Pre-slice the guard was a
  // literal-string `startsWith` against the operator-supplied cwd,
  // which an operator (or attacker with write access to a non-
  // sensitive dir) could bypass via a symlink like `/tmp/work`
  // pointing at `~/.ssh/audit/`. bwrap's `--bind <src> <dst>`
  // follows symlinks at source-bind time, mounting the wrapped
  // process's cwd ON TOP OF the real hidden directory. The string
  // check saw "/tmp/work" and let it through. Canonicalizing here
  // makes all downstream operations (check + bind + chdir) agree
  // on the same resolved absolute path, closing the bypass.
  const realpath = options.realpath ?? realpathSync;
  const cwd = canonicalizeCwd(options.cwd, realpath);

  // Slice 125 (R2 P0-4 guard): cwd-inside-hidden-dir precondition.
  // If the operator happens to run Forja from `~/.ssh/audit/` (or
  // any cwd nested under a hide_paths root), the LATER `--tmpfs
  // ~/.ssh` overlay would mask the bound cwd inside the sandbox.
  // The inner process would receive a working dir that "vanishes"
  // — opaque bwrap failure with no diagnostic. Refuse at build
  // time with a clear error.
  for (const dir of HIDE_PATHS_DIRS) {
    const hiddenAbs = joinPath(home, dir);
    if (cwd === hiddenAbs || cwd.startsWith(`${hiddenAbs}/`)) {
      throw new Error(
        `buildBwrapArgv: cwd '${cwd}' is inside hide_paths dir '${hiddenAbs}'; the sandbox would mask the cwd mount. Move to a different working directory.`,
      );
    }
  }

  const flags: string[] = [...COMMON_PROFILE_FLAGS];
  // Slice 145 (S2): kernel-level env hygiene. `--clearenv` plus a
  // narrow `--setenv` allowlist replaces userspace-only scrubEnv
  // as the authoritative env shaper. See `appendEnvFlags` comment
  // for the allowlist rationale.
  appendEnvFlags(flags, options.env);
  // Network policy.
  if (profile !== 'cwd-rw-net') {
    flags.push('--unshare-net');
  }
  // Writable mounts per profile.
  //
  // Slice 125 (R2 P0-4 known limitation): bwrap's `--bind <src>
  // <dst>` follows symlinks AT THE SOURCE before mounting. If
  // `<cwd>` itself OR any path inside cwd is a symlink whose
  // TARGET points outside cwd (e.g., `node_modules` → shared
  // cache, `.cache` → ~/.aws/sso/cache), the inner process can
  // write through the symlink to the symlink's target — which
  // may be OUTSIDE the declared sandbox boundary. bwrap exposes
  // no flag to refuse following symlinks at bind time.
  //
  // Documented as a known limitation. Mitigations available to
  // the operator:
  //   1. Don't run Forja from a cwd containing symlinks to
  //      sensitive paths.
  //   2. Use `--sandbox-host` (operator-opted-in passthrough)
  //      when symlinks are legitimate workflow tooling.
  //   3. Pre-realpath cwd before invoking Forja (`cd "$(realpath
  //      .)"`) to canonicalize any leading symlinks.
  //
  // Engine-side §4.3 `symlink_escape` deny still fires on resolver-
  // detected symlink targets, but the runtime sandbox layer does
  // not duplicate that check.
  if (profile === 'cwd-rw' || profile === 'cwd-rw-net') {
    flags.push('--bind', cwd, cwd);
  } else if (profile === 'home-rw') {
    flags.push('--bind', home, home);
  }
  // §9 hide_paths — mask credential dirs + files (slice 118, R4).
  // Applied AFTER the writable mounts so that even on home-rw
  // (which binds the full home read-write), the tmpfs / dev-null
  // overlays mask the credential paths inside the sandbox.
  // bwrap applies mount ops in order: the later flag wins.
  //
  // `--bind-try` (not `--bind`) for dirs would skip the path if
  // the source doesn't exist, but we use `--tmpfs` which always
  // creates the mount regardless of host state — every sandbox
  // gets the same shape regardless of whether the operator
  // happens to have `~/.gnupg` set up.
  for (const dir of HIDE_PATHS_DIRS) {
    flags.push('--tmpfs', joinPath(home, dir));
  }
  // Slice 140 sec-1: XDG_DATA_HOME unmask. `defaultDataDir()`
  // honors $XDG_DATA_HOME at runtime; when the operator sets it
  // outside `$HOME/.local/share`, the canonical
  // `.local/share/forja` overlay above covers the WRONG path —
  // the sandboxed process on `home-rw` would have writable access
  // to the live audit DB at the XDG location. Inject an extra
  // overlay for the live data dir when it differs from the
  // home-relative default. Idempotent: when XDG_DATA_HOME is
  // unset, `liveDataDir === homeRelativeDataDir` and we skip.
  const liveDataDir = defaultDataDir();
  const homeRelativeDataDir = joinPath(home, '.local', 'share', 'forja');
  if (liveDataDir !== homeRelativeDataDir) {
    flags.push('--tmpfs', liveDataDir);
  }
  // Slice 146 (review minor): XDG_CONFIG_HOME unmask. Analog of
  // slice 140 sec-1's XDG_DATA_HOME fix, extended to XDG_CONFIG_HOME.
  // When the operator relocates XDG_CONFIG_HOME outside `~/.config`
  // (e.g. `/srv/conf`), the canonical HIDE_PATHS_DIRS entries
  // beginning with `.config/` cover the WRONG path on disk:
  // bwrap masks `<home>/.config/{gcloud,azure,op,sops,agent,forja}`
  // while the REAL credentials live at
  // `<xdg-config>/{gcloud,azure,op,sops,agent,forja}`. Add a
  // tmpfs overlay at the relocated location for each `.config/*`
  // entry. Idempotent: when XDG_CONFIG_HOME is unset (or set to
  // exactly `<home>/.config`), the effective path matches the
  // home-relative default and we skip.
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
      flags.push('--tmpfs', joinPath(xdgConfig, sub));
    }
  }
  // For files we use `--ro-bind /dev/null <file>`. bwrap can
  // bind char devices over regular files (the mount makes the
  // file appear as /dev/null — reads return EOF, writes are
  // discarded). `--ro-bind` keeps the overlay read-only even
  // on home-rw, so the operator can't accidentally "create"
  // a credential file by writing to the masked path.
  for (const file of HIDE_PATHS_FILES) {
    flags.push('--ro-bind-try', '/dev/null', joinPath(home, file));
  }
  // Start the inner process in cwd.
  flags.push('--chdir', cwd);

  // Slice 154 (review — PATH-shim resistance): the bwrap binary
  // path is provided by the caller. `maybeWrapSandboxArgv` resolves
  // it via `resolveSandboxBinary` (canonical /usr/bin/bwrap first;
  // PATH-resolved fallback with trust check). Passing the absolute
  // path here, rather than the bare name 'bwrap', means the kernel
  // execve() loads exactly that file — no re-walk of $PATH at
  // spawn time that would re-expose a shim attack. Default is the
  // bare name for backward compatibility with tests that build
  // argv without going through maybeWrapSandboxArgv.
  const bwrapPath = options.bwrapPath ?? 'bwrap';
  return [bwrapPath, ...flags, '--', ...innerArgv];
};

// Per-spawn-site consume primitive (§6.5 runtime wire-up).
// Encapsulates the gate every spawn site has to apply identically.
// The wrap fires only when:
//
//   1. `profile` was set by the planner (engine wired with sandbox).
//   2. `profile` isn't `host` (operator-opted-in passthrough).
//   3. The host platform supports a sandbox tool:
//        Linux  → bwrap available on $PATH
//        darwin → sandbox-exec available on $PATH (slice 48)
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
// `home` defaults to `process.env.HOME ?? cwd` — same fallback
// rationale as bash.ts: in CI containers / sandboxed test runs
// $HOME may be unset, and the `home-rw` profile needs SOMETHING
// to bind. Falling back to cwd keeps the wrap valid without
// throwing or accidentally binding `/root`.
//
// Test seams (`platform`, `which`) override the live probes so the
// suite can pin macOS scenarios from a Linux runner and vice versa.
// Production callers leave both undefined.
// `profile` widened to `string | undefined` (slice 103, R6 #9) so
// callers don't need a `value as SandboxProfile` cast at the wire
// boundary — the runner validates membership at the gate and
// throws on unknown values. The narrowing happens inside, not
// upstream.
export interface MaybeWrapSandboxArgvOptions {
  profile?: string;
  cwd: string;
  home?: string;
  innerArgv: readonly string[];
  // Slice 145 (S2): env handed to the kernel-level allowlist (bwrap
  // `--clearenv` + `--setenv` on Linux; macOS sandbox-exec doesn't
  // need it — it doesn't strip env). When unset the helper falls back
  // to `process.env`, which the caller is expected to have already
  // scrubbed via `scrubEnv` before reaching here. Defense in depth:
  // even if the caller forgets to scrub, only the SAFE_ENV_VARS
  // allowlist is forwarded into the bwrap'd inner process.
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  which?: (name: string) => string | null;
  // Slice 154 (review — PATH-shim resistance): test seams for the
  // canonical-first resolver. Production callers omit; tests pin
  // `exists` to force the PATH-resolved fallback path (without
  // having to remove /usr/bin/bwrap from the host) and `stat` to
  // exercise the trust-check branches.
  stat?: (path: string) => { uid: number; mode: number } | null;
  exists?: (path: string) => boolean;
  // Slice 155 (review — symlink canonicalization): test seam for
  // realpath. Production omits (uses `node:fs.realpathSync`); tests
  // pass identity `(p) => p` to skip canonicalization OR a custom
  // mapping to exercise the symlink-to-hidden-dir Refuse path.
  realpath?: (p: string) => string;
}

export const maybeWrapSandboxArgv = (options: MaybeWrapSandboxArgvOptions): string[] => {
  const { profile, cwd, home, innerArgv } = options;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const which = options.which ?? ((name) => Bun.which(name));
  const stat = options.stat;
  const exists = options.exists;
  const realpath = options.realpath;

  // Wire-validation gate (slice 103, R6 #9). The TypeScript
  // `SandboxProfile` annotation is erased at runtime — any caller
  // that runs a `value as SandboxProfile` cast on attacker-
  // controlled input would slip an unknown string past the type
  // checker. Bootstrap previously did exactly this. Validate that
  // every defined profile is in the enum BEFORE any branch can
  // act on it. Throws (the broker maps to `'sandbox wrap failed:
  // unknown profile'`) rather than silently passing through, so a
  // hostile `BrokerRequest.sandboxProfile = 'attacker'` doesn't
  // pivot through the platform fallback into an unsandboxed exec.
  if (profile !== undefined && !isSandboxProfile(profile)) {
    throw new Error(
      `sandbox: unknown profile '${String(profile)}' (expected one of: ${SANDBOX_PROFILE_ORDER.join(', ')})`,
    );
  }

  if (profile === undefined || profile === 'host') return innerArgv.slice();

  // Slice 154 (review — PATH-shim resistance): use the canonical-
  // first resolver. /usr/bin/<tool> wins by default; PATH-resolved
  // fallback applies stat-check + trust marker. The resolved
  // absolute path becomes argv[0] of the spawn, so the kernel's
  // execve doesn't re-walk $PATH at exec time and a shim earlier
  // in PATH no longer hijacks the wrap.
  const resolveOpts: Parameters<typeof resolveSandboxBinary>[1] = { which };
  if (stat !== undefined) resolveOpts.stat = stat;
  if (exists !== undefined) resolveOpts.exists = exists;

  if (platform === 'linux') {
    const r = resolveSandboxBinary('bwrap', resolveOpts);
    if (r.path !== null) {
      const bwrapOpts: Parameters<typeof buildBwrapArgv>[0] = {
        profile: profile as Exclude<SandboxProfile, 'host'>,
        cwd,
        home: home ?? env.HOME ?? cwd,
        innerArgv,
        env,
        bwrapPath: r.path,
      };
      if (realpath !== undefined) bwrapOpts.realpath = realpath;
      return buildBwrapArgv(bwrapOpts);
    }
  }

  if (platform === 'darwin') {
    const r = resolveSandboxBinary('sandbox-exec', resolveOpts);
    if (r.path !== null) {
      const macOpts: Parameters<typeof buildSandboxExecArgv>[0] = {
        profile: profile as Exclude<SandboxProfile, 'host'>,
        cwd,
        home: home ?? process.env.HOME ?? cwd,
        innerArgv,
        sandboxExecPath: r.path,
      };
      if (realpath !== undefined) macOpts.realpath = realpath;
      return buildSandboxExecArgv(macOpts);
    }
  }

  // No sandbox tool available — degraded passthrough. The engine's
  // §6.5 plan stage is responsible for routing to host (or refusing)
  // when sandboxing is required; this helper only enforces the wrap
  // when both the profile AND the platform/tooling agree.
  return innerArgv.slice();
};
