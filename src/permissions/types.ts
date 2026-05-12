// Permission engine types per AGENTIC_CLI §8.
//
// Categories group tools by what they do, so policy rules can target the
// behavior rather than every individual tool name. New tools join an
// existing category instead of inventing a new section.
import type { SandboxProfile } from './sandbox-plan.ts';

export type PolicyCategory = 'fs.read' | 'fs.write' | 'bash' | 'web.fetch' | 'misc';

export type PolicyMode = 'strict' | 'acceptEdits' | 'bypass';

// Policy rules per category. Each section is optional; absence means "no
// opinion at this layer" (engine falls through to defaults).
//
// `locked` (per AGENTIC_CLI §8): when set in a higher-precedence layer
// (enterprise > user > project > session), lower layers cannot override
// this section. Used by enterprise admins to enforce non-negotiable
// rules like "deny rm -rf" or "deny outbound web fetch to internal IPs".
export interface BashPolicy {
  allow?: readonly string[];
  confirm?: readonly string[];
  deny?: readonly string[];
  locked?: boolean;
}

export interface PathPolicy {
  allow_paths?: readonly string[];
  confirm_paths?: readonly string[];
  deny_paths?: readonly string[];
  locked?: boolean;
}

export interface FetchPolicy {
  allow_hosts?: readonly string[];
  deny_hosts?: readonly string[];
  locked?: boolean;
}

export interface PolicyToolsSection {
  bash?: BashPolicy;
  read_file?: PathPolicy;
  write_file?: PathPolicy;
  edit_file?: PathPolicy;
  glob?: PathPolicy;
  grep?: PathPolicy;
  fetch_url?: FetchPolicy;
  // Future tools fall back to category-level policy until a section exists.
}

export interface PolicyDefaults {
  // Optional so the parser can distinguish "user file omitted
  // defaults" from "user file explicitly said mode=strict". The
  // hierarchy resolver needs that distinction to avoid logging
  // phantom lock conflicts when a lower layer is silent on mode
  // and a higher layer locked the field. The merged policy
  // (consumed by the engine) always has `mode` set via the
  // resolver's final default.
  mode?: PolicyMode;
  // When set in a higher-precedence layer, lower layers cannot
  // change `mode`. Apply at the same hierarchy granularity as
  // section-level lock (per AGENTIC_CLI §8).
  locked?: boolean;
}

// PERMISSION_ENGINE.md §6.5 policy-layer counterpart to the CLI
// `--sandbox-host` flag and the bootstrap-hardcoded `required=false`.
// All fields optional so the hierarchy resolver can distinguish
// "silent" from "explicit false" (same convention as PolicyDefaults).
//
//   - `required`: when true AND `detectSandboxAvailability` returns
//     unavailable, the bootstrap transitions the engine straight to
//     `refusing` (vs the lenient `degraded` it picks today by
//     default). Operators in regulated deployments set this in
//     enterprise policy to refuse boot under a missing sandbox
//     toolchain.
//   - `hostAllowed`: when true, the `host` sandbox profile becomes
//     selectable without the CLI flag. Pairs with `host-passthrough`
//     capability in the resolved set — both still required for `host`
//     to be picked. The CLI flag remains as a session-scoped opt-in;
//     policy + CLI compose via OR.
//
// Section-level lock mirrors `defaults.locked` / `BashPolicy.locked` /
// `PathPolicy.locked` / `FetchPolicy.locked`: when set in a higher-
// precedence layer (enterprise > user > project > session), lower
// layers cannot change `required` or `hostAllowed`. Re-affirming the
// same values is silently OK; attempting to flip a locked field
// records a `lockConflict` against `sandbox` and the lower layer's
// change is discarded.
export interface PolicySandbox {
  required?: boolean;
  hostAllowed?: boolean;
  locked?: boolean;
}

