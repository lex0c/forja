// Production bootstrap for the permission engine. Walks the state
// machine explicitly (init → loading-policy → validating-chain →
// ready) so every phase is auditable and every failure can be
// pinpointed by the operator.
//
// Why not fold this into `createPermissionEngine`: tests build
// engines from a hand-crafted Policy and a synthetic cwd; they
// don't care about install_id discovery, DB migrations, or chain
// verification. Splitting the production wiring out lets those
// tests stay synchronous and dep-free while production bootstrap
// gets the explicit state walk + audit sink it needs.
//
// Failure modes:
//   - install_id read/write fails              → state=refusing
//   - policy load throws (validation, YAML)    → state=refusing
//   - verifyChain returns broken + no override → state=refusing
//   - verifyChain returns broken + accept flag → state=ready;
//                                                emit `chain-break-accepted`
//                                                audit row (audit-loud)
//   - all of the above clean                   → state=ready

import { realpathSync } from 'node:fs';
import type { FailureEventSink } from '../failures/index.ts';
import type { DB } from '../storage/db.ts';
import { archivePolicy } from '../storage/repos/policy-archive.ts';
import type { TelemetryEvent } from '../telemetry/index.ts';
import {
  type AuditSink,
  type ReasonChainEntry,
  type VerifyResult,
  createSqliteSink,
} from './audit.ts';
import { initBashParser } from './bash-parser.ts';
import { canonicalHash, canonicalize } from './canonical.ts';
import { type PermissionEngine, createPermissionEngine } from './engine.ts';
import {
  type Layer,
  type LayerPolicy,
  type LockConflict,
  type SectionProvenance,
  resolvePolicy,
} from './hierarchy.ts';
import { type InstallIdentity, ensureInstallId } from './install_id.ts';
import { type PolicyWatcher, watchAndReload } from './policy-watcher.ts';
import { mergeTrustedHosts } from './risk-score.ts';
import { type SealingScheduler, createSealingScheduler } from './sealing-scheduler.ts';
import { type SealStore, factoryForSealMode } from './sealing.ts';
import { type EngineState, type StateTransition, createStateController } from './state-machine.ts';
import type { ApprovalPosture, Policy, SealPolicy } from './types.ts';

