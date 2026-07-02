// Deterministic risk score.
//
// Features over the resolved capabilities + command shape + engine
// state, each contributing a fixed weight. Sum capped at 1.0.
// Weights are the v2.0 baseline — defensible but not optimal; the
// calibration plan collects (score, human_decision, outcome)
// triples and derives weights via logistic regression for a v2.1
// shipment.
//
// The function is PURE and DETERMINISTIC. Same input → same output
// every time, no randomness, no clock, no IO. Determinism is
// load-bearing because the score lands in the audit row which
// feeds the hash chain; two replays of the same decision must
// produce identical chain entries.
//
// Components are surfaced as a plain object so the audit row can
// store them via `JSON.stringify` and the modal preview can render
// the breakdown ("capability_risk: 0.40, shell_chain: 0.20, …").
// Field names are stable across versions so audit consumers can
// rely on them.

import type { Capability } from './capabilities.ts';
import type { Confidence } from './grant-types.ts';
import { containsShellInjection, matchHost } from './matcher.ts';
import { MCP_TOOL_PREFIX } from './mcp-naming.ts';
import type { EngineState } from './state-machine.ts';

// Same domain as `ApprovalLogConfidence` in
// `src/storage/repos/approvals-log.ts` — the resolver's certainty
// about its capability emission. Both are type aliases of
// `Confidence` from `grant-types.ts`. Re-exported under this name
// for callers that pull from this module.
export type RiskScoreConfidence = Confidence;

export interface RiskScoreInput {
  // Resolved capabilities from the resolver. Empty when the
  // resolver returned an empty Ok (e.g. bash with missing command)
  // — score contribution is zero in that case.
  capabilities: readonly Capability[];
  // For bash: the literal command string. Other tools pass
  // undefined. Used by the `blocklist_command` and `shell_complex`
  // features which inspect the textual shape.
  command?: string;
  toolName: string;
  // Whether this tool is an MCP server tool. Caller decides via
  // `EngineOptions.isMcpTool`.
  isMcp: boolean;
  // Resolver's confidence — `high` contributes 0 to the score,
  // `medium` +0.10, `low` +0.30.
  confidence: RiskScoreConfidence;
  // Engine state from the controller. `degraded` adds +0.20
  // ("system in fallback"). `ready` contributes 0.
  engineState: EngineState;
  // Count of consecutive tool errors immediately preceding this
  // call. Caller-supplied because the engine doesn't track
  // outcomes — the harness or bootstrap maintains the counter
  // and passes it in. Default 0 when unknown.
  recentToolErrors: number;
  // Hosts the policy considers safe for outbound traffic.
  // net-egress capabilities outside this set add the
  // `untrusted_egress` feature.
  trustedHosts: readonly string[];
  // Filesystem anchors used to detect "scope escapes workspace".
  // `workspace_escape` fires when a capability's scope is rooted
  // outside cwd but inside the operator's home, or absolute and
  // outside cwd.
  cwd: string;
  home: string;
}

export interface RiskScoreOutput {
  // Sum of every active component, capped at 1.0.
  score: number;
  // Only ACTIVE components appear in the record. Zero-weighted
  // features (e.g. confidence='high' contributes nothing) are
  // omitted so a future replay reading the JSON can distinguish
  // "feature was checked and didn't fire" from "feature didn't
  // exist yet" — both reduce to "absent key" but the absence is
  // information-preserving when the feature set is documented.
  components: Record<string, number>;
}

// Capability kinds that, by their presence alone, indicate the
// call will touch high-impact surface.
const DANGEROUS_KINDS = new Set<Capability['kind']>([
  'delete-fs',
  'git-write',
  'env-mutate',
  'forja-mutate',
]);

// Substrings flagged as lethal patterns. Match is plain substring —
// operators chaining `rm -rf` inside quotes still get flagged; the
// bash AST resolver refines this where it can distinguish
// quoted-literal from literal-execution.
const BLOCKLIST_SUBSTRINGS: readonly string[] = [
  'rm -rf',
  'chmod -R',
  'chmod 777',
  ' dd ',
  'mkfs.',
  'mkfs ',
  ' fdisk',
  '> /dev/sd',
  '> /dev/nvme',
];

