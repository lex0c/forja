// Sandbox profile selection.
//
// Five profiles arranged from most restrictive to least:
//
//   ro          — read-only filesystem, no network, unshared pid.
//   cwd-rw      — write within cwd; everything else read-only;
//                 no network.
//   cwd-rw-net  — same as cwd-rw plus allow-listed egress.
//   home-rw     — write across $HOME (resto ro); no network.
//   host        — passthrough. Last resort. Requires an explicit
//                 operator flag AND a `host-passthrough` capability
//                 in the resolved set.
//
// This module owns the SELECTION primitive — given a resolved
// capability set and a host-allowed flag, pick the most
// restrictive viable profile. Actual sandbox execution (bwrap
// argv synthesis, nftables rule loading, etc.) lives in the
// runner modules; this is purely the planning step that feeds the
// audit row, the reason chain, and the runner.
//
// Algorithm:
//   1. candidates = { profile | resolved_capabilities ⊆ profile.allowed }
//   2. if candidates empty → refuse with `no_viable_sandbox`
//   3. if `host` ∈ candidates AND other ∈ candidates → drop host
//   4. tie-break by fixed order [ro, cwd-rw, cwd-rw-net, home-rw, host]
//
// `host` has additional gates beyond capability subset matching:
//   - operator must pass an explicit flag (`--sandbox-host` at the
//     CLI; threaded into selectSandboxProfile as
//     hostExplicitlyAllowed).
//   - resolved set must include a `host-passthrough` capability.
// Either missing removes `host` from the candidate set, which can
// turn an otherwise-viable plan into `no_viable_sandbox` for
// capability shapes nothing else covers.

import type { Capability, CapabilityKind } from './capabilities.ts';

export type SandboxProfile = 'ro' | 'cwd-rw' | 'cwd-rw-net' | 'home-rw' | 'host';

// Ordered list — index encodes restrictiveness. Tie-break in the
// algorithm walks this array left-to-right and picks the first
// candidate found.
export const SANDBOX_PROFILE_ORDER: readonly SandboxProfile[] = [
  'ro',
  'cwd-rw',
  'cwd-rw-net',
  'home-rw',
  'host',
] as const;

// Set form for runtime membership checks. Used by
// `isSandboxProfile` at every wire boundary that receives an
// untrusted `sandboxProfile` string — the broker validates inbound
// requests, the worker runtime validates parsed BrokerRequest,
// the sandbox runner validates before wrap. Without this set, an
// attacker passing an unknown string would slip past the typed
// `SandboxProfile` annotation (TS casts are erased at runtime)
// and either bypass the wrap (`'host'` shape) or land malformed
// bwrap args that fail mid-spawn.
const SANDBOX_PROFILE_SET: ReadonlySet<string> = new Set(SANDBOX_PROFILE_ORDER);

export const isSandboxProfile = (s: unknown): s is SandboxProfile =>
  typeof s === 'string' && SANDBOX_PROFILE_SET.has(s);

// Capability kinds each profile allows the tool to exercise.
// Modeled at the KIND level (read-fs, write-fs, etc.) rather than
// per-scope: scope-aware filtering is a separate concern handled
// by the policy/static-rule layer; this table answers "if the
// tool wants to write the filesystem somewhere, does this profile
// permit any writes at all?".
//
// Notes:
//   - All profiles allow `read-fs` (every sandbox can read; the
//     question is what they CAN'T do).
//   - `exec` is broader than fs (running a process under a
//     sandbox); the restrictive profiles still permit it because
//     the process inherits the sandbox constraints. `host` is
//     the only profile that grants `host-passthrough`.
//   - `secret-access` requires either `home-rw` or `host` because
//     secrets live under `$HOME` (e.g. `~/.config/forja/secrets`).
const PROFILE_ALLOWED_CAPABILITIES: Record<SandboxProfile, ReadonlySet<CapabilityKind>> = {
  ro: new Set<CapabilityKind>(['read-fs', 'exec']),
  'cwd-rw': new Set<CapabilityKind>(['read-fs', 'write-fs', 'delete-fs', 'exec', 'git-write']),
  'cwd-rw-net': new Set<CapabilityKind>([
    'read-fs',
    'write-fs',
    'delete-fs',
    'exec',
    'git-write',
    'net-egress',
  ]),
  'home-rw': new Set<CapabilityKind>([
    'read-fs',
    'write-fs',
    'delete-fs',
    'exec',
    'git-write',
    'secret-access',
  ]),
  host: new Set<CapabilityKind>([
    'read-fs',
    'write-fs',
    'delete-fs',
    'exec',
    'git-write',
    'net-egress',
    'net-ingress',
    'secret-access',
    'env-mutate',
    'agent-mutate',
    'host-passthrough',
  ]),
};

export interface SelectSandboxProfileOptions {
  capabilities: readonly Capability[];
  // Operator-set flag: `--sandbox-host` at the CLI. Without it,
  // the `host` profile is removed from the candidate set even when
  // the policy would otherwise allow it. Defense against accidental
  // passthrough.
  hostExplicitlyAllowed: boolean;
}

export type SelectSandboxProfileResult =
  | { kind: 'ok'; profile: SandboxProfile }
  | { kind: 'refuse'; reason: 'no_viable_sandbox'; uncovered: CapabilityKind[] };

// Returns the chosen profile or a refusal envelope. The `uncovered`
// list on refusal surfaces which capability kinds nothing covered
// (after applying the host gates); the audit/modal can render it
// as "your call needs delete-fs+net-egress but no profile permits
// both" without recomputing.
export const selectSandboxProfile = (
  options: SelectSandboxProfileOptions,
): SelectSandboxProfileResult => {
  const requiredKinds = new Set<CapabilityKind>();
  for (const cap of options.capabilities) requiredKinds.add(cap.kind);

  // `host` needs an explicit operator flag AND a host-passthrough
  // capability in the resolved set. Either missing prunes host
  // from the candidate pool BEFORE the subset check; the test
  // below assumes a pruned host doesn't artificially "cover" the
  // host-passthrough kind.
  const hostHasPassthroughCap = requiredKinds.has('host-passthrough');
  const hostEligible = options.hostExplicitlyAllowed && hostHasPassthroughCap;

  const candidates: SandboxProfile[] = [];
  for (const profile of SANDBOX_PROFILE_ORDER) {
    if (profile === 'host' && !hostEligible) continue;
    const allowed = PROFILE_ALLOWED_CAPABILITIES[profile];
    let covers = true;
    for (const kind of requiredKinds) {
      if (!allowed.has(kind)) {
        covers = false;
        break;
      }
    }
    if (covers) candidates.push(profile);
  }

  if (candidates.length === 0) {
    // Surface every kind nothing covered (under the gated host
    // rules) so the audit row carries actionable detail. We treat
    // `requiredKinds` as the uncovered set when the ENTIRE plan
    // refuses — every kind contributed to at least one rejection.
    return {
      kind: 'refuse',
      reason: 'no_viable_sandbox',
      uncovered: Array.from(requiredKinds).sort(),
    };
  }

  // Drop host when alternatives exist — host is always the last-
  // resort profile.
  const nonHost = candidates.filter((p) => p !== 'host');
  const finalists = nonHost.length > 0 ? nonHost : candidates;

  // Tie-break by SANDBOX_PROFILE_ORDER. `finalists` already came
  // from a left-to-right walk of the order, so finalists[0] is
  // the most restrictive viable choice.
  const chosen = finalists[0] as SandboxProfile;
  return { kind: 'ok', profile: chosen };
};