export interface BootstrapPermissionEngineInput {
  cwd: string;
  // Operator home for protected-paths context + install_id
  // discovery. Defaults to `env.HOME` (or platform equivalent) via
  // `installIdPath`. Tests pin both fields.
  home?: string;
  env?: NodeJS.ProcessEnv;
  db: DB;
  sessionId: string;
  // Continue under a known-broken chain. Audit-loud: a
  // `chain-break-accepted` row lands BEFORE the engine starts
  // accepting new decisions, so retrospective audits see the
  // operator's authorization on the chain itself.
  acceptBrokenChain?: boolean;
  // Initial approval posture (Supervised / Autonomous) seeded into
  // EngineOptions.approvalPosture. CLI --autonomous flows here via
  // bootstrap. Absent ⇒ supervised (fail-closed default).
  approvalPosture?: ApprovalPosture;
  // Sandbox-plan inputs. When provided, the engine's check() runs
  // the planner and refuses on `no_viable_sandbox`; when omitted,
  // the stage is skipped. The bootstrap probes `bwrap` /
  // `sandbox-exec` availability and forwards the result here; CLI's
  // `--sandbox-host` flag flows into `hostExplicitlyAllowed`.
  sandbox?: {
    available: boolean;
    hostExplicitlyAllowed: boolean;
    required: boolean;
    // When true, the engine prunes the network profile so any net-egress call refuses
    // (self-SWE-bench runs the agent network-off so it can't fetch the gold). Default off.
    denyNetwork?: boolean;
    // Gate 2 of the `host` profile (SECURITY.md §4.1/§4.7): when true, the
    // engine injects the `host-passthrough` sentinel into the planner's
    // capability set, making `host` selectable when gate 1
    // (`hostExplicitlyAllowed`) is ALSO set. Sourced from the operator's
    // `--i-know-what-im-doing` opt-in. Default off ⇒ `host` stays pruned.
    emitHostPassthrough?: boolean;
    // Resolver's trust marker so bootstrap can emit a
    // `sandbox.path_resolved` failure_event when the sandbox tool
    // was resolved via $PATH (non-canonical install). Optional for
    // backward compat with callers that don't pass the full
    // SandboxAvailability shape.
    trustLevel?: 'canonical' | 'path-resolved' | 'absent';
    // Resolved binary path (when available). Surfaced into the
    // failure_event payload so operators see "the agent wrapped
    // with bwrap at /opt/bin/bwrap" in postmortems.
    path?: string | null;
    // Trust-check warnings (`not owned by root`, `world-writable`,
    // `using non-canonical X at Y`). Forwarded verbatim into the
    // payload so the operator's audit row carries the same strings
    // doctor renders.
    trustWarnings?: readonly string[];
  };
  // Test seams for policy discovery.
  enterprisePath?: string | null;
  userPath?: string | null;
  // Inject the policy session layer (CLI flag overrides) — flows
  // straight into resolvePolicy.
  sessionPolicy?: Policy;
  // Test seams for deterministic timestamps + UUID generation.
  now?: () => number;
  uuid?: () => string;
  // Skip the install_id + policy load phases by supplying their
  // already-validated outputs from `preflightPermissionEngine`.
  // Production CLI bootstrap runs preflight BEFORE opening the
  // SQLite DB so a bad policy fails the boot without creating the
  // DB file — same invariant the v1 leak test pinned. Without
  // preflight, bootstrap performs the two phases inline; either
  // path produces the same final state.
  preflight?: PreflightResult;
  // Hot reload opt-in. When true, the bootstrap sets up
  // `watchAndReload` on the discovered policy paths AND emits
  // `policy-reloaded` / `policy-reload-failed` audit rows on every
  // reload event. Default false — one-shot CLI verbs
  // (`forja permission verify` etc.) don't pay the inotify cost.
  // The REPL bootstrap is the primary caller; it owns the returned
  // `policyWatcher` and closes it on session end.
  watchPolicy?: boolean;
  // Test seams for the watcher's debounce + fs.watch + setTimeout
  // hooks. Forwarded verbatim to watchAndReload; production
  // callers leave undefined.
  policyWatcherDebounceMs?: number;
  policyWatcherWatcher?: (path: string, cb: () => void) => { close: () => void };
  policyWatcherSetTimer?: (cb: () => void, ms: number) => unknown;
  policyWatcherClearTimer?: (handle: unknown) => void;
  policyWatcherExists?: (path: string) => boolean;
  // Sealing wire-up. When the resolved policy has a `seal` section
  // with `mode='worm-file'`, the bootstrap builds a `SealStore` via
  // this factory, constructs a `SealingScheduler`, and wires the
  // scheduler into the audit sink so every emit ticks toward
  // `interval_decisions`. The scheduler's `onSealFailed` callback
  // transitions the engine to `degraded` or `refusing` per
  // `seal.on_failure`. Production callers leave `sealStoreFactory`
  // undefined → default factory constructs a worm-file sealer that
  // runs `/usr/bin/chattr +a` on first creation. Tests override to
  // inject a mem-store and skip the chattr call.
  sealStoreFactory?: (config: SealPolicy) => SealStore;
  sealSchedulerNow?: () => number;
  sealSchedulerSetTimer?: (cb: () => void, ms: number) => unknown;
  sealSchedulerClearTimer?: (handle: unknown) => void;
  // Telemetry sink. When set, the bootstrap wires the sink into
  // (a) the state controller's `onTransition` listener so every
  // engine state change emits a `state.transition` event, and
  // (b) the audit sink so every emit produces a
  // `permission.decision` event. Production: pass an OTEL
  // adapter. Tests: pass a recording sink.
  telemetry?: { emit: (event: TelemetryEvent) => void };
  // failure_events sink. Every classified failure (sandbox loss,
  // storage contention, provider timeout, parse error, ...) lands
  // in this tamper-evident table. Default in production: SQLite
  // sink backed by the same DB; tests pass a recording sink or
  // noop. The bootstrap uses it to emit `sandbox.tool_unavailable`
  // when sandbox tooling is missing at probe time (other failure
  // classes wire from their own subsystems).
  failureSink?: FailureEventSink;
  // Side-effect oracle for the subagent envelope gate. Forwarded
  // straight to `createPermissionEngine` (EngineOptions has the
  // doc); the CLI bootstrap builds this from the tool registry by
  // looking up `metadata.writes || metadata.exec`. Optional so
  // headless unit-test callers that build an engine without a
  // registry preserve their existing setup.
  isToolSideEffect?: (toolName: string) => boolean;
}

export interface PreflightResult {
  identity: InstallIdentity;
  resolved: ReturnType<typeof resolvePolicy>;
}

export interface PreflightInput {
  cwd: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  enterprisePath?: string | null;
  userPath?: string | null;
  sessionPolicy?: Policy;
  now?: () => number;
  uuid?: () => string;
}

// Validate install_id + policy WITHOUT opening any SQLite handle.
// `mergeTrustedHosts` moved to `risk-score.ts` (where
// `DEFAULT_TRUSTED_HOSTS` lives) so engine.ts and policy-watcher.ts
// can also import it for the hot-reload path without crossing
// layering boundaries (engine.ts is the lower-level module;
// importing from bootstrap-engine here would invert the dependency
// direction). Re-exported here for backward-compat with existing
// import sites (`cli/subagent-child.ts`, the bootstrap-engine.test
// pins for the merge invariant).
export { mergeTrustedHosts } from './risk-score.ts';

