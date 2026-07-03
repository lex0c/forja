// Permission engine types.
//
// Categories group tools by what they do, so policy rules can
// target the behavior rather than every individual tool name. New
// tools join an existing category instead of inventing a new
// section.
import type { SandboxProfile } from './sandbox-plan.ts';

// 'mcp' gates tools from an MCP server (the `mcp__<server>__<tool>` wire form)
// that CANNOT reach the network — a server confined to the no-network sandbox
// profile (`cwd-rw`, the default when a sandbox tool is present — MCP.md §2.3).
// It is NOT egress. 'mcp.egress' is the category for any MCP server that CAN
// reach the network: one GRANTED network (`[servers.<name>.network]`), one
// running UNCONFINED (operator opt-out, or no sandbox tool — both inherit the
// full host network), and the future remote (sse/http) transport. Network reach
// ⇒ exfil risk ⇒ egress treatment (default confirm, never auto-approved).
export type PolicyCategory =
  | 'fs.read'
  | 'fs.write'
  | 'bash'
  | 'web.fetch'
  | 'misc'
  | 'mcp'
  | 'mcp.egress'
  | 'mesh.egress'
  // Publishing a reply to a peer that already opened a conversation (mesh_reply).
  // Deliberately NOT egress: it closes an inbound obligation the operator took on
  // with `/relay on`, so it follows the operator's posture (supervised confirms
  // what leaves; autonomous auto-approves) — unlike mesh.egress (initiating
  // outbound contact), which stays gated even in autonomous. See MESH.md §5.3/§9.
  | 'mesh.reply';

// Categories that send bytes OUT of the machine to an operator-unconfined
// destination. Egress is special-cased by the autonomous posture: a
// default-confirm for an egress category is NEVER auto-approved — a
// model-chosen fetch can carry data out in the URL (exfil; AGENTIC_CLI §9), so
// the operator always sees an unknown-host egress, even under autonomous. This
// is the SINGLE source of truth for "is this egress": a future egress category
// (a POST/webhook tool, an MCP egress) must be added here, not re-pattern-
// matched as `category === 'web.fetch'` at each guard site (which would
// silently auto-approve the new category and reopen the exfil hole).
export const categoryIsEgress = (category: PolicyCategory): boolean =>
  category === 'web.fetch' || category === 'mcp.egress' || category === 'mesh.egress';

export type PolicyMode = 'strict' | 'acceptEdits' | 'bypass';

// Operation mode the operator flips from the prompt (shown as
// Supervised / Autonomous in the TUI). Orthogonal to PolicyMode: it
// does not change how a decision is classified, only what happens to a
// routine `policy` confirm — `supervised` opens the modal (today's
// behavior), `autonomous` auto-approves it. Every risk-caused confirm
// (compound/escalate/score/resolver/degraded) still opens the modal in
// BOTH postures, and the engine suspends auto-approval entirely while
// degraded. Disambiguated from the execution `profile`
// (autonomous/orchestrated/hybrid, AGENTIC_CLI §5.2), which decides who
// orchestrates and is unrelated to this approval axis.
export type ApprovalPosture = 'supervised' | 'autonomous';

// One recorded Supervised↔Autonomous transition. The engine keeps these
// in-memory for introspection and (Slice 3) durable audit; `at` is
// engine-clock millis from the same `now` seam the engine uses.
export interface PostureChange {
  from: ApprovalPosture;
  to: ApprovalPosture;
  reason: string;
  at: number;
}

// Policy rules per category. Each section is optional; absence means "no
// opinion at this layer" (engine falls through to defaults).
//
// `locked`: when set in a higher-precedence layer (enterprise >
// user > project > session), lower layers cannot override this
// section. Used by enterprise admins to enforce non-negotiable
// rules like "deny rm -rf" or "deny outbound web fetch to internal
// IPs".
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
  // Additive over `DEFAULT_TRUSTED_HOSTS` in `risk-score.ts`. Hosts
  // listed here do NOT trigger the `untrusted_egress` risk feature
  // for this project — useful for internal CDNs, GitHub Enterprise,
  // or any endpoint outside the hardcoded public-registry default.
  // NOT an allowlist: `deny_hosts` still wins. Empty/absent leaves
  // the engine at the default set.
  //
  // Patterns honored via `matcher.ts:matchHost` — same semantic as
  // `allow_hosts` / `deny_hosts` on this section. `*.corp.internal`
  // silences subdomains; `github.com` matches exactly. Operators
  // can read both `allow_hosts` examples and `trusted_hosts`
  // examples as the same matcher rules.
  trusted_hosts?: readonly string[];
  locked?: boolean;
}

