// Sandbox tooling availability detection. Answers "is the
// sandboxing toolchain even present?" at engine bootstrap so the
// state machine + selection layer can branch accordingly.
//
// State branches:
//   - sandbox indisponível (kernel sem unshare, bwrap binary
//     missing) → state = degraded; highest profile available is
//     host with confirm forced on every call.
//   - sandbox `required: true` in policy AND unavailable →
//     state = refusing.
//
// Cheap synchronous binary lookup; no privileged probes, no
// spawned subprocesses, no kernel checks. A future revision can
// extend the probe (e.g. test `unshare(CLONE_NEWNET)` actually
// works on this kernel); for now, binary-on-PATH is the floor.
//
// Platform mapping:
//   - Linux  → `bwrap`
//   - macOS  → `sandbox-exec`
//   - Windows → not supported in v2 (always unavailable)
//
// Production bootstrap calls this once at startup and stores the
// result in EngineOptions.sandbox; tests inject a fixed value via
// the `which` seam.
//
// PATH-shim resistance: the canonical system binary path is
// preferred over a `Bun.which()` PATH lookup. Without this, an
// operator (or attacker) with `/tmp/evilbin` early on $PATH could
// plant a `bwrap` shim that `exec`s the inner argv without
// sandboxing — the harness would see `bwrap` available, wrap the
// call, but the wrap would be a no-op. Hard-pinning the canonical
// path (`/usr/bin/bwrap` / `/usr/bin/sandbox-exec`) closes the
// trivial case. Operators with `bwrap` installed outside
// `/usr/bin` (Nix, Homebrew on Linux, custom build) still work
// via the PATH-resolved fallback, but the result carries a trust
// marker and a warning if the binary fails simple ownership +
// mode checks. Bootstrap logs / telemetry surface the warning so
// the operator sees "running with non-canonical bwrap" rather
// than a silent downgrade.

import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';
import { forjaSessionTmpDir } from '../storage/paths.ts';

// Canonical system paths for each sandbox tool. Hard-coded because
// these ARE the paths every mainstream distro installs to; deviating
// almost always means the operator built from source / uses a
// package manager that lives elsewhere.
const CANONICAL_PATHS: Record<string, string> = {
  bwrap: '/usr/bin/bwrap',
  'sandbox-exec': '/usr/bin/sandbox-exec',
};

export type SandboxToolTrustLevel = 'canonical' | 'path-resolved' | 'absent';

export interface SandboxAvailability {
  available: boolean;
  // Tooling that satisfied the probe ('bwrap' / 'sandbox-exec') or
  // null when unavailable. Persists into telemetry / audit so
  // postmortems can distinguish "Linux without bwrap installed"
  // from "macOS happy path" without re-running the probe.
  tool: 'bwrap' | 'sandbox-exec' | null;
  // Absolute path the wrapper will actually exec. Null when
  // unavailable. ALWAYS passed verbatim to Bun.spawn instead of
  // the bare binary name, so the kernel `execve` resolves to this
  // path rather than re-walking $PATH at spawn time (which would
  // re-expose the shim attack).
  path: string | null;
  // Trust marker.
  //   - 'canonical'      → hit /usr/bin/<tool> literal. Highest trust.
  //   - 'path-resolved'  → PATH lookup found <tool> outside /usr/bin.
  //                        Stat-checked for owner + mode; falls back
  //                        with a warning when the checks fail.
  //   - 'absent'         → tool not found anywhere.
  trustLevel: SandboxToolTrustLevel;
  // Free-form reason captured when unavailable. Surfaces in the
  // operator-facing error / degraded notice. Empty string when
  // available (the tool name is the affirmative signal).
  reason: string;
  // Trust warnings (operator-facing). Populated when
  // trustLevel='path-resolved' AND the stat-check failed any rule
  // (non-root owner, world-writable, group-writable). Empty array
  // when trust is canonical or warnings don't apply. Telemetry /
  // bootstrap surface this so operators see "sandbox loaded with
  // /opt/bin/bwrap — owner=user, mode 0o755" rather than a silent
  // downgrade.
  trustWarnings: readonly string[];
}