// Throws on the two boot-blocking failures (install_id discovery,
// malformed policy) so the CLI driver can fail the boot before any
// DB file is created. Production bootstrap calls this, then opens
// the DB, then calls `bootstrapPermissionEngine` with the cached
// result — the chain-verify phase still produces a `refusing`
// state when applicable, but install_id and policy failures stay
// hard exceptions per the v1 leak-test invariant.
export const preflightPermissionEngine = (input: PreflightInput): PreflightResult => {
  const env = input.env ?? process.env;
  // Canonicalize cwd + home here too (best-effort, same fallback
  // chain as `bootstrapPermissionEngine`). Without this, callers
  // that run preflight separately and pass the cached result into
  // bootstrap would have a `resolved` policy whose `projectPolicyPath`
  // discovery walked a lexical cwd while bootstrap's engine would
  // get the canonical form — the two paths could disagree on which
  // `.forja/policy.toml` file applies when cwd is symlinked.
  const cwd = (() => {
    try {
      return realpathSync(input.cwd);
    } catch {
      return input.cwd;
    }
  })();
  const homeRaw = input.home ?? env.HOME ?? process.env.HOME ?? cwd;
  const home = (() => {
    try {
      return realpathSync(homeRaw);
    } catch {
      return homeRaw;
    }
  })();
  const identity = ensureInstallId({
    env,
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.uuid !== undefined ? { uuid: input.uuid } : {}),
  });
  const resolved = resolvePolicy({
    cwd,
    home,
    env,
    ...(input.enterprisePath !== undefined ? { enterprisePath: input.enterprisePath } : {}),
    ...(input.userPath !== undefined ? { userPath: input.userPath } : {}),
    ...(input.sessionPolicy !== undefined ? { session: input.sessionPolicy } : {}),
  });
  return { identity, resolved };
};

export interface BootstrapPermissionEngineResult {
  engine: PermissionEngine;
  identity: InstallIdentity;
  sink: AuditSink;
  state: EngineState;
  events: readonly StateTransition[];
  // Forwarded from resolvePolicy so the CLI driver can render layer
  // diagnostics (`--explain-permissions`, /perms why).
  policy: Policy;
  layers: readonly LayerPolicy[];
  layerNames: readonly Layer[];
  lockConflicts: readonly LockConflict[];
  provenance: SectionProvenance;
  // Outcome of the chain integrity check; useful for `forja doctor`
  // and the CLI to render an explicit "chain ok / broken at seq N"
  // line on every boot.
  chain: VerifyResult;
  // Set when refusing — operator-facing description of what failed.
  // Empty when state is ready.
  refusingReason?: string;
  // File watcher. Set when `watchPolicy: true` was passed to
  // bootstrap. Caller MUST call `.close()` on session end —
  // leaking the inotify handle keeps the engine resident + keeps
  // writing audit rows on every editor save. Undefined when
  // `watchPolicy` was false / omitted.
  policyWatcher?: PolicyWatcher;
  // Sealing. Set when the resolved policy has a `seal` section
  // with `mode='worm-file'` AND the bootstrap reached a
  // non-refusing state. Caller MUST call `sealingScheduler.close()`
  // AND `sealStore.close()` on session end — the scheduler's
  // wall-clock timer keeps the process alive (per Node's libuv
  // semantics) and the store may hold backend handles in future
  // modes. Both undefined when sealing was off, mode=none, or
  // bootstrap ended refusing.
  sealStore?: SealStore;
  sealingScheduler?: SealingScheduler;
}

const emitChainBreakAcceptedRow = (
  sink: AuditSink,
  sessionId: string,
  policyHash: string,
  verify: Extract<VerifyResult, { ok: false }>,
): void => {
  const reasonChain: ReasonChainEntry[] = [
    {
      stage: 'chain-break-accepted',
      note: `broken_at=${verify.brokenAt} reason=${verify.reason} expected=${verify.expected} actual=${verify.actual}`,
    },
  ];
  // Admin rows like this one don't traverse the resolver / risk /
  // classifier / sandbox pipeline — their 7 load-bearing fields
  // are all "no signal". Forensic replays see an admin-internal
  // row by `tool_name='permission-engine'` and these explicit
  // empties.
  sink.emit({
    session_id: sessionId,
    tool_name: 'permission-engine',
    args: { acceptBrokenChain: true },
    decision: 'allow',
    policy_hash: policyHash,
    reason_chain: reasonChain,
    capabilities: [],
    score: 0,
    score_components: {},
    classifier_hash: 'none',
    classifier_adjust: null,
    sandbox_profile: null,
    ttl_expires_at: null,
  });
};

// Policy-reloaded audit emission. Mirrors
// `emitChainBreakAcceptedRow`: tool_name='permission-engine',
// decision='allow' (operator authorized the reload by editing the
// file), reasonChain captures the hash transition. policy_hash on
// the row is the NEW hash — the reload IS the act of authorizing
// the new policy.
const emitPolicyReloadedRow = (
  sink: AuditSink,
  sessionId: string,
  oldHash: string,
  newHash: string,
): void => {
  const reasonChain: ReasonChainEntry[] = [
    {
      stage: 'policy-reloaded',
      note: `old_hash=${oldHash} new_hash=${newHash}`,
    },
  ];
  // Admin row — no pipeline signal.
  sink.emit({
    session_id: sessionId,
    tool_name: 'permission-engine',
    args: { reload: true },
    decision: 'allow',
    policy_hash: newHash,
    reason_chain: reasonChain,
    capabilities: [],
    score: 0,
    score_components: {},
    classifier_hash: 'none',
    classifier_adjust: null,
    sandbox_profile: null,
    ttl_expires_at: null,
  });
};

