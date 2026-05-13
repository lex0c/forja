import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { TelemetryEvent } from '../telemetry/index.ts';
import type { AuditEmitInput, AuditSink, ReasonChainEntry } from './audit.ts';
import { createNoopSink } from './audit.ts';
import { canonicalHash } from './canonical.ts';
import {
  type Capability,
  type CapabilityKind,
  effectiveCovers,
  formatCapability,
  sortCapabilities,
} from './capabilities.ts';
import {
  type Classifier,
  buildClassifierInput,
  clampAdjust,
  validateClassifierOutput,
} from './classifier.ts';
import {
  DEFAULT_CONTEXT_SUMMARY_DEPTH,
  DEFAULT_CONTEXT_SUMMARY_MAX_BYTES,
  buildContextSummary,
  createContextSummaryBuffer,
} from './context-summary.ts';
import type { GrantSnapshot } from './grant-types.ts';
import type { SectionProvenance } from './hierarchy.ts';
import {
  containsShellInjection,
  firstMatchingCommand,
  firstMatchingHost,
  firstMatchingPath,
  matchCommand,
  matchHost,
  matchPath,
} from './matcher.ts';
import { type ProtectedOp, type ProtectedTier, classifyProtectedPath } from './protected_paths.ts';
// Importing the resolver index registers every builtin resolver at
// module load. Engine consumers don't need a separate wire-up step.
import { type ResolverResult, resolveCapabilities } from './resolvers/index.ts';
import {
  DEFAULT_TRUSTED_HOSTS,
  type RiskScoreConfidence,
  type RiskScoreInput,
  computeRiskScore,
  defaultIsMcpTool,
} from './risk-score.ts';
import {
  type SelectSandboxProfileResult,
  isSandboxProfile,
  selectSandboxProfile,
} from './sandbox-plan.ts';
import {
  type EngineState,
  type StateController,
  createStateController,
  isRejectingState,
} from './state-machine.ts';
import type {
  BashPolicy,
  Decision,
  FetchPolicy,
  PathPolicy,
  PermissionsView,
  Policy,
  PolicyCategory,
  PolicyLayer,
  PolicyMode,
  PolicySource,
  PolicyToolsSection,
} from './types.ts';

export interface EngineOptions {
  cwd: string;
  // Per-section last-writer tracking from the hierarchy resolver
  // (PolicyLayer in types.ts). When provided, every Decision the
  // engine returns carries `source.layer` populated from the
  // section that fired the rule. Optional to keep test ergonomics
  // (a one-off engine built from a hand-crafted Policy doesn't
  // need to also synthesize provenance) — when absent, every
  // Decision falls back to source.layer='default'.
  provenance?: SectionProvenance;
  // Home directory used by `classifyProtectedPath` to resolve
  // tilde-rooted protected targets (~/.bashrc, ~/.config/agent).
  // Default `process.env.HOME ?? cwd` — production bootstrap
  // passes the operator's HOME explicitly so tests can swap it
  // without polluting process.env.
  home?: string;
  // Audit sink. Engine emits one row per `check` before returning.
  // Default `createNoopSink()` so unit tests don't need a SQLite
  // DB; production bootstrap injects `createSqliteSink({ db,
  // identity })`.
  audit?: AuditSink;
  // §18 telemetry sink (slice 74). When set, the engine emits
  // typed events for in-line signals that don't fit the audit row
  // shape — currently `classifier.unavailable` (slice 74). The
  // audit sink emits `permission.decision` events separately via
  // its own telemetry hook (slice 70). Production wiring passes
  // the SAME sink through both paths so a single observer sees
  // every event type. Structurally-typed `{emit(event)}` to keep
  // the engine module from importing concrete sink classes.
  telemetry?: { emit: (event: TelemetryEvent) => void };
  // Timestamp seam for telemetry events emitted in-line from
  // `check` (currently `classifier.unavailable`). Production:
  // `Date.now()`. Tests pin a fixed number for stable event
  // assertions.
  now?: () => number;
  // Session ID stamped on every audit row. Default 'session-anon'
  // for tests; production bootstrap passes the active session id
  // from the harness loop.
  sessionId?: string;
  // Initial state (PERMISSION_ENGINE.md §2). Default `ready` for
  // backward-compatible test ergonomics — every existing test that
  // builds an engine directly keeps working. Production bootstrap
  // injects a `stateController` instead and walks the machine
  // explicitly through init → loading-policy → validating-chain.
  initialState?: EngineState;
  // External state controller. When supplied, the engine reads
  // state from this controller instead of owning its own — letting
  // `bootstrapPermissionEngine` walk transitions before the engine
  // is even constructed. Mutually exclusive with `initialState`;
  // when both are present, the controller wins.
  stateController?: StateController;
  // Risk-score inputs (PERMISSION_ENGINE.md §6.3). All optional;
  // defaults are documented at each field. The score is computed
  // for every check, recorded in the audit row, and consulted by
  // the §6.6 approval gate via `scoreConfirmThreshold` below; a
  // would-be allow whose score crosses the threshold upgrades to
  // confirm.
  //
  // `trustedHosts`: hosts whose net-egress capabilities do NOT
  // trigger the `untrusted_egress` feature. Default:
  // DEFAULT_TRUSTED_HOSTS (github.com + 5 common public registries).
  trustedHosts?: readonly string[];
  // `isMcpTool`: predicate for the `mcp_tool` feature. Default:
  // tool names starting with `mcp__` (per MCP loader convention).
  isMcpTool?: (toolName: string) => boolean;
  // `recentToolErrors`: number of consecutive errored tool calls
  // preceding this one. Caller-supplied because the engine doesn't
  // track outcomes (harness's job). Default 0 — the
  // `recent_errors` feature contributes 0 until a harness-side
  // counter slice wires this through.
  recentToolErrors?: number;
  // Classifier hint (PERMISSION_ENGINE.md §6.4). Optional sync
  // function; receives capabilities + deterministic score + a
  // version pin, returns a clamped adjust. NEVER sees raw args /
  // tool outputs / file contents — that's the prompt-injection
  // defense. Absent or returning null counts as
  // `classifier_unavailable`. Default: no classifier wired.
  classifier?: Classifier;
  // Version pin for the active classifier. Recorded in every audit
  // row that consults the classifier so model swaps mid-install
  // are forensically visible. Default `'none'`.
  classifierHash?: string;
  // When true, an unavailable classifier (offline / throw / schema
  // invalid) transitions the engine to `degraded`. Default false
  // (lenient) — the deterministic score is kept as-is and the
  // call proceeds. Regulated deployments set this to true; local
  // CLI rides lenient.
  classifierRequired?: boolean;
  // Approval-gate score threshold (PERMISSION_ENGINE.md §6.6).
  // A would-be `allow` whose final score (deterministic + clamped
  // classifier adjust) reaches this value is upgraded to `confirm`.
  // Default DEFAULT_SCORE_CONFIRM_THRESHOLD (0.4) — the v2 baseline
  // calibration point per §6.3.2. Calibration phase (post-pilot)
  // re-derives the value; the knob exists so a redeployment can ship
  // the new constant without rebuilding the engine module.
  scoreConfirmThreshold?: number;
  // Classifier context-summary tuning (PERMISSION_ENGINE.md §6.4).
  // The engine retains the last `contextSummaryDepth` decisions in
  // an in-memory ring buffer and renders them into a sanitized
  // string (capability KINDS only, never scopes/args/outputs) that
  // the classifier receives. Both knobs ship at the v2 baseline
  // (10 entries, 1 KiB cap); calibration sweeps can tune.
  contextSummaryDepth?: number;
  contextSummaryMaxBytes?: number;
  // Sandbox planning inputs (PERMISSION_ENGINE.md §6.5). Optional —
  // when omitted, the sandbox-plan stage is skipped entirely (legacy
  // path; engine.check() never refuses for `no_viable_sandbox` and
  // never populates the audit row's sandbox_profile column).
  //
  //   - `available`: whether the host has bwrap / sandbox-exec
  //     present (see `detectSandboxAvailability`). When false AND
  //     `required` is true, the bootstrap is expected to transition
  //     the engine to `refusing`; in lenient mode the bootstrap
  //     transitions to `degraded` instead.
  //   - `hostExplicitlyAllowed`: operator passed the `--sandbox-host`
  //     flag at the CLI. Without it, the `host` profile is removed
  //     from the candidate set even when the resolved capabilities
  //     would otherwise admit it. Defense against accidental
  //     passthrough.
  //   - `required`: policy demands a viable sandbox plan; when no
  //     profile covers, refuse the call AND (at bootstrap) refuse
  //     the engine if availability is false. Default false.
  sandbox?: {
    available: boolean;
    hostExplicitlyAllowed: boolean;
    required: boolean;
  };
  // §8 grants. Optional grants snapshot provider. Engine calls
  // `listActive(Date.now())` on each `check()` so long-running
  // sessions see grants revoked or expired mid-flight. Implementations:
  //   - Production: `(ts) => listActiveGrants(db, installId, ts)`
  //   - Tests: a closure over a fixed array; mutable for revocation tests.
  // When omitted, the grant-match phase is a no-op — engine behaves
  // as before slice 40. Persisted grants (pattern scope) authorize
  // matching tool calls, short-circuiting AFTER deny rules and
  // BEFORE the in-memory session-allow / base allow / confirm chain.
  grants?: {
    listActive: (snapshotTs: number) => readonly GrantSnapshot[];
  };
  // PERMISSION_ENGINE.md §10.1 — subagent effective capability bound
  // (slice 95, R11 P0-3). When present, the engine treats itself as
  // a CHILD engine constrained to this set. Every resolved capability
  // (from the slice 5 resolver pipeline) must be covered by some
  // entry per `effectiveCovers`; any uncovered capability lands a
  // structural deny with `source.section='subagent-effective'`
  // BEFORE the static rule / bypass / grant pipeline runs.
  //
  // Three states matter:
  //   - `undefined` — root agent / legacy spawn. No bound, every
  //     resolved cap passes the effective stage; the static rule
  //     pipeline carries the call as before.
  //   - `[]` — pure-LLM subagent. ANY non-empty resolved cap is
  //     uncovered → deny. Misc-category tools (no resolver) carry
  //     `resolvedCapabilities = []` and still pass; that's the
  //     spec's intent ("no side-effect capabilities" doesn't mean
  //     "no LLM activity").
  //   - `[...]` — narrowed envelope. Each resolved cap must align
  //     with some entry under the cwd-aware coverage rule. The
  //     declared envelope is in operator-authored relative form
  //     (`read-fs:src/**`); resolved capabilities arrive in the
  //     lexical-absolute form the FS resolvers produce
  //     (`read-fs:/abs/cwd/src/auth/login.ts`). `capabilityCoversCwdAware`
  //     bridges the asymmetry via `matchPath`.
  //
  // The check is structural (fires AFTER resolver, BEFORE bypass /
  // static rules / classifier / sandbox plan). A subagent cannot
  // escape its declared envelope via any rule-pipeline path. Spec
  // §10.3 ("Escape impossível").
  effectiveCapabilities?: readonly Capability[];
}

