// Deterministic risk score per PERMISSION_ENGINE.md §6.3.
//
// Eleven features over the resolved capabilities + command shape +
// engine state, each contributing a fixed weight. Sum capped at 1.0.
// Weights are the spec §6.3.1 baseline-v2.0 — defensible but not
// optimal (spec §6.3.2 documents the calibration plan: collect
// (score, decisão_humana, outcome) triples for 30 days, derive
// weights via logistic regression, ship as v2.1).
//
// The function is PURE and DETERMINISTIC. Same input → same output
// every time, no randomness, no clock, no IO. Determinism is
// load-bearing because the score lands in the audit row which feeds
// the hash chain; two replays of the same decision must produce
// identical chain entries.
//
// Components are surfaced as a plain object so the audit row can
// store them via `JSON.stringify` and the modal preview can render
// the breakdown ("capability_risk: 0.40, shell_chain: 0.20, …").
// Field names match the spec table verbatim so audit consumers can
// rely on stable keys across slices.

import type { Capability } from './capabilities.ts';
import type { Confidence } from './grant-types.ts';
import { containsShellInjection } from './matcher.ts';
import type { EngineState } from './state-machine.ts';

// Slice 143 (minor dedup): `RiskScoreConfidence` is the same domain
// as `ApprovalLogConfidence` in `src/storage/repos/approvals-log.ts`
// — the resolver's certainty about its capability emission. Both are
// now type aliases of `Confidence` from `grant-types.ts`. Keeping the
// historical name here as a re-export preserves every import site
// while making the shared origin discoverable.
export type RiskScoreConfidence = Confidence;

export interface RiskScoreInput {
  // Resolved capabilities from the resolver (slice 3). Empty when
  // the resolver returned an empty Ok (e.g. bash with missing
  // command) — score contribution is zero in that case.
  capabilities: readonly Capability[];
  // For bash: the literal command string. Other tools pass
  // undefined. Used by the `blocklist_command` and `shell_complex`
  // features which inspect the textual shape.
  command?: string;
  toolName: string;
  // Whether this tool is an MCP server tool (slice 6 mounts the
  // canonical channel; until then, the caller decides via
  // `EngineOptions.isMcpTool`).
  isMcp: boolean;
  // Resolver's confidence — `high` contributes 0 to the score,
  // `medium` +0.10, `low` +0.30.
  confidence: RiskScoreConfidence;
  // Engine state from the §2 controller. `degraded` adds +0.20
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
// call will touch high-impact surface. Aligned with spec §6.3.1
// first row.
const DANGEROUS_KINDS = new Set<Capability['kind']>([
  'delete-fs',
  'git-write',
  'env-mutate',
  'agent-mutate',
]);

// Substrings flagged as "letal patterns" in spec §6.3.1. The match
// is plain substring — operators chaining `rm -rf` inside quotes
// still get flagged; the bash AST resolver slice will refine this
// once it can distinguish quoted-literal from literal-execution.
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
// protected-path classifier from slice 1 is the actual escape
// defense; this feature exists to add a score increment when the
// resolver pinned a scope that's plausibly off-workspace.
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
  // Plain string match; trust list is small (under 20 entries
  // typical) so linear scan is fine.
  return !trusted.includes(host);
};

// Threshold at which the `recent_errors` feature fires — spec
// §6.3.1: "three consecutive tool errors immediately preceding
// this call". Hoisted from an inlined `>= 3` so calibration can
// adjust both the WEIGHT (above) and the TRIGGER (here) from one
// audited location, and so tests can import the same canonical
// boundary value.
export const RECENT_ERRORS_THRESHOLD = 3;

// Feature weights — spec §6.3.1 baseline-v2.0. Centralized so the
// calibration slice can swap them via a single object rather than
// hunting through the compute function. Adjusting weights here is
// the way to evolve the score; the score field in audit_log
// version-tags via the engine version line so historical replays
// stay reproducible.
//
// Slice 147 (review minor): `exec_arbitrary` added. Pre-slice the
// `exec:arbitrary` capability (emitted by `cmdNpmLike`, `cmdPip`,
// `cmdMake`, `cmdCargo`, and the conservative-fallback for unknown
// commands) had no dedicated weight; it didn't qualify under
// `capability_risk` either (which is gated on delete-fs / git-write
// / env-mutate / agent-mutate). Result: `npm install`, `pip install`,
// `cargo build` resolved to `exec:arbitrary` + medium confidence
// (+0.10) for a total score of ~0.10 — silently auto-allowed even
// though every one of those commands is a supply-chain attack
// surface. New 0.30 weight pushes the total to 0.40, exactly at
// the §6.6 confirm threshold; combined with medium confidence
// (+0.10) it crosses cleanly into confirm. Operators who want
// package managers to run without prompt can add an explicit
// `allow exec:arbitrary` rule (eyes-open) or use grants.
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

  // Slice 147 (review minor): `exec:arbitrary` capability lacks a
  // dedicated DANGEROUS_KIND entry above (it doesn't write/delete
  // by itself), but it IS the canonical "I'm about to run code
  // you didn't whitelist" signal. cmdNpmLike / cmdPip / cmdMake /
  // cmdCargo emit it for package install + build commands; the
  // bash resolver's Conservative fallback also emits it for
  // unknown commands. Without this weight those calls slipped
  // under the confirm threshold. `exec:shell` (every plain `bash`
  // call) and `exec:python` / `exec:node` (interpreter w/ `-c`)
  // are explicitly excluded — they're routine.
  if (input.capabilities.some((c) => c.kind === 'exec' && c.scope === 'arbitrary')) {
    components.exec_arbitrary = RISK_SCORE_WEIGHTS.exec_arbitrary;
  }

  // Recent errors — caller-supplied counter. Threshold per spec.
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

// Default MCP-tool detector — spec §13.1 has tools surface as
// `mcp__<server>__<tool>` from the MCP loader. The detector is
// caller-overridable; this default is the fallback when no
// override is supplied to the engine.
export const defaultIsMcpTool = (name: string): boolean => name.startsWith('mcp__');
