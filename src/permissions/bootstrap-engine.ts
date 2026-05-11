// Production bootstrap for the permission engine. Walks the §2 state
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
import { type SealingScheduler, createSealingScheduler } from './sealing-scheduler.ts';
import { type SealStore, factoryForSealMode } from './sealing.ts';
import { type EngineState, type StateTransition, createStateController } from './state-machine.ts';
import type { Policy, SealPolicy } from './types.ts';

export interface BootstrapPermissionEngineInput {
  cwd: string;
  // Operator home for §11 protected-paths context + install_id
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
  // Sandbox-plan inputs (PERMISSION_ENGINE.md §6.5). When provided,
  // the engine's check() runs the §6.5 planner and refuses on
  // `no_viable_sandbox`; when omitted, the stage is skipped (legacy
  // path). The bootstrap probes `bwrap` / `sandbox-exec`
  // availability and forwards the result here; CLI's
  // `--sandbox-host` flag flows into `hostExplicitlyAllowed`.
  sandbox?: {
    available: boolean;
    hostExplicitlyAllowed: boolean;
    required: boolean;
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
  // §12.3 hot reload opt-in (slice 53). When true, the bootstrap
  // sets up `watchAndReload` on the discovered policy paths AND
  // emits `policy-reloaded` / `policy-reload-failed` audit rows on
  // every reload event. Default false — one-shot CLI verbs
  // (`agent permission verify` etc.) don't pay the inotify cost.
  // The REPL bootstrap is the primary caller; it owns the
  // returned `policyWatcher` and closes it on session end.
  watchPolicy?: boolean;
  // Test seams for the watcher's debounce + fs.watch + setTimeout
  // hooks. Forwarded verbatim to watchAndReload; production
  // callers leave undefined.
  policyWatcherDebounceMs?: number;
  policyWatcherWatcher?: (path: string, cb: () => void) => { close: () => void };
  policyWatcherSetTimer?: (cb: () => void, ms: number) => unknown;
  policyWatcherClearTimer?: (handle: unknown) => void;
  policyWatcherExists?: (path: string) => boolean;
  // §7.3 sealing wire-up (slice 57). When the resolved policy has
  // a `seal` section with `mode='worm-file'`, the bootstrap builds
  // a `SealStore` via this factory, constructs a
  // `SealingScheduler`, and wires the scheduler into the audit
  // sink so every emit ticks toward `interval_decisions`. The
  // scheduler's `onSealFailed` callback transitions the engine to
  // `degraded` or `refusing` per `seal.on_failure`. Production
  // callers leave `sealStoreFactory` undefined → default factory
  // constructs a worm-file sealer that runs `/usr/bin/chattr +a`
  // on first creation. Tests override to inject a mem-store and
  // skip the chattr call.
  sealStoreFactory?: (config: SealPolicy) => SealStore;
  sealSchedulerNow?: () => number;
  sealSchedulerSetTimer?: (cb: () => void, ms: number) => unknown;
  sealSchedulerClearTimer?: (handle: unknown) => void;
  // §18 telemetry sink (slice 70 foundation + slice 71 state
  // transitions). When set, the bootstrap wires the sink into
  // (a) the state controller's `onTransition` listener so every
  // engine state change emits a `state.transition` event, and
  // (b) the audit sink so every emit produces a
  // `permission.decision` event. Production: pass an OTEL
  // adapter (future slice). Tests: pass a recording sink.
  telemetry?: { emit: (event: TelemetryEvent) => void };
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
// Throws on the two boot-blocking failures (install_id discovery,
// malformed policy) so the CLI driver can fail the boot before any
// DB file is created. Production bootstrap calls this, then opens
// the DB, then calls `bootstrapPermissionEngine` with the cached
// result — the chain-verify phase still produces a `refusing`
// state when applicable, but install_id and policy failures stay
// hard exceptions per the v1 leak-test invariant.
export const preflightPermissionEngine = (input: PreflightInput): PreflightResult => {
  const env = input.env ?? process.env;
  const home = input.home ?? env.HOME ?? process.env.HOME ?? input.cwd;
  const identity = ensureInstallId({
    env,
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.uuid !== undefined ? { uuid: input.uuid } : {}),
  });
  const resolved = resolvePolicy({
    cwd: input.cwd,
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
  // §12.3 file watcher (slice 53). Set when `watchPolicy: true`
  // was passed to bootstrap. Caller MUST call `.close()` on session
  // end — leaking the inotify handle keeps the engine resident +
  // keeps writing audit rows on every editor save. Undefined when
  // `watchPolicy` was false / omitted.
  policyWatcher?: PolicyWatcher;
  // §7.3 sealing (slice 57). Set when the resolved policy has a
  // `seal` section with `mode='worm-file'` AND the bootstrap
  // reached a non-refusing state. Caller MUST call
  // `sealingScheduler.close()` AND `sealStore.close()` on session
  // end — the scheduler's wall-clock timer keeps the process alive
  // (per Node's libuv semantics) and the store may hold backend
  // handles in future modes. Both undefined when sealing was off,
  // mode=none, or bootstrap ended refusing.
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
  sink.emit({
    session_id: sessionId,
    tool_name: 'permission-engine',
    args: { acceptBrokenChain: true },
    decision: 'allow',
    policy_hash: policyHash,
    reason_chain: reasonChain,
  });
};

// §12.3 audit emission — spec line 743 demands "emit policy_reloaded
// event with old_hash, new_hash". Mirrors `emitChainBreakAcceptedRow`:
// tool_name='permission-engine', decision='allow' (operator
// authorized the reload by editing the file), reasonChain captures
// the hash transition. policy_hash on the row is the NEW hash —
// the reload IS the act of authorizing the new policy.
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
  sink.emit({
    session_id: sessionId,
    tool_name: 'permission-engine',
    args: { reload: true },
    decision: 'allow',
    policy_hash: newHash,
    reason_chain: reasonChain,
  });
};

// §12.3 audit emission — spec line 737 demands "emit
// policy_reload_failed event with details / keep old_policy".
// decision='deny' because the new policy WAS rejected (the old
// stays authoritative). The reason chain carries the specific
// failure surface (parse error / lock conflict / engine
// reloadPolicy ok:false) so operators see WHY in the audit log.
// policy_hash on the row is the CURRENT (old, still-authoritative)
// hash — the failed candidate has no archive entry.
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
  sink.emit({
    session_id: sessionId,
    tool_name: 'permission-engine',
    args: { reload: true },
    decision: 'deny',
    policy_hash: currentHash,
    reason_chain: reasonChain,
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

  const events: StateTransition[] = [];
  const controller = createStateController({
    initial: 'init',
    ...(input.now !== undefined ? { now: input.now } : {}),
    onTransition: (e) => {
      events.push(e);
      // §18 state.transition telemetry (slice 71). Wrapped in
      // try/catch — observability failures must not break the
      // state machine itself (a thrown emit would corrupt the
      // events trail). Same posture as the audit sink's
      // telemetry handling (slice 70).
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

  const home = input.home ?? input.env?.HOME ?? process.env.HOME ?? input.cwd;

  // Phases 1 + 2: install_id + policy load. Pre-flight (callable
  // separately by the CLI driver) lets a malformed policy throw
  // BEFORE any SQLite handle is opened, preserving the v1
  // leak-test invariant. When the caller supplied a `preflight`
  // result, we trust it and skip the work. Either way we still
  // record the explicit transitions so the events trail mirrors
  // the spec §2 walk.
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
        cwd: input.cwd,
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
  // §7.3 sealing proxy (slice 57). The sink takes a structurally-
  // typed `{ tick(): void }` from slice 56. We can't construct the
  // real `SealingScheduler` yet — it needs the engine for its
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
  });
  const chain = sink.verifyChain();

  // §18 chain.verify_failed telemetry (slice 73). Fires on EITHER
  // chain-broken path BEFORE the state transition / audit row so
  // OTEL consumers see the diagnostic context before the resulting
  // refusing-transition (state.transition event) OR chain-break-
  // accepted audit row. Wrapped in try/catch — observability cannot
  // break the chain-verify gate.
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

  // §6.5: sandbox availability + the operator's host flag flow into
  // the engine's planner. When `sandbox.required` is true AND the
  // host has no sandboxing tool, the engine never reaches `ready` —
  // we transition straight to refusing with a forensic reason. When
  // lenient, the bootstrap transitions to `degraded` instead so
  // `check()` keeps running but every would-be allow becomes confirm.
  const sandbox = input.sandbox;
  const engine = createPermissionEngine(resolveResult.policy, {
    cwd: input.cwd,
    home,
    provenance: resolveResult.provenance,
    audit: sink,
    sessionId: input.sessionId,
    stateController: controller,
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(input.telemetry !== undefined ? { telemetry: input.telemetry } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });

  if (sandbox !== undefined && !sandbox.available) {
    if (sandbox.required) {
      controller.transition('refusing', 'sandbox_required_but_unavailable');
    } else {
      controller.transition('degraded', 'sandbox_unavailable');
    }
  } else {
    controller.transition('ready', chain.ok ? 'chain_intact' : 'chain_break_accepted');
  }

  // PERMISSION_ENGINE.md §17 prerequisite: snapshot the canonical
  // policy bytes into `policy_archive` so future replay modes
  // (`--against-current-policy`, `--without-classifier`,
  // `permission diff`) can reconstruct the original policy from its
  // hash. Skip when the engine ended up `refusing` — that state never
  // produces replay-worthy decisions.
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

  // §12.3 file-watch wire-up (slice 53). Only fires when the
  // caller opted in (`watchPolicy: true`) AND the engine reached a
  // non-refusing state — refusing engines have no policy worth
  // hot-reloading. The watcher's callbacks emit audit rows per spec
  // line 743 (policy_reloaded with old/new hashes) and line 737
  // (policy_reload_failed with reason). Caller owns the returned
  // handle and MUST close() it on session end.
  let policyWatcher: PolicyWatcher | undefined;
  if (input.watchPolicy === true && archiveState !== 'refusing') {
    const resolveOptionsForWatcher: Parameters<typeof watchAndReload>[0]['resolveOptions'] = {
      cwd: input.cwd,
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

  // §7.3 sealing wire-up (slice 57). Construct the real
  // `SealStore` + `SealingScheduler` when (a) policy has a
  // `seal` section with mode='worm-file', AND (b) the engine
  // didn't end up refusing. Mode='none' (or omitted) bypasses
  // sealing entirely. The scheduler's `onSealFailed` captures
  // `engine` by closure and transitions the state machine per
  // `seal.on_failure` (degrade default, refuse strict). The
  // schedulerProxy declared in Phase 3 wires through to the
  // newly-assigned `liveScheduler` from this point onward, so the
  // sink's emit→tick path becomes live.
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
        // §18 telemetry — emit a structured sealing.failure
        // event BEFORE the state transition so an OTEL consumer
        // sees the diagnostic context (mode + path + reason)
        // paired with the subsequent state.transition event.
        // Wrapped in try/catch — observability cannot break the
        // degrade/refuse path.
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
        // Both degrade() and refuse() are idempotent for
        // already-in-state engines; refuse() supersedes degrade()
        // (state machine prevents the reverse). Repeated failures
        // re-issue the same transition — harmless but visible in
        // the events log for forensics.
        if (onFailure === 'refuse') {
          engine.refuse(`seal_failed: ${reason}`);
        } else {
          engine.degrade(`seal_failed: ${reason}`);
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
