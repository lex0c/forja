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

import { join as joinPath } from 'node:path';
import { HIDE_PATHS_DIRS, HIDE_PATHS_FILES } from './sandbox-hide-paths.ts';
import { SANDBOX_PROFILE_ORDER, type SandboxProfile, isSandboxProfile } from './sandbox-plan.ts';
import { buildSandboxExecArgv } from './sandbox-runner-macos.ts';

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
}

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
  const { profile, cwd, home, innerArgv } = options;
  if (innerArgv.length === 0) {
    throw new Error('buildBwrapArgv: innerArgv must not be empty');
  }
  if (profile === 'host') return innerArgv.slice();

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

  return ['bwrap', ...flags, '--', ...innerArgv];
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
  platform?: NodeJS.Platform;
  which?: (name: string) => string | null;
}

export const maybeWrapSandboxArgv = (options: MaybeWrapSandboxArgvOptions): string[] => {
  const { profile, cwd, home, innerArgv } = options;
  const platform = options.platform ?? process.platform;
  const which = options.which ?? ((name) => Bun.which(name));

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

  if (platform === 'linux' && which('bwrap') !== null) {
    return buildBwrapArgv({
      profile: profile as Exclude<SandboxProfile, 'host'>,
      cwd,
      home: home ?? process.env.HOME ?? cwd,
      innerArgv,
    });
  }

  if (platform === 'darwin' && which('sandbox-exec') !== null) {
    return buildSandboxExecArgv({
      profile: profile as Exclude<SandboxProfile, 'host'>,
      cwd,
      home: home ?? process.env.HOME ?? cwd,
      innerArgv,
    });
  }

  // No sandbox tool available — degraded passthrough. The engine's
  // §6.5 plan stage is responsible for routing to host (or refusing)
  // when sandboxing is required; this helper only enforces the wrap
  // when both the profile AND the platform/tooling agree.
  return innerArgv.slice();
};
