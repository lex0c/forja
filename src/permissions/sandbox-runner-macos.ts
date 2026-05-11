// Sandbox argv synthesis per PERMISSION_ENGINE.md §6.5 (macOS /
// sandbox-exec). Parallel to `sandbox-runner.ts`'s Linux/bwrap
// surface — same input shape, same per-profile mounting/network
// rules, different OS-level enforcement primitive.
//
// macOS ships `sandbox-exec` at /usr/bin/sandbox-exec on every
// supported version (10.5+). Profile syntax is SBPL — Apple's
// Sandbox Profile Language, S-expression-shaped:
//
//   (version 1)
//   (deny default)
//   (allow process-exec)
//   (allow file-read*)
//   (allow file-write* (subpath "/some/path"))
//
// sandbox-exec accepts the profile either via -p "<inline-string>"
// or -f <file>. We use -p; the profile is small (<1 KB per
// profile) so the inline form avoids a tempfile.
//
// Out of scope for THIS slice (slice 47): wiring the builder into
// the spawn-site dispatch (`maybeWrapSandboxArgv`). Decision +
// platform-dispatch land in the next slice (paralleling slice 19
// for Linux). This file is pure-function today; one helper per
// profile, all returning string[] for the caller to hand to
// Bun.spawn.
//
// Profile flag rationale (spec §6.5 mounts/network/process columns):
//
//   ro          — read-only filesystem (deny file-write*). No
//                 network (deny network*). process-exec allowed
//                 (the wrapped tool runs SOMETHING).
//   cwd-rw      — ro + writable subpath at `cwd`. No network.
//                 /tmp also writable (matches Linux's --tmpfs /tmp).
//   cwd-rw-net  — same as cwd-rw plus (allow network*).
//   home-rw     — ro + writable subpath at `$HOME`. No network.
//                 /tmp writable. Used by calls needing secret-access
//                 (the planner only routes those here).
//   host        — no wrap. Operator explicitly opted in via
//                 `--sandbox-host` AND the resolved capability set
//                 includes `host-passthrough`. The runner returns
//                 the innerArgv unchanged.

import type { SandboxProfile } from './sandbox-plan.ts';

export interface BuildSandboxExecArgvOptions {
  profile: SandboxProfile;
  // Working directory the wrapped process should start in. For
  // cwd-rw / cwd-rw-net this is also the writable subpath target.
  cwd: string;
  // Operator's home. For home-rw, this is the writable subpath target.
  home: string;
  // The inner command + args the sandbox-exec wraps. Cannot be empty.
  innerArgv: readonly string[];
}

// SBPL string escaping. Apple's profile parser accepts double-quoted
// literals; backslash escapes the next character. Filesystem paths
// almost never contain `"` or `\`, but we escape defensively so a
// crafted path can't break out of the literal and inject
// (allow ...) clauses. Throws on null bytes — those aren't valid in
// filesystem paths and indicate caller bugs upstream.
const escapeSbplLiteral = (s: string): string => {
  if (s.includes('\0')) {
    throw new Error('sandbox-runner-macos: path contains NUL byte');
  }
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
};

// Build the SBPL profile string for a given (profile, cwd, home).
// Pure function — no I/O. Returns null for `host` (the host profile
// has no wrap; the caller short-circuits before building a profile).
export const buildSbplProfile = (
  profile: Exclude<SandboxProfile, 'host'>,
  cwd: string,
  home: string,
): string => {
  // Common header for every sandboxed profile.
  const header = [
    '(version 1)',
    '(deny default)',
    // Process operations the wrapped tool needs. exec is the
    // primary need (run the inner command); fork covers any
    // subprocesses; signal restricted to same-sandbox so a wrapped
    // process can't kill the parent agent.
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    // sysctl-read is required for stdlib operations on macOS
    // (every shell invocation reads sysctl values during init).
    // Read-only — no sysctl-write granted.
    '(allow sysctl-read)',
    // mach-lookup is required for system services (e.g. dyld);
    // omitting it makes EVERY exec fail with mach-style errors.
    '(allow mach-lookup)',
  ];

  // Filesystem reads — always allowed (every profile inherits the
  // ro baseline). file-read* covers read + stat + readlink + etc.
  const readRules = ['(allow file-read*)'];

  // Filesystem writes — profile-specific. /tmp is always writable
  // (matches Linux's --tmpfs /tmp). Then cwd or home per profile.
  const writeRules: string[] = [];
  writeRules.push('(allow file-write* (subpath "/tmp"))');
  writeRules.push('(allow file-write* (subpath "/private/tmp"))');
  // macOS routes /tmp through /private/tmp via a firmlink; some
  // operations resolve one form, some the other. Allow both.
  writeRules.push('(allow file-write* (subpath "/private/var/folders"))');
  // /private/var/folders/... is macOS's per-user tempdir (TMPDIR).
  // Wrapped commands that use mktemp / NSTemporaryDirectory land
  // here. Allowing it matches the Linux profile's "ephemeral
  // scratch is writable" property.
  if (profile === 'cwd-rw' || profile === 'cwd-rw-net') {
    writeRules.push(`(allow file-write* (subpath "${escapeSbplLiteral(cwd)}"))`);
  } else if (profile === 'home-rw') {
    writeRules.push(`(allow file-write* (subpath "${escapeSbplLiteral(home)}"))`);
  }

  // Network — granted only for cwd-rw-net. Other profiles inherit
  // the (deny default) header and stay locked. network* covers
  // outbound + bind + receive; we grant the bundle since the
  // planner already gated on the net-egress capability presence.
  const netRules: string[] = [];
  if (profile === 'cwd-rw-net') {
    netRules.push('(allow network*)');
  }

  return [...header, ...readRules, ...writeRules, ...netRules].join('\n');
};

// Build the `sandbox-exec` argv for a given profile. Pure function.
//
// For `host`: returns `innerArgv` unchanged. The operator already
// confirmed at the §6.5 host gate AND the planner already required
// `host-passthrough` in the resolved set; the runner trusts both
// and runs without any wrap.
//
// For the four sandboxed profiles: returns `['sandbox-exec', '-p',
// <profile-string>, ...innerArgv]`. Unlike bwrap, sandbox-exec does
// NOT use a `--` separator — its argv after the profile flag is
// passed directly to exec(). Caller's innerArgv must be a complete
// executable + args list.
export const buildSandboxExecArgv = (options: BuildSandboxExecArgvOptions): string[] => {
  const { profile, cwd, home, innerArgv } = options;
  if (innerArgv.length === 0) {
    throw new Error('buildSandboxExecArgv: innerArgv must not be empty');
  }
  if (profile === 'host') return innerArgv.slice();

  const profileString = buildSbplProfile(profile, cwd, home);
  return ['sandbox-exec', '-p', profileString, ...innerArgv];
};
