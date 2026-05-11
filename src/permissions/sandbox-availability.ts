// Sandbox tooling availability detection per PERMISSION_ENGINE.md §6.5.
// "Sandbox indisponível (kernel sem unshare, bwrap binary missing) →
// state = degraded. Em degraded, profile mais alto disponível é
// host com confirm forçado em toda call. Se sandbox é
// `required: true` em policy → state = refusing."
//
// This module owns the DETECTION primitive — answer "is the
// sandboxing toolchain even present?" at engine bootstrap so the
// state machine + selection layer can branch accordingly. Cheap
// synchronous binary lookup via `Bun.which`; no privileged probes,
// no spawned subprocesses, no kernel checks. A future slice can
// extend the probe (e.g. test `unshare(CLONE_NEWNET)` actually
// works on this kernel) when the runner side lands; for now,
// binary-on-PATH is the floor.
//
// Platform mapping per spec §6.5:
//   - Linux  → `bwrap`
//   - macOS  → `sandbox-exec`
//   - Windows → not supported in v2 (always unavailable)
//
// Production bootstrap calls this once at startup and stores the
// result in EngineOptions.sandbox; tests inject a fixed value via
// the `which` seam.

export interface SandboxAvailability {
  available: boolean;
  // Tooling that satisfied the probe ('bwrap' / 'sandbox-exec') or
  // null when unavailable. Persists into telemetry / audit so
  // postmortems can distinguish "Linux without bwrap installed"
  // from "macOS happy path" without re-running the probe.
  tool: 'bwrap' | 'sandbox-exec' | null;
  // Free-form reason captured when unavailable. Surfaces in the
  // operator-facing error / degraded notice. Empty string when
  // available (the tool name is the affirmative signal).
  reason: string;
}

export interface DetectSandboxAvailabilityOptions {
  // Process platform override for tests. Production omits and reads
  // `process.platform`.
  platform?: NodeJS.Platform;
  // Binary-resolver seam. Production uses `Bun.which`; tests can
  // pin to a fake that returns null/string for specific names so
  // the suite doesn't depend on the host having bwrap installed.
  which?: (name: string) => string | null;
}

const defaultWhich = (name: string): string | null => {
  // `Bun.which` returns the resolved absolute path or null when
  // the binary is missing from $PATH. Synchronous and cheap.
  return Bun.which(name);
};

export const detectSandboxAvailability = (
  options: DetectSandboxAvailabilityOptions = {},
): SandboxAvailability => {
  const platform = options.platform ?? process.platform;
  const which = options.which ?? defaultWhich;

  if (platform === 'linux') {
    const path = which('bwrap');
    if (path !== null) {
      return { available: true, tool: 'bwrap', reason: '' };
    }
    return {
      available: false,
      tool: null,
      reason: 'bwrap binary not found on $PATH (install bubblewrap to enable sandboxing)',
    };
  }
  if (platform === 'darwin') {
    const path = which('sandbox-exec');
    if (path !== null) {
      return { available: true, tool: 'sandbox-exec', reason: '' };
    }
    return {
      available: false,
      tool: null,
      reason: 'sandbox-exec binary not found on $PATH',
    };
  }
  // Windows + any other platform: not supported in v2.
  return {
    available: false,
    tool: null,
    reason: `sandbox not supported on platform '${platform}' (v2 supports linux + darwin)`,
  };
};