// Slice 143 (API-2): `GrantSnapshot` moved to
// `src/permissions/grant-types.ts` — single source of truth shared
// with `src/storage/repos/grants.ts`. Re-exported here so external
// importers (CLI, tests, conformance harness) that pulled the type
// from this module pre-slice continue to work without churn.
export type { GrantSnapshot } from './grant-types.ts';

// §6.6 baseline. Sourced here (not inlined at the call site) so
// tests, audit replays, and future calibration sweeps can read the
// exact threshold the engine is enforcing. Calibration plan is in
// §6.3.2; the knob is `EngineOptions.scoreConfirmThreshold`.
export const DEFAULT_SCORE_CONFIRM_THRESHOLD = 0.4;

// §12.3 hot reload result. Discriminated union mirroring the
// `verifyChain` pattern: callers branch on `ok` and consume the
// hash transition on success or the diagnostic reason on failure.
// The engine's responsibility is atomic swap + minimal sanity
// validation; the caller (file watcher, policy resolver) is
// responsible for upstream resolution + lock-conflict checks.
export type ReloadPolicyResult =
  | { ok: true; oldHash: string; newHash: string }
  | { ok: false; reason: string };

export interface PermissionEngine {
  check(toolName: string, category: PolicyCategory, args: ToolArgs): Decision;
  view(): PermissionsView;
  mode(): PolicyMode;
  // §12.3 atomic policy swap. The new policy MUST be a Policy
  // object the caller already resolved + validated (lock conflicts,
  // hierarchy merge, etc); the engine does minimal shape checks
  // and recomputes `policy_hash` for subsequent audit rows. Returns
  // {ok: true, oldHash, newHash} on success; {ok: false, reason}
  // when the policy fails canonical-hash computation or is
  // missing required fields. Single-threaded JS means no in-flight
  // check() can be interrupted — the swap takes effect on the
  // NEXT check() call.
  //
  // Slice 139 C4: the optional `newProvenance` argument lets the
  // caller swap the per-section layer attribution alongside the
  // policy. Pre-slice the engine captured `provenance` at
  // construction time and `reloadPolicy` updated only `policy`
  // and `mode`, leaving the stale provenance in place. Result:
  // every audit row's `source.layer` and `/perms why` output
  // referenced the PRE-reload hierarchy. The watcher (policy-
  // watcher.ts) re-resolves the full hierarchy on each YAML
  // change and now forwards the fresh `SectionProvenance` here.
  // Callers without dynamic provenance (tests / one-shot uses)
  // can omit the argument and the engine keeps the construction-
  // time provenance.
  reloadPolicy(newPolicy: Policy, newProvenance?: SectionProvenance): ReloadPolicyResult;
  // Current state per PERMISSION_ENGINE.md §2. Bootstrap walks the
  // engine through `init → loading-policy → validating-chain → ready`
  // before exposing it to the harness; runtime can transition between
  // `ready` and `degraded` based on subsystem health, or fall to
  // `refusing` on a fatal event (chain break, policy reload failure
  // in strict mode).
  state(): EngineState;
  // Returns the reason associated with the most recent ready→degraded
  // (or any-state→degraded) transition while the engine IS currently
  // degraded. Returns `undefined` when the engine is not degraded,
  // OR when it's degraded but never had an explicit reason (legacy
  // path; shouldn't happen in practice — `degrade(reason)` always
  // supplies one). The §13.6 degraded-banner emitter (slice 92)
  // consumes this so the operator-facing banner can quote the
  // root cause ("⚠ Sandbox no longer available (bwrap binary missing)").
  // Reads from the state controller's history; no extra storage.
  getDegradedReason(): string | undefined;
  // Transition the engine to a degraded state — happens when an
  // auxiliary subsystem (classifier, sandbox, sealing target) goes
  // offline mid-session. `check()` keeps running but every `allow`
  // is upgraded to `confirm`. `reason` lands in the transition event
  // and (future slice) flows into the audit row's reason_chain.
  degrade(reason: string): void;
  // Recover from `degraded` back to `ready`. Inverse of `degrade`.
  // Used when the failing subsystem comes back up.
  restore(reason: string): void;
  // Fatal transition. After `refuse`, every `check` returns deny
  // until the operator builds a new engine (typically via a fresh
  // bootstrap with `--accept-broken-chain` or `--rotate-chain`).
  refuse(reason: string): void;
  // Returns a deep copy of the resolved Policy this engine was
  // built from. Subagent runtime persists the copy on
  // `subagent_runs` so the subprocess child runs under the
  // parent's exact policy even if `.agent/permissions.yaml`
  // etc. are edited mid-run. The deep copy is defensive: a
  // future caller mutating the returned object MUST NOT corrupt
  // the engine's active enforcement state. Cost is negligible
  // (typical policies are sub-10KB) compared to the latent-bug
  // surface a shared reference would expose.
  policy(): Policy;
  // Slice 128 (R4 P0-Bypass-2): expose the engine's narrowed
  // capability envelope (if any). Subagent harness loop reads
  // this BEFORE falling back to `deriveParentCapabilities(policy)`
  // so a grandchild's intersection happens against the CHILD's
  // narrowed set, not the parent's full policy. Returns null when
  // no envelope was applied at construction (root engine).
  effectiveCapabilities(): readonly Capability[] | null;
  // Returns a deep copy of the section-by-section layer attribution
  // captured at policy resolution time. Operator-facing surfaces
  // (`/perms why <section>`, `agent perms`) render this to answer
  // "which layer set required=true?". When the engine was built
  // without an explicit `EngineOptions.provenance`, the returned
  // shape carries only `defaults: 'default'` — every section is
  // attributed to the built-in default.
  provenance(): SectionProvenance;
  // Append a pattern to the session-scoped allowlist for the
  // given section. Used by the REPL's "Yes, don't ask again
  // for: <rule>" modal answer — the bridge calls this BEFORE
  // returning true so subsequent calls matching the pattern
  // skip the modal entirely.
  //
  // The pattern semantics depend on the section:
  //   - bash → matched against `args.command` (glob).
  //   - read_file / write_file / edit_file / glob / grep → matched
  //     against the resolved fs target as an `allow_paths` entry.
  //   - fetch_url → matched against the request URL's host as an
  //     `allow_hosts` entry.
  //
  // Session rules consult BEFORE base allow rules, so an operator's
  // session-allow shortcuts past any per-tool confirm rule that
  // would otherwise fire. Deny rules still win.
  //
  // Decisions emitted via a session rule carry
  // `source.layer = 'session'`, so the modal (if it ever pops
  // again — it shouldn't, because the rule allows) and `/perms
  // why` audit can attribute the rule to the runtime override.
  //
  // In-memory only — the engine's session state vanishes when the
  // process exits. Promoting session rules to a persistent layer
  // is a separate slice (TODO: permission ergonomics Tier 5
  // `/perms commit`).
  addSessionAllow(section: keyof PolicyToolsSection, pattern: string): void;
}

// Loose shape used for argument-shape lookups. The engine reads only the
// fields it knows about per category; unknown fields are ignored. The
// index signature reflects that callers (harness, tests) pass the raw
// tool args which can carry anything (`pattern`, `offset`, etc.).
export interface ToolArgs {
  // bash
  command?: string;
  // fs.* — `path` is the file/dir target for read_file/write_file/edit_file
  // and the optional search root for grep. `cwd` is the optional search
  // root for glob (which has no `path` argument at all).
  path?: string;
  cwd?: string;
  // web.fetch
  url?: string;
  [key: string]: unknown;
}

// Resolves the policy-relevant filesystem target per tool semantics.
// read_file/write_file/edit_file all operate on a single path (named
// `file_path` in slice-3+ tools per Anthropic SDK convention, named
// `path` in the v1 contract). grep and glob are search tools whose
// effective root differs:
//   - grep: `args.path` (optional; defaults to session cwd)
//   - glob: `args.cwd` (optional; defaults to session cwd; the `pattern`
//     argument defines what's matched, not what's allowed)
//
// Tool args come from model-emitted JSON via `as ToolArgs`; the TS
// shape isn't enforced at runtime. A field that should be a string can
// land here as a number, array, or object. We type-guard before
// returning — passing a non-string to path matching would throw
// ERR_INVALID_ARG_TYPE inside path.resolve, which the harness catches
// as `internalError` and reports as a SQLite-class failure. The right
// behavior is a clean policy deny.
//
// Distinction:
//   - field omitted → fall back to session cwd (grep/glob only;
//     read_file/write_file/edit_file still require the field)
//   - field present but wrong type → null → caller emits deny
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

// Resolve the path arg for non-search tools. Accepts either
// `file_path` (slice-3+ convention) or `path` (v1 contract) — same
// dual-name compat as the FS resolvers.
const filePathOf = (args: ToolArgs): string | null => {
  if (isNonEmptyString(args.file_path)) return args.file_path as string;
  if (isNonEmptyString(args.path)) return args.path;
  return null;
};

const resolveFsTarget = (toolName: string, args: ToolArgs, cwd: string): string | null => {
  if (toolName === 'glob') {
    if (args.cwd === undefined) return cwd;
    return isNonEmptyString(args.cwd) ? args.cwd : null;
  }
  if (toolName === 'grep') {
    if (args.path === undefined) return cwd;
    return isNonEmptyString(args.path) ? args.path : null;
  }
  return filePathOf(args);
};

// Resolve the layer that holds a given tools section, falling back
// to 'default' when no layer wrote it (or provenance was absent —
// test-built engines may skip provenance entirely). Return type
// pulled from `PolicyLayer` (not a hand-spelled literal union) so
// adding a future layer (e.g. CLI runtime override) automatically
// flows through here without a silent drift.
const sectionLayer = (
  provenance: SectionProvenance | undefined,
  key: keyof PolicyToolsSection,
): PolicyLayer => {
  if (provenance === undefined) return 'default';
  return provenance[key] ?? 'default';
};