// True when the capability's scope text would lift the call OUT
// of the working directory subtree. Heuristic only — the
// protected-path classifier is the actual escape defense; this
// feature exists to add a score increment when the resolver
// pinned a scope that's plausibly off-workspace.
const isOutsideWorkspace = (scope: string | null, cwd: string, home: string): boolean => {
  if (scope === null) return false;
  if (scope === '*' || scope.startsWith('*')) return false; // covered by wildcard_scope
  // Tilde-rooted paths point at the operator's home — outside cwd
  // unless cwd happens to be home itself.
  if (scope === '~' || scope.startsWith('~/')) return cwd !== home;
  // Absolute paths outside cwd trigger; absolute paths INSIDE cwd
  // are well-defined inside the workspace.
  if (scope.startsWith('/')) {
    return !scope.startsWith(`${cwd}/`) && scope !== cwd;
  }
  return false; // relative paths default to cwd-rooted
};

const isUntrustedEgressHost = (host: string | null, trusted: readonly string[]): boolean => {
  if (host === null) return false;
  // Wildcard egress is counted under `wildcard_scope` instead of
  // `untrusted_egress` — same shape, different penalty.
  if (host === '*') return false;
  // Use the same host matcher `allow_hosts` / `deny_hosts` use
  // (`matcher.ts:matchHost`) so `trusted_hosts: ["*.corp.internal"]`
  // silences subdomains consistently with the rest of the
  // fetch_url policy schema. Pre-fix this was `trusted.includes(host)`
  // — exact string compare — and operator-declared patterns
  // silently failed to take effect, flagging
  // `foo.corp.internal` as untrusted even though the policy
  // explicitly trusted `*.corp.internal`.
  //
  // Trust list is small (typical < 20 entries); the regex cache
  // inside matchHost compiles each pattern once and reuses on
  // subsequent calls, so per-check cost is O(n) regex-test which
  // is well within risk-score's existing budget.
  for (const pattern of trusted) {
    if (matchHost(pattern, host)) return false;
  }
  return true;
};

// Threshold at which the `recent_errors` feature fires: three
// consecutive tool errors immediately preceding this call.
// Hoisted from an inlined `>= 3` so calibration can adjust both
// the weight and the trigger from one audited location, and so
// tests can import the same canonical boundary value.
export const RECENT_ERRORS_THRESHOLD = 3;

// Feature weights — v2.0 baseline. Centralized so calibration can
// swap them via a single object rather than hunting through the
// compute function. Adjusting weights here is the way to evolve
// the score; the score field in audit_log version-tags via the
// engine version line so historical replays stay reproducible.
//
// `exec_arbitrary` weight: the `exec:arbitrary` capability
// (emitted by `cmdNpmLike`, `cmdPip`, `cmdMake`, `cmdCargo`, and
// the conservative-fallback for unknown commands) doesn't
// qualify under `capability_risk` (which gates on
// delete-fs / git-write / env-mutate / forja-mutate), so without
// a dedicated weight `npm install` / `pip install` / `cargo build`
// would resolve to ~0.10 (just medium confidence) and silently
// auto-allow — every one of those commands is a supply-chain
// attack surface. 0.30 pushes the total to the confirm threshold;
// combined with medium confidence (+0.10) it crosses cleanly into
// confirm. Operators who want package managers to run without
// prompt can add an explicit `allow exec:arbitrary` rule
// (eyes-open) or use grants.
export const RISK_SCORE_WEIGHTS = {
  capability_risk: 0.4,
  wildcard_scope: 0.2,
  workspace_escape: 0.15,
  blocklist_command: 0.3,
  untrusted_egress: 0.25,
  exec_arbitrary: 0.3,
  recent_errors: 0.15,
  shell_complex: 0.2,
  mcp_tool: 0.1,
  confidence_medium: 0.1,
  confidence_low: 0.3,
  engine_degraded: 0.2,
} as const;

