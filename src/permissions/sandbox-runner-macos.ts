// Sandbox argv synthesis for macOS / sandbox-exec. Parallel to
// `sandbox-runner.ts`'s Linux/bwrap surface — same input shape,
// same per-profile mounting/network rules, different OS-level
// enforcement primitive.
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
// Profile flag rationale (mounts/network/process columns):
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
import { SANDBOX_SAFE_ENV_VARS } from './safe-env-vars.ts';
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
  // Absolute path to the sandbox-exec binary. Default is the bare
  // name (kernel resolves via $PATH at execve — re-exposes shim
  // attack). Production callers via maybeWrapSandboxArgv pass the
  // canonical-first resolved path.
  sandboxExecPath?: string;
  // Test seam for `realpath()`. Production omits and uses
  // `node:fs.realpathSync`. See sandbox-runner.ts canonicalizeCwd
  // block for the threat shape + failure-mode policy; SBPL deny
  // rules on the literal cwd path would be bypassed by the same
  // symlink-to-hidden-dir trick without canonicalization.
  realpath?: (p: string) => string;
  // Per-sandbox tmpdir subpath. When set, the SBPL `file-write*`
  // allow for the tmp tree is restricted to this subpath rather
  // than the host's `/tmp` blanket (plus the `/private/tmp`
  // firmlink form).
  //
  // macOS `/tmp` is the host's `/tmp`, shared across every process
  // the operator runs — granting blanket `(allow file-write*
  // (subpath "/tmp"))` lets sandbox A write `/tmp/secret` and
  // operator's non-sandboxed app B read it. Cross-tenancy leak.
  //
  // When `tmpdir` is set:
  //   - Caller MUST pre-create the directory (mkdir + mode 0o700
  //     recommended) and override the wrapped process's
  //     `TMPDIR` env var to point at it. SBPL refuses the
  //     /tmp blanket otherwise — tools fall back to the no-write
  //     state.
  //   - SBPL profile emits `(allow file-write* (subpath "<tmpdir>"))`
  //     plus the `/private/<tmpdir-after-/tmp>` firmlink-equivalent
  //     form when tmpdir starts with `/tmp/`. No blanket /tmp.
  //
  // When omitted (default): full `/tmp` + `/private/tmp` allowed.
  // Documented divergence from Linux's per-sandbox isolation; this
  // capability exists for operator-driven workflows that pre-create
  // a session-scoped tmpdir.
  tmpdir?: string;
  // When set, the inner argv is wrapped with `/usr/bin/env -i
  // KEY=VAL ... --` so the inner process starts with ONLY the
  // allowlisted vars (`SANDBOX_SAFE_ENV_VARS`) populated from this
  // env. Matches the Linux runner's `--clearenv --setenv KEY VAL`
  // kernel-boundary behavior — without this wrap, sandbox-exec
  // inherits the spawner's env verbatim and any var off the
  // userspace scrub denylist (e.g. VAULT_ADDR, BW_SESSION, novel
  // SaaS tokens) leaks into the sandboxed bash.
  //
  // Path-shim hardening: the inner wrapper uses the canonical
  // `/usr/bin/env` path verbatim instead of the bare `env` name so
  // the kernel `execve` doesn't re-walk $PATH at exec time and
  // resolve to a `/tmp/evilbin/env` shim.
  //
  // When omitted (test seam, legacy callers): inner argv is not
  // wrapped — `sandbox-exec` execs the inner directly and it
  // inherits whatever env `Bun.spawn({env})` passed. Production
  // wiring via `maybeWrapSandboxArgv` always sets this.
  env?: NodeJS.ProcessEnv;
  // Forja-internal control-plane env appended AFTER the
  // `SANDBOX_SAFE_ENV_VARS` loop inside the `/usr/bin/env -i` wrap,
  // so colliding keys win (last `KEY=VAL` to `env -i` wins). Mirrors
  // the Linux runner's `passthroughEnv` plumbing — see
  // `BuildBwrapArgvOptions.passthroughEnv` for the threat shape +
  // membership rules. The env -i wrap fires when EITHER `env` or
  // `passthroughEnv` is set, so a caller that wants ONLY the
  // passthrough vars (no host env) can pass `env: {}` +
  // `passthroughEnv`.
  passthroughEnv?: Record<string, string>;
}