// Per-tool MCP policy (MCP.md §8). Glob/prefix patterns over the wire name
// `mcp__<server>__<tool>` (NO regex — same matcher as `bash`). Layered ON TOP of
// the manifest-trust gate (which already approved the server's whole tool set):
// an operator `deny` blocks a specific tool, `confirm` forces a prompt, `allow`
// permits it silently. Precedence deny > allow > confirm; the default (no match)
// is the CATEGORY default — `mcp` → allow, `mcp.egress` → confirm. An explicit
// `allow` therefore opts an egress tool out of its default confirm (the operator
// pre-authorized that exact tool), mirroring `fetch_url`'s allow_hosts.
export interface McpPolicy {
  allow?: readonly string[];
  confirm?: readonly string[];
  deny?: readonly string[];
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
  // MCP tools (`mcp__<server>__<tool>`). One section governs every server's
  // tools; the manifest-trust gate is per-server, this is per-tool-pattern.
  mcp?: McpPolicy;
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
  // change `mode`. Applies at the same hierarchy granularity as
  // section-level lock.
  locked?: boolean;
}

// Policy-layer counterpart to the CLI `--sandbox-host` flag and
// the bootstrap-hardcoded `required=false`. All fields optional so
// the hierarchy resolver can distinguish "silent" from "explicit
// false" (same convention as PolicyDefaults).
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

// External sealing. Configures how the engine snapshots the local
// hash chain to a write-once surface so a root adversary who
// rewrites every audit row + recomputes hashes still leaves a
// trail.
//
// `mode`:
//   - 'none'           — default; no sealing. Local hash chain only.
//   - 'worm-file'      — append-only file (chattr +a on Linux / WORM mount).
//   - 'git-anchored'   — append to a file inside a git repo, commit
//                        per entry. Commits give append-only semantics
//                        + a forensic log via `git log`. Operator
//                        pushes to a remote out-of-band for additional
//                        anchoring.
//   - 'rfc3161-tsa'    — fetch an RFC 3161 timestamp token (TSR) for
//                        each seal entry from the configured TSA HTTP
//                        endpoint. The token + chain hash give third-
//                        party non-repudiation. See `sealing-rfc3161.ts`.
//   - 's3-object-lock' — write seal entries to S3 with Object Lock
//                        (COMPLIANCE mode) at the configured retention
//                        window. The lock makes seals undeletable by
//                        anyone (including root) until expiry. See
//                        `sealing-s3-object-lock.ts`.
//
// `path` (used by every mode except `none`):
//   - worm-file:      absolute path to the seal file. The bootstrap
//                     creates the file on first append and invokes
//                     `chattr +a` via the SealStore's `onCreate` hook.
//   - git-anchored:   absolute path to a pre-initialized git repo
//                     directory. The sealer writes `seal.log` inside
//                     it and commits per append.
//   - rfc3161-tsa:    absolute path to a directory holding the TSR
//                     proof files plus the `seal.log` line index.
//   - s3-object-lock: absolute path to a local directory holding the
//                     `seal.log` line index — the immutable proofs
//                     themselves live in S3 under `bucket/key_prefix/`.
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
  // `s3-object-lock` mode. S3 bucket holding the sealed objects.
  // REQUIRED for that mode. Bucket MUST have Object Lock enabled
  // at creation (`aws s3api create-bucket
  // --object-lock-enabled-for-bucket`); this engine doesn't
  // bootstrap that.
  bucket?: string;
  // `s3-object-lock`. AWS region. Optional — when absent, the
  // `aws` CLI uses the operator's profile default (`AWS_REGION`
  // env var, `~/.aws/config`, etc.).
  region?: string;
  // `s3-object-lock`. S3 key prefix for sealed objects. Each
  // entry lands at `${prefix}${seq}-${ts}.seal`. Operators
  // typically scope by install_id (e.g., `forja/<install-id>/`).
  // Optional — defaults to empty (bucket root). MUST NOT start or
  // end with `/`; the sealer always inserts the separator.
  key_prefix?: string;
  // `s3-object-lock`. Retention window for the Object Lock
  // (COMPLIANCE mode). REQUIRED for s3-object-lock — no default,
  // because the lock makes the objects undeletable by anyone
  // (including root) until expiry. Operators MUST choose
  // deliberately. Typical regulated values: 2555 (7 years for
  // SOX), 3650 (10 years for HIPAA). Must be ≥ 1.
  retention_days?: number;
  interval_decisions?: number;
  interval_seconds?: number;
  on_failure?: SealOnFailure;
  // Enterprise locking. When `true` at any layer, lower-
  // precedence layers can't override the seal section.
  // Re-asserting the exact same seal config is silent (no
  // conflict); any field change records a `lockConflict` and the
  // lower layer's version is discarded. Without this lock, an
  // enterprise-mandated `worm-file` sealing config could be
  // silently swapped for `mode: none` by project policy,
  // defeating the forensic guarantee.
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