// PERMISSION_ENGINE.md §7.3 external sealing. Configures how the
// engine snapshots the local hash chain to a write-once surface
// so a root adversary who rewrites every audit row + recomputes
// hashes still leaves a trail.
//
// `mode`:
//   - 'none'         — default; no sealing. Local hash chain only.
//   - 'worm-file'    — append-only file (chattr +a on Linux / WORM mount).
//   - 'git-anchored' — append to a file inside a git repo, commit
//                      per entry (shipped in slice 63). Commits
//                      give append-only semantics + a forensic log
//                      via `git log`. Operator pushes to a remote
//                      out-of-band for additional anchoring.
// Other §7.3 modes (`s3-object-lock`, `rfc3161-tsa`) are reserved
// for future slices; parsing rejects them now so a typo or
// premature upgrade fails loudly instead of silently falling back
// to `none`.
//
// `path` (required when mode='worm-file' or 'git-anchored'):
//   - worm-file:    absolute path to the seal file. The bootstrap
//                   creates the file on first append and invokes
//                   `chattr +a` via the SealStore's `onCreate` hook.
//   - git-anchored: absolute path to a pre-initialized git repo
//                   directory. The sealer writes `seal.log` inside
//                   it and commits per append.
//
// `interval_decisions` (default 100) — fire a seal every N audit
// decisions. Set to 0 to disable decision-driven sealing (only the
// wall-clock interval applies). The audit sink's `emit` ticks the
// scheduler on every successful row persist.
//
// `interval_seconds` (default 3600) — fire a seal every M seconds.
// Set to 0 to disable time-driven sealing. The scheduler self-
// reschedules so operators don't need an external cron.
//
// `on_failure`:
//   - 'degrade' (default) — store.append failure transitions the
//     engine to `degraded`. New decisions continue but every
//     would-be allow becomes confirm.
//   - 'refuse'           — store.append failure transitions the
//     engine to `refusing`. Every check returns deny until restart.
//
// Single layer wins — the highest-precedence layer that sets
// `seal` defines the entire config. No partial merge across layers
// (a mixed config — enterprise sets mode, user sets interval — is
// usually a mistake; "all-or-nothing" makes intent obvious).
export type SealMode = 'none' | 'worm-file' | 'git-anchored' | 'rfc3161-tsa' | 's3-object-lock';
export type SealOnFailure = 'degrade' | 'refuse';

export interface SealPolicy {
  mode: SealMode;
  // Backend-polymorphic storage location.
  //   - `worm-file`: path to the append-only seal log file
  //   - `git-anchored`: path to the pre-existing git repo directory
  //   - `rfc3161-tsa`: path to a directory holding TSR proof tokens
  //     (one file per seal) AND the seal.log line index
  //   - `s3-object-lock`: path to a local directory holding the
  //     seal.log line index (the immutable proofs themselves live
  //     in S3 under `bucket/key_prefix/`)
  path?: string;
  // Polymorphic endpoint URL.
  //   - `rfc3161-tsa`: REQUIRED. TSA HTTP endpoint accepting
  //     application/timestamp-query.
  //   - `s3-object-lock`: OPTIONAL custom S3 endpoint (e.g., MinIO
  //     `http://minio:9000`). Absent → AWS default for the region.
  endpoint?: string;
  // §7.3 `s3-object-lock` mode (slice 89). S3 bucket holding the
  // sealed objects. REQUIRED for that mode. Bucket MUST have
  // Object Lock enabled at creation (`aws s3api
  // create-bucket --object-lock-enabled-for-bucket`); this engine
  // doesn't bootstrap that.
  bucket?: string;
  // §7.3 `s3-object-lock`. AWS region. Optional — when absent,
  // the `aws` CLI uses the operator's profile default
  // (`AWS_REGION` env var, `~/.aws/config`, etc.).
  region?: string;
  // §7.3 `s3-object-lock`. S3 key prefix for sealed objects.
  // Each entry lands at `${prefix}${seq}-${ts}.seal`. Operators
  // typically scope by install_id (e.g., `forja/<install-id>/`).
  // Optional — defaults to empty (bucket root). MUST NOT start or
  // end with `/`; the sealer always inserts the separator.
  key_prefix?: string;
  // §7.3 `s3-object-lock`. Retention window for the Object Lock
  // (COMPLIANCE mode). REQUIRED for s3-object-lock — no default,
  // because the lock makes the objects undeletable by anyone
  // (including root) until expiry. Operators MUST choose
  // deliberately. Typical regulated values: 2555 (7 years for
  // SOX), 3650 (10 years for HIPAA). Must be ≥ 1.
  retention_days?: number;
  interval_decisions?: number;
  interval_seconds?: number;
  on_failure?: SealOnFailure;
  // §12.2 enterprise locking semantics (slice 112, R8 #322).
  // When `true` at any layer, lower-precedence layers can't
  // override the seal section. Re-asserting the exact same
  // seal config is silent (no conflict); any field change
  // records a `lockConflict` and the lower layer's version is
  // discarded. Pre-slice the seal section was last-writer-wins
  // with no lock semantics — enterprise-mandated `worm-file`
  // sealing could be silently swapped for `mode: none` by
  // project policy, defeating the §7.3 forensic guarantee.
  locked?: boolean;
}