// SBPL string escaping. Apple's profile parser accepts double-quoted
// literals; backslash escapes the next character. Filesystem paths
// almost never contain `"` or `\`, but we escape defensively so a
// crafted path can't break out of the literal and inject
// (allow ...) clauses.
//
// Rejects on:
//   - NUL bytes — invalid in filesystem paths; indicates caller bug.
//   - Full CC0 (U+0000-U+001F) + CC1 (U+0080-U+009F) control-
//     character ranges. Beyond line-structure injection (`\n`/`\r`),
//     the same class of attacker-controllable bytes (ANSI ESC
//     `\x1b`, BEL `\x07`, OSC opening `\x9d`) could produce
//     terminal-side escapes when the operator views the rendered
//     profile error, or unknown SBPL parser behavior on its own
//     escape semantics. POSIX permits these in paths but they're
//     extraordinarily rare; rejecting forecloses an entire
//     injection class for negligible legitimate cost.
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
  // Per-sandbox tmpdir subpath. When set, replaces the blanket
  // `/tmp` + `/private/tmp` write allow with a subpath-scoped
  // allow. See BuildSandboxExecArgvOptions.tmpdir for the threat
  // shape + caller-responsibility contract.
  tmpdir?: string,
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
    // Deny nested sandbox-exec. The `(allow process-exec)` above
    // lets the wrapped process spawn arbitrary binaries; an LLM-
    // driven bash could `sandbox-exec -p '(version 1)(allow
    // default)' /bin/sh` to wrap itself in a permissive profile and
    // escape the outer one. macOS DOES intersect nested sandbox
    // profiles for the FS/network gates, but the inner profile can
    // still toggle mach-lookup / signal / process semantics within
    // the outer profile's allowed set. Cheaper to refuse the launch
    // outright.
    //
    // A single `(literal "/usr/bin/sandbox-exec")` is bypassable via
    // `cp /usr/bin/sandbox-exec /tmp/se && /tmp/se ...` (both `/tmp`
    // and cwd are writable in cwd-rw / cwd-rw-net profiles). The
    // regex denies match any path whose basename is exactly
    // `sandbox-exec`:
    //   `^/.*/sandbox-exec$` (any directory + trailing
    //                          "/sandbox-exec")
    //   `^/sandbox-exec$`     (root-level binary)
    //
    // SBPL last-match-wins, so both denys come AFTER
    // (allow process-exec) and win. The regex is a SBPL primitive
    // (not the Forja-side glob/prefix matcher) — the "no regex in
    // policy/permissions" rule applies to operator-facing policy
    // YAML, not to a kernel DSL where regex is the documented
    // primitive. The literal deny stays for clarity.
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
    // `(allow mach-lookup)` is blanket — every mach service the
    // sandboxed process names resolves, including LaunchServices.
    // That lets the inner bash call `open -a Mail
    // file://exfil.html` or `open -a 'TextEdit.app' /etc/shadow`;
    // the `open` call is brokered OUTSIDE the sandbox by `lsd` /
    // `coreservicesd`, which then spawn the target app un-sandboxed
    // with the operator's full privileges. The sandboxed process
    // effectively requested an arbitrary exec via mach-IPC,
    // escaping the SBPL.
    //
    // SBPL evaluates rules top-to-bottom and the LAST matching rule
    // wins. Explicit denies for the LaunchServices / app-launch
    // mach surface come AFTER the blanket allow so dyld / libc
    // still resolve normal services but `open(1)`'s helper calls
    // hit a refusal.
    //
    // Service-name selection: each entry below is documented in
    // public Apple sources OR appears in well-known `dtrace -n
    // 'pid$target::*mach_lookup*'` traces of `open(1)`:
    //   - `com.apple.lsd` — LaunchServicesD primary mach port.
    //   - `com.apple.coreservices.launchservicesd` — newer
    //     launchd-named variant on macOS 12+.
    //   - `com.apple.LSOpenApplication` — public LaunchServices
    //     open-app API; targeted by `LSOpenFromURLSpec` and the
    //     deprecated `LSOpenApplication` selectors.
    //   - `com.apple.taskgated` + `-helper` — task-port broker;
    //     `task_for_pid` cross-process call. A sandboxed bash
    //     reaching this could request a sibling's task port and
    //     inject code, escaping the SBPL completely.
    // Conservative posture: name the surfaces we KNOW are
    // load-bearing for the escape, accept that an undocumented
    // `lsd.*` subservice we missed could still leak. Future audit
    // sweep can add more — names are additive (each is an extra
    // deny, never relaxes the blanket allow).
    '(deny mach-lookup (global-name "com.apple.lsd"))',
    '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))',
    '(deny mach-lookup (global-name "com.apple.LSOpenApplication"))',
    '(deny mach-lookup (global-name "com.apple.taskgated"))',
    '(deny mach-lookup (global-name "com.apple.taskgated-helper"))',
  ];

  // Filesystem reads — always allowed (every profile inherits the
  // ro baseline). file-read* covers read + stat + readlink + etc.
  const readRules = ['(allow file-read*)'];

  // Filesystem writes — profile-specific. /tmp is always writable
  // (matches Linux's --tmpfs /tmp). Then cwd or home per profile.
  //
  // When `tmpdir` is set, the SBPL allow is restricted to that
  // subpath ONLY (plus the /private firmlink-equivalent form when
  // tmpdir starts with /tmp/). No blanket /tmp + /private/tmp
  // allow. When `tmpdir` is unset (default), the full /tmp tree is
  // allowed. The caller is responsible for pre-creating the
  // directory and setting `TMPDIR=<tmpdir>` in the wrapped
  // process's env so mktemp / NSTemporaryDirectory honor the
  // restricted scope.
  const writeRules: string[] = [];
  if (tmpdir !== undefined) {
    const escTmpdir = escapeSbplLiteral(tmpdir);
    writeRules.push(`(allow file-write* (subpath "${escTmpdir}"))`);
    // macOS firmlinks /tmp ↔ /private/tmp; emit the /private form
    // for tmpdirs under /tmp so operations that resolve through
    // either prefix find the matching allow.
    if (tmpdir.startsWith('/tmp/')) {
      const privateForm = `/private${tmpdir}`;
      const escPrivate = escapeSbplLiteral(privateForm);
      writeRules.push(`(allow file-write* (subpath "${escPrivate}"))`);
    }
  } else {
    writeRules.push('(allow file-write* (subpath "/tmp"))');
    writeRules.push('(allow file-write* (subpath "/private/tmp"))');
  }
  // macOS routes /tmp through /private/tmp via a firmlink; some
  // operations resolve one form, some the other. Allow both.
  //
  // We do NOT allow write to `/private/var/folders` (macOS per-user
  // TMPDIR root). That root is SHARED across every app the user
  // runs — includes `com.apple.Keychain.*` ephemeral state,
  // `com.apple.security.*` caches, credential-helper sockets.
  // Granting it would defeat the per-sandbox isolation the Linux
  // `--tmpfs /tmp` provides.
  //
  // Cost: wrapped tools that hard-code NSTemporaryDirectory
  // (Swift/Obj-C apps; some Python/Ruby/Node tools via system
  // libs) will fail at exec time. Workaround: operator can prefix
  // `TMPDIR=/tmp <cmd>` to redirect, OR opt into `host-passthrough`
  // for that specific call. A future per-sandbox tempdir bind as
  // TMPDIR would close this gap but requires runtime side effects
  // beyond the current pure-function runner contract.
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

  // hide_paths — credential dirs + files masked inside every
  // sandbox profile. The `(allow file-read*)` baseline above
  // exposes the operator's entire home read-only inside the
  // sandbox; the LLM could `cat ~/.ssh/id_rsa` from a `ro` profile
  // without this defense. The engine-side protected-paths classifier
  // only catches calls that surface as resolved capabilities — a
  // sandboxed bash reading the file directly bypasses it.
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
  // XDG_DATA_HOME unmask. Same gap as the Linux runner —
  // `.local/share/forja` is only the home-relative default;
  // `defaultDataDir()` honors $XDG_DATA_HOME at runtime. When the
  // operator sets XDG_DATA_HOME outside $HOME/.local/share, the
  // canonical literal deny covers the wrong subpath and the
  // sandboxed process on `home-rw` can read/write the live audit
  // DB. Idempotent: when XDG_DATA_HOME is unset, liveDataDir
  // matches the home-relative default and the extra rule is
  // redundant (SBPL accepts duplicate denies; last-match-wins).
  //
  // Absolute-path guard: per XDG Base Directory Spec, relative
  // values SHOULD be ignored. SBPL subpath rules require absolute
  // paths, and a relative `liveDataDir` would either be rejected by
  // `sandbox-exec` at profile-load time OR silently fail to match
  // the actual data dir (worse: silent unmask). Skip the extra rule
  // when XDG_DATA_HOME is non-absolute; the home-relative deny for
  // `.local/share/forja` above still covers the canonical path.
  const liveDataDir = defaultDataDir();
  const homeRelativeDataDir = joinPath(home, '.local', 'share', 'forja');
  if (liveDataDir.startsWith('/') && liveDataDir !== homeRelativeDataDir) {
    const escaped = escapeSbplLiteral(liveDataDir);
    denyRules.push(`(deny file-read* (subpath "${escaped}"))`);
    denyRules.push(`(deny file-write* (subpath "${escaped}"))`);
  }
  // XDG_CONFIG_HOME unmask — macOS parity with the Linux runner.
  // Same shape as the XDG_DATA_HOME block above; covers
  // `.config/*` HIDE_PATHS_DIRS entries when the operator
  // relocated XDG_CONFIG_HOME outside `~/.config`. Read env
  // directly here for parity with `defaultDataDir()` above (the
  // macOS SBPL builder doesn't take an env param because it
  // doesn't need `--clearenv` / `--setenv` like bwrap).
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
// confirmed at the host gate AND the planner already required
// `host-passthrough` in the resolved set; the runner trusts both
// and runs without any wrap.
//
// For the four sandboxed profiles: returns `['sandbox-exec', '-p',
// <profile-string>, ...innerArgv]`. Unlike bwrap, sandbox-exec does
// NOT use a `--` separator — its argv after the profile flag is
// passed directly to exec(). Caller's innerArgv must be a complete
// executable + args list.
export const buildSandboxExecArgv = (options: BuildSandboxExecArgvOptions): string[] => {
  const { profile, innerArgv } = options;
  if (innerArgv.length === 0) {
    throw new Error('buildSandboxExecArgv: innerArgv must not be empty');
  }
  if (profile === 'host') return innerArgv.slice();

  // Canonicalize the cwd via realpath BEFORE the hide_paths check
  // and the SBPL profile generation. Without this, a
  // `/tmp/work → ~/.ssh/audit/` symlink slips past the literal
  // string check and the SBPL allow-rule generated for the
  // original cwd path lets the sandboxed process write to the
  // symlink target — which the deny rules thought were masked.
  // Canonicalizing here lines the check, the allow rule, and the
  // operator's actual cwd up on the same resolved absolute path.
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

  // Canonicalize `home` so SBPL deny rules at
  // `(literal "${home}/.ssh/id_rsa")` and HIDE_PATHS overlays
  // target the canonical path. Symlinked-home layouts
  // (`/home/op → /data/users/op`) would otherwise leave the
  // canonical `.ssh` exposed via the base `(allow file-read*)`
  // while the deny only matches the symlink path. Best-effort
  // fallback: on realpath failure, use the literal input — home
  // not existing at canonical time is rare and doesn't justify
  // refusing the wrap.
  let home: string;
  try {
    home = realpath(options.home);
  } catch {
    home = options.home;
  }

  // Refuse at build time when cwd is inside a hide_paths root.
  // SBPL evaluates rules top-to-bottom with last-match-wins. An
  // operator running Forja from `~/.ssh/audit/` (or any cwd nested
  // under a hide_paths root) would build a profile where
  // `(allow file-write* (subpath cwd))` is followed by
  // `(deny file-write* (subpath ~/.ssh))` — deny wins. The inner
  // process receives a working dir that "vanishes" inside the
  // sandbox, exec then fails with an opaque SBPL error rather than
  // a clear build-time refuse. Mirrors the Linux bwrap runner's
  // refuse. Applies to the canonicalized cwd computed above.
  for (const dir of HIDE_PATHS_DIRS) {
    const hiddenAbs = joinPath(home, dir);
    if (cwd === hiddenAbs || cwd.startsWith(`${hiddenAbs}/`)) {
      throw new Error(
        `buildSandboxExecArgv: cwd '${cwd}' is inside hide_paths dir '${hiddenAbs}'; the sandbox would mask the cwd mount. Move to a different working directory.`,
      );
    }
  }

  const profileString = buildSbplProfile(profile, cwd, home, options.tmpdir);
  // Use the resolved absolute path when provided (production via
  // maybeWrapSandboxArgv); fall back to the bare binary name for
  // direct-build test callers.
  const sandboxExecPath = options.sandboxExecPath ?? 'sandbox-exec';

  // Env scrub allowlist. sandbox-exec inherits the spawner's env
  // verbatim; without an equivalent of `bwrap --clearenv`,
  // userspace scrubEnv would be the SOLE env barrier on darwin.
  // Wrapping the inner argv with `/usr/bin/env -i KEY=VAL ... --`
  // ensures the inner process starts with ONLY the allowlisted
  // vars. The wrap is opt-in via the `env` option — when omitted
  // (test callers), inner argv is execed verbatim and the
  // spawner's env passes through. Production via
  // `maybeWrapSandboxArgv` always sets it.
  //
  // Canonical /usr/bin/env path: same PATH-shim rationale as the
  // sandbox-exec resolver — bare `env` lets `execve` re-resolve
  // via $PATH at exec time, exposing the shim attack.
  // `/usr/bin/env` is canonical on every supported macOS version.
  let effectiveInner: readonly string[] = innerArgv;
  // env -i wrap fires when EITHER the host-env allowlist OR the
  // forja-internal passthrough is requested. Both paths build the
  // same KEY=VAL list, with passthrough entries appended LAST so a
  // colliding key wins (env -i applies the args in order, last wins).
  if (options.env !== undefined || options.passthroughEnv !== undefined) {
    const envAssignments: string[] = [];
    if (options.env !== undefined) {
      for (const key of SANDBOX_SAFE_ENV_VARS) {
        const value = options.env[key];
        if (value === undefined) continue;
        // NUL bytes inside env values would silently truncate at the
        // execve layer. Skip — same defense the Linux runner's
        // appendEnvFlags applies for the bwrap --setenv path.
        if (value.includes('\0')) continue;
        envAssignments.push(`${key}=${value}`);
      }
    }
    if (options.passthroughEnv !== undefined) {
      for (const [key, value] of Object.entries(options.passthroughEnv)) {
        if (key.length === 0) continue;
        if (key.includes('\0') || key.includes('=')) continue;
        if (value.includes('\0')) continue;
        envAssignments.push(`${key}=${value}`);
      }
    }
    effectiveInner = ['/usr/bin/env', '-i', ...envAssignments, '--', ...innerArgv];
  }
  return [sandboxExecPath, '-p', profileString, ...effectiveInner];
};
