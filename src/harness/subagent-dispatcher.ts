// Subagent dispatcher extracted from the harness loop's runAgent (N5 — reduce
// the god-object). The ~525-line `spawnSubagentImpl` closure — the single seam
// both `task` (sync) and `task_async` (async) flow through — moves here as
// `dispatchSubagent(args, signalOverride, handleId, deps)`. It covers the whole
// dispatch: unknown/depth/model-preflight refusals, the cost-cap gate, the
// capability-intersection security gate (§10.1), the cost-progress IPC watchdog
// (live-cost tracking + the fire-once cap-cross cancelAll), the runSubagent
// option assembly, child-cost reconciliation, and the result envelope. It takes
// an explicit snapshot of the ~7 run deps it used to close over (config, budget,
// the cost accountant, the run signal, sessionId, a lazy handle-store getter,
// and the run-scoped cap-watchdog latch as a mutable holder) instead of the
// shared locals. Behavior is preserved verbatim: the body is byte-for-byte the
// old closure with `capWatchdogFired` renamed to the `capWatchdog.fired` holder
// and `subagentHandleStore` bound once at the top from the lazy getter. The loop
// keeps a thin wrapper; the subagents suite is the net.
import {
  deriveParentCapabilities,
  formatCapability,
  intersectCapabilities,
  parseCapability,
} from '../permissions/capabilities.ts';
import { resolveProviderFromId } from '../providers/resolve.ts';
import { insertCostProgressEvent } from '../storage/index.ts';
import type { SubagentHandleStore } from '../subagents/handle-store.ts';
import type { PermissionDecision } from '../subagents/ipc.ts';
import { MAX_SUBAGENT_DEPTH, runSubagent } from '../subagents/runtime.ts';
import type { SpawnSubagentArgs, SpawnSubagentResult } from '../tools/types.ts';
import type { CostAccountant } from './cost-accountant.ts';
import { resolveProviderEffort } from './effort.ts';
import { safeEmit } from './emit.ts';
import type { HarnessConfig, HarnessEvent, RunBudget } from './types.ts';

export interface SubagentDispatchDeps {
  config: HarnessConfig;
  budget: RunBudget;
  acct: CostAccountant;
  // The run's combined abort signal (caller Ctrl+C + wall-clock).
  signal: AbortSignal;
  sessionId: string;
  // Lazy: the handle store is created AFTER the dispatcher is wired, so read it
  // at call time (every dispatch happens after it exists). Bound once per call.
  getHandleStore: () => SubagentHandleStore | undefined;
  // Run-scoped fire-once cap-watchdog latch, a mutable holder so the
  // in-flight-termination branch can set it across dispatches within a run.
  capWatchdog: { fired: boolean };
}

