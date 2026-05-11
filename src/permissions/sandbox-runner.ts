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

import type { SandboxProfile } from './sandbox-plan.ts';

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

  const flags: string[] = [...COMMON_PROFILE_FLAGS];
  // Network policy.
  if (profile !== 'cwd-rw-net') {
    flags.push('--unshare-net');
  }
  // Writable mounts per profile.
  if (profile === 'cwd-rw' || profile === 'cwd-rw-net') {
    flags.push('--bind', cwd, cwd);
  } else if (profile === 'home-rw') {
    flags.push('--bind', home, home);
  }
  // Start the inner process in cwd.
  flags.push('--chdir', cwd);

  return ['bwrap', ...flags, '--', ...innerArgv];
};

// Per-spawn-site consume primitive (§6.5 runtime wire-up).
// Encapsulates the four-condition gate every spawn site has to
// apply identically:
//
//   1. `profile` was set by the planner (engine wired with sandbox).
//   2. `profile` isn't `host` (operator-opted-in passthrough).
//   3. `process.platform === 'linux'` (bwrap is Linux-only).
//   4. `Bun.which('bwrap') !== null` (defensive recheck — bootstrap
//      detected once at startup; a package update can remove the
//      binary mid-session).
//
// All four must hold for the wrap to fire. Otherwise the helper
// returns `innerArgv.slice()` (defensive copy — caller can mutate
// without poisoning source data) and the spawn proceeds with the
// inner argv directly.
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
export interface MaybeWrapSandboxArgvOptions {
  profile?: SandboxProfile;
  cwd: string;
  home?: string;
  innerArgv: readonly string[];
}

export const maybeWrapSandboxArgv = (options: MaybeWrapSandboxArgvOptions): string[] => {
  const { profile, cwd, home, innerArgv } = options;
  const shouldWrap =
    profile !== undefined &&
    profile !== 'host' &&
    process.platform === 'linux' &&
    Bun.which('bwrap') !== null;
  if (!shouldWrap) return innerArgv.slice();
  return buildBwrapArgv({
    profile: profile as Exclude<SandboxProfile, 'host'>,
    cwd,
    home: home ?? process.env.HOME ?? cwd,
    innerArgv,
  });
};
