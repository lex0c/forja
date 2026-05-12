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

import { join as joinPath } from 'node:path';
import { HIDE_PATHS_DIRS, HIDE_PATHS_FILES } from './sandbox-hide-paths.ts';
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
// (allow ...) clauses.
//
// Rejects on:
//   - NUL bytes — invalid in filesystem paths; indicates caller bug.
//   - Newlines (`\n`/`\r`) — slice 125 (R2 P1): the SBPL profile is
//     line-joined with `\n` (see buildSbplProfile's `.join('\n')`).
//     A path containing a literal newline would break the line
//     structure and could land attacker-controlled tokens at the
//     start of a fresh line (e.g. `(allow file-read*)` injection).
//     POSIX permits newlines in paths but they're extraordinarily
//     rare in practice; rejecting defends against a real injection
//     vector with negligible legitimate cost.
const escapeSbplLiteral = (s: string): string => {
  if (s.includes('\0')) {
    throw new Error('sandbox-runner-macos: path contains NUL byte');
  }
  if (s.includes('\n') || s.includes('\r')) {
    throw new Error('sandbox-runner-macos: path contains newline (CR/LF)');
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
  //
  // Slice 125 (R2 P0-6): pre-slice we also allowed write to
  // `/private/var/folders` (macOS per-user TMPDIR root) for
  // mktemp / NSTemporaryDirectory compatibility. But that root
  // is SHARED across every app the user runs — includes
  // `com.apple.Keychain.*` ephemeral state, `com.apple.security.*`
  // caches, credential-helper sockets. The Linux equivalent uses
  // `--tmpfs /tmp` (fresh isolated tmpfs per-sandbox); macOS
  // just unlocked the host path. Removed.
  //
  // Cost: wrapped tools that hard-code NSTemporaryDirectory
  // (Swift/Obj-C apps; some Python/Ruby/Node tools via system
  // libs) will fail at exec time. Workaround: operator can
  // prefix `TMPDIR=/tmp <cmd>` to redirect, OR opt into
  // `host-passthrough` for that specific call. Future slice
  // could mint a per-sandbox tempdir + bind it as TMPDIR; that
  // requires runtime side effects beyond the current pure-
  // function runner contract.
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

  // §9 hide_paths — credential dirs + files masked inside every
  // sandbox profile (slice 119, R4). The `(allow file-read*)`
  // baseline above exposes the operator's entire home read-only
  // inside the sandbox; the LLM could `cat ~/.ssh/id_rsa` from a
  // `ro` profile without this defense. Engine-side §11 protected
  // paths (slice 97) only catches calls that surface as resolved
  // capabilities — a sandboxed bash reading the file directly
  // bypasses the classifier.
  //
  // SBPL evaluation: rules apply top-to-bottom and the LAST
  // matching rule wins for that operation. The deny clauses
  // emitted here come AFTER the allow file-read* baseline and
  // AFTER any profile-specific (allow file-write* ...) — so a
  // read of `~/.ssh/id_rsa` matches both `(allow file-read*)`
  // and `(deny file-read* (subpath "~/.ssh"))`, and deny wins.
  //
  // Path kind shapes:
  //   dirs  → `(subpath "<abs>")` — matches the dir AND any
  //           descendant, so `~/.ssh/known_hosts` is also denied.
  //   files → `(literal "<abs>")` — matches only that exact path.
  //
  // We deny BOTH file-read* and file-write* so that home-rw
  // (which grants `(allow file-write* (subpath home))`) still
  // can't write `~/.ssh/authorized_keys` — the later deny wins
  // there too. Canonical lists from `sandbox-hide-paths.ts`,
  // shared with the Linux bwrap runner.
  const denyRules: string[] = [];
  for (const dir of HIDE_PATHS_DIRS) {
    const absDir = joinPath(home, dir);
    const escaped = escapeSbplLiteral(absDir);
    denyRules.push(`(deny file-read* (subpath "${escaped}"))`);
    denyRules.push(`(deny file-write* (subpath "${escaped}"))`);
  }
  for (const file of HIDE_PATHS_FILES) {
    const absFile = joinPath(home, file);
    const escaped = escapeSbplLiteral(absFile);
    denyRules.push(`(deny file-read* (literal "${escaped}"))`);
    denyRules.push(`(deny file-write* (literal "${escaped}"))`);
  }

  return [...header, ...readRules, ...writeRules, ...netRules, ...denyRules].join('\n');
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