export const computeRiskScore = (input: RiskScoreInput): RiskScoreOutput => {
  const components: Record<string, number> = {};

  // Capability risk — any dangerous kind in the set.
  if (input.capabilities.some((c) => DANGEROUS_KINDS.has(c.kind))) {
    components.capability_risk = RISK_SCORE_WEIGHTS.capability_risk;
  }

  // Wildcard scope — capability whose scope is exactly `*`. Catches
  // `net-egress:*` from compound-bash conservative results and
  // similar broad emits.
  if (input.capabilities.some((c) => c.scope === '*')) {
    components.wildcard_scope = RISK_SCORE_WEIGHTS.wildcard_scope;
  }

  // Workspace escape — capability scope lives outside cwd.
  if (input.capabilities.some((c) => isOutsideWorkspace(c.scope, input.cwd, input.home))) {
    components.workspace_escape = RISK_SCORE_WEIGHTS.workspace_escape;
  }

  // Blocklist command — only meaningful when a command string was
  // supplied (bash tool path).
  if (input.command !== undefined) {
    if (BLOCKLIST_SUBSTRINGS.some((s) => input.command?.includes(s))) {
      components.blocklist_command = RISK_SCORE_WEIGHTS.blocklist_command;
    }
    // Shell composition — `containsShellInjection` is already the
    // engine's compound-shape detector. Reusing keeps the score
    // aligned with what the compound guard already flags.
    if (containsShellInjection(input.command)) {
      components.shell_complex = RISK_SCORE_WEIGHTS.shell_complex;
    }
  }

  // Untrusted egress — net-egress with a host outside the trust
  // list (wildcard egress is counted elsewhere).
  if (
    input.capabilities.some(
      (c) => c.kind === 'net-egress' && isUntrustedEgressHost(c.scope, input.trustedHosts),
    )
  ) {
    components.untrusted_egress = RISK_SCORE_WEIGHTS.untrusted_egress;
  }

  // `exec:arbitrary` lacks a dedicated DANGEROUS_KIND entry (it
  // doesn't write/delete by itself), but it IS the canonical "I'm
  // about to run code you didn't whitelist" signal. cmdNpmLike /
  // cmdPip / cmdMake / cmdCargo emit it for package install +
  // build commands; the bash resolver's Conservative fallback
  // also emits it for unknown commands. Without this weight those
  // calls slipped under the confirm threshold. `exec:shell`
  // (every plain `bash` call) and `exec:python` / `exec:node`
  // (interpreter w/ `-c`) are explicitly excluded — routine.
  if (input.capabilities.some((c) => c.kind === 'exec' && c.scope === 'arbitrary')) {
    components.exec_arbitrary = RISK_SCORE_WEIGHTS.exec_arbitrary;
  }

  // Recent errors — caller-supplied counter.
  if (input.recentToolErrors >= RECENT_ERRORS_THRESHOLD) {
    components.recent_errors = RISK_SCORE_WEIGHTS.recent_errors;
  }

  // MCP tool — supply-chain surface adder.
  if (input.isMcp) {
    components.mcp_tool = RISK_SCORE_WEIGHTS.mcp_tool;
  }

  // Confidence — medium and low; high contributes nothing.
  if (input.confidence === 'medium') {
    components.confidence_medium = RISK_SCORE_WEIGHTS.confidence_medium;
  } else if (input.confidence === 'low') {
    components.confidence_low = RISK_SCORE_WEIGHTS.confidence_low;
  }

  // Engine state — degraded adds; ready/anything-else contributes 0.
  if (input.engineState === 'degraded') {
    components.engine_degraded = RISK_SCORE_WEIGHTS.engine_degraded;
  }

  // Sum components, cap at 1.0. Cap matters because feature
  // collisions (high-risk bash with `rm -rf /` AND degraded state
  // AND low confidence) can otherwise produce values > 1.0; the
  // audit row + downstream consumers expect a unit interval.
  const raw = Object.values(components).reduce((a, b) => a + b, 0);
  const score = raw > 1 ? 1 : raw;

  return { score, components };
};

// Default trusted-hosts list — the six most-common public package
// registries + github. Operators override via
// `EngineOptions.trustedHosts`. A `null` ingress (no hosts ever
// trusted, all flagged) is the explicit "lockdown" shape.
export const DEFAULT_TRUSTED_HOSTS: readonly string[] = [
  'github.com',
  'api.github.com',
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'crates.io',
];

// Merge policy-supplied trusted hosts with the hardcoded default
// list. Additive set-union: policy entries that duplicate a default
// host produce one entry, not two (the engine iterates this list
// per fetch — keep it tight). When the policy supplies nothing,
// return the default array unchanged so callers can use it as a
// sentinel (e.g., engine.ts compares against DEFAULT_TRUSTED_HOSTS
// by reference equality in some paths).
//
// Lives here in risk-score.ts (alongside DEFAULT_TRUSTED_HOSTS) so
// every consumer that needs the merge — bootstrap-engine (initial
// construction), subagent-child (parent's policy snapshot), engine
// (hot reload via reloadPolicy), policy-watcher (file-change
// reload) — can import without crossing layering boundaries.
export const mergeTrustedHosts = (policyTrustedHosts: readonly string[]): readonly string[] => {
  if (policyTrustedHosts.length === 0) return DEFAULT_TRUSTED_HOSTS;
  return Array.from(new Set([...DEFAULT_TRUSTED_HOSTS, ...policyTrustedHosts]));
};

// Default MCP-tool detector. Tools surface as
// `mcp__<server>__<tool>` from the MCP loader. The detector is
// caller-overridable; this default is the fallback when no
// override is supplied to the engine.
export const defaultIsMcpTool = (name: string): boolean => name.startsWith(MCP_TOOL_PREFIX);