// Fields common to every Decision variant. `approvalSeq` is
// populated when the engine's audit sink wrote a row to
// `approvals_log` (production path with the SQLite sink). Omitted
// under the noop sink (tests, headless paths that skip
// persistence). The harness uses it to link `approvals_log.seq`
// with the matching `tool_calls.id` via the
// `approval_call_links` table, so future replay modes
// (`--against-current-policy`, `permission diff`) can recover
// raw args from `tool_calls.input`.
//
// `sandboxProfile` is populated when EngineOptions.sandbox is set
// (production bootstrap wires it from `detectSandboxAvailability`).
// The harness propagates it into ToolContext so tools that spawn
// child processes (currently bash) can wrap with the bwrap argv
// from `buildBwrapArgv`. Omitted on misc category (resolver
// skipped, no profile to plan) or when the engine was constructed
// without sandbox inputs.
interface DecisionBase {
  approvalSeq?: number;
  sandboxProfile?: SandboxProfile;
  // Grant TTL — when this Decision was produced by matching a
  // persisted grant, the grant's `expires_at` flows through here
  // so the audit row's `ttl_expires_at` column records when the
  // granted authority lapses. Undefined for non-grant decisions
  // (the default deny / session-allow / policy-rule paths).
  ttlExpiresAt?: number;
}

// Why a `confirm` decision fired. The approval-posture axis
// (ApprovalPosture) keys on this: under `autonomous` posture the engine
// auto-approves ONLY `policy` confirms — every other cause is a
// risk/safety signal that keeps its modal regardless of posture
// (fail-closed). It's a typed field rather than something parsed back
// out of `reason` so the auto-approve rule can never drift on a
// reworded reason string.
//   - 'policy'   — matched an operator `confirm` rule (the routine,
//                  auto-approvable case).
//   - 'compound' — bash compound / shell-injection guard forced confirm.
//   - 'escalate' — protected-path `escalate` tier forced confirm.
//   - 'degraded' — engine degraded forced allow→confirm.
//   - 'score'    — risk-score / approval-gate forced allow→confirm.
//   - 'resolver' — resolver conservative / low-confidence forced confirm.
export type ConfirmCause = 'policy' | 'compound' | 'escalate' | 'degraded' | 'score' | 'resolver';

// What the engine returns from a check. The harness converts `confirm`
// into a UI prompt at invocation time; without a confirmFn, the harness
// must default to deny — silently auto-allowing a `confirm` decision is
// the bug class this type prevents.
export type Decision =
  | (DecisionBase & { kind: 'allow'; reason?: string; source?: PolicySource })
  | (DecisionBase & { kind: 'deny'; reason: string; source?: PolicySource })
  | (DecisionBase & {
      kind: 'confirm';
      prompt: string;
      // Why this confirm fired — drives autonomous-posture auto-approval
      // (only 'policy' is auto-approvable; all else stays a modal). See
      // ConfirmCause.
      confirmCause: ConfirmCause;
      reason?: string;
      source?: PolicySource;
    });

// Snapshot view of permissions handed to a tool's ToolContext.
// Read-only — tools must not mutate. Exposes the active policy mode and
// approval posture; tools that need to short-circuit a multi-step plan
// should call back into the engine via the harness with the right
// tool name (the view can't know which tool's per-tool rules to
// consult by category alone).
export interface PermissionsView {
  mode: PolicyMode;
  posture: ApprovalPosture;
  // True iff reading `path` would be a clean `allow` under the current
  // read_file policy (deny / confirm / sensitive-floor → false). Pure:
  // it does NOT record an audit decision or bump the approval seq.
  //
  // Content-emitting tools (`git diff`/`git show`, `grep`) gate on a
  // single search ROOT, but their OUTPUT carries content from many
  // descendant files. A denied file under an allowed root would leak
  // through that output. Such tools call this per emitted file to drop
  // the ones the policy would not let `read_file` open. `path` may be
  // absolute or cwd-relative — same resolution as a `read_file` check.
  canReadPath(path: string): boolean;
}