export interface DetectSandboxAvailabilityOptions {
  // Process platform override for tests. Production omits and reads
  // `process.platform`.
  platform?: NodeJS.Platform;
  // Binary-resolver seam. Production uses `Bun.which`; tests can
  // pin to a fake that returns null/string for specific names so
  // the suite doesn't depend on the host having bwrap installed.
  which?: (name: string) => string | null;
  // Stat seam. Production uses `node:fs.statSync`; tests pin owner
  // + mode to exercise canonical vs warning paths without needing
  // a real binary on disk.
  stat?: (path: string) => { uid: number; mode: number } | null;
  // Filesystem-existence seam. Used by the canonical-path probe to
  // distinguish "canonical exists" from "canonical missing, fall
  // back to PATH". Production uses statSync existence check; tests
  // inject deterministic answers.
  exists?: (path: string) => boolean;
  // Executability seam. Used by the canonical-path probe to confirm
  // the binary is actually usable for execve(2) by the current user
  // BEFORE returning it as "available." Production uses
  // `accessSync(p, X_OK)` (the kernel's own execute-access predicate);
  // tests inject deterministic answers. Without this gate, a
  // canonical /usr/bin/<tool> that exists but isn't executable
  // (mode stripped, owner mismatch, ACLs, etc.) would be reported as
  // available, then every wrapped spawn would fail with EACCES even
  // when a working binary is on PATH elsewhere — the fast path
  // monopolized the answer without verifying usability.
  isExecutable?: (path: string) => boolean;
}

const defaultWhich = (name: string): string | null => {
  // `Bun.which` returns the resolved absolute path or null when
  // the binary is missing from $PATH. Synchronous and cheap.
  return Bun.which(name);
};

// `statSync` follows symlinks and reports the target's metadata;
// we report mode from the target because that IS what the kernel
// respects for the `execve` access check. But OWNERSHIP needs
// both: a non-root-owned symlink at a PATH-walk location (e.g.
// `/tmp/evilbin/bwrap -> /usr/bin/bwrap`) is supply-chain
// expansion regardless of how trustworthy the target is — the
// attacker controls which target gets called via the link's name
// resolution. `lstatSync` reports the LINK's owner; combining via
// max(uid) surfaces "non-root owner anywhere in the resolution
// chain".
//
// We deliberately do NOT OR the LINK mode bits into the target
// mode. POSIX symlinks have mode 0o777 by convention (the kernel
// ignores them and respects only target-mode for access); OR-ing
// would force every symlink-resolved path into "group/world
// writable" and trip the trust check downstream on perfectly fine
// distro layouts (e.g. `/usr/bin/bwrap → /usr/lib/.../bwrap`).
const defaultStat = (path: string): { uid: number; mode: number } | null => {
  try {
    const target = statSync(path);
    let linkUid: number | null = null;
    try {
      linkUid = lstatSync(path).uid;
    } catch {
      linkUid = null;
    }
    // If lstat failed (rare — usually means target stat already
    // succeeded so this is some racy unlink), trust just the
    // target shape.
    if (linkUid === null) return { uid: target.uid, mode: target.mode };
    // Combine UID only: pick the LESS trustworthy (any non-root
    // in the chain shows up). Mode stays target-only.
    const combinedUid = target.uid !== 0 || linkUid !== 0 ? Math.max(target.uid, linkUid) : 0;
    return { uid: combinedUid, mode: target.mode };
  } catch {
    return null;
  }
};

const defaultExists = (path: string): boolean => {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
};

