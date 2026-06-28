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
    'forja-mutate',
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
  // Coarse network posture from `[sandbox] network` (default off). When true,
  // an `exec:arbitrary` call is floored to `cwd-rw-net` (it additionally
  // requires `net-egress`) so unmodeled toolchains can fetch dependencies.
  // Egress is an operator-level axis, never inferred from the binary name.
  // Omitted/false ⇒ off (unbounded exec stays `cwd-rw`, no network). See
  // PERMISSION_ENGINE.md §6.5.
  networkAllowed?: boolean;
  // Trust of the directory being acted on (repo root). When an `exec:arbitrary`
  // call (a build that runs arbitrary code) ALSO carries `net-egress` (a modeled
  // dep-manager — npm/go/pip/…), egress is granted only if this is true: an
  // UNtrusted dir's build lands `cwd-rw` (no network), killing the
  // clone-and-build exfiltration vector. `net-egress` WITHOUT `exec:arbitrary`
  // (curl/wget/git/ssh/gh — explicit net actions) is NOT gated. Omitted ⇒
  // untrusted (fail-closed). See PERMISSION_ENGINE.md §6.5.
  dirTrusted?: boolean;
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
  // Resolver-honest required kinds — EXACTLY what the capabilities carry. This
  // set drives the refuse `uncovered` report (audit-facing), so it must reflect
  // only the resolver's attribution, never the floor below.
  const requiredKinds = new Set<CapabilityKind>();
  for (const cap of options.capabilities) {
    requiredKinds.add(cap.kind);
  }

  // Floor for unbounded exec. A capability that runs arbitrary program code
  // (`exec:arbitrary` — an unmodeled binary, `sed`/`awk` classified by-effect,
  // `find -exec` with an arbitrary inner, the `git` pager escape hatch, or a
  // `python`/`node`/`ruby`/`perl` SCRIPT via cmdInterpreter) can, by
  // definition, write its own working directory. Without this floor the call
  // carries only `{exec, read-fs}` → the selector picks `ro` (whole FS
  // read-only) and EVERY legitimate build/codegen/test write fails with EROFS
  // ("read-only file system") — the exact bug that made `go build` /
  // `dotnet build` / `./local-tool` unusable. Requiring `write-fs` prunes `ro`
  // (it lacks write-fs) and lands `cwd-rw`.
  //
  // Keyed on scope `arbitrary` specifically: the `python`/`node` exec scopes
  // exist in the union but have no emitter today (interpreters emit
  // `exec:arbitrary`), so `arbitrary` is the sufficient and future-proof
  // discriminator. `exec:shell` (the baseline every bash pipeline carries) and
  // read-only commands do NOT trip the floor, so pure reads stay `ro`.
  const hasUnboundedExec = options.capabilities.some(
    (cap) => cap.kind === 'exec' && cap.scope === 'arbitrary',
  );

  // SELECTION set — `requiredKinds` plus the floor's `write-fs`, minus any
  // trust-gated egress. Kept SEPARATE from `requiredKinds` so neither the floor
  // nor the trust-gate leaks into the audit-facing `uncovered` report or the
  // resolved set the engine scores/envelope-gates (PERMISSION_ENGINE.md §6.5).
  let selectionKinds: ReadonlySet<CapabilityKind> = requiredKinds;
  if (hasUnboundedExec) {
    const s = new Set<CapabilityKind>(requiredKinds);
    // `write-fs` floor: an unbounded-exec call may write its cwd. (Never makes a
    // set unsatisfiable — cwd-rw covers it — so the floor alone can't refuse.)
    s.add('write-fs');
    // EXEMPTION from the trust-gate below: egress that is the command's EXPLICIT
    // purpose (an explicit network tool — ssh/curl/scp, `Capability.explicitEgress`)
    // is the operation itself, not incidental build fetch. `ssh host <cmd>` ALSO
    // carries `exec:arbitrary` (the remote command) and would otherwise look
    // identical to a dep-manager build and lose its network — so it is never
    // stripped. (Plain curl/wget/git carry net-egress WITHOUT `exec:arbitrary`
    // and don't reach this branch at all.)
    const hasExplicitEgress = options.capabilities.some(
      (cap) => cap.kind === 'net-egress' && cap.explicitEgress === true,
    );
    // Trust-gate BUILD egress: an `exec:arbitrary` call reaches the network only
    // in a TRUSTED dir. Untrusted → drop INCIDENTAL `net-egress` so a modeled
    // dep-manager (npm/go/pip/…) lands `cwd-rw` (no egress) not `cwd-rw-net`,
    // killing the clone-and-build exfil vector (one confirm would otherwise grant
    // full egress + broad host read).
    if (options.dirTrusted !== true && !hasExplicitEgress) s.delete('net-egress');
    selectionKinds = s;
  }

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
    for (const kind of selectionKinds) {
      if (!allowed.has(kind)) {
        covers = false;
        break;
      }
    }
    if (covers) candidates.push(profile);
  }

  if (candidates.length === 0) {
    // Surface every kind nothing covered (under the gated host rules) so the
    // audit row carries actionable detail. Reports `requiredKinds` (the
    // resolver-honest set) — NOT the floored `selectionKinds` — so the audit
    // names only what the binary actually requested.
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

  // Coarse network posture — a POST-selection bump for UNMODELED toolchains
  // (a user binary, `./gradlew`/`./mvnw` wrappers, swift/zig). Egress is an
  // OPERATOR decision (`[sandbox] network = on`, default off), never inferred
  // per-binary. Requires BOTH the posture on (`networkAllowed`) AND a TRUSTED
  // dir (`dirTrusted`): an unbounded-exec call that landed `cwd-rw` is upgraded
  // to `cwd-rw-net` only then. The `dirTrusted` half makes egress trust-gated
  // UNIFORMLY — same as the modeled-dep-manager `net-egress` drop above — so an
  // untrusted clone's build never reaches the network even with a global
  // `network = on` (kills the drive-by exfil vector). Doing it as a bump (not a
  // required kind) means it can NEVER turn a viable plan into a refuse:
  // `exec:arbitrary + secret-access` stays `home-rw` instead of refusing on the
  // unsatisfiable {secret-access, net-egress} combo. `cwd-rw-net` ⊇ `cwd-rw`, so
  // the bump is always valid. Modeled dep-managers reach `cwd-rw-net` via their
  // own `net-egress` (also dirTrusted-gated above), independent of this posture.
  if (
    hasUnboundedExec &&
    options.networkAllowed === true &&
    options.dirTrusted === true &&
    chosen === 'cwd-rw'
  ) {
    return { kind: 'ok', profile: 'cwd-rw-net' };
  }
  return { kind: 'ok', profile: chosen };
};