const denyDefault = (toolName: string, mode: PolicyMode, source: PolicySource): Decision => ({
  kind: 'deny',
  reason: `no policy rule matched for ${toolName} (mode=${mode})`,
  source,
});

// §8 grants — per-section relevance filter. A pattern grant
// authorizes a tool call only when its `capability` kind aligns
// with what the tool is doing. A `read-fs:src/**` grant does NOT
// authorize a `write_file` call (write_file emits write-fs, not just
// read-fs), even though the path glob matches.
//
// Slice 40 ships scope_kind='pattern' only; scope_kind='capability'
// is a follow-up. Pattern grants check ONE direction (kind prefix);
// capability grants will use `capabilityCovers` against the resolved
// caps.
const grantRelevantForSection = (
  grant: GrantSnapshot,
  section: keyof PolicyToolsSection,
): boolean => {
  if (grant.scope_kind !== 'pattern') return false;
  const kindPrefix = grant.capability.split(':')[0];
  switch (section) {
    case 'bash':
      // Bash multi-emits (exec/read-fs/write-fs/delete-fs/net-egress/
      // git-write per slice 26 footprint). Slice 40 narrows: only
      // `exec:`-prefixed grants authorize bash commands. Future
      // capability-scope grants can cover the other kinds.
      return kindPrefix === 'exec';
    case 'read_file':
    case 'glob':
    case 'grep':
      return kindPrefix === 'read-fs';
    case 'write_file':
    case 'edit_file':
      // write_file/edit_file need write authorization — a read-only
      // grant doesn't suffice.
      return kindPrefix === 'write-fs';
    case 'fetch_url':
      return kindPrefix === 'net-egress';
    default:
      return false;
  }
};

// §8 grants — first matching grant for the given target. Returns
// the full snapshot (not just the pattern) so the caller can record
// the grant id and expires_at on the Decision / audit row.
const firstMatchingGrant = (
  grants: readonly GrantSnapshot[] | undefined,
  section: keyof PolicyToolsSection,
  target: string,
  cwd: string,
): GrantSnapshot | null => {
  if (grants === undefined || grants.length === 0) return null;
  for (const g of grants) {
    if (!grantRelevantForSection(g, section)) continue;
    let matches: boolean;
    if (section === 'bash') {
      matches = matchCommand(g.scope_value, target);
    } else if (section === 'fetch_url') {
      matches = matchHost(g.scope_value, target);
    } else {
      matches = matchPath(g.scope_value, target, cwd);
    }
    if (matches) return g;
  }
  return null;
};

// Reason-chain entries for grant matches flow through the generic
// `reasonChainFor` path (Decision.source.section='grants' triggers
// the 'grant-match' stage). No dedicated builder needed — the
// rule (grant id) + section ('grants') + layer ('session') fields
// already carry the attribution.

const checkBash = (
  toolName: string,
  args: ToolArgs,
  rules: BashPolicy | undefined,
  mode: PolicyMode,
  provenance: SectionProvenance | undefined,
  sessionAllow: readonly string[] | undefined,
  activeGrants: readonly GrantSnapshot[] | undefined,
): Decision => {
  const command = args.command;
  if (typeof command !== 'string' || command.length === 0) {
    // Engine-internal reject (missing arg). No policy was
    // consulted — source.layer='default' so the modal doesn't
    // mislead the operator into editing the wrong YAML.
    return {
      kind: 'deny',
      reason: `${toolName}: missing 'command' argument`,
      source: { layer: 'default' },
    };
  }

  const layer = sectionLayer(provenance, 'bash');

  // Deny rules win over everything (including compound commands,
  // session-allow, and bypass — though bypass short-circuits
  // before this fn). Run deny FIRST so a hostile compound like
  // `git status; rm -rf /tmp/*` still gets denied if the literal
  // matches a deny pattern. Operator session-allow can never
  // override a deny.
  const denied = firstMatchingCommand(rules?.deny, command);
  if (denied !== null) {
    return {
      kind: 'deny',
      reason: `bash command matched deny rule: ${denied}`,
      source: { layer, rule: denied, section: 'bash' },
    };
  }

  // §8 persisted grant check. Runs AFTER deny (deny always wins,
  // even over an operator-granted exemption) and BEFORE the in-memory
  // session-allow + compound guard. A matching grant carries the
  // operator's prior approval forward across session boundaries.
  // Compound guard is intentionally bypassed — same rationale as
  // session-allow: the operator authorized this pattern explicitly
  // for the grant's TTL window.
  const grantMatch = firstMatchingGrant(activeGrants, 'bash', command, '');
  if (grantMatch !== null) {
    return {
      kind: 'allow',
      reason: `bash command matched grant ${grantMatch.id} (${grantMatch.scope_value})`,
      source: { layer: 'session', rule: grantMatch.id, section: 'grants' },
      ttlExpiresAt: grantMatch.expires_at,
    };
  }

  // Session-allow check: operator's "Yes, don't ask again for:
  // <rule>" promotes a pattern into an in-memory session
  // allowlist. Matches BEFORE the compound guard and the base
  // allowlist so a session-trusted shape skips the modal next
  // time. Deny already ran above. Compound guard is bypassed
  // intentionally — operator explicitly authorized this pattern
  // for the session, the safety net for ACCIDENTAL compounds is
  // the modal that fired the first time.
  const sessionMatched = firstMatchingCommand(sessionAllow, command);
  if (sessionMatched !== null) {
    return {
      kind: 'allow',
      reason: `bash command matched session-allow rule: ${sessionMatched}`,
      source: { layer: 'session', rule: sessionMatched, section: 'bash' },
    };
  }

  // Compound-command guard: glob `*` in an allow pattern admits
  // injection (`git status; <anything>` matches `git status*`).
  // Force confirm on any command containing shell metacharacters
  // (`;`, `&&`, `||`, `|`, `$(...)`, backticks). Operator always
  // sees the literal command for a compound and decides
  // explicitly. Deny rules already ran above; base allow rules
  // are skipped — by design, no base allow pattern can silently
  // admit a compound. Operator who needs a specific compound
  // silenced narrows the policy with a deny exception, runs the
  // commands separately, or session-allows the literal pattern
  // (the path that already cleared the modal once).
  if (containsShellInjection(command)) {
    return {
      kind: 'confirm',
      prompt: `Run bash: ${command}`,
      reason:
        'compound shell command (contains ; && || | $(...) or backticks) — confirming explicitly to surface the literal command',
      source: { layer, section: 'bash' },
    };
  }

  const allowed = firstMatchingCommand(rules?.allow, command);
  if (allowed !== null) {
    return {
      kind: 'allow',
      reason: `bash command matched allow rule: ${allowed}`,
      source: { layer, rule: allowed, section: 'bash' },
    };
  }
  const confirm = firstMatchingCommand(rules?.confirm, command);
  if (confirm !== null) {
    return {
      kind: 'confirm',
      prompt: `Run bash: ${command}`,
      reason: `matched confirm rule: ${confirm}`,
      source: { layer, rule: confirm, section: 'bash' },
    };
  }
  // Default-deny: no rule matched. `layer` still reflects which
  // YAML holds the bash section (so operator knows where to add
  // an allow rule), or 'default' when no layer declared bash at
  // all. Section name set so `/perms why` can point operator at
  // tools.bash.
  return denyDefault(toolName, mode, { layer, section: 'bash' });
};

// Search-tool roots (grep/glob) are policy-allowed when the pattern
// admits a descendant of the root. For example, `allow_paths: ['src/**']`
// and a grep rooted at `src` should pass — the search will only land
// on files under `src`. We probe by appending a synthetic segment to
// the root and matching that. Without this, `src` doesn't match
// `src/**` (the `**` requires at least one path component) and the
// rule is unusable for search tools.
const SYNTHETIC_DESCENDANT = '.forja-check';

const isSearchTool = (toolName: string): boolean => toolName === 'grep' || toolName === 'glob';

const matchTargetForRules = (toolName: string, path: string): string =>
  isSearchTool(toolName) ? `${path}/${SYNTHETIC_DESCENDANT}` : path;

