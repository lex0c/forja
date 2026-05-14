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

import { realpathSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { defaultDataDir } from '../storage/paths.ts';
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
  // Slice 154 (review — PATH-shim resistance): absolute path to
  // the sandbox-exec binary. Default is the bare name (kernel
  // resolves via $PATH at execve — re-exposes shim attack).
  // Production callers via maybeWrapSandboxArgv pass the
  // canonical-first resolved path.
  sandboxExecPath?: string;
  // Slice 155 (review — symlink canonicalization): test seam for
  // `realpath()`. Production omits and uses `node:fs.realpathSync`.
  // See sandbox-runner.ts canonicalizeCwd block for the threat
  // shape + failure-mode policy; this option mirrors that for
  // macOS parity (SBPL deny rules on the literal cwd path would
  // be bypassed by the same symlink-to-hidden-dir trick).
  realpath?: (p: string) => string;
}

// SBPL string escaping. Apple's profile parser accepts double-quoted
// literals; backslash escapes the next character. Filesystem paths
// almost never contain `"` or `\`, but we escape defensively so a
// crafted path can't break out of the literal and inject
// (allow ...) clauses.
//
// Rejects on:
//   - NUL bytes — invalid in filesystem paths; indicates caller bug.
//   - Slice 127 (R3 P1): the full CC0 (U+0000-U+001F) + CC1
//     (U+0080-U+009F) control-character ranges. Pre-slice 125
//     only `\n`/`\r` were rejected (the line-structure-injection
//     case), but the SAME class of attacker-controllable bytes
//     (ANSI ESC `\x1b`, BEL `\x07`, OSC opening `\x9d`) could
//     produce equally bad outcomes — terminal-side escapes when
//     the operator views the rendered profile error, or unknown
//     SBPL parser behavior on its own escape semantics. Symmetric
//     with welcome.ts's CONTROL_CHAR_RE (slice 125 R2 P2) which
//     strips the same ranges from operator-visible output.
//     POSIX permits these in paths but they're extraordinarily
//     rare; rejecting forecloses an entire injection class for
//     negligible legitimate cost.
// biome-ignore lint/suspicious/noControlCharactersInRegex: rule's purpose IS to match control chars (defense intent)
const SBPL_CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f]/;
const escapeSbplLiteral = (s: string): string => {
  if (s.includes('\0')) {
    throw new Error('sandbox-runner-macos: path contains NUL byte');
  }
  if (SBPL_CONTROL_CHAR_RE.test(s)) {
    throw new Error('sandbox-runner-macos: path contains a control character (CC0 / CC1)');
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
    // Slice 140 sec-2 + slice 145 S3: deny nested sandbox-exec.
    // The `(allow process-exec)` above lets the wrapped process
    // spawn arbitrary binaries; an LLM-driven bash could
    // `sandbox-exec -p '(version 1)(allow default)' /bin/sh` to
    // wrap itself in a permissive profile and escape the outer
    // one. macOS DOES intersect nested sandbox profiles for the
    // FS/network gates, but the inner profile can still toggle
    // mach-lookup / signal / process semantics within the outer
    // profile's allowed set. Cheaper to refuse the launch
    // outright.
    //
    // Slice 140 used only `(literal "/usr/bin/sandbox-exec")` —
    // bypassable via `cp /usr/bin/sandbox-exec /tmp/se && /tmp/se
    // ...` since both `/tmp` and cwd are writable in cwd-rw /
    // cwd-rw-net profiles. Slice 145 adds a regex deny matching
    // any path whose basename is exactly `sandbox-exec`:
    //   `^/.*/sandbox-exec$` (any directory + trailing
    //                          "/sandbox-exec")
    //   `^/sandbox-exec$`     (root-level binary)
    //
    // SBPL last-match-wins, so both denys come AFTER
    // (allow process-exec) and win. The regex is a SBPL primitive
    // (not the Forja-side glob/prefix matcher) — the CLAUDE.md
    // "no regex in policy/permissions" rule applies to operator-
    // facing policy YAML, not to a kernel DSL where regex is the
    // documented primitive. The literal deny stays for clarity.
    '(deny process-exec (literal "/usr/bin/sandbox-exec"))',
    '(deny process-exec (regex #"^/.*/sandbox-exec$"))',
    '(deny process-exec (regex #"^/sandbox-exec$"))',
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
  // Slice 140 sec-1: XDG_DATA_HOME unmask. Same gap as the Linux
  // runner — `.local/share/forja` is only the home-relative
  // default; `defaultDataDir()` honors $XDG_DATA_HOME at runtime.
  // When the operator sets XDG_DATA_HOME outside $HOME/.local/share,
  // the canonical literal deny covers the wrong subpath and the
  // sandboxed process on `home-rw` can read/write the live audit DB.
  // Idempotent: when XDG_DATA_HOME is unset, liveDataDir matches
  // the home-relative default and the extra rule is redundant
  // (SBPL accepts duplicate denies; last-match-wins).
  const liveDataDir = defaultDataDir();
  const homeRelativeDataDir = joinPath(home, '.local', 'share', 'forja');
  if (liveDataDir !== homeRelativeDataDir) {
    const escaped = escapeSbplLiteral(liveDataDir);
    denyRules.push(`(deny file-read* (subpath "${escaped}"))`);
    denyRules.push(`(deny file-write* (subpath "${escaped}"))`);
  }
  // Slice 146 (review minor): XDG_CONFIG_HOME unmask — macOS
  // parity with the Linux runner. Same shape as the XDG_DATA_HOME
  // block above; covers `.config/*` HIDE_PATHS_DIRS entries when
  // the operator relocated XDG_CONFIG_HOME outside `~/.config`.
  // Read env directly here for parity with `defaultDataDir()`
  // above (the macOS SBPL builder doesn't take an env param
  // because it doesn't need `--clearenv` / `--setenv` like bwrap).
  const xdgConfig = process.env.XDG_CONFIG_HOME;
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
      const absDir = joinPath(xdgConfig, sub);
      const escaped = escapeSbplLiteral(absDir);
      denyRules.push(`(deny file-read* (subpath "${escaped}"))`);
      denyRules.push(`(deny file-write* (subpath "${escaped}"))`);
    }
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
  const { profile, home, innerArgv } = options;
  if (innerArgv.length === 0) {
    throw new Error('buildSandboxExecArgv: innerArgv must not be empty');
  }
  if (profile === 'host') return innerArgv.slice();

  // Slice 155 (review — symlink canonicalization for cwd guard):
  // canonicalize the cwd via realpath BEFORE the hide_paths check
  // and the SBPL profile generation. Same threat as the Linux
  // runner (sandbox-runner.ts): a `/tmp/work → ~/.ssh/audit/`
  // symlink slips past the literal string check and the SBPL
  // allow-rule generated for the original cwd path lets the
  // sandboxed process write to the symlink target — which the
  // deny rules thought were masked. Canonicalizing here lines
  // the check, the allow rule, and the operator's actual cwd up
  // on the same resolved absolute path.
  const realpath = options.realpath ?? realpathSync;
  let cwd: string;
  try {
    cwd = realpath(options.cwd);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const code = err.code;
    let detail: string;
    switch (code) {
      case 'ENOENT':
        detail = `cwd '${options.cwd}' does not exist (broken symlink target?)`;
        break;
      case 'ELOOP':
        detail = `cwd '${options.cwd}' symlink chain loops`;
        break;
      case 'EACCES':
      case 'EPERM':
        detail = `cwd '${options.cwd}' cannot be canonicalized: permission denied (ancestor unreadable?)`;
        break;
      case 'ENOTDIR':
        detail = `cwd '${options.cwd}' or an ancestor is not a directory`;
        break;
      default:
        detail = `cwd '${options.cwd}' cannot be canonicalized (code=${code ?? 'unknown'}: ${err.message})`;
    }
    throw new Error(`sandbox: ${detail}`);
  }

  // Slice 134 P0-12 (cross-platform parity with sandbox-runner.ts:147-154):
  // SBPL evaluates rules top-to-bottom with last-match-wins. An operator
  // running Forja from `~/.ssh/audit/` (or any cwd nested under a
  // hide_paths root) would build a profile where
  // `(allow file-write* (subpath cwd))` is followed by `(deny file-write*
  // (subpath ~/.ssh))` — deny wins. The inner process receives a working
  // dir that "vanishes" inside the sandbox, exec then fails with an
  // opaque SBPL error rather than a clear build-time refuse. The Linux
  // bwrap runner refuses here pre-slice 134; macOS silently produced
  // the broken profile until this guard landed. Refuse at build time
  // for parity. Slice 155: applies to the canonicalized cwd.
  for (const dir of HIDE_PATHS_DIRS) {
    const hiddenAbs = joinPath(home, dir);
    if (cwd === hiddenAbs || cwd.startsWith(`${hiddenAbs}/`)) {
      throw new Error(
        `buildSandboxExecArgv: cwd '${cwd}' is inside hide_paths dir '${hiddenAbs}'; the sandbox would mask the cwd mount. Move to a different working directory.`,
      );
    }
  }

  const profileString = buildSbplProfile(profile, cwd, home);
  // Slice 154 (review — PATH-shim resistance): use the resolved
  // absolute path when provided (production via maybeWrapSandboxArgv);
  // fall back to the bare binary name for direct-build test callers.
  const sandboxExecPath = options.sandboxExecPath ?? 'sandbox-exec';
  return [sandboxExecPath, '-p', profileString, ...innerArgv];
};