// Default executability probe: does the current user have +x on
// the path AS A USER (kernel's own X_OK check)? This is what
// `execve(2)` itself uses, so the canonical fast path's answer
// matches the spawn-time outcome — no false positives.
//
// `accessSync` throws on rejection (EACCES, ENOENT, etc.). Wrapping
// in try/catch + returning bool keeps the seam contract simple. A
// thrown error from ENOENT is the natural "not there + not
// executable" answer; we don't need to distinguish that from a
// real permission denial here because the canonical branch already
// checked existence via `exists()` upstream — by the time we get
// here we know the file is present, so any error is a usability
// failure.
const defaultIsExecutable = (path: string): boolean => {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// Assess trust of a resolved sandbox-tool binary. Two rules, both
// must hold for a clean trust report:
//   1. Owner is root (uid 0). Non-root ownership means a non-
//      privileged user (the operator OR an attacker with $HOME
//      access) placed the binary; the kernel still respects its
//      contents but the supply chain is wider.
//   2. Mode bits exclude world-write (0o002) AND group-write
//      (0o020). A world-writable binary can be replaced by ANY
//      local user; group-writable opens it to the group's members.
//
// The trust check is ADVISORY — it produces warnings, not
// refuses. Operators with intentional non-canonical installs
// (Nix, Homebrew) will see warnings AND a working sandbox. Hard-
// rejecting would break those installs; the trust model is
// "operator owns their own $HOME, but running with a non-canonical
// bwrap is worth flagging so any later forensic review can
// correlate".
const assessTrust = (
  path: string,
  stat: (p: string) => { uid: number; mode: number } | null,
): { ok: true } | { ok: false; warnings: string[] } => {
  const s = stat(path);
  if (s === null) {
    return { ok: false, warnings: [`${path}: stat() failed — binary may have been removed`] };
  }
  const warnings: string[] = [];
  if (s.uid !== 0) {
    warnings.push(`${path}: not owned by root (uid=${s.uid})`);
  }
  if ((s.mode & 0o022) !== 0) {
    const bits: string[] = [];
    if ((s.mode & 0o020) !== 0) bits.push('group-writable');
    if ((s.mode & 0o002) !== 0) bits.push('world-writable');
    warnings.push(
      `${path}: writable by non-owner (${bits.join(', ')}, mode=0o${s.mode.toString(8)})`,
    );
  }
  if (warnings.length === 0) return { ok: true };
  return { ok: false, warnings };
};

// Canonical-first resolver. Tries the hard-coded /usr/bin path;
// if that exists, uses it (highest trust). Otherwise falls back to
// PATH lookup and runs the stat-check, returning the result with
// the appropriate trust marker. Used by both
// detectSandboxAvailability AND the runtime spawn path so the
// resolved path is consistent and the kernel never re-walks $PATH
// for the sandbox binary at exec time.
//
// Returns the same shape as SandboxAvailability minus the
// `available`/`tool` fields (those are derived by the caller from
// the platform mapping).
interface ResolvedTool {
  path: string | null;
  trustLevel: SandboxToolTrustLevel;
  trustWarnings: string[];
}

export const resolveSandboxBinary = (
  name: string,
  options: {
    which?: (name: string) => string | null;
    stat?: (path: string) => { uid: number; mode: number } | null;
    exists?: (path: string) => boolean;
    isExecutable?: (path: string) => boolean;
  } = {},
): ResolvedTool => {
  const which = options.which ?? defaultWhich;
  const stat = options.stat ?? defaultStat;
  const exists = options.exists ?? defaultExists;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;

  const canonical = CANONICAL_PATHS[name];
  // Canonical fast path requires BOTH existence AND executability.
  // Returning canonical on existence alone would let a
  // /usr/bin/<tool> that exists but isn't executable for the
  // current user (mode stripped, ACL deny, owner mismatch) get
  // reported as available — every wrapped spawn would then fail
  // with EACCES even when `which()` could resolve a working binary
  // elsewhere on PATH. Falling through to the PATH lookup when
  // canonical isn't usable lets the operator's Nix/Homebrew/custom
  // install take over (with the appropriate trust marker +
  // warning).
  if (canonical !== undefined && exists(canonical) && isExecutable(canonical)) {
    // Hot path: canonical install. No trust warnings because the
    // path itself is the trust marker.
    return { path: canonical, trustLevel: 'canonical', trustWarnings: [] };
  }

  const resolved = which(name);
  if (resolved === null || !isAbsolute(resolved)) {
    return { path: null, trustLevel: 'absent', trustWarnings: [] };
  }

  const trust = assessTrust(resolved, stat);
  if (trust.ok) {
    // PATH-resolved but stat-clean (root-owned, no non-owner write).
    // Still flagged as path-resolved because the path itself isn't
    // canonical — operator may want to know.
    return {
      path: resolved,
      trustLevel: 'path-resolved',
      trustWarnings: [
        `using non-canonical ${name} at ${resolved} (canonical is ${canonical ?? '<unknown>'})`,
      ],
    };
  }
  return {
    path: resolved,
    trustLevel: 'path-resolved',
    trustWarnings: [
      `using non-canonical ${name} at ${resolved} (canonical is ${canonical ?? '<unknown>'})`,
      ...trust.warnings,
    ],
  };
};

// Canonical scheme for the per-sandbox tmpdir path. Used by
// callers that pre-create a session-scoped tmpdir + pass it via
// `MaybeWrapSandboxArgvOptions.tmpdir` to restrict the macOS SBPL
// allow-rule. The path lives directly under `/tmp` (not under
// `/private/var/folders/...`) because the SBPL filter's firmlink
// resolution between `/tmp` and `/private/tmp` is the only path
// where the SBPL builder emits the matching `/private` form.
//
// `sessionId` is the harness's session UUID. Embedding it ties
// the tmpdir to a single Forja session: two parallel `forja`
// processes don't collide, and operator post-mortem can correlate
// `ls /tmp/forja-sb-*` against `forja doctor` sessions.
//
// Caller responsibility: pre-create (mkdir + mode 0o700), set
// `TMPDIR=<this-path>` in the wrapped process's env, optionally
// clean up at session end. The path itself is pure / side-effect
// free.
export const defaultSandboxTmpdir = (sessionId: string): string => {
  return `/tmp/forja-sb-${sessionId}`;
};

// Pre-creates the per-sandbox tmpdir so production callers can
// wire it up safely.
//
// What this owns (darwin only — non-darwin returns the no-op
// shape):
//   1. mkdir(tmpdir, mode=0o700, recursive=true). 0o700 so a
//      non-Forja user on the same host can't read the sandbox's
//      temp files (operator's OTHER apps shouldn't see Forja's
//      tmp either). recursive=true makes the call idempotent
//      across resumes / re-runs that reuse the sessionId.
//   2. cleanup callback (rm -rf, best-effort). Caller registers
//      this on process exit / session end so the directory doesn't
//      orphan. Failure to clean up doesn't refuse — orphans get
//      swept by `forja worktree gc` (offline) later.
//
// What this does NOT own:
//   - sessionId generation (caller decides; CLI bootstrap uses a
//     fresh ULID per CLI invocation so two parallel `forja`s never
//     collide).
//   - TMPDIR env propagation (caller merges into spawn env; the
//     env layout differs per callsite).
//   - SBPL profile wiring (handled by maybeWrapSandboxArgv with
//     the `tmpdir` field).
//
// Failure mode: if mkdir throws (EACCES on /tmp, ENOSPC, anything
// non-EEXIST that recursive=true can't paper over), the helper
// invokes the `warn` callback and returns `tmpdir=undefined`. The
// caller then passes undefined to maybeWrapSandboxArgv, which
// degrades to the blanket /tmp allow — graceful fallback, not a
// refuse. Operators with broken /tmp get a warning row in audit
// instead of a hard-down agent.
export interface AcquireSandboxTmpdirOptions {
  // ULID / UUID / any stable string the caller wants embedded in
  // the tmpdir path. The CLI bootstrap generates one ULID per
  // process invocation; tests pass a fixture string.
  sessionId: string;
  // Platform override for tests. Production omits and reads
  // `process.platform`. On Linux a tmpdir is created ONLY when
  // `sharedTmp` is on (else the `--tmpfs /tmp` default already
  // isolates → no-op); darwin always creates one (SBPL tmpdir-subpath
  // restriction + per-sandbox isolation); Windows isn't supported.
  platform?: NodeJS.Platform;
  // Opt-in per-session persistent `/tmp` (`[sandbox] shared_tmp`). Linux
  // only: when true, acquire `forjaSessionTmpDir(sessionId)` so the runner
  // can bind it onto `/tmp`. Ignored on darwin (a tmpdir is always
  // acquired there) and on unsupported platforms.
  sharedTmp?: boolean;
  // mkdir seam. Production uses node:fs.mkdirSync; tests inject
  // a spy that records calls without touching the real /tmp.
  mkdir?: (path: string, opts: { recursive: true; mode: number }) => void;
  // rm seam (cleanup path). Production uses node:fs.rmSync; tests
  // inject a spy to verify cleanup is called exactly once.
  rm?: (path: string, opts: { recursive: true; force: true }) => void;
  // Operator-visible warning channel. Invoked when mkdir fails;
  // the caller routes this to stderr / a structured failure sink /
  // audit. Defaults to a no-op so unit tests stay quiet.
  warn?: (message: string) => void;
}

export interface SandboxTmpdir {
  // Directory path to pass into `MaybeWrapSandboxArgvOptions.tmpdir`
  // AND into the wrapped process's `TMPDIR` env. `undefined` on
  // non-darwin (no work to do — Linux already isolates) OR on
  // mkdir failure (callers degrade gracefully to the blanket /tmp
  // allow).
  tmpdir: string | undefined;
  // Best-effort `rm -rf <tmpdir>`. Idempotent — calling twice is
  // safe; the second call is a no-op. Caller registers this on
  // process exit / session end. Failure inside the rm is swallowed
  // (best-effort cleanup; orphans get swept by `forja worktree gc`).
  cleanup: () => void;
}

export const acquireSandboxTmpdir = (opts: AcquireSandboxTmpdirOptions): SandboxTmpdir => {
  const platform = opts.platform ?? process.platform;
  // Per-platform tmpdir decision:
  //   darwin → ALWAYS `/tmp/forja-sb-<id>`. The SBPL tmpdir-subpath
  //            restriction needs the `/tmp/` prefix (firmlink form), and it
  //            provides per-sandbox isolation independent of shared_tmp.
  //   linux  → `forjaSessionTmpDir(<id>)` ONLY when shared_tmp is on. Off,
  //            the default `--tmpfs /tmp` already isolates per spawn, so
  //            there's nothing to acquire (no-op → undefined).
  //   other  → unsupported → no-op.
  let tmpdir: string;
  if (platform === 'darwin') {
    tmpdir = defaultSandboxTmpdir(opts.sessionId);
  } else if (platform === 'linux' && opts.sharedTmp === true) {
    tmpdir = forjaSessionTmpDir(opts.sessionId);
  } else {
    return { tmpdir: undefined, cleanup: () => {} };
  }
  const mkdir =
    opts.mkdir ??
    ((p, o) => {
      mkdirSync(p, o);
    });
  try {
    mkdir(tmpdir, { recursive: true, mode: 0o700 });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const code = err.code ?? 'UNKNOWN';
    const message = err.message ?? String(e);
    if (opts.warn !== undefined) {
      opts.warn(
        `sandbox tmpdir mkdir failed for '${tmpdir}' (${code}: ${message}); falling back to an ephemeral /tmp (no cross-spawn persistence this session)`,
      );
    }
    return { tmpdir: undefined, cleanup: () => {} };
  }

  const rm =
    opts.rm ??
    ((p, o) => {
      rmSync(p, o);
    });
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      rm(tmpdir, { recursive: true, force: true });
    } catch {
      // Best-effort. The directory may already be gone (concurrent
      // cleanup signal) or the operator may have rm'd it. Either
      // way, swallowing the error is correct: cleanup is advisory.
    }
  };
  return { tmpdir, cleanup };
};