// Resolve a path to its symlink-followed absolute form for protected
// path classification. Mirrors the matcher's `resolveSymlinks` so a
// symlink at `./safe → /etc/passwd` is caught by the protected check
// just like the matcher catches it for rule matching.
//
// Always normalizes lexically via `path.resolve(cwd, rawPath)` first
// — even when `rawPath` is already absolute. This closes the slice-28
// finding where `/work/proj/data/../../etc/hosts` in a fictional cwd
// stayed un-normalized (both realpath fallbacks ENOENT-failed,
// textual abs was returned with the `/work/proj/` prefix intact, and
// the protected classifier missed the underlying `/etc/` target).
// `path.resolve` does the .. and `./` resolution lexically without
// touching the filesystem; realpath then refines for symlinks if the
// resolved target exists.
//
// realpath fails on paths that don't exist (write_file creating a
// new file); fall back to realpathing the parent + joining the
// basename (catches symlink parents) and finally to the lexically
// normalized absolute form.
const resolveForProtected = (rawPath: string, cwd: string): string => {
  const abs = resolve(cwd, rawPath);
  try {
    return realpathSync(abs);
  } catch {
    try {
      return join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
};

const checkPath = (
  toolName: string,
  args: ToolArgs,
  rules: PathPolicy | undefined,
  mode: PolicyMode,
  cwd: string,
  home: string,
  isWrite: boolean,
  provenance: SectionProvenance | undefined,
  sectionKey: keyof PolicyToolsSection,
  sessionAllow: readonly string[] | undefined,
  activeGrants: readonly GrantSnapshot[] | undefined,
): Decision => {
  const path = resolveFsTarget(toolName, args, cwd);
  if (path === null) {
    return {
      kind: 'deny',
      reason: `${toolName}: missing or non-string path argument`,
      source: { layer: 'default' },
    };
  }

  const layer = sectionLayer(provenance, sectionKey);
  const sectionName = sectionKey;

  // Protected-path classification per PERMISSION_ENGINE.md §11.
  // Runs against the SYMLINK-RESOLVED absolute form so a symlink
  // inside cwd pointing at /etc/passwd is still classified as
  // protected. Tier `deny` returns immediately (any op, any rule).
  // Tier `escalate` is carried as a flag — if downstream rule
  // lookup produces `allow`, we upgrade it to `confirm` per
  // §11's "write/delete sempre escala pra confirm no mínimo".
  // Reads of escalate-tier paths pass through unchanged.
  const protectedAbsPath = resolveForProtected(path, cwd);
  const protectedTier: ProtectedTier | null = classifyProtectedPath({
    absPath: protectedAbsPath,
    op: isWrite ? 'write' : 'read',
    home,
    cwd,
  });
  if (protectedTier === 'deny') {
    return {
      kind: 'deny',
      reason: `path is in protected zone (deny tier): ${protectedAbsPath}`,
      source: { layer: 'default', section: 'protected' },
    };
  }

  // For search-tool roots we also need to check the literal path against
  // deny rules — a `deny_paths: ['secrets/**']` should block grep rooted
  // at `secrets`, not just descendants. Run deny against both forms and
  // refuse on either match.
  const matchTarget = matchTargetForRules(toolName, path);
  const deniedLiteral = isSearchTool(toolName)
    ? firstMatchingPath(rules?.deny_paths, path, cwd)
    : null;
  const denied = firstMatchingPath(rules?.deny_paths, matchTarget, cwd) ?? deniedLiteral;
  if (denied !== null) {
    return {
      kind: 'deny',
      reason: `path matched deny rule: ${denied}`,
      source: { layer, rule: denied, section: sectionName },
    };
  }
  // §8 persisted grant check. Same position as for bash: after deny,
  // before session-allow. A grant carrying a path pattern that
  // matches the resolved fs target authorizes the call. Protected-
  // path `escalate` tier still upgrades the decision to confirm —
  // the grant authorizes the WRITE attempt, but §11 demands a
  // confirm-on-protected even with prior approval.
  const grantMatch = firstMatchingGrant(activeGrants, sectionKey, matchTarget, cwd);
  if (grantMatch !== null) {
    if (protectedTier === 'escalate') {
      return {
        kind: 'confirm',
        prompt: `Write to ${path}? (protected path)`,
        reason: `path matched grant ${grantMatch.id} (${grantMatch.scope_value}) but is in protected zone; escalated to confirm per §11`,
        source: { layer: 'session', rule: grantMatch.id, section: 'grants' },
        ttlExpiresAt: grantMatch.expires_at,
      };
    }
    return {
      kind: 'allow',
      reason: `path matched grant ${grantMatch.id} (${grantMatch.scope_value})`,
      source: { layer: 'session', rule: grantMatch.id, section: 'grants' },
      ttlExpiresAt: grantMatch.expires_at,
    };
  }
  // Session-allow check: same semantics as base `allow_paths` but
  // sourced from the operator's runtime "Yes, don't ask again for:
  // <pattern>" answers. Runs before base allow so operator's
  // session decision shortcuts past any base confirm rule that
  // would otherwise fire. Deny already ran above.
  const sessionMatched = firstMatchingPath(sessionAllow, matchTarget, cwd);
  if (sessionMatched !== null) {
    if (protectedTier === 'escalate') {
      return {
        kind: 'confirm',
        prompt: `Write to ${path}? (protected path)`,
        reason: `path matched session-allow '${sessionMatched}' but is in protected zone; escalated to confirm per §11`,
        source: { layer: 'session', rule: sessionMatched, section: sectionName },
      };
    }
    return {
      kind: 'allow',
      reason: `path matched session-allow rule: ${sessionMatched}`,
      source: { layer: 'session', rule: sessionMatched, section: sectionName },
    };
  }
  const allowed = firstMatchingPath(rules?.allow_paths, matchTarget, cwd);
  if (allowed !== null) {
    if (protectedTier === 'escalate') {
      return {
        kind: 'confirm',
        prompt: `Write to ${path}? (protected path)`,
        reason: `path matched allow rule '${allowed}' but is in protected zone; escalated to confirm per §11`,
        source: { layer, rule: allowed, section: sectionName },
      };
    }
    return {
      kind: 'allow',
      reason: `path matched allow rule: ${allowed}`,
      source: { layer, rule: allowed, section: sectionName },
    };
  }
  const confirm = firstMatchingPath(rules?.confirm_paths, matchTarget, cwd);
  if (confirm !== null) {
    // acceptEdits per AGENTIC_CLI §8: "aceita edits sem confirmação".
    // For writes, a confirm_paths match becomes an auto-allow — that IS
    // the convenience the mode promises. Reads still require confirmation.
    // BUT: protected-tier `escalate` paths block the auto-accept —
    // §11's "no mínimo confirm" wins over acceptEdits's convenience.
    if (mode === 'acceptEdits' && isWrite && protectedTier !== 'escalate') {
      return {
        kind: 'allow',
        reason: `acceptEdits: matched confirm rule (auto-accepted): ${confirm}`,
        source: { layer, rule: confirm, section: sectionName },
      };
    }
    return {
      kind: 'confirm',
      prompt: `${isWrite ? 'Write to' : 'Read from'} ${path}?${protectedTier === 'escalate' ? ' (protected path)' : ''}`,
      reason: `matched confirm rule: ${confirm}`,
      source: { layer, rule: confirm, section: sectionName },
    };
  }

  // Unmatched paths default-deny in every mode (strict and acceptEdits).
  // acceptEdits skips the confirm step for confirmable writes; it does not
  // open writes to anywhere — that's what `bypass` is for.
  return denyDefault(toolName, mode, { layer, section: sectionName });
};

const checkFetch = (
  toolName: string,
  args: ToolArgs,
  rules: FetchPolicy | undefined,
  mode: PolicyMode,
  provenance: SectionProvenance | undefined,
  sessionAllow: readonly string[] | undefined,
  activeGrants: readonly GrantSnapshot[] | undefined,
): Decision => {
  const url = args.url;
  if (typeof url !== 'string' || url.length === 0) {
    return {
      kind: 'deny',
      reason: `${toolName}: missing 'url' argument`,
      source: { layer: 'default' },
    };
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return {
      kind: 'deny',
      reason: `${toolName}: invalid URL '${url}'`,
      source: { layer: 'default' },
    };
  }

  const layer = sectionLayer(provenance, 'fetch_url');
  const denied = firstMatchingHost(rules?.deny_hosts, host);
  if (denied !== null) {
    return {
      kind: 'deny',
      reason: `host matched deny rule: ${denied}`,
      source: { layer, rule: denied, section: 'fetch_url' },
    };
  }
  // §8 persisted grant check. Pattern grants targeting hosts use the
  // same matcher as `allow_hosts` (case-insensitive host glob).
  const grantMatch = firstMatchingGrant(activeGrants, 'fetch_url', host, '');
  if (grantMatch !== null) {
    return {
      kind: 'allow',
      reason: `host matched grant ${grantMatch.id} (${grantMatch.scope_value})`,
      source: { layer: 'session', rule: grantMatch.id, section: 'grants' },
      ttlExpiresAt: grantMatch.expires_at,
    };
  }
  // Session-allow check: same precedence as the bash/path branches.
  // Pattern matched against the URL host (not the full URL); the
  // base `allow_hosts` semantics carry over.
  const sessionMatched = firstMatchingHost(sessionAllow, host);
  if (sessionMatched !== null) {
    return {
      kind: 'allow',
      reason: `host matched session-allow rule: ${sessionMatched}`,
      source: { layer: 'session', rule: sessionMatched, section: 'fetch_url' },
    };
  }
  const allowed = firstMatchingHost(rules?.allow_hosts, host);
  if (allowed !== null) {
    return {
      kind: 'allow',
      reason: `host matched allow rule: ${allowed}`,
      source: { layer, rule: allowed, section: 'fetch_url' },
    };
  }
  return denyDefault(toolName, mode, { layer, section: 'fetch_url' });
};

// Resolve the policy section name for a tool. The mapping is mostly
// identity (`read_file` → `tools.read_file`, `bash` → `tools.bash`),
// but the bash family — `bash`, `bash_background`, `bash_output`,
// `bash_kill` — all share `tools.bash` so an operator writes one
// allow/deny list instead of duplicating across four sections.
//
// The policy section is selected per-category, not per-tool: every
// bash-category tool reads `tools.bash`. fs.* and web.fetch keep
// their per-tool lookup because their semantics already differ
// (read_file's allow_paths != write_file's allow_paths).
//
// Returns `undefined` for `misc` (no policy section consulted). Both
// `lookupRules` and source attribution route through this single
// helper — without the unified path, a future fs.* tool whose name
// diverged from its policy section would still match `lookupRules`
// (which casts to string) but produce a bogus `provenance[key]`
// lookup at the source-attribution site, silently mis-attributing
// the rule's layer.
const policySectionFor = (
  toolName: string,
  category: PolicyCategory,
): keyof PolicyToolsSection | undefined => {
  if (category === 'bash') return 'bash';
  if (category === 'misc') return undefined;
  // fs.read / fs.write / web.fetch — section key is the literal
  // tool name. The cast asserts the tool's name is a known section
  // key; tools that aren't surface a clean default-deny via
  // lookupRules' undefined rules path. The narrower-than-`string`
  // return type also kills the silent drift risk a string return
  // hid (caller could pass anything to `provenance[key]` and get
  // 'default' back instead of the right layer).
  return toolName as keyof PolicyToolsSection;
};

// Map an engine Decision to the discrete audit row enum. The audit
// log distinguishes pre-modal 'confirm' from post-modal 'confirm-
// allowed' / 'confirm-denied' — the post-modal update path lands
// in the modal-bridge slice. Today every `confirm` returned from
// `check()` is the pre-modal form.
const decisionToAuditEnum = (kind: Decision['kind']): 'allow' | 'deny' | 'confirm' => kind;

// Build the reason chain entry for a Decision. Each stage produces
// one entry — for now the engine emits a single entry capturing the
// final stage. Future slices append entries from `resolve`,
// `risk-score`, `classifier`, `sandbox-plan`, `approval-gate` per
// spec §6.
//
// Stage selection order:
//   - 'protected-path' — Decision was produced by §11 (deny or
//     escalate). Detected via `source.section === 'protected'`.
//   - 'session-allow' — operator promoted a rule into the in-memory
//     session allowlist (`source.layer === 'session'`).
//   - 'static-rule' — a configured allow/deny/confirm rule matched
//     (rule literal present in `source`).
//   - 'default-deny' — no rule matched and the engine fell through
//     to default-deny (`kind === 'deny'` AND no rule).
//   - 'engine-default' — engine-internal allow path (bypass mode,
//     misc category) with no rule consulted.
// Upgrade an `allow` Decision into a `confirm` for the degraded path
// (spec §2: "toda decisão `allow` automática vira `confirm`").
// Preserves source attribution so the modal still shows the rule that
// would have fired; the reason explicitly cites the degraded state
// so operators see why a normally-silent allow surfaced as a prompt.
// Non-allow decisions pass through unchanged — degraded never
// downgrades a `deny` or `confirm`.
//
// Slice 139 C3: spread `decision` so non-source fields survive
// — `approvalSeq`, `sandboxProfile`, `ttlExpiresAt` (load-bearing
// for grant-match audit rows: pre-fix the rebuild dropped them and
// `ttl_expires_at` in `approvals_log` landed `null` even when a
// grant authorized the call). The `kind`, `prompt`, and `reason`
// fields below intentionally override the spread values — we want
// the post-degrade shape, not the pre-degrade allow shape.
const degradeAllowToConfirm = (decision: Decision): Decision => {
  if (decision.kind !== 'allow') return decision;
  return {
    ...decision,
    kind: 'confirm',
    prompt: 'Engine is in degraded mode — confirm before continuing.',
    reason: `degraded state forced confirm (was: ${decision.reason ?? 'allow'})`,
  };
};

// Optional reason-chain entry appended when the engine intercepts a
// decision via state. Returns undefined for `ready` so the normal
// chain stays one entry long. Audit row gains a second entry tagged
// `engine-state` whenever degraded forced an upgrade or a non-ready
// state forced a deny.
const degradedStageEntry = (state: EngineState): ReasonChainEntry | undefined => {
  if (state === 'ready') return undefined;
  return { stage: 'engine-state', note: `state=${state}` };
};

// Reason-chain entry for the resolver stage. Fires when the resolver
// forced a confirm upgrade — Conservative or `Ok confidence: low`.
// The note captures the precise cause (resolver's `reason` for
// Conservative; the confidence label for low) so the audit row +
// modal preview show "we forced a confirm because the bash command
// was a compound" or "...because the registry has no resolver for
// tool X" without recomputing from the capability set.
const resolverStageEntry = (result: ResolverResult | null): ReasonChainEntry | undefined => {
  if (result === null) return undefined;
  if (result.kind === 'conservative') {
    return { stage: 'resolve', note: `conservative: ${result.reason}` };
  }
  if (result.kind === 'ok' && result.confidence === 'low') {
    return { stage: 'resolve', note: `confidence=${result.confidence}` };
  }
  return undefined;
};

// §6.6 row 4-5: a would-be `allow` upgrades to `confirm` when EITHER
// the final score (deterministic + clamped classifier adjust) crosses
// the threshold OR the resolver confidence dropped below `high`. The
// two conditions are independent — high-confidence/low-score allows
// pass through; everything else escalates. Only `allow` is gated
// (deny/confirm are already terminal for this purpose). Misc tools
// skip the resolver and run at `high` confidence with score 0, so
// they never trigger this gate. Caller passes `null` confidence for
// misc to short-circuit.
const scoreForcesConfirm = (
  decision: Decision,
  score: number,
  confidence: RiskScoreConfidence | null,
  threshold: number,
): boolean => {
  if (decision.kind !== 'allow') return false;
  if (score >= threshold) return true;
  if (confidence !== null && confidence !== 'high') return true;
  return false;
};

// Reason-chain entry tagged `approval-gate` when the score / confidence
// gate forced the confirm. Carries which side fired (`score=X >= T` or
// `confidence=Y`) so the modal preview can render "Risk score: 0.62
// (above 0.40 threshold)" verbatim. Distinct from `resolve` (which
// fires on Conservative/low specifically — those are still attributed
// to the resolver) because §6.6's score-threshold rule is an engine-
// level gate over a successful resolver result, not a resolver
// outcome itself.
const approvalGateStageEntry = (
  score: number,
  confidence: RiskScoreConfidence | null,
  threshold: number,
): ReasonChainEntry | undefined => {
  if (score >= threshold) {
    return {
      stage: 'approval-gate',
      note: `score=${score.toFixed(2)} >= threshold=${threshold.toFixed(2)}`,
    };
  }
  if (confidence !== null && confidence !== 'high') {
    return { stage: 'approval-gate', note: `confidence=${confidence}` };
  }
  return undefined;
};

// Reason-chain entry tagged `sandbox-plan` (PERMISSION_ENGINE.md §6.5).
// Fires every time the sandbox planner runs — for both ok (chosen
// profile recorded) and refuse (uncovered capability kinds named)
// outcomes. Lets `/perms why` render "this call needed delete-fs +
// net-egress but no profile permits both" without re-running the
// planner.
const sandboxPlanStageEntry = (result: SelectSandboxProfileResult): ReasonChainEntry => {
  if (result.kind === 'ok') {
    return { stage: 'sandbox-plan', note: `profile=${result.profile}` };
  }
  return {
    stage: 'sandbox-plan',
    note: `${result.reason} (uncovered: ${result.uncovered.join(', ')})`,
  };
};

const reasonChainFor = (decision: Decision): ReasonChainEntry[] => {
  let stage: string;
  if (decision.source?.section === 'protected') {
    stage = 'protected-path';
  } else if (decision.source?.section === 'subagent-effective') {
    // §10.1 child-envelope deny (slice 95). Distinct stage so audit
    // replays and `/perms why` rendering can tell the operator the
    // call was refused because it stepped OUTSIDE what the subagent
    // declared — not because the parent's policy refused it. The
    // distinction matters for triage: the operator's policy might
    // already authorize the requested cap, but the SUBAGENT's
    // declared envelope didn't.
    stage = 'subagent-effective';
  } else if (decision.source?.section === 'grants') {
    // §8 grant match — checked before the generic session-allow
    // branch (grant decisions carry both `section='grants'` and
    // `layer='session'`). Distinct stage so audit replays and
    // `/perms why` rendering can distinguish a PERSISTED grant
    // from a transient session-allow.
    stage = 'grant-match';
  } else if (decision.source?.layer === 'session') {
    stage = 'session-allow';
  } else if (decision.source?.rule !== undefined) {
    stage = 'static-rule';
  } else if (decision.kind === 'deny') {
    stage = 'default-deny';
  } else {
    stage = 'engine-default';
  }
  const entry: ReasonChainEntry = { stage };
  if (decision.source?.layer !== undefined) entry.layer = decision.source.layer;
  if (decision.source?.rule !== undefined) entry.rule = decision.source.rule;
  if (decision.source?.section !== undefined) entry.section = decision.source.section;
  if (decision.reason !== undefined) entry.note = decision.reason;
  return [entry];
};

export const createPermissionEngine = (
  initialPolicy: Policy,
  options: EngineOptions,
): PermissionEngine => {
  // §12.3 hot reload: policy / mode / policyHash are mutable cells
  // so `reloadPolicy()` can swap them atomically. JS `let` bindings
  // are by-reference in closures, so check() (and every helper it
  // calls through this scope) reads the CURRENT value on each
  // access — no extra plumbing needed. The reloadPolicy method at
  // the bottom of this factory updates all three.
  let policy = initialPolicy;
  // Mode is optional on parsed policies (so the resolver can tell
  // "user file was silent" from "user file said strict explicitly")
  // but the engine needs a concrete value. Default to strict — same
  // policy as the empty-file fallback.
  let mode: PolicyMode = policy.defaults.mode ?? 'strict';
  const cwd = options.cwd;
  const home = options.home ?? process.env.HOME ?? cwd;
  // Slice 139 C4: mutable so reloadPolicy can swap. Pre-slice this
  // was `const`, which made every `/perms why` and `source.layer`
  // audit field stale post-reload — the engine kept the
  // construction-time hierarchy attribution even when the watcher
  // resolved a fresh policy from a different layer.
  let provenance = options.provenance;
  const audit = options.audit ?? createNoopSink();
  const sessionId = options.sessionId ?? 'session-anon';
  // State controller — caller-supplied (production: bootstrap walks
  // init → loading-policy → validating-chain → ready) or built
  // internally with `initialState` (default `ready` for backward
  // test compat). The engine always reads from this controller on
  // every `check` so external transitions (degrade / refuse fired
  // by health-watcher slices) take effect immediately.
  const stateController =
    options.stateController ?? createStateController({ initial: options.initialState ?? 'ready' });
  const trustedHosts = options.trustedHosts ?? DEFAULT_TRUSTED_HOSTS;
  const isMcpTool = options.isMcpTool ?? defaultIsMcpTool;
  const recentToolErrors = options.recentToolErrors ?? 0;
  const classifier = options.classifier;
  const classifierHash = options.classifierHash ?? 'none';
  const classifierRequired = options.classifierRequired ?? false;
  const telemetry = options.telemetry;
  const telemetryNow = options.now ?? Date.now;
  // §6.6 score threshold. Caller can override for calibration sweeps
  // or per-deployment tuning; default is the v2 baseline (0.4).
  const scoreConfirmThreshold = options.scoreConfirmThreshold ?? DEFAULT_SCORE_CONFIRM_THRESHOLD;
  const contextSummaryDepth = options.contextSummaryDepth ?? DEFAULT_CONTEXT_SUMMARY_DEPTH;
  const contextSummaryMaxBytes =
    options.contextSummaryMaxBytes ?? DEFAULT_CONTEXT_SUMMARY_MAX_BYTES;
  const contextSummaryBuffer = createContextSummaryBuffer(contextSummaryDepth);
  const sandboxOptions = options.sandbox;
  // §10.1 child-envelope bound (slice 95). `undefined` ⇒ root /
  // legacy: skip the stage entirely. Empty array ⇒ pure-LLM child:
  // any non-empty resolved cap is uncovered → deny. Non-empty
  // ⇒ narrowed envelope: every resolved cap must be covered by
  // `effectiveCovers`.
  const effectiveCapabilities = options.effectiveCapabilities;
  // policy_hash is stamped on every audit row. Recomputed on hot
  // reload (§12.3 / slice 51) so post-swap rows carry the new
  // hash. Canonical hash so two engines with semantically
  // equivalent policies produce the same hash.
  let policyHash = `sha256:${canonicalHash(policy)}`;

  // Session-scoped allowlist: per-section list of patterns the
  // operator promoted via the modal's "Yes, don't ask again
  // for: <rule>" answer. In-memory only — survives the lifetime
  // of this engine instance, vanishes on process exit. The Map
  // grows append-only during a session; rules are NEVER removed
  // (a future `/perms forget` slash would clear them, but for
  // now operator restarts the session to revoke trust).
  const sessionAllow = new Map<keyof PolicyToolsSection, string[]>();

  const emitAudit = (
    toolName: string,
    args: ToolArgs,
    decision: Decision,
    capabilities: readonly Capability[],
    score: number,
    scoreComponents: Record<string, number>,
    classifierAdjust: number | null,
    extraStages: readonly ReasonChainEntry[] = [],
    sandboxProfileForRow: string | null = null,
  ): { seq: number; this_hash: string } => {
    const chain = reasonChainFor(decision);
    if (score > 0) {
      // Surface the score in the reason chain so the modal preview
      // can render "Risk score: 0.62 (capability_risk 0.40, …)"
      // straight from the chain — no recompute. Zero-score calls
      // get no entry (the chain stays one line for the common safe
      // case) and the audit row's `score` column still records 0.
      chain.push({ stage: 'risk-score', note: `score=${score.toFixed(2)}` });
    }
    for (const stage of extraStages) chain.push(stage);
    const input: AuditEmitInput = {
      session_id: sessionId,
      tool_name: toolName,
      args,
      decision: decisionToAuditEnum(decision.kind),
      policy_hash: policyHash,
      reason_chain: chain,
      // Canonical sort so the audit row's capabilities_json is
      // byte-stable across runs — chain hash determinism depends on
      // it. Resolver implementation order doesn't leak into the
      // ledger.
      capabilities: sortCapabilities(capabilities).map(formatCapability),
      score,
      score_components: scoreComponents,
      // Classifier metadata: hash is recorded for every check (even
      // when classifier didn't run; default 'none' makes the
      // missing-classifier case visible in audit). `classifierAdjust`
      // is null when no classifier consulted or unavailable —
      // forensically distinct from "consulted but returned 0".
      classifier_hash: classifierHash,
      classifier_adjust: classifierAdjust,
      // §6.5 chosen profile. Null when the sandbox planner didn't
      // run (no EngineOptions.sandbox) OR when the call refused
      // before it reached the planner. A `sandbox-plan` reason-
      // chain entry pairs with this column on every row where the
      // planner ran (success or refusal).
      sandbox_profile: sandboxProfileForRow,
      // §8 grant expiry. Populated when the Decision was produced
      // by a persisted grant match (`decision.ttlExpiresAt`); null
      // otherwise. Future replay can correlate `ttl_expires_at` +
      // the `grant-match` reason chain stage to reconstruct the
      // grant trail.
      ttl_expires_at: decision.ttlExpiresAt ?? null,
    };
    const emitted = audit.emit(input);

    // §6.4: record THIS decision in the ring buffer so the NEXT
    // check's classifier sees it. Capability KINDS only — scopes
    // never enter the buffer (defense against leaking adversary-
    // visible paths/hosts to a sometimes-remote classifier). Dedup
    // kinds so a call with five `read-fs:...` capabilities lands
    // as a single `read-fs` kind in the summary.
    const kindSet = new Set<CapabilityKind>();
    for (const cap of capabilities) kindSet.add(cap.kind);
    contextSummaryBuffer.push({
      toolName,
      decision: decisionToAuditEnum(decision.kind),
      capabilityKinds: Array.from(kindSet),
    });
    return emitted;
  };

  // Attach `approvalSeq` to a Decision so the harness can link the
  // audit row with the matching `tool_calls` row (§17 prerequisite).
  // The noop sink returns seq=0 (no row persisted); we omit the field
  // in that case so a downstream `linkApprovalToToolCall(seq=0)` call
  // never fires under tests/headless paths.
  const withApprovalSeq = (decision: Decision, seq: number): Decision => {
    if (seq === 0) return decision;
    return { ...decision, approvalSeq: seq };
  };

  // Attach `sandboxProfile` to a Decision so the harness can thread
  // it into ToolContext for runtime enforcement (§6.5 part 2). Omits
  // the field when the planner didn't run (no `EngineOptions.sandbox`
  // or refused branch); the runner-side wrap is a no-op without the
  // hint.
  const withSandboxProfile = (decision: Decision, profile: string | null): Decision => {
    if (profile === null) return decision;
    // Slice 125 (R2 P1): defense-in-depth validation. The
    // `profile` param's domain is `selectSandboxProfile`'s return
    // type, but a future code path that wires an external string
    // here would silently launder past the type system via the
    // cast. `isSandboxProfile` matches the wire-validation gate
    // slice 103 added at the runner boundary; keeping the engine
    // boundary symmetric ensures both sides refuse the same way.
    if (!isSandboxProfile(profile)) {
      throw new Error(
        `withSandboxProfile: invalid profile '${profile}' — expected ro|cwd-rw|cwd-rw-net|home-rw|host`,
      );
    }
    return { ...decision, sandboxProfile: profile };
  };

  const check = (toolName: string, category: PolicyCategory, args: ToolArgs): Decision => {
    // State machine gate (PERMISSION_ENGINE.md §2 + §6 approval-gate).
    // Runs BEFORE bypass and before any rule lookup: an engine in
    // init / loading-policy / validating-chain hasn't proven it can
    // safely decide anything; refusing is the fatal sink. In each
    // of those states return deny with a state-specific reason so
    // the operator (and audit log) sees exactly why. degraded falls
    // through to the normal pipeline but with an allow → confirm
    // upgrade after the decision is built.
    const currentState = stateController.get();
    if (isRejectingState(currentState)) {
      const decision: Decision = {
        kind: 'deny',
        reason: `engine not ready (state=${currentState})`,
        source: { layer: 'default', section: 'engine-state' },
      };
      const e = emitAudit(toolName, args, decision, [], 0, {}, null);
      return withApprovalSeq(decision, e.seq);
    }

    // Resolve capabilities (PERMISSION_ENGINE.md §5). Runs BEFORE
    // bypass, before rule lookup — `Refuse` is structural rejection
    // (dynamic eval, malformed args, no-safe-resolution commands
    // like `dd`/`mkfs`) and trumps any allow rule. The resolved
    // capabilities flow into the audit row and into the modal's
    // preview; even a `bypass` mode decision carries an honest
    // capability set so the operator can see what the model
    // intended to consume.
    //
    // `misc` category skips resolution entirely — those tools are
    // declared "no side effects worth gating" and shouldn't pay
    // the resolver cost (or risk a stub-resolver mismatch). They
    // emit with an empty capability list, which is honest about
    // their declared shape.
    let resolverResult: ResolverResult | null = null;
    let resolvedCapabilities: Capability[] = [];
    if (category !== 'misc') {
      resolverResult = resolveCapabilities(toolName, args as Record<string, unknown>, {
        cwd,
        home,
      });
      if (resolverResult.kind === 'refuse') {
        const decision: Decision = {
          kind: 'deny',
          reason: `resolver refused: ${resolverResult.reason}`,
          source: { layer: 'default', section: 'resolver-refuse' },
        };
        const e = emitAudit(toolName, args, decision, [], 0, {}, null);
        return withApprovalSeq(decision, e.seq);
      }
      resolvedCapabilities = resolverResult.capabilities;
    }

    // §10.1 child-envelope check (slice 95). Runs AFTER resolver and
    // BEFORE every downstream stage (risk score, classifier, sandbox
    // plan, bypass, static rules, grants, session-allow). A subagent
    // that emits a resolved capability OUTSIDE its declared envelope
    // is structurally rejected — no policy rule can override.
    //
    // Misc-category tools land here with `resolvedCapabilities = []`
    // and trivially pass; pure-LLM children stay free to invoke
    // them. The check fires ONLY when the engine was built with
    // `effectiveCapabilities` (i.e. it's a child engine); root
    // engines skip the stage entirely.
    if (effectiveCapabilities !== undefined && resolvedCapabilities.length > 0) {
      const { uncovered } = effectiveCovers(effectiveCapabilities, resolvedCapabilities, cwd);
      if (uncovered.length > 0) {
        const uncoveredStrings = sortCapabilities(uncovered).map(formatCapability);
        const decision: Decision = {
          kind: 'deny',
          reason: `subagent capability outside declared envelope: ${uncoveredStrings.join(', ')}`,
          source: { layer: 'default', section: 'subagent-effective' },
        };
        const e = emitAudit(toolName, args, decision, resolvedCapabilities, 0, {}, null);
        return withApprovalSeq(decision, e.seq);
      }
    }

    // Compute the deterministic risk score (PERMISSION_ENGINE.md §6.3)
    // once per check, from the resolved state. Used both for the
    // audit row and (in a future slice) for the approval-gate
    // escalation. Conservative resolver outcomes feed `low`
    // confidence into the score; `null` resolver (misc category)
    // feeds `high` since misc tools have no side effects worth
    // scoring.
    const scoreConfidence: RiskScoreConfidence =
      resolverResult === null
        ? 'high'
        : resolverResult.kind === 'conservative'
          ? 'low'
          : resolverResult.confidence;
    const riskInput: RiskScoreInput = {
      capabilities: resolvedCapabilities,
      ...(typeof args.command === 'string' ? { command: args.command } : {}),
      toolName,
      isMcp: isMcpTool(toolName),
      confidence: scoreConfidence,
      engineState: currentState,
      recentToolErrors,
      trustedHosts,
      cwd,
      home,
    };
    const { score: deterministicScore, components: scoreComponents } = computeRiskScore(riskInput);

    // Classifier hint (PERMISSION_ENGINE.md §6.4). Hint-only — the
    // classifier can adjust the score by ±0.2 clamped but cannot
    // independently force a deny. Failures (offline, exception,
    // schema invalid) emit `classifier-unavailable` in the reason
    // chain and either continue (lenient default) or degrade the
    // engine (strict mode). Misc category skips the classifier
    // alongside the resolver — no side effects worth scoring AND
    // no need to consult a hint.
    let score = deterministicScore;
    let classifierAdjust: number | null = null;
    let classifierStage: ReasonChainEntry | null = null;
    if (classifier !== undefined && category !== 'misc') {
      // PERMISSION_ENGINE.md §6.4: classifier sees a sanitized
      // summary of recent activity. Built from the engine's ring
      // buffer (capability KINDS only, never scopes/args/outputs)
      // capped by `contextSummaryMaxBytes`. Empty string when the
      // session has no prior decisions yet — the classifier degrades
      // gracefully on absent context.
      const contextSummary = buildContextSummary(contextSummaryBuffer.snapshot(), {
        maxBytes: contextSummaryMaxBytes,
      });
      const classifierInput = buildClassifierInput({
        toolName,
        capabilities: resolvedCapabilities,
        score: deterministicScore,
        classifierHash,
        ...(contextSummary.length > 0 ? { contextSummary } : {}),
      });
      let rawOutput: ReturnType<Classifier> | null = null;
      let failed = false;
      let failureReason = '';
      try {
        rawOutput = classifier(classifierInput);
      } catch (e) {
        failed = true;
        failureReason = `threw: ${(e as Error).message}`;
      }
      const validated = failed ? null : validateClassifierOutput(rawOutput);
      if (validated === null) {
        // Classifier didn't produce a usable signal — either
        // returned null explicitly, threw, or produced garbage.
        // All three collapse to `classifier-unavailable` in the
        // chain. Strict mode degrades the engine; lenient
        // continues with the deterministic score.
        const reason = failed ? failureReason : 'unavailable';
        classifierStage = { stage: 'classifier-unavailable', note: reason };
        // §18 classifier.unavailable telemetry (slice 74). Fires
        // regardless of strict mode — the metric counts EVERY
        // unavailable response across the install; the `strict`
        // field distinguishes the operational impact. Wrapped in
        // try/catch — observability cannot break engine.check.
        // Categorize the failure mode: threw, unavailable
        // (returned null), or invalid (returned non-conformant
        // schema). The two non-throwing failures collapse here
        // under `validated === null`, so we differentiate by
        // whether rawOutput was non-null (invalid schema) or
        // null (genuinely unavailable).
        if (telemetry !== undefined) {
          try {
            const eventReason: 'unavailable' | 'threw' | 'invalid' = failed
              ? 'threw'
              : rawOutput === null
                ? 'unavailable'
                : 'invalid';
            telemetry.emit({
              kind: 'classifier.unavailable',
              ts: telemetryNow(),
              tool: toolName,
              classifier_hash: classifierHash,
              reason: eventReason,
              strict: classifierRequired,
            });
          } catch {
            // Best-effort.
          }
        }
        if (classifierRequired && currentState === 'ready') {
          stateController.transition('degraded', `classifier_${failed ? 'threw' : 'unavailable'}`);
        }
      } else {
        // Apply clamped adjust. Re-cap to [0, 1] after the sum so a
        // floor of 0.9 + adjust +0.2 doesn't escape the unit
        // interval. Subtraction handled by the cap-at-0 floor on
        // the lower end too.
        classifierAdjust = clampAdjust(validated.score_adjust);
        score = Math.min(1, Math.max(0, deterministicScore + classifierAdjust));
        classifierStage = {
          stage: 'classifier',
          note: `adjust=${classifierAdjust.toFixed(2)} (${validated.reason})`,
        };
      }
    }
    // Sandbox plan stage (PERMISSION_ENGINE.md §6.5). Runs AFTER the
    // classifier hint and BEFORE the bypass / static-rule branches.
    // Optional — wired only when the caller passed `EngineOptions
    // .sandbox`. When absent, the audit row's `sandbox_profile`
    // stays null and the reason chain has no `sandbox-plan` entry
    // (legacy callers / harness paths that don't yet snapshot
    // sandbox availability skip the stage cleanly).
    //
    // Refusal cases:
    //   - no_viable_sandbox → deny outright with
    //     `source.section='sandbox-plan'`. Bypass mode does NOT
    //     override this: a call whose resolved capabilities admit
    //     no sandbox profile is a structural rejection, not a
    //     policy decision.
    //   - sandbox unavailable + required → already handled at the
    //     bootstrap layer (engine never reaches `ready`); per-call
    //     check sees the engine in `refusing` state and short-
    //     circuits via the state-rejecting branch above.
    //   - sandbox unavailable + lenient → handled at the bootstrap
    //     layer too (engine transitions to `degraded`); per-call
    //     check still runs the planner and may still pick a profile
    //     (the planner doesn't itself care about availability —
    //     that's a runner-side concern).
    let sandboxProfile: string | null = null;
    let sandboxStage: ReasonChainEntry | null = null;
    if (sandboxOptions !== undefined) {
      const planResult = selectSandboxProfile({
        capabilities: resolvedCapabilities,
        hostExplicitlyAllowed: sandboxOptions.hostExplicitlyAllowed,
      });
      sandboxStage = sandboxPlanStageEntry(planResult);
      if (planResult.kind === 'refuse') {
        const decision: Decision = {
          kind: 'deny',
          reason: `sandbox plan refused: ${planResult.reason} (uncovered: ${planResult.uncovered.join(', ')})`,
          source: { layer: 'default', section: 'sandbox-plan' },
        };
        const stages: ReasonChainEntry[] = [];
        if (classifierStage !== null) stages.push(classifierStage);
        stages.push(sandboxStage);
        const e = emitAudit(
          toolName,
          args,
          decision,
          resolvedCapabilities,
          score,
          scoreComponents,
          classifierAdjust,
          stages,
          /* sandbox_profile= */ null,
        );
        return withApprovalSeq(decision, e.seq);
      }
      sandboxProfile = planResult.profile;
    }

    // What forces a `confirm` upgrade after the normal pipeline:
    //   - Conservative outcome (the resolver couldn't pin a precise
    //     set; the operator deserves the modal).
    //   - Ok with `confidence: low` (genuinely ambiguous).
    // We intentionally do NOT upgrade on `confidence: medium`.
    // Spec §5.1 says "Confidence < high force human approval", but
    // calibrating that against operator fatigue is the risk-score
    // slice's job — medium covers "well-understood read-only with
    // some uncertainty" (e.g. `find` against a path) and shouldn't
    // pop the modal on every invocation. The slice 3 BACKLOG entry
    // calls this out as an explicit decision to revisit when the
    // scoring formula lands.
    const resolverForcesConfirm =
      resolverResult !== null &&
      (resolverResult.kind === 'conservative' ||
        (resolverResult.kind === 'ok' && resolverResult.confidence === 'low'));

    if (mode === 'bypass') {
      // `bypass` is a defaults-level setting — source.layer points
      // at whichever YAML chose `mode='bypass'` so the operator
      // can find and undo it. No section/rule (mode-driven, not
      // rule-driven).
      //
      // degraded loses the bypass shortcut (spec §2: "toda decisão
      // `allow` automática vira `confirm`"). Resolver-driven
      // confirm is a softer signal — operators who explicitly
      // chose bypass are committing to the broader risk surface,
      // and a Conservative result shouldn't undo that decision.
      // The audit row still carries the resolved capabilities so
      // the row remains a faithful summary of what the tool will
      // touch, even when the decision was `allow`.
      //
      // §11 protected-path classification (slice 97, R1 #4): spec
      // §11 declares the protected paths as HARDCODED, not
      // flexible-via-policy. Bypass is a policy mode, not an
      // override of §11. Walk the resolved capability set and
      // classify each fs-shaped scope: a `deny` tier (system
      // pseudofs like /proc, /sys, /boot, /dev) refuses even
      // under bypass; an `escalate` tier on a write op upgrades
      // the bypass-allow to confirm so the operator sees the
      // literal target before the rewrite commits. Reads of
      // escalate-tier paths pass through unchanged — bypass is
      // still bypass for the routine surface; only the §11
      // hardcoded list trumps it.
      let bypassProtectedTier: ProtectedTier | null = null;
      let bypassProtectedTarget = '';
      for (const cap of resolvedCapabilities) {
        if (cap.kind !== 'read-fs' && cap.kind !== 'write-fs' && cap.kind !== 'delete-fs') {
          continue;
        }
        if (cap.scope === null) continue;
        const op: ProtectedOp = cap.kind === 'read-fs' ? 'read' : 'write';
        const protectedAbsPath = resolveForProtected(cap.scope, cwd);
        const tier = classifyProtectedPath({ absPath: protectedAbsPath, op, home, cwd });
        if (tier === 'deny') {
          // First deny wins — short-circuit and refuse outright.
          const decision: Decision = {
            kind: 'deny',
            reason: `path is in protected zone (deny tier): ${protectedAbsPath} (bypass mode does NOT override §11)`,
            source: { layer: 'default', section: 'protected' },
          };
          const stages: ReasonChainEntry[] = [];
          if (classifierStage !== null) stages.push(classifierStage);
          if (sandboxStage !== null) stages.push(sandboxStage);
          const e = emitAudit(
            toolName,
            args,
            decision,
            resolvedCapabilities,
            score,
            scoreComponents,
            classifierAdjust,
            stages,
            sandboxProfile,
          );
          return withSandboxProfile(withApprovalSeq(decision, e.seq), sandboxProfile);
        }
        if (tier === 'escalate' && op === 'write') {
          // Track the first escalating target for the confirm
          // prompt; continue scanning so a later deny-tier hit
          // still wins.
          if (bypassProtectedTier === null) {
            bypassProtectedTier = 'escalate';
            bypassProtectedTarget = protectedAbsPath;
          }
        }
      }
      const baseAllow: Decision = {
        kind: 'allow',
        reason: 'mode=bypass',
        source: { layer: provenance?.defaults ?? 'default' },
      };
      let bypassDecision: Decision;
      if (bypassProtectedTier === 'escalate') {
        bypassDecision = {
          kind: 'confirm',
          prompt: `${toolName} on protected path: ${bypassProtectedTarget}`,
          reason: `bypass mode still escalates §11 protected paths: ${bypassProtectedTarget}`,
          source: { layer: 'default', section: 'protected' },
        };
      } else {
        bypassDecision = baseAllow;
      }
      const upgraded =
        currentState === 'degraded' && bypassDecision.kind === 'allow'
          ? degradeAllowToConfirm(bypassDecision)
          : bypassDecision;
      const stages: ReasonChainEntry[] = [];
      if (classifierStage !== null) stages.push(classifierStage);
      if (sandboxStage !== null) stages.push(sandboxStage);
      const degradedStage = degradedStageEntry(currentState);
      if (degradedStage !== undefined) stages.push(degradedStage);
      const e = emitAudit(
        toolName,
        args,
        upgraded,
        resolvedCapabilities,
        score,
        scoreComponents,
        classifierAdjust,
        stages,
        sandboxProfile,
      );
      return withSandboxProfile(withApprovalSeq(upgraded, e.seq), sandboxProfile);
    }

    // Single source of truth for section key + rule lookup. Both
    // `lookupRules` (rule matching) and the path/fetch source-
    // attribution branches read `key` here, so a future change to
    // tool→section mapping (e.g. a new fs.* tool routing to a
    // shared section) updates one site instead of two.
    const sectionKey = policySectionFor(toolName, category);
    const sectionRules =
      sectionKey === undefined
        ? undefined
        : (policy.tools as unknown as Record<string, unknown>)[sectionKey];

    // §8 grants snapshot. Sampled once per `check()` call against
    // the current wall-clock so a long-running session sees a grant
    // revoked or expired mid-flight on its NEXT tool call (not this
    // one — atomicity is per-check, not per-tool-execution). When
    // `options.grants` is undefined, the snapshot is undefined and
    // the grant-match phase in each checkX is a no-op.
    const activeGrants = options.grants?.listActive(Date.now());

    let decision: Decision;
    switch (category) {
      case 'bash':
        // `sectionKey` is always 'bash' here (policySectionFor
        // collapses the bash family); checkBash hardcodes the
        // section name internally.
        decision = checkBash(
          toolName,
          args,
          sectionRules as BashPolicy | undefined,
          mode,
          provenance,
          sessionAllow.get('bash'),
          activeGrants,
        );
        break;
      case 'fs.read':
        // `sectionKey` is non-undefined for non-misc categories.
        // The non-null assertion is safe (typed branch) and
        // documented at policySectionFor.
        decision = checkPath(
          toolName,
          args,
          sectionRules as PathPolicy | undefined,
          mode,
          cwd,
          home,
          false,
          provenance,
          sectionKey as keyof PolicyToolsSection,
          sessionAllow.get(sectionKey as keyof PolicyToolsSection),
          activeGrants,
        );
        break;
      case 'fs.write':
        decision = checkPath(
          toolName,
          args,
          sectionRules as PathPolicy | undefined,
          mode,
          cwd,
          home,
          true,
          provenance,
          sectionKey as keyof PolicyToolsSection,
          sessionAllow.get(sectionKey as keyof PolicyToolsSection),
          activeGrants,
        );
        break;
      case 'web.fetch':
        decision = checkFetch(
          toolName,
          args,
          sectionRules as FetchPolicy | undefined,
          mode,
          provenance,
          sessionAllow.get('fetch_url'),
          activeGrants,
        );
        break;
      case 'misc':
        // No category-level policy yet; misc tools must be explicitly
        // safe (no side effects worth gating). Default allow.
        // source.layer='default' — engine-internal decision, no
        // policy section consulted.
        decision = {
          kind: 'allow',
          reason: 'misc category: no gate applied',
          source: { layer: 'default' },
        };
        break;
    }
    // Degraded upgrade applied AFTER the normal pipeline so the
    // rule that would have fired keeps its attribution in `source`
    // — the operator sees "rule X matched, but engine is degraded
    // so I'm asking anyway" in the modal. Same shape for
    // resolver-driven upgrade (Conservative or low confidence) and
    // for the §6.6 approval-gate score/confidence rule.
    //
    // Session-allow is intentionally exempt from the resolver AND
    // score upgrades: the operator already saw the modal once for
    // this shape and explicitly authorized it ("Yes, don't ask
    // again for: <rule>"). Re-prompting on every invocation would
    // regress the same approval-fatigue the session-allow mechanism
    // exists to prevent. degraded state, however, DOES override
    // session-allow: a subsystem-health signal overrides operator
    // trust because the trust was given under the expectation of a
    // healthy engine.
    //
    // Misc category skipped the resolver, so its capability set is
    // empty and the score is 0 — neither rule can fire. Pass `null`
    // confidence to the gate so the medium/low check no-ops.
    const sessionAllowed = decision.source?.layer === 'session';
    const gateConfidence: RiskScoreConfidence | null =
      resolverResult === null
        ? null
        : resolverResult.kind === 'conservative'
          ? 'low'
          : resolverResult.confidence;
    const scoreEscalates = scoreForcesConfirm(
      decision,
      score,
      gateConfidence,
      scoreConfirmThreshold,
    );
    if (
      currentState === 'degraded' ||
      ((resolverForcesConfirm || scoreEscalates) && !sessionAllowed)
    ) {
      decision = degradeAllowToConfirm(decision);
    }
    const stages: ReasonChainEntry[] = [];
    if (classifierStage !== null) stages.push(classifierStage);
    if (sandboxStage !== null) stages.push(sandboxStage);
    // Tail attribution: prefer the most specific cause. degraded
    // beats everything (it's a system-health signal); resolver-
    // forced beats score-gating (resolver outcome is more precise
    // than an aggregate score); score-gating is the residual path.
    // Both resolver-forced and score-gating respect session-allow.
    let tailStage: ReasonChainEntry | undefined;
    if (currentState === 'degraded') {
      tailStage = degradedStageEntry(currentState);
    } else if (resolverForcesConfirm && !sessionAllowed) {
      tailStage = resolverStageEntry(resolverResult);
    } else if (scoreEscalates && !sessionAllowed) {
      tailStage = approvalGateStageEntry(score, gateConfidence, scoreConfirmThreshold);
    }
    if (tailStage !== undefined) stages.push(tailStage);
    const e = emitAudit(
      toolName,
      args,
      decision,
      resolvedCapabilities,
      score,
      scoreComponents,
      classifierAdjust,
      stages,
      sandboxProfile,
    );
    return withSandboxProfile(withApprovalSeq(decision, e.seq), sandboxProfile);
  };

  const view = (): PermissionsView => ({ mode });

  const addSessionAllow = (section: keyof PolicyToolsSection, pattern: string): void => {
    // Empty/whitespace-only pattern is a programming bug (the
    // bridge should never call us with one). Silently drop
    // instead of corrupting the allowlist with a glob that
    // matches every input — a `''` pattern compiled to `^$`
    // matches the empty string only, harmless, but a future
    // refactor that strips/normalizes could turn it into `*`.
    // Defense-in-depth.
    const trimmed = pattern.trim();
    if (trimmed.length === 0) return;
    const existing = sessionAllow.get(section);
    if (existing === undefined) {
      sessionAllow.set(section, [trimmed]);
      return;
    }
    // Skip duplicates so repeated session-allow on the same
    // pattern doesn't grow the list unboundedly across a long
    // session. Order is preserved (`firstMatchingCommand` walks
    // left-to-right; the original promotion wins for diagnostic
    // attribution).
    if (existing.includes(trimmed)) return;
    existing.push(trimmed);
  };

  return {
    check,
    view,
    mode: () => mode,
    state: () => stateController.get(),
    // §13.6 reason plumbing (slice 93). Walks history backwards
    // for the most recent transition INTO degraded — that's the
    // root cause until a `restore()` flips state back to ready
    // (which itself produces a transition pair, so the next
    // degrade after restore overwrites this lookup).
    getDegradedReason: (): string | undefined => {
      if (stateController.get() !== 'degraded') return undefined;
      const history = stateController.history();
      for (let i = history.length - 1; i >= 0; i--) {
        const entry = history[i];
        if (entry !== undefined && entry.to === 'degraded') {
          return entry.reason;
        }
      }
      return undefined;
    },
    degrade: (reason) => {
      stateController.transition('degraded', reason);
    },
    restore: (reason) => {
      stateController.transition('ready', reason);
    },
    refuse: (reason) => {
      stateController.transition('refusing', reason);
    },
    // Deep clone via structuredClone — the resolved Policy is
    // pure data (parsed YAML), no functions or DOM references,
    // so structuredClone is both correct and ~µs for realistic
    // sizes. Returning the captured `policy` reference directly
    // would let any caller silently mutate the engine's
    // enforcement state. JSON.parse(JSON.stringify(...)) would
    // also work but loses Date/Map shapes if a future Policy
    // grows them; structuredClone preserves them.
    policy: () => structuredClone(policy),
    effectiveCapabilities: () => {
      if (effectiveCapabilities === undefined) return null;
      // Slice 129 (R5 P1 immutability): callers consume this to
      // build child-engine constraint envelopes and to render
      // /perms introspection — both should treat the value as
      // read-only. Pre-slice the per-call `.map((c) => ({ ...c }))`
      // produced a fresh mutable array of fresh mutable objects.
      // A caller could mutate an element and pass the array back
      // into another engine constructor, silently widening the
      // child's constraint set. freeze the elements AND the array
      // so any such mutation throws in strict mode.
      const cloned = effectiveCapabilities.map((c) => Object.freeze({ ...c }));
      return Object.freeze(cloned);
    },
    // Same defensive-clone strategy as `policy()`. The returned
    // provenance is consumed by /perms-style introspection; callers
    // mutating it shouldn't corrupt the engine's enforcement
    // attribution. When no provenance was supplied at construction
    // (test-built engines, headless dry-runs), default to the
    // sentinel "everything is the built-in default" shape.
    provenance: () =>
      structuredClone(options.provenance ?? ({ defaults: 'default' } as SectionProvenance)),
    addSessionAllow,
    // §12.3 hot reload — atomic swap of policy + recompute hash +
    // mode. Caller responsibility: resolve hierarchy, validate
    // shape, check lock conflicts BEFORE invoking. Engine does
    // minimal defensive checks (`canonicalHash` succeeds, `defaults`
    // field present) and either commits the swap or returns a
    // diagnostic. Single-threaded JS means in-flight check() calls
    // run to completion before this fires.
    reloadPolicy: (newPolicy: Policy, newProvenance?: SectionProvenance): ReloadPolicyResult => {
      if (newPolicy === null || typeof newPolicy !== 'object') {
        return { ok: false, reason: 'reloadPolicy: newPolicy must be a non-null object' };
      }
      if (newPolicy.defaults === undefined || newPolicy.defaults === null) {
        return { ok: false, reason: 'reloadPolicy: newPolicy missing required `defaults` field' };
      }
      let newHash: string;
      try {
        newHash = `sha256:${canonicalHash(newPolicy)}`;
      } catch (e) {
        return {
          ok: false,
          reason: `reloadPolicy: canonicalHash failed: ${(e as Error).message}`,
        };
      }
      const oldHash = policyHash;
      policy = newPolicy;
      policyHash = newHash;
      mode = newPolicy.defaults.mode ?? 'strict';
      // Slice 139 C4: swap provenance alongside policy when the
      // caller forwards a fresh one. Omitting `newProvenance` (or
      // passing undefined) preserves the construction-time
      // provenance — backward-compatible for callers that don't
      // know about layered policy attribution.
      if (newProvenance !== undefined) provenance = newProvenance;
      return { ok: true, oldHash, newHash };
    },
  };
};