// Dispatch ONE subagent (sync `task` and async `task_async` both flow here).
// Returns a structured envelope; the calling tool maps refusal kinds
// (unknown_subagent / depth_exceeded / playbook_model_unavailable /
// budget_exhausted / subagent_escalation) onto model-recoverable tool errors.
export const dispatchSubagent = async (
  args: SpawnSubagentArgs,
  signalOverride: AbortSignal | undefined,
  handleId: string | undefined,
  deps: SubagentDispatchDeps,
): Promise<SpawnSubagentResult> => {
  const { config, budget, acct, signal, sessionId, capWatchdog } = deps;
  const subagentHandleStore = deps.getHandleStore();
  const registry = config.subagentRegistry;
  if (registry === undefined) {
    return { kind: 'unknown_subagent', requested: args.name, available: [] };
  }
  const def = registry.byName.get(args.name);
  if (def === undefined) {
    return {
      kind: 'unknown_subagent',
      requested: args.name,
      available: Array.from(registry.byName.keys()).sort(),
    };
  }
  // Depth check happens here (before runSubagent's own
  // throw) so the model gets a recoverable tool error
  // instead of a wrapped exception. The tool surface
  // distinguishes "you passed a bad name"
  // (unknown_subagent) from "you nested too deep"
  // (depth_exceeded) — both are model-fixable.
  const childDepth = (config.subagentDepth ?? 0) + 1;
  if (childDepth > MAX_SUBAGENT_DEPTH) {
    return {
      kind: 'depth_exceeded',
      requested: args.name,
      depth: childDepth,
      maxDepth: MAX_SUBAGENT_DEPTH,
    };
  }

  // Per-playbook execution model (PLAYBOOKS.md §1.1). When the
  // playbook declares `model`, run the child on a provider
  // resolved from the catalog instead of the session provider;
  // absence inherits it. Fail-soft preflight: a bad id or an
  // uninstantiable provider (e.g. missing credential) refuses the
  // spawn with a model-fixable envelope BEFORE any child process
  // starts — same posture as the unknown/depth checks above. The
  // child session records this provider's id (runSubagent →
  // createSession), so cost attribution and audit stay honest.
  let childProvider = config.provider;
  if (def.model !== undefined) {
    if (config.modelRegistry === undefined) {
      return {
        kind: 'playbook_model_unavailable',
        requested: args.name,
        model: def.model,
        reason: 'no model catalog is wired to resolve the override',
      };
    }
    const resolved = resolveProviderFromId(config.modelRegistry, def.model);
    if (!resolved.ok) {
      return {
        kind: 'playbook_model_unavailable',
        requested: args.name,
        model: def.model,
        reason:
          resolved.kind === 'unknown'
            ? `unknown model '${def.model}' is not in the catalog${resolved.knownIds.length > 0 ? ` (known: ${resolved.knownIds.join(', ')})` : ''}`
            : `provider for '${def.model}' could not be instantiated: ${resolved.message}`,
      };
    }
    childProvider = resolved.provider;
  }

  // Cost-cap gate (spec ORCHESTRATION.md §3.5).
  // Single source of truth for budget enforcement —
  // covers BOTH the sync `task` and async `task_async`
  // surfaces because both flow through this dispatcher.
  // Pessimistic projection: parent self-cost + child
  // cumulative settled + reserved in-flight (async only)
  // + this spawn's worst-case estimate from its
  // definition. Refuse with a structured envelope when
  // the cap would be crossed; the calling tool maps it
  // to `subagent.budget_exhausted`.
  //
  // The strict `>` matches `costCapDetailIfExceeded` —
  // a `maxCostUsd: 0` config refuses on the first non-
  // zero-cost spawn rather than before any work runs.
  if (budget.maxCostUsd !== undefined) {
    const estimate =
      Number.isFinite(def.budget.maxCostUsd) && def.budget.maxCostUsd > 0
        ? def.budget.maxCostUsd
        : 0;
    // Exclude THIS handle's own reservation from the
    // sum: when the store dispatches us, the record is
    // already in `records` with `estimateCostUsd =
    // estimate`. Without the exclude, the same estimate
    // counts in both `reserved` and the `+ estimate`
    // below — false rejections at cap boundaries (e.g.
    // a single async spawn whose estimate exactly
    // matches the remaining budget). Sync `task` runs
    // with `handleId === undefined`; the exclude is a
    // no-op there.
    const reserved = subagentHandleStore?.getReservedChildCostUsd(handleId) ?? 0;
    const spent = acct.cumulativeSpend(reserved);
    const projected = spent + estimate;
    if (projected > budget.maxCostUsd) {
      return {
        kind: 'budget_exhausted',
        requested: args.name,
        spent,
        estimate,
        projected,
        cap: budget.maxCostUsd,
      };
    }
  }
  // Capability intersection gate (PERMISSION_ENGINE.md §10.1).
  // When the model requested capabilities via `task`'s
  // `capabilities` arg (→ `args.declaredCapabilities`), the
  // spawn factory enforces declared ⊆ parent. Any declared
  // capability not covered by the parent set refuses the
  // spawn with `subagent_escalation`; the tool layer maps
  // it onto `subagent.escalation`.
  //
  // Slice 25 closes the §10 wiring: when the caller didn't
  // pass an explicit `parentCapabilities`, derive it from
  // the parent's active policy via
  // `deriveParentCapabilities`. The intersection now fires
  // automatically whenever the model declares capabilities,
  // matching the §10 spec wording ("subagent inherits the
  // parent's effective set"). Tests still pass an explicit
  // `parentCapabilities` when they want to pin the parent
  // set verbatim — caller-supplied takes precedence over
  // derivation.
  // Slice 95: capture the `effective` array from the
  // intersection result so we can seal it onto the child's
  // audit row (§10.1 evaluation-side gate). Pre-slice this
  // value was discarded — only `excess` mattered for the
  // refuse path. Defaults to `undefined` (no envelope,
  // root behavior) so callers that don't declare
  // capabilities preserve their legacy semantics.
  let effectiveForChild: string[] | undefined;
  if (args.declaredCapabilities !== undefined) {
    try {
      const declared = args.declaredCapabilities.map(parseCapability);
      // Slice 128 (R4 P0-Bypass-2): when the engine has a
      // narrowed envelope (i.e., it's a CHILD engine
      // spawning a grandchild), use the engine's actual
      // effective set as the parent caps for the
      // intersection. Pre-slice we derived from
      // `engine.policy()` which is the INHERITED policy
      // snapshot (parent's full set), not the child's
      // narrowed envelope — grandchild intersection then
      // succeeded against a wider set than the child
      // itself was allowed, violating §10.3 "escape
      // impossível" across depth-2.
      //
      // `engine.effectiveCapabilities()` returns null on
      // a ROOT engine (no envelope applied at
      // construction) → fall back to the legacy
      // deriveParentCapabilities path. Caller-supplied
      // `parentCapabilities` still wins (tests).
      const envelopeOverride = config.permissionEngine.effectiveCapabilities();
      const parentCaps =
        args.parentCapabilities !== undefined
          ? args.parentCapabilities.map(parseCapability)
          : envelopeOverride !== null
            ? envelopeOverride
            : deriveParentCapabilities(config.permissionEngine.policy());
      const { effective, excess } = intersectCapabilities(parentCaps, declared);
      if (excess.length > 0) {
        return {
          kind: 'subagent_escalation',
          requested: args.name,
          excess: excess.map(formatCapability),
        };
      }
      // Effective is what survived ⊆ declared, in declared
      // order. Format back to the wire form for persistence.
      // `[]` (pure-LLM) survives as `[]`, distinct from
      // `undefined` — the child engine treats the two
      // differently (see EngineOptions.effectiveCapabilities).
      effectiveForChild = effective.map(formatCapability);
    } catch (e) {
      // Malformed capability string slipped through the
      // tool-layer validation (programmer error, not a
      // model error). Refuse defensively rather than
      // silently letting the spawn proceed.
      return {
        kind: 'subagent_escalation',
        requested: args.name,
        excess: [`<parse error: ${(e as Error).message}>`],
      };
    }
  }
  // Validate child's whitelist against the ROOT registry
  // (full toolset), NOT against this harness's `toolRegistry`
  // (which is narrowed to OUR own whitelist when we're a
  // subagent). A coordinator subagent with `tools: [task]`
  // must still be able to spawn a worker with
  // `tools: [read_file]` even though it doesn't have
  // `read_file` itself.
  const rootRegistry = config.rootToolRegistry ?? config.toolRegistry;
  // Combine the run's signal with the optional per-call
  // override. Both must be live at the same time: the run
  // signal carries hard-abort + wall-clock from the parent;
  // the override is the per-handle controller `task_cancel`
  // flips. `AbortSignal.any` handles the case where the
  // override is undefined (returns the run signal directly,
  // no wrapping cost).
  const combinedSignal =
    signalOverride === undefined ? signal : AbortSignal.any([signal, signalOverride]);

  // Wrap the parent's event observer when (a) we need
  // the cost-update budget tracker (async path: we got a
  // handleId AND a store) OR (b) the operator wired
  // `config.onEvent` for observability. When NEITHER
  // applies (sync `task` from a headless test, no
  // operator TUI), we omit `onChildEvent` entirely —
  // the runtime's `effectiveIpc = input.ipc === true ||
  // input.onChildEvent !== undefined` (runtime.ts ~535)
  // would otherwise spin up an IPC channel for every
  // sync subagent solely so a dead `handleId !==
  // undefined` check could fire.
  //
  // The wrapper has two responsibilities (spec
  // ORCHESTRATION.md §3.5):
  //   (1) update the handle store's per-record live cost
  //       via `recordLiveCost` so `getReservedChildCostUsd`
  //       reflects actual spend instead of the
  //       pessimistic floor.
  //   (2) cap watchdog: when cumulative live spend
  //       crosses `maxCostUsd`, hard-signal every active
  //       handle ("subagent ativo recebe sinal de
  //       finalizar"). The pre-spawn gate above handles
  //       NEW spawn refusal; this branch handles
  //       in-flight termination.
  // Local-rebind so TS narrowing survives the closure
  // body (the outer `let` widens back to optional inside
  // a lambda).
  const trackerStore = handleId !== undefined ? subagentHandleStore : undefined;
  const trackerHandleId = handleId;
  const onChildEventForwarder: ((e: HarnessEvent) => void) | undefined =
    trackerStore !== undefined || config.onEvent !== undefined
      ? (e: HarnessEvent) => {
          if (
            trackerStore !== undefined &&
            trackerHandleId !== undefined &&
            e.type === 'subagent_progress' &&
            e.lastEvent.type === 'cost_update'
          ) {
            // R4 — defensive validation on the IPC boundary.
            // IPC.md §7 ("mensagens do filho NÃO são
            // confiáveis"): a malformed cost_update (negative
            // values, cumulative-regression, NaN) could
            // mis-steer the cap watchdog into a false trip
            // (cancelAll fires) or — worse — silently grow
            // the reservation under the cap. The handle-store's
            // monotonic guard catches REGRESSION but accepts
            // any non-negative finite value; reject upstream.
            const { delta, cumulative } = e.lastEvent;
            if (
              !Number.isFinite(delta) ||
              !Number.isFinite(cumulative) ||
              delta < 0 ||
              cumulative < 0
            ) {
              process.stderr.write(
                `subagent ${trackerHandleId}: cost_update rejected (delta=${delta}, cumulative=${cumulative})\n`,
              );
              return;
            }
            trackerStore.recordLiveCost(trackerHandleId, e.lastEvent.cumulative);
            // Persist the cost-update into the audit
            // stream (migration 022, audit fix #2). The
            // in-memory tracker drives live behavior
            // (reservation tracking, watchdog); this
            // INSERT is purely for postmortem
            // reconstruction. Best-effort: a DB throw
            // (SQLITE_BUSY under WAL contention; FK
            // violation if the parent session row was
            // dropped mid-run) MUST NOT take the harness
            // down — losing one event degrades curve
            // resolution but the live tracker already
            // observed it.
            //
            // Persist runs UNCONDITIONALLY of the
            // tracker's monotonic / cancelled guards.
            // A late `cost_update` arriving after
            // `cancelAll` lands at the parent will be
            // no-op'd by `recordLiveCost` (cancelled
            // record guard) but STILL inserted here —
            // audit truth: the child kept burning
            // tokens until its observed-abort point,
            // and forensic queries deserve to see
            // those rows. The model-side view (settled
            // `cancelled` envelope) and the table view
            // (post-cancel cumulative growth) are both
            // correct; they describe different layers.
            try {
              insertCostProgressEvent(config.db, {
                handleId: trackerHandleId,
                parentSessionId: sessionId,
                delta: e.lastEvent.delta,
                cumulative: e.lastEvent.cumulative,
              });
            } catch (persistErr) {
              const message = persistErr instanceof Error ? persistErr.message : String(persistErr);
              // R4: `console.error` violates the hard rule
              // "stdout is pure, stderr is for logs" — Bun
              // sometimes interleaves console.error with
              // stdout in --json mode despite the underlying
              // routing. Route to process.stderr explicitly
              // to keep --json's NDJSON stdout clean.
              process.stderr.write(
                `cost_progress persist failed for handle ${trackerHandleId}: ${message}\n`,
              );
            }
            if (budget.maxCostUsd !== undefined) {
              const reserved = trackerStore.getReservedChildCostUsd();
              const total = acct.cumulativeSpend(reserved);
              if (total > budget.maxCostUsd && !capWatchdog.fired) {
                // Latch the fire-once flag BEFORE the
                // cancellations run so a re-entrant
                // `cost_update` that lands while
                // cancelAll is still propagating sees
                // `capWatchdog.fired === true` and
                // skips. The latch never resets — once
                // the watchdog fires for a run, the
                // operator banner has the data they
                // need; subsequent cap-crosses (which
                // only happen because cumulative cost
                // doesn't decrease) carry no new signal.
                capWatchdog.fired = true;
                // Snapshot the dispatched count BEFORE
                // cancelAll. `inFlightCount` returns
                // every record with `status: 'running'`,
                // which includes records still queued
                // on `acquireSlot` — those have no
                // child session yet, so saying "3
                // subagents cancelled" when only 2
                // dispatched would mislead the operator.
                // Subtract `queuedCount()` to land on
                // "actually dispatched" (D236 review
                // fix). cancelAll is idempotent on
                // already-settled rows, so the firing
                // count and the actual-cancel count
                // match in practice for the dispatched
                // set.
                const cancelledCount = trackerStore.inFlightCount() - trackerStore.queuedCount();
                trackerStore.cancelAll('cap_watchdog');
                // Surface to the operator. Pre-D233 this
                // event was missing — handles just
                // disappeared from the live region and
                // the operator had to root-cause via
                // audit logs. The TUI adapter converts
                // this into a permanent banner line.
                safeEmit(config.onEvent, {
                  type: 'cap_watchdog_fired',
                  cancelledCount: Math.max(0, cancelledCount),
                  cumulativeUsd: total,
                  capUsd: budget.maxCostUsd,
                });
              }
            }
          }
          config.onEvent?.(e);
        }
      : undefined;

  // Subagents inherit the operator's reasoning-effort axis
  // (the resolved provider-effort) so `/effort` applies
  // task-wide — but NOT the operational caps, which stay
  // per-playbook (the child gets `providerEffort`, not
  // `effort`). Transitive: a child that is itself a parent
  // forwards its own resolved value on the next hop.
  const childProviderEffort = resolveProviderEffort(config);
  // Custom credential env vars for every catalog model, forwarded so the
  // child preserves them through scrubEnv (PLAYBOOKS.md §1.1). A child
  // resolving a grandchild's `model` override needs that model's
  // credential var to have survived this boundary — its own apiKeyEnv
  // isn't enough. Gated to a child that can SPAWN: only then are those
  // OTHER-model credentials reachable. The gate mirrors the subagent-
  // child spawn gate (`toolsWhitelist.includes('task')`), so a leaf
  // carries no catalog credentials it cannot use (env-credential
  // minimization — the creds never reach tools, but tighter is better).
  const childCanSpawn = def.tools.includes('task');
  const catalogApiKeyEnvVars =
    childCanSpawn && config.modelRegistry !== undefined
      ? [
          ...new Set(
            config.modelRegistry
              .list()
              .map((e) => e.apiKeyEnv)
              .filter((v): v is string => v !== undefined),
          ),
        ]
      : [];
  const child = await runSubagent({
    definition: def,
    prompt: args.prompt,
    parentSessionId: sessionId,
    provider: childProvider,
    ...(catalogApiKeyEnvVars.length > 0 ? { catalogApiKeyEnvVars } : {}),
    parentToolRegistry: rootRegistry,
    permissionEngine: config.permissionEngine,
    db: config.db,
    cwd: config.cwd,
    // Migration 058 — back-link the audit row to the approval
    // that admitted the spawning tool call.
    ...(args.parentApprovalId !== undefined ? { parentApprovalId: args.parentApprovalId } : {}),
    ...(onChildEventForwarder !== undefined ? { onChildEvent: onChildEventForwarder } : {}),
    ...(config.hooks !== undefined ? { hooksSnapshot: config.hooks } : {}),
    // §10.1 effective envelope (slice 95). When the model
    // declared capabilities, we forward the intersection
    // result so the child engine can gate every resolved
    // capability at evaluation time. `undefined` ⇒ child
    // runs without a bound (root semantics) for callers
    // that didn't declare.
    ...(effectiveForChild !== undefined ? { effectiveCapabilities: effectiveForChild } : {}),
    signal: combinedSignal,
    ...(config.softStopSignal !== undefined ? { softStopSignal: config.softStopSignal } : {}),
    subagentRegistry: registry,
    ...(config.isCwdTrusted === true ? { cwdTrusted: true } : {}),
    // S5 CRIT/H3: forward shared-scope fail-closed verdict
    // to the child. Without this, a subagent spawned after
    // the operator revoked (or after verify_failed) would
    // re-read disk and surface bodies the parent gated.
    // Array → boolean translation: the child receives a
    // single boolean via `--subagent-shared-scope-offline`
    // (cleaner IPC than serializing an array of scopes);
    // S5's only excluded scope is `project_shared` so the
    // collapse is lossless today. If a future detector
    // gates a different scope, this site widens to encode
    // the array (and the spawn-factory grows a list flag).
    ...(config.memoryExcludeScopes?.includes('project_shared') ? { sharedScopeOffline: true } : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(childProviderEffort !== undefined ? { providerEffort: childProviderEffort } : {}),
    depth: childDepth,
    // Forward the spawn factory test seam. Production
    // callers leave it unset; runSubagent falls back to
    // its default Bun.spawn-based factory.
    ...(config.spawnChildProcess !== undefined
      ? { spawnChildProcess: config.spawnChildProcess }
      : {}),
    // Permission proxy (spec docs/spec/IPC.md §7).
    // Forward only when the parent has a `confirmPermission`
    // callback wired (REPL does; one-shot / headless do
    // not). Local rebind so the narrowed type survives
    // across the async closure (the outer
    // `config.confirmPermission !== undefined` guard
    // wouldn't follow a member access through the promise
    // hop).
    ...((): {
      onPermissionAsk?: (req: {
        toolName: string;
        args: Record<string, unknown>;
        cwd: string;
        prompt: string;
        subagent: { sessionId: string; name: string };
        signal: AbortSignal;
      }) => Promise<PermissionDecision>;
    } => {
      const ask = config.confirmPermission;
      if (ask === undefined) return {};
      return {
        onPermissionAsk: async (req) => {
          const allowed = await ask({
            toolName: req.toolName,
            args: req.args,
            cwd: req.cwd,
            prompt: req.prompt,
            subagent: req.subagent,
            signal: req.signal,
          });
          return allowed ? 'allow' : 'deny';
        },
      };
    })(),
  });
  // Reconcile the child's terminal `costUsd` against the
  // live tracker captured via cost_update IPC events.
  // The runtime hardcodes `costUsd: 0` for kill paths
  // (interrupted / aborted / wall_clock / heartbeat_stale
  // — see runtime.ts ~1152/1171/1184/1203). Without the
  // max, a watchdog-killed child that had spent $2 would
  // contribute $0 to `cumulativeChildCostUsd`, defeating
  // the kill-during-run cap enforcement THIS branch
  // explicitly added. The live tracker only exists for
  // async path (handleId provided); sync `task` falls
  // through to the unmodified terminal value.
  const childCostUsd =
    handleId !== undefined && subagentHandleStore !== undefined
      ? Math.max(child.costUsd, subagentHandleStore.getLiveCostUsd(handleId))
      : child.costUsd;
  // Charge the reconciled cost against the run-wide
  // tracker. Both `task` (sync) and `task_async` reach
  // this dispatcher, so this single increment captures
  // every spawn. NaN-guarded: a misbehaving child that
  // emits a non-finite costUsd would otherwise poison
  // the cumulative counter and trip every subsequent
  // budget gate.
  acct.addChildCost(childCostUsd);
  return {
    kind: 'ran',
    output: child.output,
    sessionId: child.sessionId,
    status: child.status,
    reason: child.reason,
    // Surface the reconciled cost in the envelope so
    // task_await consumers and persisted audit rows
    // reflect the truth even when the runtime emitted 0
    // on a kill path.
    costUsd: childCostUsd,
    steps: child.steps,
    durationMs: child.durationMs,
    ...(child.auditFailure !== undefined ? { auditFailure: child.auditFailure } : {}),
    ...(child.worktree !== undefined ? { worktree: child.worktree } : {}),
    ...(child.worktreeError !== undefined ? { worktreeError: child.worktreeError } : {}),
    // Forward the child's diagnostic detail (provider
    // error text, tool-budget breakdown, etc.) so
    // task / task_await error strings can show the
    // cause instead of just the categorical reason.
    ...(child.detail !== undefined ? { detail: child.detail } : {}),
  };
};
