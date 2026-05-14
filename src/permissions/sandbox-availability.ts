// Sandbox tooling availability detection per PERMISSION_ENGINE.md §6.5.
// "Sandbox indisponível (kernel sem unshare, bwrap binary missing) →
// state = degraded. Em degraded, profile mais alto disponível é
// host com confirm forçado em toda call. Se sandbox é
// `required: true` em policy → state = refusing."
//
// This module owns the DETECTION primitive — answer "is the
// sandboxing toolchain even present?" at engine bootstrap so the
// state machine + selection layer can branch accordingly. Cheap
// synchronous binary lookup; no privileged probes, no spawned
// subprocesses, no kernel checks. A future slice can extend the
// probe (e.g. test `unshare(CLONE_NEWNET)` actually works on this
// kernel) when the runner side lands; for now, binary-on-PATH is
// the floor.
//
// Platform mapping per spec §6.5:
//   - Linux  → `bwrap`
//   - macOS  → `sandbox-exec`
//   - Windows → not supported in v2 (always unavailable)
//
// Production bootstrap calls this once at startup and stores the
// result in EngineOptions.sandbox; tests inject a fixed value via
// the `which` seam.
//
// Slice 154 (review — bwrap PATH-shim resistance): the canonical
// system binary path is preferred over a `Bun.which()` PATH lookup.
// Pre-slice an operator (or attacker) with `/tmp/evilbin` early on
// $PATH could plant a `bwrap` shim that `exec`s the inner argv
// without sandboxing — the harness saw `bwrap` available, wrapped
// the call, but the wrapping was a no-op. Hard-pinning the
// canonical path (`/usr/bin/bwrap` / `/usr/bin/sandbox-exec`)
// closes the trivial case. Operators with `bwrap` installed
// outside `/usr/bin` (Nix, Homebrew on Linux, custom build) still
// work via the PATH-resolved fallback, but the result carries a
// trust marker and a warning if the binary fails simple ownership
// + mode checks. Bootstrap logs / telemetry surface the warning so
// the operator sees "running with non-canonical bwrap" rather than
// a silent downgrade.

import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

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
  // Slice 154: absolute path the wrapper will actually exec. Null
  // when unavailable. ALWAYS passed verbatim to Bun.spawn instead of
  // the bare binary name, so the kernel `execve` resolves to this
  // path rather than re-walking $PATH at spawn time (which would
  // re-expose the shim attack).
  path: string | null;
  // Slice 154: trust marker.
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
  // Slice 154: trust warnings (operator-facing). Populated when
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
  // Slice 154: stat seam. Production uses `node:fs.statSync`; tests
  // pin owner + mode to exercise canonical vs warning paths
  // without needing a real binary on disk.
  stat?: (path: string) => { uid: number; mode: number } | null;
  // Slice 154: filesystem-existence seam. Used by the canonical-path
  // probe to distinguish "canonical exists" from "canonical missing,
  // fall back to PATH". Production uses statSync existence check;
  // tests inject deterministic answers.
  exists?: (path: string) => boolean;
}

const defaultWhich = (name: string): string | null => {
  // `Bun.which` returns the resolved absolute path or null when
  // the binary is missing from $PATH. Synchronous and cheap.
  return Bun.which(name);
};

const defaultStat = (path: string): { uid: number; mode: number } | null => {
  try {
    const s = statSync(path);
    return { uid: s.uid, mode: s.mode };
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

// Slice 154: assess trust of a resolved sandbox-tool binary. Two
// rules, both must hold for a clean trust report:
//   1. Owner is root (uid 0). Non-root ownership means a non-
//      privileged user (the operator OR an attacker with $HOME
//      access) placed the binary; the kernel still respects its
//      contents but the supply chain is wider.
//   2. Mode bits exclude world-write (0o002) AND group-write (0o020).
//      A world-writable binary can be replaced by ANY local user;
//      group-writable opens it to the group's members.
//
// The trust check is ADVISORY — it produces warnings, not refuses.
// Operators with intentional non-canonical installs (Nix, Homebrew)
// will see warnings AND a working sandbox. Hard-rejecting would
// break those installs; the trust model documented in
// PERMISSION_ENGINE.md §6.5 is that "operator owns their own $HOME,
// but running with a non-canonical bwrap is worth flagging so any
// later forensic review can correlate."
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

// Slice 154: canonical-first resolver. Tries the hard-coded
// /usr/bin path; if that exists, uses it (highest trust). Otherwise
// falls back to PATH lookup and runs the stat-check, returning the
// result with the appropriate trust marker. Used by both
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
  } = {},
): ResolvedTool => {
  const which = options.which ?? defaultWhich;
  const stat = options.stat ?? defaultStat;
  const exists = options.exists ?? defaultExists;

  const canonical = CANONICAL_PATHS[name];
  if (canonical !== undefined && exists(canonical)) {
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

// Slice 156 (review — macOS /tmp shared sandbox+host): canonical
// scheme for the per-sandbox tmpdir path. Used by callers that
// pre-create a session-scoped tmpdir + pass it via
// `MaybeWrapSandboxArgvOptions.tmpdir` to restrict the macOS SBPL
// allow-rule. The path lives directly under `/tmp` (not under
// `/private/var/folders/...`) because the SBPL filter's firmlink
// resolution between `/tmp` and `/private/tmp` is the only path
// where the slice 156 builder emits the matching `/private` form.
//
// `sessionId` is the harness's session UUID. Embedding it ties
// the tmpdir to a single Forja session: two parallel `forja`
// processes don't collide, and operator post-mortem can correlate
// `ls /tmp/forja-sb-*` against `agent doctor` sessions.
//
// Caller responsibility: pre-create (mkdir + mode 0o700), set
// `TMPDIR=<this-path>` in the wrapped process's env, optionally
// clean up at session end. The path itself is pure / side-effect
// free.
export const defaultSandboxTmpdir = (sessionId: string): string => {
  return `/tmp/forja-sb-${sessionId}`;
};

export const detectSandboxAvailability = (
  options: DetectSandboxAvailabilityOptions = {},
): SandboxAvailability => {
  const platform = options.platform ?? process.platform;
  const which = options.which ?? defaultWhich;
  const stat = options.stat ?? defaultStat;
  const exists = options.exists ?? defaultExists;

  if (platform === 'linux') {
    const r = resolveSandboxBinary('bwrap', { which, stat, exists });
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
    const r = resolveSandboxBinary('sandbox-exec', { which, stat, exists });
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