export const detectSandboxAvailability = (
  options: DetectSandboxAvailabilityOptions = {},
): SandboxAvailability => {
  const platform = options.platform ?? process.platform;
  const which = options.which ?? defaultWhich;
  const stat = options.stat ?? defaultStat;
  const exists = options.exists ?? defaultExists;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;

  if (platform === 'linux') {
    const r = resolveSandboxBinary('bwrap', { which, stat, exists, isExecutable });
    if (r.path === null) {
      return {
        available: false,
        tool: null,
        path: null,
        trustLevel: 'absent',
        reason: 'bwrap binary not found on $PATH (install bubblewrap to enable sandboxing)',
        trustWarnings: [],
      };
    }
    return {
      available: true,
      tool: 'bwrap',
      path: r.path,
      trustLevel: r.trustLevel,
      reason: '',
      trustWarnings: r.trustWarnings,
    };
  }
  if (platform === 'darwin') {
    const r = resolveSandboxBinary('sandbox-exec', { which, stat, exists, isExecutable });
    if (r.path === null) {
      return {
        available: false,
        tool: null,
        path: null,
        trustLevel: 'absent',
        reason: 'sandbox-exec binary not found on $PATH',
        trustWarnings: [],
      };
    }
    return {
      available: true,
      tool: 'sandbox-exec',
      path: r.path,
      trustLevel: r.trustLevel,
      reason: '',
      trustWarnings: r.trustWarnings,
    };
  }
  // Windows + any other platform: not supported in v2.
  return {
    available: false,
    tool: null,
    path: null,
    trustLevel: 'absent',
    reason: `sandbox not supported on platform '${platform}' (v2 supports linux + darwin)`,
    trustWarnings: [],
  };
};
