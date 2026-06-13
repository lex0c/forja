import { readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { redactSecrets } from '../sanitize/secrets.ts';
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
import {
  type ProtectedOp,
  type ProtectedTier,
  classifyProtectedPath,
  isDevSafe,
  startsWithSegment,
} from './protected_paths.ts';
// Importing the resolver index registers every builtin resolver at
// module load. Engine consumers don't need a separate wire-up step.
import { topLevelCommandTexts } from './resolvers/bash.ts';
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
import { matchSensitivePath } from './sensitive-paths.ts';
import {
  type EngineState,
  type StateController,
  createStateController,
  isRejectingState,
} from './state-machine.ts';
import type {
  ApprovalPosture,
  BashPolicy,
  ConfirmCause,
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
  PostureChange,
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
  // Telemetry sink. When set, the engine emits typed events for
  // in-line signals that don't fit the audit row shape — currently
  // `classifier.unavailable`. The audit sink emits
  // `permission.decision` events separately via its own telemetry
  // hook. Production wiring passes the SAME sink through both paths
  // so a single observer sees every event type. Structurally-typed
  // `{emit(event)}` to keep the engine module from importing
  // concrete sink classes.
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
  // Initial approval posture (Supervised / Autonomous). Default
  // 'supervised' — the safe, ask-first stance. Production bootstrap
  // passes the operator's choice (CLI flag); headless/non-TTY callers
  // and tests fall through to supervised (fail-closed). Mutable at
  // runtime via `setApprovalPosture` — this only seeds the initial
  // value.
  approvalPosture?: ApprovalPosture;
  // Initial state. Default `ready` for backward-compatible test
  // ergonomics — every existing test that builds an engine
  // directly keeps working. Production bootstrap injects a
  // `stateController` instead and walks the machine explicitly
  // through init → loading-policy → validating-chain.
  initialState?: EngineState;
  // External state controller. When supplied, the engine reads
  // state from this controller instead of owning its own — letting
  // `bootstrapPermissionEngine` walk transitions before the engine
  // is even constructed. Mutually exclusive with `initialState`;
  // when both are present, the controller wins.
  stateController?: StateController;
  // Risk-score inputs. All optional; defaults are documented at
  // each field. The score is computed for every check, recorded in
  // the audit row, and consulted by the approval gate via
  // `scoreConfirmThreshold` below; a would-be allow whose score
  // crosses the threshold upgrades to confirm.
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
  // track outcomes (harness's job). Default 0.
  //
  // Accepts EITHER a number (frozen snapshot — suitable for tests /
  // one-shot calls / engines that never persist across check()
  // invocations) OR a `() => number` getter (read fresh on every
  // check). Long-running harness sessions must pass the getter
  // form: a frozen number captured at construction would never
  // observe consecutive errors accumulating mid-session, and the
  // `recent_errors` risk component would silently contribute 0
  // forever, missing score-based confirm escalation when the model
  // starts looping on failures.
  recentToolErrors?: number | (() => number);
  // Classifier hint. Optional sync function; receives capabilities
  // + deterministic score + a version pin, returns a clamped
  // adjust. NEVER sees raw args / tool outputs / file contents —
  // that's the prompt-injection defense. Absent or returning null
  // counts as `classifier_unavailable`. Default: no classifier wired.
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
  // Approval-gate score threshold. A would-be `allow` whose final
  // score (deterministic + clamped classifier adjust) reaches this
  // value is upgraded to `confirm`. Default
  // DEFAULT_SCORE_CONFIRM_THRESHOLD (0.4) — the v2 baseline
  // calibration point. Calibration phase (post-pilot) re-derives
  // the value; the knob exists so a redeployment can ship the new
  // constant without rebuilding the engine module.
  scoreConfirmThreshold?: number;
  // Classifier context-summary tuning. The engine retains the last
  // `contextSummaryDepth` decisions in an in-memory ring buffer and
  // renders them into a sanitized string (capability KINDS only,
  // never scopes/args/outputs) that the classifier receives. Both
  // knobs ship at the v2 baseline (10 entries, 1 KiB cap);
  // calibration sweeps can tune.
  contextSummaryDepth?: number;
  contextSummaryMaxBytes?: number;
  // Sandbox planning inputs. Optional — when omitted, the
  // sandbox-plan stage is skipped entirely; engine.check() never
  // refuses for `no_viable_sandbox` and never populates the audit
  // row's sandbox_profile column.
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
  // Optional grants snapshot provider. Engine calls
  // `listActive(Date.now())` on each `check()` so long-running
  // sessions see grants revoked or expired mid-flight. Implementations:
  //   - Production: `(ts) => listActiveGrants(db, installId, ts)`
  //   - Tests: a closure over a fixed array; mutable for revocation tests.
  // When omitted, the grant-match phase is a no-op. Persisted grants
  // (pattern scope) authorize matching tool calls, short-circuiting
  // AFTER deny rules and BEFORE the in-memory session-allow / base
  // allow / confirm chain.
  grants?: {
    listActive: (snapshotTs: number) => readonly GrantSnapshot[];
  };
  // Subagent effective capability bound. When present, the engine
  // treats itself as a CHILD engine constrained to this set. Every
  // resolved capability (from the resolver pipeline) must be
  // covered by some entry per `effectiveCovers`; any uncovered
  // capability lands a structural deny with
  // `source.section='subagent-effective'` BEFORE the static rule /
  // bypass / grant pipeline runs.
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
  // escape its declared envelope via any rule-pipeline path.
  effectiveCapabilities?: readonly Capability[];
  // Side-effect oracle for the envelope gate. Spec §10.1 mandates
  // pure-LLM subagent has no side-effect tools and §10.3 says escape
  // is impossible — but several tools (`bash_kill`, `bash_output`,
  // `bash_background` without a `command` arg) carry `metadata.writes`
  // or `metadata.exec` while their resolver returns
  // `capabilities: []` (the resolver lacks the args to attribute
  // anything). Without this callback the envelope gate skips them
  // (`resolvedCapabilities.length === 0` path), letting a narrowed
  // subagent invoke side-effect tools outside the envelope.
  //
  // Bootstrap wires the callback from the tool registry's
  // `metadata.writes || metadata.exec`. When omitted, the engine
  // keeps the pre-slice behavior (preserves test ergonomics that
  // build engines without a registry).
  isToolSideEffect?: (toolName: string) => boolean;
}

// `GrantSnapshot` lives in `src/permissions/grant-types.ts` — single
// source of truth shared with `src/storage/repos/grants.ts`. Re-
// exported here so external importers (CLI, tests, conformance
// harness) can continue pulling the type from this module.
export type { GrantSnapshot } from './grant-types.ts';

// Approval-gate score threshold baseline. Sourced here (not inlined
// at the call site) so tests, audit replays, and future calibration
// sweeps can read the exact threshold the engine is enforcing. The
// knob is `EngineOptions.scoreConfirmThreshold`.
export const DEFAULT_SCORE_CONFIRM_THRESHOLD = 0.4;

// Hot reload result. Discriminated union mirroring the `verifyChain`
// pattern: callers branch on `ok` and consume the hash transition on
// success or the diagnostic reason on failure. The engine's
// responsibility is atomic swap + minimal sanity validation; the
// caller (file watcher, policy resolver) is responsible for upstream
// resolution + lock-conflict checks.
export type ReloadPolicyResult =
  | { ok: true; oldHash: string; newHash: string }
  | { ok: false; reason: string };

export interface PermissionEngine {
  check(toolName: string, category: PolicyCategory, args: ToolArgs): Decision;
  view(): PermissionsView;
  mode(): PolicyMode;
  // Current approval posture. Supervised (default) opens the modal for
  // every confirmable decision; autonomous auto-approves routine
  // `policy` confirms (see ApprovalPosture / ConfirmCause). Read by the
  // TUI footer and by the harness when seeding live state.
  approvalPosture(): ApprovalPosture;
  // Flip the posture at runtime (operator toggle / CLI). No-op when
  // `next` equals the current posture. `reason` is recorded on the
  // transition (postureLog) for introspection + audit. Takes effect on
  // the NEXT check() — single-threaded JS means no in-flight check is
  // interrupted, same contract as reloadPolicy.
  setApprovalPosture(next: ApprovalPosture, reason: string): void;
  // Append-only log of posture transitions this session (oldest
  // first). Backs `/perms`-style introspection and the durable audit
  // (Slice 3). Returns a shallow copy.
  postureLog(): readonly PostureChange[];
  // Atomic policy swap. The new policy MUST be a Policy object the
  // caller already resolved + validated (lock conflicts, hierarchy
  // merge, etc); the engine does minimal shape checks and
  // recomputes `policy_hash` for subsequent audit rows. Returns
  // {ok: true, oldHash, newHash} on success; {ok: false, reason}
  // when the policy fails canonical-hash computation or is missing
  // required fields. Single-threaded JS means no in-flight check()
  // can be interrupted — the swap takes effect on the NEXT check()
  // call.
  //
  // The optional `newProvenance` argument lets the caller swap the
  // per-section layer attribution alongside the policy. The watcher
  // (policy-watcher.ts) re-resolves the full hierarchy on each YAML
  // change and forwards the fresh `SectionProvenance` here. Callers
  // without dynamic provenance (tests / one-shot uses) can omit the
  // argument and the engine keeps the construction-time provenance.
  //
  // The optional `newTrustedHosts` argument lets the caller swap the
  // risk-score `trustedHosts` list alongside the policy. Without
  // this, an operator who edits `fetch_url.trusted_hosts` to add an
  // internal CDN would see the policy hash change but the risk-
  // scorer would keep using the construction-time list — same host
  // continues to trigger `untrusted_egress` until process restart.
  // The watcher computes `mergeTrustedHosts(newPolicy.tools.fetch_url
  // ?.trusted_hosts ?? [])` and forwards. Omitting the argument
  // preserves the construction-time value (test seam — callers that
  // never reload don't need to know about this plumbing).
  reloadPolicy(
    newPolicy: Policy,
    newProvenance?: SectionProvenance,
    newTrustedHosts?: readonly string[],
  ): ReloadPolicyResult;
  // Current state. Bootstrap walks the engine through
  // `init → loading-policy → validating-chain → ready` before
  // exposing it to the harness; runtime can transition between
  // `ready` and `degraded` based on subsystem health, or fall to
  // `refusing` on a fatal event (chain break, policy reload failure
  // in strict mode).
  state(): EngineState;
  // Returns the reason associated with the most recent ready→degraded
  // (or any-state→degraded) transition while the engine IS currently
  // degraded. Returns `undefined` when the engine is not degraded,
  // OR when it's degraded but never had an explicit reason
  // (shouldn't happen in practice — `degrade(reason)` always
  // supplies one). The degraded-banner emitter consumes this so the
  // operator-facing banner can quote the root cause ("Sandbox no
  // longer available (bwrap binary missing)"). Reads from the state
  // controller's history; no extra storage.
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
  // Expose the engine's narrowed capability envelope (if any). The
  // subagent harness loop reads this BEFORE falling back to
  // `deriveParentCapabilities(policy)` so a grandchild's
  // intersection happens against the CHILD's narrowed set, not the
  // parent's full policy. Returns null when no envelope was applied
  // at construction (root engine).
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
  // given section. The permission modal no longer carries a
  // "session-allow" option (removed alongside option 2); this API
  // exists for non-modal promotion paths (future `/perms` slash
  // commands, programmatic test setup, audit replay). Subsequent
  // engine.check() calls matching the pattern short-circuit to
  // allow.
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
  // (`/perms commit`) is future work.
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
// `file_path` per Anthropic SDK convention, or `path` in the v1
// contract). grep and glob are search tools whose effective root
// differs:
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
// `file_path` or `path` — same dual-name compat as the FS resolvers.
const filePathOf = (args: ToolArgs): string | null => {
  if (isNonEmptyString(args.file_path)) return args.file_path as string;
  if (isNonEmptyString(args.path)) return args.path;
  return null;
};

// Per-tool fs traits — the single declarative source for "what kind
// of filesystem tool is this", so the engine consults a trait instead
// of hard-coding tool names across resolveFsTarget / isSearchTool /
// the allow-side literal fallback / policySectionFor.
interface FsToolTraits {
  // The (optional) arg holding the search ROOT; absent → session cwd.
  // Having this marks the tool a "search tool": it walks a tree, so
  // matching uses the synthetic-descendant probe and a pathless call
  // targets cwd. (grep/git read `path`; glob reads `cwd`.)
  rootArg?: 'path' | 'cwd';
  // ALSO test the literal path on the ALLOW side. For single-file
  // invocations (git blame/diff -- f) an exact-file rule must match;
  // search tools without this require a `dir/**` form for allows (the
  // grep/glob "bare-root does not fire" pin).
  exactFileAllow?: boolean;
  // Share another tool's policy section (git's reads are governed by
  // `tools.read_file`).
  section?: keyof PolicyToolsSection;
}

const FS_TOOL_TRAITS: Readonly<Record<string, FsToolTraits>> = {
  glob: { rootArg: 'cwd' },
  grep: { rootArg: 'path' },
  git: { rootArg: 'path', exactFileAllow: true, section: 'read_file' },
};

const resolveFsTarget = (toolName: string, args: ToolArgs, cwd: string): string | null => {
  const rootArg = FS_TOOL_TRAITS[toolName]?.rootArg;
  if (rootArg !== undefined) {
    // Search tool: a pathless/cwd-less call targets the session cwd;
    // a present-but-non-string value is structural failure (null).
    const value = args[rootArg];
    if (value === undefined) return cwd;
    return isNonEmptyString(value) ? value : null;
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

// Grants — per-section relevance filter. A pattern grant authorizes
// a tool call only when its `capability` kind aligns with what the
// tool is doing. A `read-fs:src/**` grant does NOT authorize a
// `write_file` call (write_file emits write-fs, not just read-fs),
// even though the path glob matches.
//
// Today only scope_kind='pattern' is wired; scope_kind='capability'
// is future work. Pattern grants check ONE direction (kind prefix);
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
      // git-write footprint). Only `exec:`-prefixed grants authorize
      // bash commands here. Future capability-scope grants can cover
      // the other kinds.
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

// First matching grant for the given target. Returns the full
// snapshot (not just the pattern) so the caller can record the
// grant id and expires_at on the Decision / audit row.
//
// `cwd` is optional because only path-based sections need it.
// Pre-fix the bash + fetch_url callers passed `cwd=''` as a
// placeholder — works today because the internal switch routes
// to `matchCommand` / `matchHost` (neither reads cwd) but the
// empty string would `resolve('', value)` against the process
// cwd with arbitrary semantics if a future section refactor
// dropped to the `matchPath` branch. Now the path branch
// defensively returns null when cwd is missing, and the bash +
// fetch_url callers omit the argument entirely.
const firstMatchingGrant = (
  grants: readonly GrantSnapshot[] | undefined,
  section: keyof PolicyToolsSection,
  target: string,
  cwd?: string,
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
      // Path-based section requires cwd. A caller that omits it
      // can't resolve relative grant scopes — drop the grant
      // rather than fall back to a process-cwd resolve that the
      // engine never intended.
      if (cwd === undefined) return null;
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

  // Persisted grant check. Runs AFTER deny (deny always wins, even
  // over an operator-granted exemption) and BEFORE the in-memory
  // session-allow + compound guard. A matching grant carries the
  // operator's prior approval forward across session boundaries.
  // Compound guard is intentionally bypassed — same rationale as
  // session-allow: the operator authorized this pattern explicitly
  // for the grant's TTL window.
  const grantMatch = firstMatchingGrant(activeGrants, 'bash', command);
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
  //
  // The bash prompt interpolates the literal command into the
  // operator-visible `prompt` field: `Run bash: curl -H
  // "Authorization: Bearer SECRET" ...`. The IPC envelope (for
  // subagent confirm) carries this prompt verbatim; structured-event
  // consumers can log it. Redact BEFORE interpolation so secrets
  // never reach the prompt string. The operator's modal STILL
  // renders the raw `args` block alongside the prompt, so the
  // operator can see the literal command for the decision; only the
  // prompt-line hint is sanitized.
  const promptCommand = redactSecrets(command);
  if (containsShellInjection(command)) {
    return {
      kind: 'confirm',
      // Risk signal (compound / shell-injection shape), not a routine
      // policy rule — never auto-approved by autonomous posture.
      confirmCause: 'compound',
      prompt: `Run bash: ${promptCommand}`,
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
      confirmCause: 'policy',
      prompt: `Run bash: ${promptCommand}`,
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

// A search tool walks a tree from a root (declared via `rootArg`),
// so deny/allow matching uses the synthetic-descendant probe.
const isSearchTool = (toolName: string): boolean => FS_TOOL_TRAITS[toolName]?.rootArg !== undefined;

// Whether a tool's ALLOW side also tests the literal path (exact-file
// rules for single-file invocations — git only today).
const allowsExactFile = (toolName: string): boolean =>
  FS_TOOL_TRAITS[toolName]?.exactFileAllow === true;

const matchTargetForRules = (toolName: string, path: string): string =>
  isSearchTool(toolName) ? `${path}/${SYNTHETIC_DESCENDANT}` : path;

// Resolve a path to its symlink-followed absolute form for protected
// path classification. Mirrors the matcher's `resolveSymlinks` so a
// symlink at `./safe → /etc/passwd` is caught by the protected check
// just like the matcher catches it for rule matching.
//
// Always normalizes lexically via `path.resolve(cwd, rawPath)` first
// — even when `rawPath` is already absolute. Without this,
// `/work/proj/data/../../etc/hosts` in a fictional cwd stays
// un-normalized (both realpath fallbacks ENOENT-fail, textual abs
// returns with the `/work/proj/` prefix intact, and the protected
// classifier misses the underlying `/etc/` target). `path.resolve`
// does the .. and `./` resolution lexically without touching the
// filesystem; realpath then refines for symlinks if the resolved
// target exists.
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

// True iff the symlink-resolved target is a REGULAR FILE. Gates the
// `exactFileAllow` literal fallback so it grants only genuine
// single-file reads (git blame/diff -- f): a bare-directory allow
// (`src`) must NOT match a directory PATH (`git ls_files/log -- src`)
// and thereby grant subtree enumeration that the search-tool rule
// shape deliberately reserves for `src/**`. A non-existent path is not
// a file → falls back to synthetic-descendant matching (safe).
const isRegularFile = (absPath: string): boolean => {
  try {
    return statSync(absPath).isFile();
  } catch {
    return false;
  }
};

// The fs "floor": the hardcoded protected zones (deny/escalate tiers,
// §11) plus the sensitive-path deny-list (§8.4). Neither is overridable
// by operator policy OR by `mode=bypass`. Centralized so checkPath, the
// bypass branch, and canReadPath classify a path identically (a change
// to the floor lands in ONE place). Symlink-resolves the path first so
// a symlink into a protected/sensitive target is still caught.
interface FloorClassification {
  absPath: string;
  // null = not protected. `deny` short-circuits; `escalate` is carried
  // forward (confirm-on-write).
  tier: ProtectedTier | null;
  // Matched sensitive pattern, or null. Skipped when tier === 'deny'
  // (a deny already wins, so the sensitive check would be moot).
  sensitive: string | null;
}
const classifyFloor = (
  rawPath: string,
  op: ProtectedOp,
  cwd: string,
  home: string,
): FloorClassification => {
  const absPath = resolveForProtected(rawPath, cwd);
  const tier = classifyProtectedPath({ absPath, op, home, cwd });
  const sensitive =
    tier === 'deny' ? null : (matchSensitivePath(absPath) ?? matchSensitivePath(rawPath));
  return { absPath, tier, sensitive };
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

  // Protected-path classification. Runs against the SYMLINK-RESOLVED
  // absolute form so a symlink inside cwd pointing at /etc/passwd is
  // still classified as protected. Tier `deny` returns immediately
  // (any op, any rule). Tier `escalate` is carried as a flag — if
  // downstream rule lookup produces `allow`, we upgrade it to
  // `confirm` (write/delete on a protected path always escalates to
  // confirm at minimum). Reads of escalate-tier paths pass through
  // unchanged.
  const floor = classifyFloor(path, isWrite ? 'write' : 'read', cwd, home);
  const protectedAbsPath = floor.absPath;
  const protectedTier = floor.tier;
  if (protectedTier === 'deny') {
    return {
      kind: 'deny',
      reason: `path is in protected zone (deny tier): ${protectedAbsPath}`,
      source: { layer: 'default', section: 'protected' },
    };
  }

  // Sensitive-path engine-floor refuse. Pairs with the protected-
  // zone check above: protected-zone covers system-root paths fixed
  // by OS layout, sensitive-path covers content-based secrets that
  // match by NAME regardless of where they live in the fs (.env,
  // *.pem, id_rsa*, .aws/credentials, **/credentials*.json, etc.).
  //
  // This fires BEFORE deny_paths / session_allow / allow_paths
  // because the deny is an engine-floor: paths on this list are
  // blocked from read_file (any read tool) and write_file (any write
  // tool). Operator cannot widen via policy — same engine-floor
  // posture as HARD_REFUSE_COMMANDS in the bash resolver. Threat:
  // model emits `read_file('.env')` against a policy with
  // `allow_paths: ['**']` (the "let it work" config many operators
  // write); without this gate the read succeeds and secrets land in
  // `tool_calls.output`. Redaction is not an option because
  // checkpoint needs literal content — refuse is the only correct
  // posture.
  //
  // Match against the canonical absolute (already symlink-resolved
  // by resolveForProtected) AND the operator-supplied path form, so
  // both a request for `~/.ssh/id_rsa` and one for a symlink
  // pointing at it land in the same refuse.
  const sensitiveMatch = floor.sensitive;
  if (sensitiveMatch !== null) {
    return {
      kind: 'deny',
      reason: `path matches sensitive-path deny-list (SEC §8.4): ${sensitiveMatch}`,
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
  // Persisted grant check. Same position as for bash: after deny,
  // before session-allow. A grant carrying a path pattern that
  // matches the resolved fs target authorizes the call. Protected-
  // path `escalate` tier still upgrades the decision to confirm —
  // the grant authorizes the WRITE attempt, but a confirm-on-
  // protected is mandatory even with prior approval.
  // `git` ALSO tests the LITERAL path on the allow side. Its
  // `matchTarget` is `path/.forja-check` (search-tool framing), which
  // admits a tree root against `dir/**` but MISSES an exact-file allow/
  // grant (e.g. `src/a.ts`) when git was handed a single file — the
  // case for `git blame -- f` / `git diff -- f`. Restricted to `git`
  // (not grep/glob): those deliberately require a `dir/**` form for the
  // allow side — a bare-root `dir` rule must NOT admit a subtree search
  // (see the "bare-root pattern does NOT fire" regression pin). Deny
  // ran above, so this extra literal match only relaxes an over-strict
  // allow, never bypasses a deny.
  const grantMatch =
    firstMatchingGrant(activeGrants, sectionKey, matchTarget, cwd) ??
    (allowsExactFile(toolName) && isRegularFile(protectedAbsPath)
      ? firstMatchingGrant(activeGrants, sectionKey, path, cwd)
      : null);
  if (grantMatch !== null) {
    if (protectedTier === 'escalate') {
      return {
        kind: 'confirm',
        confirmCause: 'escalate',
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
  const sessionMatched =
    firstMatchingPath(sessionAllow, matchTarget, cwd) ??
    (allowsExactFile(toolName) && isRegularFile(protectedAbsPath)
      ? firstMatchingPath(sessionAllow, path, cwd)
      : null);
  if (sessionMatched !== null) {
    if (protectedTier === 'escalate') {
      return {
        kind: 'confirm',
        confirmCause: 'escalate',
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
  const allowed =
    firstMatchingPath(rules?.allow_paths, matchTarget, cwd) ??
    (allowsExactFile(toolName) && isRegularFile(protectedAbsPath)
      ? firstMatchingPath(rules?.allow_paths, path, cwd)
      : null);
  if (allowed !== null) {
    if (protectedTier === 'escalate') {
      return {
        kind: 'confirm',
        confirmCause: 'escalate',
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
  // Same git-only literal fallback as the allow/grant/session branches
  // above — so an exact-file `confirm_paths: ['src/a.ts']` prompts for
  // `git blame -- src/a.ts` instead of default-denying (the synthetic
  // `src/a.ts/.forja-check` target would miss it).
  const confirm =
    firstMatchingPath(rules?.confirm_paths, matchTarget, cwd) ??
    (allowsExactFile(toolName) && isRegularFile(protectedAbsPath)
      ? firstMatchingPath(rules?.confirm_paths, path, cwd)
      : null);
  if (confirm !== null) {
    // acceptEdits accepts edits without confirmation. For writes, a
    // confirm_paths match becomes an auto-allow — that IS the
    // convenience the mode promises. Reads still require confirmation.
    // BUT: protected-tier `escalate` paths block the auto-accept —
    // the "at minimum, confirm" floor wins over acceptEdits's
    // convenience.
    if (mode === 'acceptEdits' && isWrite && protectedTier !== 'escalate') {
      return {
        kind: 'allow',
        reason: `acceptEdits: matched confirm rule (auto-accepted): ${confirm}`,
        source: { layer, rule: confirm, section: sectionName },
      };
    }
    return {
      kind: 'confirm',
      // Protected-tier escalate overrode an allow/confirm rule on a
      // write — a safety floor, not a routine policy confirm.
      confirmCause: protectedTier === 'escalate' ? 'escalate' : 'policy',
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
  // Persisted grant check. Pattern grants targeting hosts use the
  // same matcher as `allow_hosts` (case-insensitive host glob).
  const grantMatch = firstMatchingGrant(activeGrants, 'fetch_url', host);
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
  // A tool may SHARE another's policy section (declared in
  // FS_TOOL_TRAITS). `git` shares `read_file` — an operator who grants
  // file reads thereby governs git's reads with one allow/deny list,
  // and git works out-of-box wherever read_file does (the bash family
  // shares `tools.bash` the same way).
  const shared = FS_TOOL_TRAITS[toolName]?.section;
  if (shared !== undefined) return shared;
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
// allowed' / 'confirm-denied' — the post-modal update path lives
// elsewhere. Every `confirm` returned from `check()` is the pre-
// modal form.
const decisionToAuditEnum = (kind: Decision['kind']): 'allow' | 'deny' | 'confirm' => kind;

// Upgrade an `allow` Decision into a `confirm`. The cause is
// explicit so the modal prompt + audit row accurately name what
// fired (a previous version hardcoded "degraded state" regardless of
// cause, so score-gated confirms on a perfectly READY engine were
// mis-labeled). Three flavors:
//   - 'degraded' — engine actually in degraded state.
//   - 'score'    — risk score crossed threshold OR resolver
//                  confidence was low (the approval gate).
//   - 'resolver' — resolver returned conservative / low confidence
//                  via the forced-confirm path.
//
// Preserves source attribution so the modal still shows the rule
// that would have fired. Non-allow decisions pass through unchanged
// — never downgrades a `deny` or `confirm`. Spreads `decision` so
// non-source fields survive — `approvalSeq`, `sandboxProfile`,
// `ttlExpiresAt` (load-bearing for grant-match audit rows: dropping
// them would leave `ttl_expires_at` null even when a grant
// authorized the call). The `kind`, `prompt`, and `reason` fields
// below intentionally override the spread values.
//
// `detail` carries the metric for the audit row + modal preview
// (e.g., `score=0.62 >= 0.40`, `confidence=low`, `conservative: <reason>`).
// The subset of ConfirmCause this helper can stamp. `Extract` keeps it
// pinned to the public union: drop one of these three from ConfirmCause
// and this type (and the Records below) fail to compile rather than
// drift silently.
type DegradeCause = Extract<ConfirmCause, 'degraded' | 'score' | 'resolver'>;

const degradeAllowToConfirm = (
  decision: Decision,
  cause: DegradeCause,
  detail: string,
): Decision => {
  if (decision.kind !== 'allow') return decision;
  const baseReason = decision.reason ?? 'allow';
  const prompts: Record<DegradeCause, string> = {
    degraded: 'Engine is in degraded mode — confirm before continuing.',
    score: `Risk score forced confirm (${detail}). Review before continuing.`,
    resolver: `Resolver forced confirm (${detail}). Review before continuing.`,
  };
  const reasons: Record<DegradeCause, string> = {
    degraded: `degraded state forced confirm (was: ${baseReason})`,
    score: `score gate forced confirm (${detail}; was: ${baseReason})`,
    resolver: `resolver gate forced confirm (${detail}; was: ${baseReason})`,
  };
  return {
    ...decision,
    kind: 'confirm',
    // The upgrade cause IS the confirm cause — degraded/score/resolver
    // are all risk signals, so none of them is auto-approvable.
    confirmCause: cause,
    prompt: prompts[cause],
    reason: reasons[cause],
  };
};

// Inverse of degradeAllowToConfirm for the autonomous posture: a
// routine `policy` confirm becomes an allow so it clears without a
// modal. Handles ONLY the 'policy' cause; the bash 'compound' / 'resolver'
// / 'score' causes have a capability-confinement sibling
// (`autoApproveRepoConfined`). Every OTHER cause (escalate/degraded) is a
// risk/safety signal and passes through unchanged (fail-closed: an
// unrecognized future cause stays a confirm too). Preserves source
// attribution + carried DecisionBase fields so the audit row still names
// the rule that matched; the reason records that POSTURE, not the rule,
// cleared it. Caller only invokes this when the engine is `ready` —
// degraded suspends auto-approval.
const autoApprovePolicyConfirm = (decision: Decision): Decision => {
  if (decision.kind !== 'confirm' || decision.confirmCause !== 'policy') return decision;
  const allow: Extract<Decision, { kind: 'allow' }> = {
    kind: 'allow',
    reason: `autonomous posture: auto-approved policy confirm (was: ${decision.reason ?? 'confirm'})`,
  };
  if (decision.source !== undefined) allow.source = decision.source;
  if (decision.ttlExpiresAt !== undefined) allow.ttlExpiresAt = decision.ttlExpiresAt;
  return allow;
};

// Whether a single capability is "repo-confined and non-dangerous" for
// the autonomous posture — an effect the operator opted to run without a
// modal when hands-off (§8.1 `AGENTIC_CLI`). Safe = filesystem read /
// write / delete UNDER the cwd subtree (and neither OS-protected nor a
// content-secret), a LOCAL git write on this repo, the `/dev` safe
// pseudo-devices (so `2>/dev/null` doesn't gate), and `exec:shell` (the
// bash process itself). Everything else keeps its modal: network
// (net-egress / net-ingress — `git push`/`pull`/`fetch` carry net-egress,
// so they gate even though they also git-write), an unknown binary
// (`exec:arbitrary`), python/node interpreters, secret-access, env/agent
// mutation, and ANY path outside the repo or hitting a protected
// (`.git`/`.agent`/system) or sensitive (`.env`/`*.pem`/`id_rsa`/
// credentials) target. The sensitive/protected checks are
// belt-and-suspenders — the engine's §8.4 sensitive floor already DENIES
// most of these before this runs — so a future floor change can't
// silently widen auto-approval. Fail-closed: an unrecognized kind, or a
// scoped kind with a null scope, is not safe.
const capRepoConfined = (cap: Capability, cwd: string, home: string): boolean => {
  switch (cap.kind) {
    case 'exec':
      return cap.scope === 'shell';
    case 'git-write':
      // Resolver stamps git-write with repo == cwd; a network git op
      // (push/pull/fetch/unknown subcommand) ALSO carries net-egress,
      // which fails this predicate via the default branch.
      return cap.scope === cwd;
    case 'read-fs':
    case 'write-fs':
    case 'delete-fs': {
      const path = cap.scope;
      if (path === null) return false;
      if (isDevSafe(path)) return true; // /dev/null, /dev/stdout, /dev/fd/*, ...
      if (!startsWithSegment(path, cwd)) return false; // escapes the repo
      // Gate if protected for EITHER op. `.git`/`.agent`/`.claude` are
      // write-escalate but readable to git in general — for the no-modal
      // auto-approval we treat them as off-limits for reads too (they can
      // carry tokens / `core.sshCommand`), honoring the operator's
      // ".git stays gated" intent. System-deny roots gate for both ops.
      if (
        classifyProtectedPath({ absPath: path, op: 'read', home, cwd }) !== null ||
        classifyProtectedPath({ absPath: path, op: 'write', home, cwd }) !== null
      ) {
        return false;
      }
      if (matchSensitivePath(path) !== null) return false; // .env/*.pem/credentials
      return true;
    }
    default:
      // net-egress, net-ingress, secret-access, env-mutate, agent-mutate,
      // host-passthrough → never repo-confined.
      return false;
  }
};

// Autonomous-posture sibling of autoApprovePolicyConfirm for the
// capability-confined case: a bash `confirm` (compound / resolver-low-
// confidence / score-gated) becomes an allow when EVERY resolved
// capability is repo-confined (`capRepoConfined`) AND no top-level segment
// matches an operator `deny` rule. This is what lets the agent work freely
// INSIDE the repo under autonomous — read/write/delete repo files, local
// git — while every dangerous effect (network, outside-repo, unknown
// binary, protected/sensitive path) keeps its modal. The caller gates this
// on resolver `kind: ok` (the command is FULLY modeled, so the capability
// set is COMPLETE): within that, command structure (compound, glob,
// pipeline) doesn't gate — only the EFFECT does. A `conservative` result
// (soft control flow, dynamic `$var`, unknown command) never reaches here,
// because its caps are best-effort and can under-represent the runtime
// targets. The per-segment deny re-check closes
// checkBash's whole-string-glob gap (`deny: ['curl*']` misses `echo x &&
// curl evil`); it runs only for the compound cause. That is SOUND because
// of an invariant: the `resolver`/`score` causes arise only from an
// upgraded ALLOW (`degradeAllowToConfirm` rewrites `allow`→`confirm` and
// returns an existing `confirm` untouched), and an allow is necessarily
// NON-compound — checkBash stamps any shell-metachar command `compound`
// BEFORE the allow rules. So a compound always carries cause `compound`
// (even when also low-confidence or score-crossing), and a `resolver`/
// `score` confirm is always a single command whose whole string checkBash
// already deny-matched. Pinned by tests. Fail-closed: an empty capability
// set, a command that can't be decomposed, or any non-confined cap keeps
// the modal.
const autoApproveRepoConfined = (
  decision: Decision,
  command: unknown,
  caps: readonly Capability[],
  cwd: string,
  home: string,
  denyRules: readonly string[] | undefined,
): Decision => {
  if (decision.kind !== 'confirm') return decision;
  if (caps.length === 0) return decision;
  for (const cap of caps) {
    if (!capRepoConfined(cap, cwd, home)) return decision;
  }
  if (decision.confirmCause === 'compound') {
    if (typeof command !== 'string') return decision;
    const segments = topLevelCommandTexts(command);
    if (segments === null) return decision;
    for (const segment of segments) {
      if (firstMatchingCommand(denyRules, segment) !== null) return decision;
    }
  }
  const allow: Extract<Decision, { kind: 'allow' }> = {
    kind: 'allow',
    reason: `autonomous posture: auto-approved repo-confined operation (was: ${decision.reason ?? 'confirm'})`,
  };
  if (decision.source !== undefined) allow.source = decision.source;
  if (decision.ttlExpiresAt !== undefined) allow.ttlExpiresAt = decision.ttlExpiresAt;
  return allow;
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

// A would-be `allow` upgrades to `confirm` when EITHER the final
// score (deterministic + clamped classifier adjust) crosses the
// threshold OR the resolver confidence is `low`. The two conditions
// are independent — high/medium-confidence + low-score allows pass
// through; only score≥threshold or confidence='low' escalates.
// medium confidence intentionally does NOT force (over-escalating
// medium would generate approval fatigue and poison the calibration
// plan's `confidence` signal). Only `allow` is gated (deny/confirm
// are already terminal for this purpose). Misc tools skip the
// resolver and run at `high` confidence with score 0, so they never
// trigger this gate. Caller passes `null` confidence for misc to
// short-circuit.
const scoreForcesConfirm = (
  decision: Decision,
  score: number,
  confidence: RiskScoreConfidence | null,
  threshold: number,
): boolean => {
  if (decision.kind !== 'allow') return false;
  if (score >= threshold) return true;
  if (confidence === 'low') return true;
  return false;
};

// Reason-chain entry tagged `approval-gate` when the score / confidence
// gate forced the confirm. Carries which side fired (`score=X >= T` or
// `confidence=Y`) so the modal preview can render "Risk score: 0.62
// (above 0.40 threshold)" verbatim. Distinct from `resolve` (which
// fires on Conservative/low specifically — those are still attributed
// to the resolver) because the score-threshold rule is an engine-
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
  // Only `low` confidence forces the gate, not `medium` (parallel to
  // the `scoreForcesConfirm` rule).
  if (confidence === 'low') {
    return { stage: 'approval-gate', note: 'confidence=low' };
  }
  return undefined;
};

// Compute the detail string passed into `degradeAllowToConfirm` so
// the modal/audit accurately names what caused the upgrade. Returns
// 'unspecified' when neither side fired (caller shouldn't be calling
// us then).
const approvalGateDetail = (
  score: number,
  confidence: RiskScoreConfidence | null,
  threshold: number,
): string => {
  if (score >= threshold) {
    return `score=${score.toFixed(2)} >= threshold=${threshold.toFixed(2)}`;
  }
  if (confidence === 'low') return 'confidence=low';
  return 'unspecified';
};

// Detail for the resolver-driven confirm path. Mirrors the existing
// `resolverStageEntry` shape so the modal prompt matches the
// reason-chain note.
const resolverDetail = (result: ResolverResult | null): string => {
  if (result === null) return 'unspecified';
  if (result.kind === 'conservative') return `conservative: ${result.reason}`;
  if (result.kind === 'ok' && result.confidence === 'low') return 'confidence=low';
  return 'unspecified';
};

// Reason-chain entry tagged `sandbox-plan`. Fires every time the
// sandbox planner runs — for both ok (chosen profile recorded) and
// refuse (uncovered capability kinds named) outcomes. Lets
// `/perms why` render "this call needed delete-fs + net-egress but
// no profile permits both" without re-running the planner.
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
  } else if (decision.source?.section === 'engine-state') {
    // State-rejecting denies (engine in
    // init/loading/validating/refusing). Distinct from
    // `default-deny` so forensic queries for "decisions refused
    // while engine was in state X" can find them.
    stage = 'engine-state';
  } else if (decision.source?.section === 'resolver-refuse') {
    // Resolver-floor refuses (HARD_REFUSE_COMMANDS, RED_FLAG_NODES,
    // SSRF blocklist, etc). Distinct from operator-policy denies
    // because operator cannot widen them.
    stage = 'resolver-refuse';
  } else if (decision.source?.section === 'sandbox-plan' && decision.kind === 'deny') {
    // Sandbox-plan REFUSE (uncovered capability set or sandbox
    // required + unavailable). The existing `sandboxPlanStageEntry`
    // appends a second `sandbox-plan` entry describing the planner
    // state. The FIRST entry's stage reflects that the call was
    // REFUSED at sandbox-plan time, not `default-deny`.
    stage = 'sandbox-refused';
  } else if (decision.source?.section === 'subagent-effective') {
    // Child-envelope deny. Distinct stage so audit replays and
    // `/perms why` rendering can tell the operator the call was
    // refused because it stepped OUTSIDE what the subagent declared
    // — not because the parent's policy refused it. The distinction
    // matters for triage: the operator's policy might already
    // authorize the requested cap, but the SUBAGENT's declared
    // envelope didn't.
    stage = 'subagent-effective';
  } else if (decision.source?.section === 'grants') {
    // Grant match — checked before the generic session-allow branch
    // (grant decisions carry both `section='grants'` and
    // `layer='session'`). Distinct stage so audit replays and
    // `/perms why` rendering can distinguish a PERSISTED grant from
    // a transient session-allow.
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
  // Hot reload: policy / mode / policyHash are mutable cells so
  // `reloadPolicy()` can swap them atomically. JS `let` bindings are
  // by-reference in closures, so check() (and every helper it calls
  // through this scope) reads the CURRENT value on each access — no
  // extra plumbing needed. The reloadPolicy method at the bottom of
  // this factory updates all three.
  let policy = initialPolicy;
  // Mode is optional on parsed policies (so the resolver can tell
  // "user file was silent" from "user file said strict explicitly")
  // but the engine needs a concrete value. Default to strict — same
  // policy as the empty-file fallback.
  let mode: PolicyMode = policy.defaults.mode ?? 'strict';
  // Approval posture is a runtime axis orthogonal to `mode` (it comes
  // from EngineOptions / the operator toggle, not from policy YAML).
  // Seeds from options; defaults to the safe supervised stance.
  let posture: ApprovalPosture = options.approvalPosture ?? 'supervised';
  const cwd = options.cwd;
  const home = options.home ?? process.env.HOME ?? cwd;
  // Mutable so reloadPolicy can swap. A const would make every
  // `/perms why` and `source.layer` audit field stale post-reload —
  // the engine would keep the construction-time hierarchy
  // attribution even when the watcher resolved a fresh policy from a
  // different layer.
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
  // Mutable so reloadPolicy can swap it alongside policy / hash /
  // mode. Pre-fix this was a const, which meant a hot-reload that
  // added or removed `fetch_url.trusted_hosts` entries left the
  // risk-scorer using the construction-time list — operator edited
  // YAML, policy hash advanced, but `untrusted_egress` kept firing
  // (or stopped firing) against the OLD set until process restart.
  let trustedHosts = options.trustedHosts ?? DEFAULT_TRUSTED_HOSTS;
  const isMcpTool = options.isMcpTool ?? defaultIsMcpTool;
  // Normalize `recentToolErrors` to a getter. The number form is
  // wrapped in a closure capturing the literal value (preserves
  // frozen-snapshot semantics for test callers), while a getter
  // passed by a long-running harness is invoked fresh on every
  // check() — see the EngineOptions doc for why a frozen snapshot
  // breaks risk scoring in long sessions.
  const recentToolErrorsRaw = options.recentToolErrors;
  const getRecentToolErrors: () => number =
    typeof recentToolErrorsRaw === 'function'
      ? recentToolErrorsRaw
      : (() => {
          const frozen = recentToolErrorsRaw ?? 0;
          return () => frozen;
        })();
  const classifier = options.classifier;
  const classifierHash = options.classifierHash ?? 'none';
  const classifierRequired = options.classifierRequired ?? false;
  const telemetry = options.telemetry;
  const telemetryNow = options.now ?? Date.now;
  // Score threshold. Caller can override for calibration sweeps or
  // per-deployment tuning; default is the v2 baseline (0.4).
  const scoreConfirmThreshold = options.scoreConfirmThreshold ?? DEFAULT_SCORE_CONFIRM_THRESHOLD;
  const contextSummaryDepth = options.contextSummaryDepth ?? DEFAULT_CONTEXT_SUMMARY_DEPTH;
  const contextSummaryMaxBytes =
    options.contextSummaryMaxBytes ?? DEFAULT_CONTEXT_SUMMARY_MAX_BYTES;
  const contextSummaryBuffer = createContextSummaryBuffer(contextSummaryDepth);
  const sandboxOptions = options.sandbox;
  // Child-envelope bound. `undefined` ⇒ root: skip the stage
  // entirely. Empty array ⇒ pure-LLM child: any non-empty resolved
  // cap is uncovered → deny. Non-empty ⇒ narrowed envelope: every
  // resolved cap must be covered by `effectiveCovers`.
  const effectiveCapabilities = options.effectiveCapabilities;
  const isToolSideEffect = options.isToolSideEffect;
  // policy_hash is stamped on every audit row. Recomputed on hot
  // reload so post-swap rows carry the new hash. Canonical hash so
  // two engines with semantically equivalent policies produce the
  // same hash.
  let policyHash = `sha256:${canonicalHash(policy)}`;

  // Session-scoped allowlist: per-section list of patterns the
  // operator promoted via the modal's "Yes, don't ask again
  // for: <rule>" answer. In-memory only — survives the lifetime
  // of this engine instance, vanishes on process exit. The Map
  // grows append-only during a session; rules are NEVER removed
  // (a future `/perms forget` slash would clear them, but for
  // now operator restarts the session to revoke trust).
  const sessionAllow = new Map<keyof PolicyToolsSection, string[]>();

  // Posture transition log (append-only, oldest first). Slice 3 drains
  // it into durable audit; until then it preserves each transition's
  // reason and powers introspection + the setter tests.
  const postureChanges: PostureChange[] = [];

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
      // Chosen sandbox profile. Null when the sandbox planner didn't
      // run (no EngineOptions.sandbox) OR when the call refused
      // before it reached the planner. A `sandbox-plan` reason-
      // chain entry pairs with this column on every row where the
      // planner ran (success or refusal).
      sandbox_profile: sandboxProfileForRow,
      // Grant TTL expiry. Populated when the Decision was produced
      // by a persisted grant match (`decision.ttlExpiresAt`); null
      // otherwise. Future replay can correlate `ttl_expires_at` +
      // the `grant-match` reason chain stage to reconstruct the
      // grant trail.
      ttl_expires_at: decision.ttlExpiresAt ?? null,
    };
    const emitted = audit.emit(input);

    // Record THIS decision in the ring buffer so the NEXT check's
    // classifier sees it. Capability KINDS only — scopes never
    // enter the buffer (defense against leaking adversary-visible
    // paths/hosts to a sometimes-remote classifier). Dedup kinds so
    // a call with five `read-fs:...` capabilities lands as a single
    // `read-fs` kind in the summary.
    const kindSet = new Set<CapabilityKind>();
    for (const cap of capabilities) kindSet.add(cap.kind);
    contextSummaryBuffer.push({
      toolName,
      decision: decisionToAuditEnum(decision.kind),
      capabilityKinds: Array.from(kindSet),
    });
    return emitted;
  };

  // Posture-change admin row. Same shape as bootstrap's
  // chain-break-accepted / policy-reloaded rows: tool_name=
  // 'permission-engine', decision='allow' (the operator authorized the
  // flip), every pipeline signal empty, the transition captured in
  // `args` + `reason_chain`. This keeps Supervised↔Autonomous changes
  // in the SAME tamper-evident ledger as the decisions they govern,
  // rather than a side table outside the hash chain. Bypasses
  // `emitAudit` on purpose — a posture change must not enter the
  // classifier ring buffer (it's not a tool decision). No-op under the
  // noop sink (tests/headless), where `audit.emit` returns the
  // sentinel.
  const emitPostureChangeRow = (
    from: ApprovalPosture,
    to: ApprovalPosture,
    reason: string,
  ): void => {
    audit.emit({
      session_id: sessionId,
      tool_name: 'permission-engine',
      args: { posture_from: from, posture_to: to, reason },
      decision: 'allow',
      policy_hash: policyHash,
      reason_chain: [{ stage: 'posture-change', note: `from=${from} to=${to}: ${reason}` }],
      capabilities: [],
      score: 0,
      score_components: {},
      classifier_hash: 'none',
      classifier_adjust: null,
      sandbox_profile: null,
      ttl_expires_at: null,
      // No explicit `ts`: let the sink stamp Date.now, like every other
      // emitAudit row. Injecting the engine's `now` seam here — while the
      // sink validates timestamps against real wall-clock — was the only
      // emit site that could trip the skew guard under a deterministic
      // clock (replay / tests).
    });
  };

  // Attach `approvalSeq` to a Decision so the harness can link the
  // audit row with the matching `tool_calls` row. The noop sink
  // returns seq=0 (no row persisted); we omit the field in that case
  // so a downstream `linkApprovalToToolCall(seq=0)` call never fires
  // under tests/headless paths.
  const withApprovalSeq = (decision: Decision, seq: number): Decision => {
    if (seq === 0) return decision;
    return { ...decision, approvalSeq: seq };
  };

  // Attach `sandboxProfile` to a Decision so the harness can thread
  // it into ToolContext for runtime enforcement. Omits the field
  // when the planner didn't run (no `EngineOptions.sandbox` or
  // refused branch); the runner-side wrap is a no-op without the
  // hint.
  const withSandboxProfile = (decision: Decision, profile: string | null): Decision => {
    if (profile === null) return decision;
    // Defense-in-depth validation. The `profile` param's domain is
    // `selectSandboxProfile`'s return type, but a future code path
    // wiring an external string here would silently launder past the
    // type system via the cast. `isSandboxProfile` matches the
    // wire-validation gate at the runner boundary; keeping the
    // engine boundary symmetric ensures both sides refuse the same
    // way.
    if (!isSandboxProfile(profile)) {
      throw new Error(
        `withSandboxProfile: invalid profile '${profile}' — expected ro|cwd-rw|cwd-rw-net|home-rw|host`,
      );
    }
    return { ...decision, sandboxProfile: profile };
  };

  const check = (toolName: string, category: PolicyCategory, args: ToolArgs): Decision => {
    // State machine gate. Runs BEFORE bypass and before any rule
    // lookup: an engine in init / loading-policy / validating-chain
    // hasn't proven it can safely decide anything; refusing is the
    // fatal sink. In each of those states return deny with a
    // state-specific reason so the operator (and audit log) sees
    // exactly why. degraded falls through to the normal pipeline
    // but with an allow → confirm upgrade after the decision is
    // built.
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

    // Resolve capabilities. Runs BEFORE bypass, before rule lookup —
    // `Refuse` is structural rejection (dynamic eval, malformed
    // args, no-safe-resolution commands like `dd`/`mkfs`) and trumps
    // any allow rule. The resolved capabilities flow into the audit
    // row and into the modal's preview; even a `bypass` mode
    // decision carries an honest capability set so the operator can
    // see what the model intended to consume.
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
        // Wire realpath so the bash analyzer's per-arg classifier
        // can detect symlink-shaped bypasses (e.g.,
        // `/work/proj/innocent.txt` → `/etc/shadow`). Best-effort:
        // `realpathSync` throws for paths that don't exist (write-
        // creates-new-file) and the resolver's helper falls back to
        // the lexical form. The engine doesn't need to centralize
        // the try/catch; the helper handles it. Production wiring
        // only — tests that build ResolverContext directly omit
        // `realpath` and stay on the lexical-only path.
        realpath: realpathSync,
        // Slice 178 (review). Paired with `realpath` so the
        // resolver's dangling-symlink fallback can read the stored
        // target literal when the full realpath walk fails.
        // Without this, a broken symlink at `<cwd>/outlink → /tmp/x`
        // would collapse to `<cwd>/outlink` (parent realpath +
        // basename rejoin) and the cwd-scope-escape detector would
        // miss it — but the kernel still follows the symlink at
        // exec time.
        readlink: readlinkSync,
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

    // Child-envelope check. Runs AFTER resolver and BEFORE every
    // downstream stage (risk score, classifier, sandbox plan,
    // bypass, static rules, grants, session-allow). A subagent that
    // emits a resolved capability OUTSIDE its declared envelope is
    // structurally rejected — no policy rule can override.
    //
    // Two refuse paths:
    //
    //   (a) Resolver emitted at least one cap. Run `effectiveCovers`
    //       and refuse if any of them is uncovered.
    //
    //   (b) Resolver emitted ZERO caps but the tool declares a side
    //       effect (`metadata.writes` or `metadata.exec`). Spec
    //       §10.1 mandates pure-LLM subagent has no side-effect
    //       tools; §10.3 says escape is impossible. `bash_kill` /
    //       `bash_output` (category 'misc', empty caps from the
    //       resolver because they carry no `args.command` to
    //       attribute from) would otherwise pass under
    //       `effectiveCapabilities: []`. The `isToolSideEffect`
    //       oracle is bootstrap-wired from the tool registry's
    //       `metadata.writes || metadata.exec`; when omitted (test
    //       harnesses without a registry), branch (b) is skipped
    //       so legacy callers see the prior behavior.
    //
    // Misc-category tools without `writes`/`exec` (purely
    // informational ToolContext accessors) still trivially pass —
    // they hit branch (a) with caps=[] and skip branch (b) because
    // the oracle returns false.
    //
    // The check fires ONLY when the engine was built with
    // `effectiveCapabilities` (i.e. it's a child engine); root
    // engines skip the stage entirely.
    if (effectiveCapabilities !== undefined) {
      if (resolvedCapabilities.length > 0) {
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
      } else if (isToolSideEffect?.(toolName) === true) {
        // Empty caps + declared side-effect tool. Per spec §10.3
        // refuse outright — there's nothing in the envelope that
        // could ever cover an opaque side effect. The reason names
        // the tool because the operator's audit needs to see WHICH
        // tool tripped the gate (resolved caps are empty by
        // definition here).
        const decision: Decision = {
          kind: 'deny',
          reason: `subagent envelope blocks side-effect tool '${toolName}': resolver emitted no capability but the tool declares writes/exec (spec §10.1, §10.3)`,
          source: { layer: 'default', section: 'subagent-effective' },
        };
        const e = emitAudit(toolName, args, decision, [], 0, {}, null);
        return withApprovalSeq(decision, e.seq);
      }
    }

    // Compute the deterministic risk score once per check, from the
    // resolved state. Used both for the audit row and for the
    // approval-gate escalation. Conservative resolver outcomes feed
    // `low` confidence into the score; `null` resolver (misc
    // category) feeds `high` since misc tools have no side effects
    // worth scoring.
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
      // Read live — see `getRecentToolErrors` construction site for
      // why a snapshotted value would defeat the risk component.
      recentToolErrors: getRecentToolErrors(),
      trustedHosts,
      cwd,
      home,
    };
    const { score: deterministicScore, components: scoreComponents } = computeRiskScore(riskInput);

    // Classifier hint. Hint-only — the classifier can adjust the
    // score by ±0.2 clamped but cannot independently force a deny.
    // Failures (offline, exception, schema invalid) emit
    // `classifier-unavailable` in the reason chain and either
    // continue (lenient default) or degrade the engine (strict
    // mode). Misc category skips the classifier alongside the
    // resolver — no side effects worth scoring AND no need to
    // consult a hint.
    let score = deterministicScore;
    let classifierAdjust: number | null = null;
    let classifierStage: ReasonChainEntry | null = null;
    if (classifier !== undefined && category !== 'misc') {
      // Classifier sees a sanitized summary of recent activity.
      // Built from the engine's ring buffer (capability KINDS only,
      // never scopes/args/outputs) capped by `contextSummaryMaxBytes`.
      // Empty string when the session has no prior decisions yet —
      // the classifier degrades gracefully on absent context.
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
        // Telemetry for classifier.unavailable. Fires regardless of
        // strict mode — the metric counts EVERY unavailable response
        // across the install; the `strict` field distinguishes the
        // operational impact. Wrapped in try/catch — observability
        // cannot break engine.check. Categorize the failure mode:
        // threw, unavailable (returned null), or invalid (returned
        // non-conformant schema). The two non-throwing failures
        // collapse here under `validated === null`, so we
        // differentiate by whether rawOutput was non-null (invalid
        // schema) or null (genuinely unavailable).
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
    // Sandbox plan stage. Runs AFTER the classifier hint and BEFORE
    // the bypass / static-rule branches. Optional — wired only when
    // the caller passed `EngineOptions.sandbox`. When absent, the
    // audit row's `sandbox_profile` stays null and the reason chain
    // has no `sandbox-plan` entry (callers / harness paths that
    // don't snapshot sandbox availability skip the stage cleanly).
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
    // Medium confidence intentionally does NOT upgrade. Calibrating
    // that against operator fatigue is the risk-score's job —
    // medium covers "well-understood read-only with some
    // uncertainty" (e.g. `find` against a path) and shouldn't pop
    // the modal on every invocation. Revisit when the scoring
    // formula stabilizes.
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
      // degraded loses the bypass shortcut (every automatic `allow`
      // becomes `confirm`). Resolver-driven confirm is a softer
      // signal — operators who explicitly chose bypass are
      // committing to the broader risk surface, and a Conservative
      // result shouldn't undo that decision. The audit row still
      // carries the resolved capabilities so the row remains a
      // faithful summary of what the tool will touch, even when the
      // decision was `allow`.
      //
      // Protected-path classification: the protected paths are
      // HARDCODED, not flexible-via-policy. Bypass is a policy mode,
      // not an override of the protected-path floor. Walk the
      // resolved capability set and classify each fs-shaped scope: a
      // `deny` tier (system pseudofs like /proc, /sys, /boot, /dev)
      // refuses even under bypass; an `escalate` tier on a write op
      // upgrades the bypass-allow to confirm so the operator sees
      // the literal target before the rewrite commits. Reads of
      // escalate-tier paths pass through unchanged — bypass is still
      // bypass for the routine surface; only the hardcoded protected
      // list trumps it.
      let bypassProtectedTier: ProtectedTier | null = null;
      let bypassProtectedTarget = '';
      for (const cap of resolvedCapabilities) {
        // `git-write` capability carries an fs-path scope (the
        // target repo). The protected-path floor must apply here
        // too — git-write to a path in the deny / escalate tier
        // should refuse / confirm under bypass, same as a direct
        // write-fs would.
        //
        // Treat git-write as the WRITE op for classifier purposes
        // (a git push / commit / clone writes the repo's objects
        // dir; reading is not the dangerous side). Other non-fs
        // kinds (exec, net-egress, env-mutate, host-passthrough,
        // etc.) stay out of this loop by design — they're not
        // path-shaped and the protected classifier is path-only.
        if (
          cap.kind !== 'read-fs' &&
          cap.kind !== 'write-fs' &&
          cap.kind !== 'delete-fs' &&
          cap.kind !== 'git-write'
        ) {
          continue;
        }
        if (cap.scope === null) continue;
        const op: ProtectedOp = cap.kind === 'read-fs' ? 'read' : 'write';
        const floor = classifyFloor(cap.scope, op, cwd, home);
        const protectedAbsPath = floor.absPath;
        const tier = floor.tier;
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
          // Match the general bypass-mode exit's chain shape so
          // forensics on a deny row under bypass still surfaces the
          // engine state (`degraded` / `boot-deny-all`).
          const degradedStage = degradedStageEntry(currentState);
          if (degradedStage !== undefined) stages.push(degradedStage);
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
        // Sensitive-path engine-floor refuse. Mirror the checkPath
        // wire above — bypass mode does NOT override the sensitive-
        // path deny list. Operator who set mode=bypass intends to
        // skip CONFIRM prompts and policy matching, NOT to widen
        // access to credentials. These patterns remain a hard floor.
        const sensitiveBypassMatch = floor.sensitive;
        if (sensitiveBypassMatch !== null) {
          const decision: Decision = {
            kind: 'deny',
            reason: `path matches sensitive-path deny-list (SEC §8.4): ${sensitiveBypassMatch} (bypass mode does NOT override §8.4)`,
            source: { layer: 'default', section: 'protected' },
          };
          const stages: ReasonChainEntry[] = [];
          if (classifierStage !== null) stages.push(classifierStage);
          if (sandboxStage !== null) stages.push(sandboxStage);
          // Match the bypass-deny path above so a sensitive-path
          // deny under bypass shows the engine state too.
          const degradedStage = degradedStageEntry(currentState);
          if (degradedStage !== undefined) stages.push(degradedStage);
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
          confirmCause: 'escalate',
          prompt: `${toolName} on protected path: ${bypassProtectedTarget}`,
          reason: `bypass mode still escalates §11 protected paths: ${bypassProtectedTarget}`,
          source: { layer: 'default', section: 'protected' },
        };
      } else {
        bypassDecision = baseAllow;
      }
      const upgraded =
        currentState === 'degraded' && bypassDecision.kind === 'allow'
          ? degradeAllowToConfirm(bypassDecision, 'degraded', `state=${currentState}`)
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

    // Grants snapshot. Sampled once per `check()` call against the
    // current wall-clock so a long-running session sees a grant
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
    // for the approval-gate score/confidence rule.
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
    // Pass the actual cause so the modal prompt + audit reason name
    // what really fired. Priority: degraded > resolver-forced >
    // score-gated (matches the tailStage selection below for
    // consistency).
    if (currentState === 'degraded') {
      decision = degradeAllowToConfirm(decision, 'degraded', `state=${currentState}`);
    } else if (resolverForcesConfirm && !sessionAllowed) {
      decision = degradeAllowToConfirm(decision, 'resolver', resolverDetail(resolverResult));
    } else if (scoreEscalates && !sessionAllowed) {
      decision = degradeAllowToConfirm(
        decision,
        'score',
        approvalGateDetail(score, gateConfidence, scoreConfirmThreshold),
      );
    }
    // Autonomous posture clears a confirm without the modal. Runs LAST —
    // after every allow→confirm upgrade — and stays honest via these
    // floors:
    //   - Two auto-approvable shapes only. (1) a routine `policy` confirm
    //     (operator `confirm` rule) that is ITSELF low-risk — one that
    //     also trips the score / resolver gate is held, since
    //     `degradeAllowToConfirm` only upgrades `allow`s and a high-risk
    //     `confirm` rule must not get LESS protection than an `allow`.
    //     (2) a bash compound / resolver / score confirm whose every
    //     resolved capability is repo-confined (`autoApproveRepoConfined`):
    //     network, outside-repo, unknown-binary, and protected/sensitive
    //     effects all fail that predicate and keep the modal. `escalate`
    //     (protected-path tier) and `degraded` are never auto-approved.
    //   - suspended while degraded: a subsystem-health signal re-arms the
    //     modal for everything, posture included. We read the LIVE state
    //     here, NOT the `currentState` snapshot taken at the top of
    //     check(): a `classifierRequired` failure transitions the engine
    //     to degraded MID-check (in the classifier block above), and the
    //     snapshot would still read `ready` — auto-approving on the very
    //     check that degraded. The live read suspends auto-approval on
    //     that check too. Rejecting states already returned far above and
    //     the classifier path only transitions to `degraded`, so `ready`
    //     is the only clearing value here.
    const liveState = stateController.get();
    const policyConfirmIsRisky =
      score >= scoreConfirmThreshold || gateConfidence === 'low' || resolverForcesConfirm;
    let postureNote: string | null = null;
    if (posture === 'autonomous' && liveState === 'ready' && decision.kind === 'confirm') {
      if (decision.confirmCause === 'policy' && !policyConfirmIsRisky) {
        decision = autoApprovePolicyConfirm(decision);
        if (decision.kind === 'allow') postureNote = 'autonomous: auto-approved policy confirm';
      } else if (
        category === 'bash' &&
        resolverResult !== null &&
        resolverResult.kind === 'ok' &&
        (decision.confirmCause === 'compound' ||
          decision.confirmCause === 'resolver' ||
          decision.confirmCause === 'score')
      ) {
        // Capability-confinement: a bash confirm whose every resolved
        // capability stays inside the repo and is non-dangerous clears
        // without a modal, regardless of compound structure. Gated on
        // resolver `kind: ok` — i.e. the resolver FULLY modeled the command
        // — because that is the only state where the capability set is a
        // COMPLETE representation of the effect. A `conservative` result
        // (soft control flow, a dynamic `$var`, an unknown command) emits
        // BEST-EFFORT caps that can UNDER-represent the runtime targets:
        // `for f in /tmp/*; do rm "$f"; done` models the body's `$f` as
        // `<cwd>/$f` and emits no cap for the `/tmp/*` loop source, so the
        // caps all look repo-confined while the command deletes `/tmp` —
        // those stay behind the modal. (`refuse` already became a deny
        // upstream.) The cap predicate + per-segment deny re-check live in
        // the helper.
        const before = decision;
        decision = autoApproveRepoConfined(
          decision,
          args.command,
          resolvedCapabilities,
          cwd,
          home,
          (sectionRules as BashPolicy | undefined)?.deny,
        );
        if (decision !== before) postureNote = 'autonomous: auto-approved repo-confined operation';
      }
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
    // Trace the posture auto-approval so the audit row's `allow` is
    // attributable to the autonomous toggle, not just the matched rule.
    if (postureNote !== null) {
      stages.push({ stage: 'approval-posture', note: postureNote });
    }
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

  // Pure read_file path evaluation for content-emitting tools (see
  // `PermissionsView.canReadPath`). Reuses the same `checkPath`
  // pipeline as a real `read_file` decision — so operator deny_paths
  // AND the sensitive-path engine floor both apply — but deliberately
  // does NOT go through `check()`: no audit row, no approval-seq bump.
  // A clean `allow` (not confirm/deny) is the only "yes".
  const canReadPath = (path: string): boolean => {
    // `bypass` is handled in check() BEFORE the static path-rule
    // branch, so calling checkPath directly would miss it: with no
    // read_file.allow_paths it would default-deny every non-sensitive
    // file even though the engine allows the tool call under bypass.
    // Mirror check()'s bypass-read floor — allow everything EXCEPT the
    // hardcoded protected deny-tier and the sensitive-path floor
    // (neither is overridable by bypass; an escalate-tier READ passes
    // through, same as check()).
    if (mode === 'bypass') {
      // Same floor as check()'s bypass-read: allow everything except a
      // protected deny-tier and the sensitive-path list (escalate-tier
      // read passes through).
      const floor = classifyFloor(path, 'read', cwd, home);
      return floor.tier !== 'deny' && floor.sensitive === null;
    }
    const sectionRules = (policy.tools as unknown as Record<string, unknown>).read_file;
    const decision = checkPath(
      'read_file',
      { path },
      sectionRules as PathPolicy | undefined,
      mode,
      cwd,
      home,
      false,
      provenance,
      'read_file',
      sessionAllow.get('read_file'),
      options.grants?.listActive(Date.now()),
    );
    return decision.kind === 'allow';
  };

  const view = (): PermissionsView => ({ mode, posture, canReadPath });

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
    approvalPosture: () => posture,
    setApprovalPosture: (next, reason) => {
      if (next === posture) return;
      // Refuse while the engine isn't ready to extend its own ledger
      // (init / loading / validating / refusing) — mirrors
      // reloadPolicy's refusal and avoids recording a posture change
      // onto a chain the engine considers untrustworthy. Degraded is
      // allowed: the toggle is inert there (auto-approval is suspended
      // at check() time) but recording the operator's intent is fine.
      if (isRejectingState(stateController.get())) return;
      const from = posture;
      // Audit FIRST, mutate SECOND. If the row can't be written (skew /
      // DB error) `emitPostureChangeRow` throws and the posture does NOT
      // change — live behavior never diverges from the ledger.
      emitPostureChangeRow(from, next, reason);
      postureChanges.push({ from, to: next, reason, at: telemetryNow() });
      posture = next;
    },
    postureLog: () => postureChanges.slice(),
    state: () => stateController.get(),
    // Walks history backwards for the most recent transition INTO
    // degraded — that's the root cause until a `restore()` flips
    // state back to ready (which itself produces a transition pair,
    // so the next degrade after restore overwrites this lookup).
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
      // Callers consume this to build child-engine constraint
      // envelopes and to render /perms introspection — both should
      // treat the value as read-only. A naive `.map((c) => ({ ...c
      // }))` produces a fresh mutable array of fresh mutable
      // objects; a caller could mutate an element and pass the
      // array back into another engine constructor, silently
      // widening the child's constraint set. Freeze the elements
      // AND the array so any such mutation throws in strict mode.
      const cloned = effectiveCapabilities.map((c) => Object.freeze({ ...c }));
      return Object.freeze(cloned);
    },
    // Same defensive-clone strategy as `policy()`. The returned
    // provenance is consumed by /perms-style introspection; callers
    // mutating it shouldn't corrupt the engine's enforcement
    // attribution. When no provenance was supplied at construction
    // (test-built engines, headless dry-runs), default to the
    // sentinel "everything is the built-in default" shape.
    //
    // Reads from the MUTABLE `provenance` local so `reloadPolicy(_,
    // newProvenance)` swaps take effect here too — otherwise
    // `/perms` and audit interpretation would keep reporting the
    // OLD attribution while enforcement + hashes had already
    // swapped.
    provenance: () => structuredClone(provenance ?? ({ defaults: 'default' } as SectionProvenance)),
    addSessionAllow,
    // Hot reload — atomic swap of policy + recompute hash + mode.
    // Caller responsibility: resolve hierarchy, validate shape,
    // check lock conflicts BEFORE invoking. Engine does minimal
    // defensive checks (`canonicalHash` succeeds, `defaults` field
    // present) and either commits the swap or returns a diagnostic.
    // Single-threaded JS means in-flight check() calls run to
    // completion before this fires.
    reloadPolicy: (
      newPolicy: Policy,
      newProvenance?: SectionProvenance,
      newTrustedHosts?: readonly string[],
    ): ReloadPolicyResult => {
      // Refuse the reload when the engine is in `refusing` state.
      // Otherwise the policy-watcher would keep firing reloads on
      // YAML edits after a sealing failure / chain break /
      // mandatory-sandbox-unavailable, swapping policy / policyHash
      // / mode / provenance and emitting `policy-reloaded` audit
      // rows with `decision: 'allow'` — while every actual
      // `check()` returned deny. Forensic tools (`permission diff`,
      // `permission replay`) would later believe the engine
      // operated under the new policy when it was actually
      // refusing.
      //
      // Refusing is terminal; the only path out is a fresh engine
      // (CLI reset, --accept-broken-chain, etc.). While in this
      // state, policy YAML is irrelevant. Returning ok:false here
      // makes the watcher's next-tick log an explicit refusal.
      if (stateController.get() === 'refusing') {
        return {
          ok: false,
          reason:
            'reloadPolicy: engine state is `refusing` (terminal); policy swap rejected. Restart the agent to recover.',
        };
      }
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
      // Swap provenance alongside policy when the caller forwards a
      // fresh one. Omitting `newProvenance` (or passing undefined)
      // preserves the construction-time provenance — callers that
      // don't know about layered policy attribution stay correct.
      if (newProvenance !== undefined) provenance = newProvenance;
      // Swap trustedHosts when the caller forwards a fresh list.
      // The watcher (`policy-watcher.ts`) computes
      // `mergeTrustedHosts(newPolicy.tools.fetch_url?.trusted_hosts
      // ?? [])` and passes here. Omitting preserves the
      // construction-time value (test-only callers that don't care
      // about hot-reload semantics aren't forced to plumb it).
      //
      // Polarity note: `[]` IS swap-eligible (caller's explicit
      // lockdown intent — "no hosts trusted, every egress flagged").
      // Only `undefined` preserves construction-time. So a test
      // caller passing `trustedHosts: []` at construction AND then
      // calling `reloadPolicy(policy)` (2 args) keeps the lockdown;
      // calling `reloadPolicy(policy, undefined, [])` (3 args, empty
      // array) also keeps it. The production watcher never passes
      // `[]` — `mergeTrustedHosts` returns `DEFAULT_TRUSTED_HOSTS`
      // (non-empty) when the policy declares no trusted_hosts.
      if (newTrustedHosts !== undefined) trustedHosts = newTrustedHosts;
      return { ok: true, oldHash, newHash };
    },
  };
};