export interface Policy {
  defaults: PolicyDefaults;
  tools: PolicyToolsSection;
  sandbox?: PolicySandbox;
  seal?: SealPolicy;
}

// Provenance of the matching rule that produced a Decision.
// Populated by the engine on every internal Decision creation so
// the modal layer + audit can answer "which layer / which rule
// fired?" without re-running the merge.
//
// `layer` values:
//   - 'enterprise' | 'user' | 'project' | 'session' — the layer
//     whose section carried the matching rule.
//   - 'default' — engine-internal decision: no rule matched
//     anywhere (default-deny), `mode=bypass` short-circuit,
//     `misc` category passthrough, or a missing/invalid argument
//     rejection that fired BEFORE any policy lookup.
//
// `rule` (optional): the literal pattern that matched (`'rm *'`,
// `'src/**'`, `'api.example.com'`). Absent when the path was
// engine-internal (default-deny, missing-arg rejection, bypass,
// misc).
//
// `section` (optional): the policy section the rule lives in
// (`bash`, `read_file`, `defaults`). Lets `/perms why <tool>`
// render "your rule lives at tools.bash:deny[2]"-style hints
// without the modal having to recompute.
//
// Optional on `Decision` (rather than required) so consumers
// that don't render source info (audit, hooks pipeline) don't
// pay a migration cost. The engine populates source on EVERY
// Decision it returns; absence in the wild only happens for
// Decision objects synthesized by tests / non-engine code.
export type PolicyLayer = 'enterprise' | 'user' | 'project' | 'session' | 'default';

export interface PolicySource {
  layer: PolicyLayer;
  rule?: string;
  section?: string;
}

// Fields common to every Decision variant. PERMISSION_ENGINE.md §17
// linkage: `approvalSeq` is populated when the engine's audit sink
// wrote a row to `approvals_log` (production path with the SQLite
// sink). Omitted under the noop sink (tests, headless paths that
// skip persistence). The harness uses it to link `approvals_log.seq`
// with the matching `tool_calls.id` via the `approval_call_links`
// table, so future replay modes (`--against-current-policy`,
// `permission diff`) can recover raw args from `tool_calls.input`.
//
// §6.5 sandbox profile populated when EngineOptions.sandbox is set
// (production bootstrap wires it from `detectSandboxAvailability`).
// The harness propagates it into ToolContext so tools that spawn
// child processes (currently bash) can wrap with the bwrap argv
// from `buildBwrapArgv`. Omitted on misc category (resolver skipped,
// no profile to plan) or when the engine was constructed without
// sandbox inputs (legacy / test path).
interface DecisionBase {
  approvalSeq?: number;
  sandboxProfile?: SandboxProfile;
  // §8 TTL — when this Decision was produced by matching a persisted
  // grant, the grant's `expires_at` flows through here so the audit
  // row's `ttl_expires_at` column records when the granted authority
  // lapses. Undefined for non-grant decisions (the default deny /
  // session-allow / policy-rule paths).
  ttlExpiresAt?: number;
}

// What the engine returns from a check. The harness converts `confirm`
// into a UI prompt at invocation time; without a confirmFn, the harness
// must default to deny — silently auto-allowing a `confirm` decision is
// the bug class this type prevents.
export type Decision =
  | (DecisionBase & { kind: 'allow'; reason?: string; source?: PolicySource })
  | (DecisionBase & { kind: 'deny'; reason: string; source?: PolicySource })
  | (DecisionBase & { kind: 'confirm'; prompt: string; reason?: string; source?: PolicySource });

// Snapshot view of permissions handed to a tool's ToolContext (per
// CONTRACTS §2 line 63). Read-only — tools must not mutate. Currently
// just exposes the active mode; tools that need to short-circuit a
// multi-step plan should call back into the engine via the harness with
// the right tool name (the view can't know which tool's per-tool rules
// to consult by category alone).
export interface PermissionsView {
  mode: PolicyMode;
}
