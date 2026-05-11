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
// Section-level lock (mirroring `defaults.locked`) is intentionally
// deferred to a successor slice — none of the current operator
// workflows need it yet, and adding it without a real use case would
// be premature.
export interface PolicySandbox {
  required?: boolean;
  hostAllowed?: boolean;
}

export interface Policy {
  defaults: PolicyDefaults;
  tools: PolicyToolsSection;
  sandbox?: PolicySandbox;
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