// Policy-reload-failed audit emission. decision='deny' because the
// new policy WAS rejected (the old stays authoritative). The reason
// chain carries the specific failure surface (parse error / lock
// conflict / engine reloadPolicy ok:false) so operators see WHY in
// the audit log. policy_hash on the row is the CURRENT (old,
// still-authoritative) hash — the failed candidate has no archive
// entry.
const emitPolicyReloadFailedRow = (
  sink: AuditSink,
  sessionId: string,
  currentHash: string,
  reason: string,
): void => {
  const reasonChain: ReasonChainEntry[] = [
    {
      stage: 'policy-reload-failed',
      note: reason,
    },
  ];
  // Admin row — no pipeline signal.
  sink.emit({
    session_id: sessionId,
    tool_name: 'permission-engine',
    args: { reload: true },
    decision: 'deny',
    policy_hash: currentHash,
    reason_chain: reasonChain,
    capabilities: [],
    score: 0,
    score_components: {},
    classifier_hash: 'none',
    classifier_adjust: null,
    sandbox_profile: null,
    ttl_expires_at: null,
  });
};

export const bootstrapPermissionEngine = async (
  input: BootstrapPermissionEngineInput,
): Promise<BootstrapPermissionEngineResult> => {
  // Bash AST resolver requires the tree-sitter-bash grammar to be
  // loaded. Init is idempotent and cached across invocations — first
  // call is ~30ms (wasm + grammar load), subsequent calls return
  // immediately. Runs during the validating-chain phase so the
  // engine's first check() finds a warm parser.
  await initBashParser();

  // Canonicalize cwd + home up front so every downstream consumer
  // (resolvePolicy / projectPolicyPath, engine + ctx.cwd in
  // resolvers, matcher.matchPathPrepared, protected_paths classifier)
  // sees the same physical path. Pre-fix, a cwd that prefixed a
  // symlink (firmlinks on macOS, /tmp/projlink → /actual/proj,
  // managed-NFS layouts, `cd $(mktemp -d)` under tmpfs symlinks)
  // leaked the lexical form into:
  //   - matcher's `prepareTarget`: target gets realpath'd but
  //     `absCwd = resolve(cwd)` stays lexical; `relativize(lexicalCwd,
  //     canonicalTarget)` returns null → allow_paths default-denies.
  //   - bash resolver's `detectCwdScopeEscape`: lexical-inside-cwd vs
  //     canonical-outside-cwd returns true on every legitimate call
  //     → confidence='low' → confirm-on-every-tool.
  //   - engine's `resolveForProtected`: protected-path classifier
  //     compares canonical target against lexical cwd-relative
  //     escalate dirs, silently misses `.git` / `.forja` / `.claude`
  //     when cwd is symlinked.
  // Sandbox runner already canonicalizes cwd (slice 155) at the wrap
  // boundary; this closes the engine-side gap so the two layers agree
  // on the physical path.
  //
  // Best-effort: realpath failures fall back to the lexical input so
  // tests building engines against synthetic / non-existent cwds keep
  // working. Production callers always pass an existing cwd; the only
  // legitimate failure case is `cd` into a dir that was removed
  // mid-session, which produces a downstream error regardless of
  // canonicalization.
  const cwd = (() => {
    try {
      return realpathSync(input.cwd);
    } catch {
      return input.cwd;
    }
  })();

  const events: StateTransition[] = [];
  const controller = createStateController({
    initial: 'init',
    ...(input.now !== undefined ? { now: input.now } : {}),
    onTransition: (e) => {
      events.push(e);
      // state.transition telemetry. Wrapped in try/catch —
      // observability failures must not break the state machine
      // itself (a thrown emit would corrupt the events trail).
      // Same posture as the audit sink's telemetry handling.
      if (input.telemetry !== undefined) {
        try {
          input.telemetry.emit({
            kind: 'state.transition',
            ts: e.ts,
            from: e.from,
            to: e.to,
            reason: e.reason,
          });
        } catch {
          // Best-effort.
        }
      }
    },
  });

  // Same canonicalization rationale as cwd — `home` flows into the
  // protected-paths classifier (`classifyProtectedPath` resolves
  // tilde-escalate entries against `home`) and the resolver context.
  // A managed-NFS-style `/home/op → /data/users/op` would otherwise
  // leak the symlink form into resolved capability scopes for
  // `~/.ssh/id_rsa` reads, missing the matcher's prefix check against
  // the canonical path. Defaults to cwd (already canonical above)
  // when no home is supplied — preserves the prior fallback chain
  // shape while keeping canonical semantics.
  const homeRaw = input.home ?? input.env?.HOME ?? process.env.HOME ?? cwd;
  const home = (() => {
    try {
      return realpathSync(homeRaw);
    } catch {
      return homeRaw;
    }
  })();

  // Phases 1 + 2: install_id + policy load. Pre-flight (callable
  // separately by the CLI driver) lets a malformed policy throw
  // BEFORE any SQLite handle is opened, preserving the leak-test
  // invariant. When the caller supplied a `preflight` result, we
  // trust it and skip the work. Either way we still record the
  // explicit transitions so the events trail mirrors the state-
  // machine walk.
  controller.transition('loading-policy', 'bootstrap_start');
  let identity: InstallIdentity;
  let resolveResult: ReturnType<typeof resolvePolicy>;
  if (input.preflight !== undefined) {
    identity = input.preflight.identity;
    resolveResult = input.preflight.resolved;
  } else {
    try {
      identity = ensureInstallId({
        env: input.env ?? process.env,
        ...(input.now !== undefined ? { now: input.now } : {}),
        ...(input.uuid !== undefined ? { uuid: input.uuid } : {}),
      });
    } catch (e) {
      const reason = `install_id_failed: ${(e as Error).message}`;
      controller.transition('refusing', reason);
      return buildRefusingResult({ controller, events, reason, db: input.db });
    }
    try {
      resolveResult = resolvePolicy({
        cwd,
        home,
        env: input.env ?? process.env,
        ...(input.enterprisePath !== undefined ? { enterprisePath: input.enterprisePath } : {}),
        ...(input.userPath !== undefined ? { userPath: input.userPath } : {}),
        ...(input.sessionPolicy !== undefined ? { session: input.sessionPolicy } : {}),
      });
    } catch (e) {
      const reason = `policy_load_failed: ${(e as Error).message}`;
      controller.transition('refusing', reason);
      return buildRefusingResult({ controller, events, reason, db: input.db, identity });
    }
  }

  // Phase 3: validate the audit chain. The sink we build here is the
  // same one the engine will emit through, so a single SQLite handle
  // backs the entire lifetime.
  //
  // Sealing proxy. The sink takes a structurally-typed
  // `{ tick(): void }`. We can't construct the real
  // `SealingScheduler` yet — it needs the engine for its
  // `onSealFailed` callback, and the engine doesn't exist until
  // Phase 4. The proxy defers to a mutable `liveScheduler` slot;
  // any emit during Phase 3 (`chain-break-accepted`) hits a no-op
  // tick, and the slot fills in later when sealing is wired.
  controller.transition('validating-chain', 'policy_loaded');
  let liveScheduler: SealingScheduler | undefined;
  const schedulerProxy = {
    tick: (): void => {
      liveScheduler?.tick();
    },
  };
  const sink = createSqliteSink({
    db: input.db,
    identity,
    scheduler: schedulerProxy,
    ...(input.telemetry !== undefined ? { telemetry: input.telemetry } : {}),
    // engine_state bridge. Telemetry events for
    // permission.decision carry the current state alongside the
    // decision so an OTEL consumer can correlate decision outcomes
    // with engine health (e.g., "every confirm-allowed happened
    // while degraded — operator should fix the underlying
    // subsystem"). Plumbing the getter (not the value) here means
    // the event captures state AT EMIT TIME — accurate even if the
    // state changed between bootstrap and the individual check
    // (which happens via engine.degrade / engine.refuse fired from
    // anywhere with a controller ref).
    engineState: () => controller.get(),
  });
  const chain = sink.verifyChain();

  // chain.verify_failed telemetry. Fires on EITHER chain-broken
  // path BEFORE the state transition / audit row so OTEL consumers
  // see the diagnostic context before the resulting refusing-
  // transition (state.transition event) OR chain-break-accepted
  // audit row. Wrapped in try/catch — observability cannot break
  // the chain-verify gate.
  if (!chain.ok && input.telemetry !== undefined) {
    try {
      input.telemetry.emit({
        kind: 'chain.verify_failed',
        ts: input.now?.() ?? Date.now(),
        install_id: identity.install_id,
        broken_at: chain.brokenAt,
        reason: chain.reason,
        expected: chain.expected,
        actual: chain.actual,
        accepted: input.acceptBrokenChain === true,
      });
    } catch {
      // Best-effort.
    }
  }

  if (!chain.ok && input.acceptBrokenChain !== true) {
    const reason = `chain_broken: seq=${chain.brokenAt} reason=${chain.reason}`;
    controller.transition('refusing', reason);
    return buildRefusingResult({
      controller,
      events,
      reason,
      db: input.db,
      identity,
      sink,
      chain,
      resolved: resolveResult,
    });
  }

  // Phase 4: ready (or ready + audit-loud chain-break acknowledgement).
  // The engine is constructed with the controller already in
  // validating-chain — the final transition lands AFTER the
  // chain-break audit row so the row's prev_hash anchors on the
  // last broken-but-accepted hash, not on a phantom mid-bootstrap
  // state.
  if (!chain.ok && input.acceptBrokenChain === true) {
    // Compute a policy_hash matching what the engine will use, so
    // the audit row's policy_hash field is stable. The engine
    // computes the same value internally via `canonicalHash(policy)`.
    const policyHash = `sha256:${canonicalHash(resolveResult.policy)}`;
    emitChainBreakAcceptedRow(sink, input.sessionId, policyHash, chain);
  }

  // Sandbox availability + the operator's host flag flow into the
  // engine's planner. When `sandbox.required` is true AND the host
  // has no sandboxing tool, the engine never reaches `ready` — we
  // transition straight to refusing with a forensic reason. When
  // lenient, the bootstrap transitions to `degraded` instead so
  // `check()` keeps running but every would-be allow becomes confirm.
  const sandbox = input.sandbox;
  // Operator-augmented trusted-hosts list. Additive over
  // DEFAULT_TRUSTED_HOSTS (`risk-score.ts`) — policy entries do
  // NOT replace the hardcoded public-registry set; they extend it
  // with per-project internal hosts (CDN, GitHub Enterprise, etc.).
  // Empty/absent leaves the engine at the default. See
  // `mergeTrustedHosts` for the dedup-set-union shape (exported
  // so tests can pin the structural invariant directly — a
  // behavioral test alone can't distinguish "extra duplicates
  // were silently accepted" from "list is correct").
  const trustedHosts = mergeTrustedHosts(resolveResult.policy.tools.fetch_url?.trusted_hosts ?? []);
  const engine = createPermissionEngine(resolveResult.policy, {
    cwd,
    home,
    provenance: resolveResult.provenance,
    audit: sink,
    sessionId: input.sessionId,
    stateController: controller,
    trustedHosts,
    ...(input.approvalPosture !== undefined ? { approvalPosture: input.approvalPosture } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(input.telemetry !== undefined ? { telemetry: input.telemetry } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.isToolSideEffect !== undefined ? { isToolSideEffect: input.isToolSideEffect } : {}),
  });

  // Emit `sandbox.path_resolved` when the resolver flagged the
  // install as non-canonical. Fires BEFORE the unavailable check
  // below — non-canonical-but-present is a SEPARATE concern from
  // absent. Postmortem trail: operators who later see "compromise
  // traced to sandbox bypass" can query `failure_events WHERE
  // code='sandbox.path_resolved'` and correlate against the install
  // path on the affected host.
  if (
    sandbox?.available &&
    sandbox.trustLevel !== undefined &&
    sandbox.trustLevel !== 'canonical' &&
    input.failureSink !== undefined
  ) {
    try {
      input.failureSink.emit({
        code: 'sandbox.path_resolved',
        classe: 'sandbox',
        recovery_action: 'degraded',
        user_visible: true,
        session_id: input.sessionId,
        payload: {
          platform: process.platform,
          trust_level: sandbox.trustLevel,
          path: sandbox.path ?? null,
          warnings: sandbox.trustWarnings ?? [],
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(
        `forja bootstrap: sandbox.path_resolved emit failed (${msg}); trust warnings still in availability\n`,
      );
    }
  }

  // The operator's explicit two-gate opt-in to run UNSANDBOXED (`--sandbox-host` AND the
  // `--i-know-what-im-doing` host-passthrough sentinel) is an INTENTIONAL choice, not a degradation.
  // A container/CI that already provides isolation has no bwrap; the operator accepts that and asks
  // for the `host` passthrough profile. Without this carve-out the boot transition below fires
  // `degraded` (every would-be allow → confirm) BEFORE the §6.5 per-call planner ever runs, so the
  // host profile the planner would pick is moot and a headless agent dead-ends on un-answerable
  // confirms. In lenient mode the opt-in stays `ready` and lets the planner select `host` (audited
  // as sandbox_profile=host). A policy that REQUIRES a sandbox still wins — the operator flag below
  // cannot override `sandbox.required` (that path falls through to `refusing`).
  const hostPassthroughOptIn =
    sandbox !== undefined &&
    sandbox.required === false &&
    sandbox.hostExplicitlyAllowed === true &&
    sandbox.emitHostPassthrough === true;

  if (sandbox !== undefined && !sandbox.available && !hostPassthroughOptIn) {
    // Structured failure_event so ops queries can answer "which
    // sessions booted without sandbox tooling?" without parsing
    // stderr. recovery_action reflects the state-machine branch
    // we're about to take: fatal when policy required sandbox
    // (engine goes refusing), degraded otherwise (engine still
    // answers checks but every would-be allow becomes confirm).
    if (input.failureSink !== undefined) {
      try {
        input.failureSink.emit({
          code: 'sandbox.tool_unavailable',
          classe: 'sandbox',
          recovery_action: sandbox.required ? 'fatal' : 'degraded',
          user_visible: true,
          session_id: input.sessionId,
          payload: {
            platform: process.platform,
            policy_required: sandbox.required,
            host_explicitly_allowed: sandbox.hostExplicitlyAllowed,
          },
        });
      } catch (e) {
        // failure_events emit must NOT crash bootstrap (the row
        // is observability of the unavailable-sandbox event, not
        // the event itself). DO surface the sink failure to
        // stderr so an infra-level break (missing migration, disk
        // full, locked DB) doesn't silently suppress audit — an
        // empty catch would let `DROP TABLE failure_events` +
        // every future emit return success with no signal to the
        // operator.
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(
          `forja bootstrap: failure_events emit failed (${msg}); transition still firing\n`,
        );
      }
    }
    if (sandbox.required) {
      controller.transition('refusing', 'sandbox_required_but_unavailable');
    } else {
      controller.transition('degraded', 'sandbox_unavailable');
    }
  } else {
    controller.transition('ready', chain.ok ? 'chain_intact' : 'chain_break_accepted');
  }

  // Snapshot the canonical policy bytes into `policy_archive` so
  // future replay modes (`--against-current-policy`,
  // `--without-classifier`, `permission diff`) can reconstruct the
  // original policy from its hash. Skip when the engine ended up
  // `refusing` — that state never produces replay-worthy decisions.
  //
  // Uses the SAME bytes the engine hashed (`canonicalize(policy)`)
  // so the roundtrip invariant
  // `canonicalHash(JSON.parse(canonical_json)) === policy_hash`
  // holds for every archived row.
  const archiveState = controller.get();
  if (archiveState !== 'refusing') {
    const now = input.now?.() ?? Date.now();
    archivePolicy(input.db, {
      policy_hash: `sha256:${canonicalHash(resolveResult.policy)}`,
      canonical_json: canonicalize(resolveResult.policy),
      now,
    });
  }

  // File-watch wire-up. Only fires when the caller opted in
  // (`watchPolicy: true`) AND the engine reached a non-refusing
  // state — refusing engines have no policy worth hot-reloading.
  // The watcher's callbacks emit audit rows for policy_reloaded
  // (old/new hashes) and policy_reload_failed (reason). Caller
  // owns the returned handle and MUST close() it on session end.
  let policyWatcher: PolicyWatcher | undefined;
  if (input.watchPolicy === true && archiveState !== 'refusing') {
    const resolveOptionsForWatcher: Parameters<typeof watchAndReload>[0]['resolveOptions'] = {
      cwd,
      home,
      env: input.env ?? process.env,
      ...(input.enterprisePath !== undefined ? { enterprisePath: input.enterprisePath } : {}),
      ...(input.userPath !== undefined ? { userPath: input.userPath } : {}),
      ...(input.sessionPolicy !== undefined ? { session: input.sessionPolicy } : {}),
    };
    policyWatcher = watchAndReload({
      engine,
      resolveOptions: resolveOptionsForWatcher,
      onReload: (result) => {
        // Archive the post-reload policy bytes BEFORE emitting the
        // audit row. Without this, post-reload `policy-reloaded`
        // audit rows have no matching entry in `policy_archive`,
        // and `forja permission replay <seq>
        // --against-archived-policy` later reports `skipped_reason:
        // 'policy hash <H> not in policy_archive'` for every
        // post-reload row.
        //
        // Re-canonicalize via engine.policy() (deep-clone return
        // from the engine API). Hash matches result.newHash by
        // construction (engine swapped both atomically); the
        // canonical_json bytes are the source of truth the engine
        // used for the new hash.
        const archiveNow = input.now?.() ?? Date.now();
        try {
          archivePolicy(input.db, {
            policy_hash: result.newHash,
            canonical_json: canonicalize(engine.policy()),
            now: archiveNow,
          });
        } catch {
          // Best-effort. Archive failures shouldn't suppress the
          // policy-reloaded audit row — the operator should still
          // see the reload event even if archive storage is broken.
          // TODO: emit a failure_event here.
        }
        emitPolicyReloadedRow(sink, input.sessionId, result.oldHash, result.newHash);
      },
      onReloadFailed: (reason) => {
        // Use the engine's CURRENT policy hash (post-reload-attempt,
        // which equals pre-attempt on failure since the engine
        // didn't swap). policy() returns a deep clone — recompute
        // hash is cheap and matches what the engine itself stamps.
        const currentHash = `sha256:${canonicalHash(engine.policy())}`;
        emitPolicyReloadFailedRow(sink, input.sessionId, currentHash, reason);
      },
      ...(input.policyWatcherDebounceMs !== undefined
        ? { debounceMs: input.policyWatcherDebounceMs }
        : {}),
      ...(input.policyWatcherWatcher !== undefined ? { watcher: input.policyWatcherWatcher } : {}),
      ...(input.policyWatcherSetTimer !== undefined
        ? { setTimer: input.policyWatcherSetTimer }
        : {}),
      ...(input.policyWatcherClearTimer !== undefined
        ? { clearTimer: input.policyWatcherClearTimer }
        : {}),
      ...(input.policyWatcherExists !== undefined ? { exists: input.policyWatcherExists } : {}),
    });
  }

  // Sealing wire-up. Construct the real `SealStore` +
  // `SealingScheduler` when (a) policy has a `seal` section with
  // mode='worm-file', AND (b) the engine didn't end up refusing.
  // Mode='none' (or omitted) bypasses sealing entirely. The
  // scheduler's `onSealFailed` captures `engine` by closure and
  // transitions the state machine per `seal.on_failure` (degrade
  // default, refuse strict). The schedulerProxy declared in
  // Phase 3 wires through to the newly-assigned `liveScheduler`
  // from this point onward, so the sink's emit→tick path becomes
  // live.
  let sealStore: SealStore | undefined;
  let sealingScheduler: SealingScheduler | undefined;
  const sealConfig = resolveResult.policy.seal;
  if (sealConfig !== undefined && sealConfig.mode !== 'none' && archiveState !== 'refusing') {
    const factory = input.sealStoreFactory ?? factoryForSealMode(sealConfig.mode);
    if (factory === null) {
      // Unreachable in well-formed input — parsePolicy rejects
      // unknown modes. Defensive guard for a future schema that
      // accepts a mode before this branch knows about it.
      throw new Error(
        `bootstrapPermissionEngine: no factory wired for seal.mode='${sealConfig.mode}'`,
      );
    }
    sealStore = factory(sealConfig);
    const onFailure: SealOnFailureLocal = sealConfig.on_failure ?? 'degrade';
    sealingScheduler = createSealingScheduler({
      store: sealStore,
      db: input.db,
      installId: identity.install_id,
      ...(sealConfig.interval_decisions !== undefined
        ? { intervalDecisions: sealConfig.interval_decisions }
        : {}),
      ...(sealConfig.interval_seconds !== undefined
        ? { intervalSeconds: sealConfig.interval_seconds }
        : {}),
      onSealFailed: (reason: string): void => {
        // Emit a structured sealing.failure telemetry event BEFORE
        // the state transition so an OTEL consumer sees the
        // diagnostic context (mode + path + reason) paired with
        // the subsequent state.transition event. Wrapped in
        // try/catch — observability cannot break the degrade/refuse
        // path.
        if (input.telemetry !== undefined) {
          try {
            input.telemetry.emit({
              kind: 'sealing.failure',
              ts: input.now?.() ?? Date.now(),
              mode: sealConfig.mode,
              ...(sealConfig.path !== undefined ? { path: sealConfig.path } : {}),
              reason,
              on_failure: onFailure,
            });
          } catch {
            // Best-effort.
          }
        }
        // Gate the state transition on the CURRENT state.
        // `degraded → degraded` is NOT in VALID_TRANSITIONS, and
        // `refusing` is terminal. Without this gate the 2nd
        // consecutive seal failure (timer path: an hour after the
        // first; tick path: another 100 audit emits after the
        // first) throws from `engine.degrade`. The throw from the
        // tick path is swallowed by audit.ts's try-around-
        // scheduler.tick(); the throw from the timer path
        // propagates as uncaughtException → signal handler →
        // process.exit(1). A sustained worm-file outage (disk
        // full, chattr +a dropped, EROFS) would kill the REPL
        // mid-tool.
        //
        // Read the current state and only attempt a transition
        // when the edge is allowed. When already in the target
        // state, this is a no-op; telemetry already fired above so
        // operators still see every failure event.
        const currentState = engine.state();
        if (onFailure === 'refuse') {
          // refusing is terminal — skip if already there. Other
          // states (init/loading-policy/validating-chain/ready/
          // degraded) can all transition to refusing.
          if (currentState !== 'refusing') {
            engine.refuse(`seal_failed: ${reason}`);
          }
        } else {
          // degraded is reachable only from `ready` and
          // `validating-chain`. If we're already degraded OR
          // refusing OR in a pre-ready phase that doesn't allow
          // this edge, skip silently — the telemetry event above
          // is the operator-visible record.
          if (currentState === 'ready') {
            engine.degrade(`seal_failed: ${reason}`);
          }
        }
      },
      ...(input.sealSchedulerNow !== undefined ? { now: input.sealSchedulerNow } : {}),
      ...(input.sealSchedulerSetTimer !== undefined
        ? { setTimer: input.sealSchedulerSetTimer }
        : {}),
      ...(input.sealSchedulerClearTimer !== undefined
        ? { clearTimer: input.sealSchedulerClearTimer }
        : {}),
    });
    liveScheduler = sealingScheduler;
  }

  return {
    engine,
    identity,
    sink,
    state: controller.get(),
    events,
    policy: resolveResult.policy,
    layers: resolveResult.layers,
    layerNames: resolveResult.layers.map((l) => l.layer),
    lockConflicts: resolveResult.lockConflicts,
    provenance: resolveResult.provenance,
    chain,
    ...(sandbox !== undefined && !sandbox.available && sandbox.required
      ? { refusingReason: 'sandbox_required_but_unavailable' }
      : {}),
    ...(policyWatcher !== undefined ? { policyWatcher } : {}),
    ...(sealStore !== undefined ? { sealStore } : {}),
    ...(sealingScheduler !== undefined ? { sealingScheduler } : {}),
  };
};

// Local type alias — avoids importing SealOnFailure when the
// schema's union is already pinned by the policy parser. The
// import would be purely cosmetic given the parsed `seal.on_failure`
// is already typed.
type SealOnFailureLocal = 'degrade' | 'refuse';

// Build a placeholder result for any refusing transition. The engine
// here is a stub that denies every check — caller MUST inspect
// `state` before using it. We still return a valid object so the CLI
// driver can render diagnostics + the policy layer trail (if loaded).
const buildRefusingResult = (params: {
  controller: ReturnType<typeof createStateController>;
  events: readonly StateTransition[];
  reason: string;
  db: DB;
  identity?: InstallIdentity;
  sink?: AuditSink;
  chain?: VerifyResult;
  resolved?: ReturnType<typeof resolvePolicy>;
}): BootstrapPermissionEngineResult => {
  // Synthesize a placeholder identity when install_id failed —
  // downstream consumers should never reach decision code in
  // refusing state, but they may still want to render a "no
  // identity" message.
  const identity: InstallIdentity = params.identity ?? {
    install_id: 'unknown',
    created_at_ms: 0,
  };
  const sink = params.sink ?? createSqliteSink({ db: params.db, identity });
  const policy: Policy = params.resolved?.policy ?? {
    defaults: { mode: 'strict' },
    tools: {},
  };
  // Build a refusing engine. We hand it a fresh controller pinned
  // to refusing so every check returns deny, but mirror the audit
  // wiring of the live path so the caller's audit pipeline keeps
  // working.
  const refusingController = createStateController({ initial: 'refusing' });
  const engine = createPermissionEngine(policy, {
    cwd: '.',
    audit: sink,
    sessionId: 'refusing',
    stateController: refusingController,
  });
  return {
    engine,
    identity,
    sink,
    state: 'refusing',
    events: params.events,
    policy,
    layers: params.resolved?.layers ?? [],
    layerNames: (params.resolved?.layers ?? []).map((l) => l.layer),
    lockConflicts: params.resolved?.lockConflicts ?? [],
    provenance: params.resolved?.provenance ?? { defaults: 'default' },
    chain: params.chain ?? { ok: true, rows: 0, current_rotation_id: 0, quarantined: false },
    refusingReason: params.reason,
  };
};
