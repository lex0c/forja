import { createHash } from 'node:crypto';
import { type BgManager, createBgManager } from '../bg/index.ts';
import {
  type CheckpointManager,
  createCheckpointManager,
  detectCheckpointSupport,
} from '../checkpoints/index.ts';
import { type HookChainResult, type HookEventPayload, dispatchChain } from '../hooks/index.ts';
import { addUsage, computeCost, emptyUsage } from '../providers/cost.ts';
import type {
  GenerateRequest,
  ProviderContentBlock,
  ProviderMessage,
  ProviderToolDef,
  ProviderToolResultBlock,
  ProviderToolUseBlock,
} from '../providers/index.ts';
import { estimatePromptTokens } from '../providers/tokens.ts';
import {
  appendMessage,
  completeSession,
  createSession,
  getSession,
  insertCostProgressEvent,
  insertSubagentGateDecision,
  listMessageTailBySession,
  reopenSession,
} from '../storage/index.ts';
import { type SubagentHandleStore, createSubagentHandleStore } from '../subagents/handle-store.ts';
import type { PermissionDecision } from '../subagents/ipc.ts';
import { MAX_SUBAGENT_DEPTH, runSubagent } from '../subagents/runtime.ts';
import { type TodoStore, createTodoStore } from '../todo/index.ts';
import type { ToolContext } from '../tools/index.ts';
import type { SpawnSubagentArgs, SpawnSubagentResult } from '../tools/types.ts';
import { StepStallError, abortableIterable, stallWatchdog } from './abortable.ts';
import { CollectStepError, type CollectedToolUse, collectStep } from './collect.ts';
import { compactMessages } from './compaction.ts';
import { invokeTool } from './invoke-tool.ts';
import {
  ALIGNMENT_FETCH_MARGIN,
  MAX_RESUME_MESSAGES,
  STRANDED_TURN_PLACEHOLDER,
  messagesToProviderMessages,
} from './resume.ts';
import { DEFAULT_RETRY, generateWithRetry } from './retry.ts';
import {
  type ExitReason,
  type HarnessConfig,
  type HarnessEvent,
  type HarnessResult,
  MAX_CONCURRENT_SUBAGENTS_CAP,
  MAX_CONCURRENT_TOOL_CALLS_CAP,
  type RunBudget,
  effectiveBudget,
  resolveMaxOutputTokens,
} from './types.ts';

type TerminalSessionStatus = 'done' | 'interrupted' | 'exhausted' | 'error';

const safeEmit = (onEvent: HarnessConfig['onEvent'], event: HarnessEvent): void => {
  if (onEvent === undefined) return;
  try {
    onEvent(event);
  } catch {
    // Renderers throwing must not derail the loop.
  }
};

const stableStringify = (obj: unknown): string => {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((obj as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(',')}}`;
};

const hashToolCall = (name: string, args: Record<string, unknown>): string =>
  createHash('sha256')
    .update(`${name}:${stableStringify(args)}`)
    .digest('hex');

// Bounded-concurrency runner used by the parallel-tool path. Spawns
// `cap` workers that pull the next free index off a shared cursor;
// each worker awaits its assigned `worker(item)` before grabbing the
// next index. Result array is populated in original index order, so
// callers can preserve the model's tool_use ordering even though
// completion order is whichever finishes first.
//
// Errors thrown by `worker` propagate via the wrapping `Promise.all`
// — invoke-tool already converts tool failures into ToolResult error
// shapes, so the only realistic throw path here is a programming bug
// in the harness itself; we want it to surface, not be swallowed.
const runPool = async <I, T>(
  items: readonly I[],
  cap: number,
  worker: (item: I) => Promise<T>,
): Promise<T[]> => {
  const results = new Array<T>(items.length);
  const concurrency = Math.max(1, Math.min(cap, items.length));
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;
      // Bounds-checked: `i < items.length` was just verified above.
      // The `as I` keeps TS happy under noUncheckedIndexedAccess
      // without paying a runtime guard for the impossible case.
      const item = items[i] as I;
      results[i] = await worker(item);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  return results;
};

const exitToStatus: Record<ExitReason, TerminalSessionStatus> = {
  done: 'done',
  maxSteps: 'exhausted',
  maxWallClockMs: 'interrupted',
  maxOutputTokens: 'exhausted',
  maxCostUsd: 'exhausted',
  maxToolErrors: 'error',
  degenerateLoop: 'error',
  // Step-stalled is closer to an error than an interrupt — the
  // provider opened a stream and went silent, which is a runtime
  // failure (provider hang, network drop mid-stream, parser
  // stuck). Resume can retry; same handling as providerError.
  stepStalled: 'error',
  aborted: 'interrupted',
  providerError: 'error',
  internalError: 'error',
  scriptExhausted: 'error',
  // Hook-blocked prompts terminate the turn at session boot. The
  // operator's hook decision is closer to a soft cancel than to
  // an error — interrupted matches the existing 'aborted' shape
  // (operator-initiated termination).
  userPromptBlocked: 'interrupted',
};

const exitToHarnessStatus: Record<ExitReason, HarnessResult['status']> = {
  done: 'done',
  maxSteps: 'exhausted',
  maxWallClockMs: 'interrupted',
  maxOutputTokens: 'exhausted',
  maxCostUsd: 'exhausted',
  maxToolErrors: 'error',
  degenerateLoop: 'error',
  stepStalled: 'error',
  aborted: 'interrupted',
  providerError: 'error',
  internalError: 'error',
  scriptExhausted: 'error',
  userPromptBlocked: 'interrupted',
};

const buildToolDefs = (config: HarnessConfig): ProviderToolDef[] =>
  config.toolRegistry.list().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

// Strip `name` from the tool model so it stays inside our domain — providers
// expect their own format already constructed by the adapter.

export const runAgent = async (config: HarnessConfig): Promise<HarnessResult> => {
  const budget: RunBudget = effectiveBudget(config.budget);
  const startMs = Date.now();

  // Combine the caller's abort signal with a wall-clock timer so the cap
  // fires even when a provider call hangs mid-step (between-step checks
  // miss this case). AbortSignal.any composes them; either firing aborts
  // downstream provider/tool work via the canonical signal.
  const wallClockController = new AbortController();
  const wallClockTimer = setTimeout(() => wallClockController.abort(), budget.maxWallClockMs);
  const callerSignal = config.signal ?? new AbortController().signal;
  const signal = AbortSignal.any([callerSignal, wallClockController.signal]);

  const messages: ProviderMessage[] = [];
  const tools = buildToolDefs(config);
  const recentToolHashes: string[] = [];
  const HASH_WINDOW = 5;

  let steps = 0;
  let consecutiveErrors = 0;
  let sessionId = '';
  let lastMessageId = '';
  // Session-scoped bg manager. Created lazily after createSession
  // so the manager can record the right session_id on every spawn.
  // Stays undefined when no bgLogDir is configured — bg tools will
  // surface `bg.manager_unavailable` if invoked. Captured via
  // closure so the outer-finally cleanup hook can find it whether
  // we exited normally or through guardedFinish.
  let bgManager: BgManager | undefined;
  // Run-scoped subagent handle store (spec ORCHESTRATION.md §3,
  // task_async family). Created after sessionId resolves —
  // identical lifecycle window as bgManager. Drained in the outer
  // finally so a hard parent abort still tears every running
  // spawn down before SQLite closes. Stays undefined when no
  // subagent registry is wired (mirrors `task` tool's behavior).
  let subagentHandleStore: SubagentHandleStore | undefined;
  // Run-scoped subagent spawn implementation. Captures the run's
  // sessionId, signal, depth, and config; accepts an optional
  // per-call signal override that the handle store wires per
  // handle so `task_cancel` can preempt one child without
  // disturbing siblings. The legacy synchronous `task` tool uses
  // it WITHOUT an override (defaults to the run signal), so both
  // task surfaces share the same dispatcher.
  let spawnSubagentImpl:
    | ((
        args: SpawnSubagentArgs,
        signalOverride?: AbortSignal,
        handleId?: string,
      ) => Promise<SpawnSubagentResult>)
    | undefined;
  // Per-session CheckpointManager. Lifecycle parallels bgManager:
  // created after sessionId is resolved (the manager carries it),
  // used inline before tool execution, and otherwise just lives on
  // the stack. No teardown — checkpoint refs are durable artifacts
  // intentionally; the lazy-purge sweep at startup of the NEXT run
  // is what reclaims them.
  let checkpointManager: CheckpointManager | undefined;
  // Tracks the in-flight retention sweep (if any). Captured in the
  // outer scope so the outer finally can await it before the caller
  // closes the DB. Without the await, the purge would race against
  // db.close() in cli/run.ts and hit a closed sqlite handle.
  let checkpointsPurgeInFlight: Promise<unknown> | undefined;
  // Per-session TodoList store. Created once per session here so the
  // todo_write tool sees a fresh list, and torn down in the outer
  // finally so accumulated state from a long-lived process doesn't
  // leak across sessions. Spec §7.4: not persisted, work-state only.
  //
  // The bare store is a pure data structure; observability is layered
  // on at the harness boundary by wrapping `set` to emit a
  // `todo_updated` HarnessEvent after the write lands. Wrapping rather
  // than mutating the store keeps test contexts that build a store
  // directly free of the emit dependency. `clear` is NOT wrapped —
  // session-end cleanup is not a planning event (D132).
  const baseTodoStore = createTodoStore();
  // Wrap each method through a fresh closure rather than aliasing the
  // method reference. Today `createTodoStore` returns plain arrows
  // bound by closure (no `this`), so direct aliasing would work — but
  // a future refactor to a class with `this`-bound methods would
  // silently break get/clear at runtime without TS catching it. The
  // extra layer costs nothing and keeps the contract explicit.
  const todoStore: TodoStore = {
    get: (sid) => baseTodoStore.get(sid),
    set: (sid, items) => {
      baseTodoStore.set(sid, items);
      // Read back through the store so the event carries the same
      // deep-cloned snapshot a fresh `get` would return — observers
      // can't poison stored state, and the items they see are
      // structurally identical to what the next call to get() yields.
      safeEmit(config.onEvent, {
        type: 'todo_updated',
        sessionId: sid,
        items: baseTodoStore.get(sid),
      });
    },
    clear: (sid) => baseTodoStore.clear(sid),
  };
  // Per-run totals. Each completed provider turn adds its usage and
  // its computed cost; HarnessResult.usage / costUsd report THIS
  // RUN's numbers — caller telemetry that has to stay self-
  // consistent (zero usage means zero cost, etc.).
  let totalUsage = emptyUsage();
  let totalCostUsd = 0;
  // Stays true until an assistant turn produces output without an
  // accompanying usage event. The aggregate `usage`/`costUsd` only
  // sums measured turns; this flag tells the caller whether those
  // numbers are complete or a lower-bound estimate.
  let usageComplete = true;
  // Cumulative state from prior runs of the same session id (zero
  // for new sessions). Held SEPARATELY from the per-run totals so
  // HarnessResult stays per-run while the persisted column stays
  // cumulative — fixing the contract mismatch where seeding
  // totalCostUsd from the existing row made costUsd report
  // "current run + prior" while usage was still "current only".
  // Persistence at finish() writes (priorCostUsd + totalCostUsd);
  // the result reports just totalCostUsd.
  let priorCostUsd = 0;
  let priorUsageComplete = true;

  // Cost incurred by settled child handles inherited from prior
  // runs of the resumed session. Lives SEPARATELY from
  // `priorCostUsd` because the two flow to different sinks:
  //
  //   - `priorCostUsd` is parent-self only and is round-tripped
  //     through `sessions.totalCostUsd` (loaded at resume, written
  //     back at finish via `priorCostUsd + totalCostUsd`).
  //   - `rehydratedChildCostUsd` is the sum of `costUsd` across
  //     SETTLED rows in `subagent_handles` — already persisted by
  //     each child's `runSubagent` settle event. Folding it back
  //     into `priorCostUsd` would double-persist on every resume:
  //     finish() would write `(priorCostUsd + childA + childB) +
  //     totalCostUsd` to sessions.totalCostUsd; the next resume
  //     loads that into `priorCostUsd` and adds the same children
  //     again. After N resumes, `sessions.totalCostUsd` shows
  //     `parentSelf + N * childTotal` even though no new work
  //     ran.
  //
  // The budget gate (cap check, getCostBudget, watchdog) sums all
  // four — priorCostUsd + totalCostUsd + cumulativeChildCostUsd
  // (this run's children) + rehydratedChildCostUsd (prior runs'
  // children) + reserved (in-flight) — so a resumed run still
  // sees the full picture and can't burn the cap a second time.
  // Persistence stays parent-self only.
  let rehydratedChildCostUsd = 0;

  // Per-turn cost-delta event emitter (spec ORCHESTRATION.md §3.5
  // shared-budget contract). Fires every time the run's
  // `totalCostUsd` advances — turn settle, compaction, partial
  // provider-error charge. Carries `delta` (the latest charge
  // alone) and `cumulative` (this session's running self-cost).
  // For a subagent run, the parent's IPC observer reads these
  // events and tracks live in-flight spend; for a top-level run
  // the event is harmless (TUI ignores it). Skipped on zero
  // deltas so a misbehaving provider that emitted a usage event
  // with all zeros doesn't generate noise.
  const emitCostUpdate = (delta: number): void => {
    if (!Number.isFinite(delta) || delta <= 0) return;
    safeEmit(config.onEvent, {
      type: 'cost_update',
      delta,
      cumulative: totalCostUsd,
    });
  };

  // Cumulative cost of every child this run spawned (sync `task`
  // and async `task_async` alike). Increments inside
  // `spawnSubagentImpl` after each `runSubagent` returns. Used
  // by both the per-step cap check and the pre-spawn budget
  // gate to ensure the parent + children share `maxCostUsd`
  // (spec ORCHESTRATION.md §3.5). Reserved-but-not-yet-settled
  // async children are tracked separately by the handle store
  // (`getReservedChildCostUsd`); the projected total combines
  // both so a burst of concurrent `task_async` calls can't slip
  // past the gate while their reservations are pending.
  let cumulativeChildCostUsd = 0;

  // Parallel-tool dispatch counters (spec ORCHESTRATION.md
  // §1.3). Updated inside the parallel branch's `runPool`
  // before/after each worker invokes its tool; outside that
  // branch (idle, serial path) both stay at 0. The TUI's
  // footer reads these via the `parallel_status` HarnessEvent
  // — the cap chip is suppressed at 0 so a serial-only run
  // shows nothing.
  let parallelToolsRunning = 0;
  let parallelToolsCap = 0;

  // Cap-watchdog fire-once latch (D235 review fix). Without
  // this, the watchdog can emit `cap_watchdog_fired` multiple
  // times per run: after the first `cancelAll('cap_watchdog')`,
  // every cancelled record contributes 0 to the reservation
  // (filtered in `getReservedChildCostUsd`), but
  // `cumulativeChildCostUsd` already accumulated the
  // pre-cancel cost and stays > cap. Any cost_update still
  // queued in the IPC pipe fires the same `total > cap`
  // branch again, re-emitting the banner. The latch silences
  // re-emissions for the rest of the run — `cancelAll` is
  // idempotent so the structural side effect is fine; only
  // the operator-visible signal needs deduplication.
  let capWatchdogFired = false;

  // Helper: snapshot the current parallelism state and fire a
  // `parallel_status` HarnessEvent. Called from two sources:
  // (a) the handle store's `onStateChange` callback when a
  // spawn / dispatch / settle transitions; (b) the parallel
  // tool path before/after each worker invokes its tool. The
  // event lands at the TUI footer's reducer, which renders
  // `subagents R+Q/cap` and `tools R/cap` chips.
  const emitParallelStatus = (): void => {
    const subagentsActive = subagentHandleStore?.inFlightCount() ?? 0;
    const subagentsQueued = subagentHandleStore?.queuedCount() ?? 0;
    // `inFlightCount` returns every record with status='running' —
    // both the dispatched and the queue-waiting. Subtract the
    // queue depth to get "actually running through spawnFn".
    const subagentsRunning = Math.max(0, subagentsActive - subagentsQueued);
    const subagentsCap = Math.max(
      1,
      Math.min(budget.maxConcurrentSubagents, MAX_CONCURRENT_SUBAGENTS_CAP),
    );
    safeEmit(config.onEvent, {
      type: 'parallel_status',
      subagentsRunning,
      subagentsQueued,
      subagentsCap,
      toolsRunning: parallelToolsRunning,
      toolsCap: parallelToolsCap,
    });
  };

  // Distinguish wall-clock from user abort — both use `signal.aborted` but
  // the user wants different exit reasons.
  const isWallClockTimeout = (): boolean =>
    wallClockController.signal.aborted && !callerSignal.aborted;

  // Cumulative-cost cap check. Returns a detail string when the cap
  // is exceeded so callers can build the finish() call inline; null
  // otherwise. The comparison uses TOTAL cumulative cost
  // (parent self + children settled + reserved in-flight) so the
  // parent's turn-end gate stays consistent with the pre-spawn
  // budget gate in `spawnSubagentImpl`. Without including
  // children, a resumed run with $4 of prior child cost and $0
  // of parent self-cost could pass every turn-end check forever
  // while `task_async` refuses new spawns at $1.01 — incoherent
  // surface the reviewer flagged as risk #2. Matches the
  // persistence contract where the session row stores cumulative
  // spend. Strict `>` so a `maxCostUsd: 0` config trips the gate
  // on the first paid turn, not before any work runs.
  const costCapDetailIfExceeded = (): string | null => {
    if (budget.maxCostUsd === undefined) return null;
    const reserved = subagentHandleStore?.getReservedChildCostUsd() ?? 0;
    const cumulative =
      priorCostUsd + totalCostUsd + cumulativeChildCostUsd + rehydratedChildCostUsd + reserved;
    if (cumulative <= budget.maxCostUsd) return null;
    return `cumulative cost $${cumulative.toFixed(6)} exceeded cap $${budget.maxCostUsd.toFixed(6)}`;
  };

  // Hook chain dispatch (spec AGENTIC_CLI.md §10). All sites
  // funnel through this helper so the dispatcher's deps (db,
  // sessionId, cwd) are bound consistently and stray exceptions
  // never leak past the harness boundary. Returns the chain
  // result so blocking-event call sites can inspect `blockedBy`
  // and short-circuit; non-blocking sites just `void` the
  // promise.
  //
  // Returns `null` when there are no hooks OR when the
  // dispatcher itself throws — both surface as "no operator
  // decision was made", which CONTRACTS.md §10 line 1057
  // mandates as the fail-open behavior on chain failure
  // ("continuação assume 'ninguém bloqueou' para eventos
  // bloqueáveis; warning loggado").
  //
  // Spec §10.3 line 1041: non-blocking events run fire-and-
  // forget WRT decisions, but we still await here in lifecycle
  // sites so audit lands before the DB closes — without that,
  // a legitimate hook can disappear from `hook_runs` because
  // the DB closes underneath it. The wall-clock cap (15s) inside
  // the dispatcher protects against runaway hooks adding latency.
  //
  // In-flight chain promises are tracked in `pendingHookChains`
  // so the outer finally can drain them before the caller closes
  // the DB. Without the drain, a fire-and-forget Notification
  // / PreCheckpoint / PostToolUse can race db.close() and the
  // dispatcher's createHookRun call hits a closed handle —
  // surfacing as a stderr "AUDIT DRIFT" line instead of a
  // landed row. Awaited dispatches resolve before settling
  // here too, so adding them to the set is a no-op cost.
  const pendingHookChains = new Set<Promise<unknown>>();
  const dispatchHooks = async (payload: HookEventPayload): Promise<HookChainResult | null> => {
    if (config.hooks === undefined || config.hooks.length === 0) return null;
    const chain = (async (): Promise<HookChainResult | null> => {
      try {
        return await dispatchChain(config.hooks ?? [], payload, config.cwd, {
          db: config.db,
          sessionId: sessionId.length > 0 ? sessionId : null,
        });
      } catch (err) {
        // Defense-in-depth: dispatchChain wraps each hook's
        // error already, but a programming bug in the dispatcher
        // itself (or a synchronous throw before the per-hook
        // try/catch started) shouldn't crash the harness. Log
        // to stderr so the operator notices.
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`hooks: chain dispatch failed for ${payload.event}: ${msg}\n`);
        return null;
      }
    })();
    pendingHookChains.add(chain);
    chain.finally(() => pendingHookChains.delete(chain));
    return chain;
  };

  // `abortCause` is only meaningful when reason === 'aborted'; ignored
  // otherwise. Callers thread it from the abort site that knew which
  // signal fired (hard signal.aborted vs softStopSignal.aborted) so
  // the result carries the discriminator audit / telemetry needs.
  const finish = async (
    reason: ExitReason,
    detail?: string,
    abortCause?: 'soft' | 'hard',
  ): Promise<HarnessResult> => {
    clearTimeout(wallClockTimer);
    // Skip completeSession when init failed before createSession — there's
    // no row to mark and SQLite would just throw a foreign-key error.
    if (sessionId.length > 0) {
      try {
        // Persist CUMULATIVE totals (prior + this run) so the row
        // reflects the session's lifetime cost. The result returned
        // below stays per-run (caller telemetry). abortCause is
        // threaded through so audit / replay tools can recover the
        // discriminator after the process exits — without this, the
        // in-memory HarnessResult.abortCause died at the boundary.
        completeSession(
          config.db,
          sessionId,
          exitToStatus[reason],
          priorCostUsd + totalCostUsd,
          priorUsageComplete && usageComplete,
          undefined,
          abortCause,
        );
      } catch {
        // Storage already broken; nothing useful to do beyond return the
        // result so the caller knows the run is over.
      }
    }
    const result: HarnessResult = {
      status: exitToHarnessStatus[reason],
      reason,
      sessionId,
      steps,
      durationMs: Date.now() - startMs,
      usage: totalUsage,
      costUsd: totalCostUsd,
      usageComplete,
      lastMessageId,
    };
    if (detail !== undefined) result.detail = detail;
    if (reason === 'aborted' && abortCause !== undefined) {
      result.abortCause = abortCause;
    }
    // Stop hooks (spec AGENTIC_CLI.md §10.1). Fired AFTER the
    // session row is marked complete and the result struct is
    // built — so the operator's hook can read the final row /
    // status as authoritative — but BEFORE the renderer sees
    // session_finished, so any "session ended at $cost"
    // notification from a Stop hook lands while the UI is still
    // around. Audit is awaited; latency is bounded by the
    // dispatcher's MAX_HOOK_CHAIN_MS.
    //
    // Skipped on init-fail paths where createSession never
    // landed (`sessionId === ''`) — the spec contract on
    // HookEventPayload promises a non-empty sessionId, and
    // there's no real session for the operator's Stop hook to
    // act on. Mirrors the symmetric guard around SessionStart
    // (which only fires after the session_start emit, by which
    // point sessionId is guaranteed set).
    if (sessionId.length > 0) {
      await dispatchHooks({
        schema: 'v1',
        event: 'Stop',
        sessionId,
        data: {
          durationMs: result.durationMs,
          costUsd: result.costUsd,
          steps: result.steps,
        },
      });
    }
    // Drain any fire-and-forget chains still in flight
    // (PostToolUse from the last tool of the run, Notification
    // from a confirm modal that opened mid-step, PreCheckpoint
    // from the last writes-true step). Without this, a chain
    // that hadn't yet reached its `createHookRun` call by the
    // time runAgent returns races `db.close()` in the CLI
    // driver — surfacing as stderr "AUDIT DRIFT" lines instead
    // of a landed row. The dispatcher's per-hook + chain
    // timeouts already bound how long this can take. Use
    // allSettled so a rogue chain that throws here doesn't
    // crash the harness's exit path.
    if (pendingHookChains.size > 0) {
      await Promise.allSettled([...pendingHookChains]);
    }
    safeEmit(config.onEvent, { type: 'session_finished', result });
    return result;
  };

  // Convert any uncaught exception (typically SQLite errors from append
  // operations) into a clean error exit instead of letting it crash the
  // caller. Tool exceptions are already wrapped by invokeTool; this catch
  // is for the persistence path that surrounds it. We don't know what
  // turns were measured at the throw site, so the safe call is to mark
  // aggregate totals as incomplete.
  //
  // Special case: if `signal.aborted` at throw time, the underlying
  // exception is most likely AbortError (SQLite write interrupted by
  // the abort signal, async iteration cancelled, etc.). Map to
  // `aborted` with `cause='hard'` instead of burying it as
  // `internalError` — operator-initiated termination shouldn't look
  // like a harness bug in audit. Wall-clock timeout takes precedence
  // (matches the in-loop check).
  const guardedFinish = async (e: unknown): Promise<HarnessResult> => {
    usageComplete = false;
    const detail = e instanceof Error ? e.message || e.name || String(e) : String(e);
    if (signal.aborted) {
      return isWallClockTimeout()
        ? await finish('maxWallClockMs', detail)
        : await finish('aborted', detail, 'hard');
    }
    return await finish('internalError', detail);
  };

  // Init writes (createSession + initial appendMessage) live INSIDE the
  // try so a SQLite failure here routes through guardedFinish — that
  // clears the wall-clock timer instead of leaking it for the full
  // maxWallClockMs window (default 10 min).
  //
  // The outer try/finally is the session-end cleanup hook for any bg
  // processes (`bash_background` & co, M3 §7.3). Spawned processes
  // outlive a single turn, so when the loop exits — naturally, on
  // budget, on abort, or on internalError — we send SIGTERM to every
  // still-running child. Best-effort: cleanup errors are swallowed
  // so they don't mask the run's HarnessResult, and the DB is
  // converged via markRunningAsKilled inside cleanup() regardless of
  // whether the OS kill landed.
  try {
    try {
      // Resume vs new session. In resume mode, the prior session id
      // is reused and its persisted messages are loaded back into
      // the in-memory array so the model sees the full conversation
      // before the new userPrompt. The session is flipped back to
      // 'running' so completeSession at run-end doesn't trip its
      // 'must be running' WHERE guard. We validate the id BEFORE
      // any side effects so a typo'd session id doesn't leave a
      // half-initialized state.
      // Resume budget semantics: `steps`, `consecutiveErrors`,
      // `totalUsage`, `totalCostUsd`, and `usageComplete` are
      // PER-RUN accumulators that start at zero/true — they drive
      // HarnessResult, which is per-run telemetry that has to
      // stay self-consistent (zero usage means zero cost, etc.).
      // The CUMULATIVE state (prior + this run) is held separately
      // in `priorCostUsd` / `priorUsageComplete` and only used at
      // completeSession time so the persisted column reflects the
      // session's lifetime cost. This separation closes the bug
      // where seeding totalCostUsd from the row made costUsd
      // report cumulative while usage stayed per-run.
      // The CLI's run.ts also calls getSession before constructing
      // the config (`resolveResumeId`) so a typo'd id fails fast on
      // stderr. The duplicate check here is intentional defense in
      // depth: programmatic callers (evals, future tests) may build
      // a HarnessConfig directly without going through the CLI, and
      // getSession returning null inside the loop would otherwise
      // surface as a confusing 'getSession on null result' downstream
      // when we read totalCostUsd. The cost of one extra SELECT per
      // resume call is negligible.
      const resumeId = config.resumeFromSessionId;
      const preassignedId = config.preassignedSessionId;
      if (resumeId !== undefined && preassignedId !== undefined) {
        // Defense in depth: the two paths are mutually exclusive —
        // resume reopens an existing finalized session, preassigned
        // uses a freshly-created row the caller built. Setting both
        // is a programmer bug, fail loud rather than guess intent.
        throw new Error(
          'HarnessConfig: resumeFromSessionId and preassignedSessionId are mutually exclusive',
        );
      }
      if (resumeId !== undefined) {
        const existing = getSession(config.db, resumeId);
        if (existing === null) {
          throw new Error(`session ${resumeId} not found`);
        }
        // cwd divergence between the original session and the
        // resume context is silently broken: messages reference
        // files / paths from the original cwd, but bash calls in
        // the resumed run land in the new cwd. Refuse rather than
        // let the model think it's in a filesystem that doesn't
        // match its conversation. Operators who legitimately want
        // to resume in a different directory can `cd` to the
        // original first or start a fresh session — both are
        // clearer than silent divergence.
        if (existing.cwd !== config.cwd) {
          throw new Error(
            `cannot resume session ${resumeId}: original cwd was '${existing.cwd}', current cwd is '${config.cwd}'. cd to the original directory or start a new session.`,
          );
        }
        priorCostUsd = existing.totalCostUsd;
        priorUsageComplete = existing.usageComplete;
        reopenSession(config.db, resumeId);
        sessionId = resumeId;
      } else if (preassignedId !== undefined) {
        // Caller-created row. Verify it exists and matches the
        // expected shape (cwd, status='running'). The cwd check
        // mirrors resume's — relative paths in messages must
        // resolve consistently between the row's recorded cwd
        // and the runtime cwd. The status check guards against
        // accidentally rerunning over a finalized session, which
        // would silently overwrite messages.
        const existing = getSession(config.db, preassignedId);
        if (existing === null) {
          throw new Error(
            `preassignedSessionId ${preassignedId} not found; the caller must createSession before constructing the config`,
          );
        }
        if (existing.cwd !== config.cwd) {
          throw new Error(
            `preassignedSessionId ${preassignedId}: row cwd is '${existing.cwd}', config cwd is '${config.cwd}' — must match`,
          );
        }
        if (existing.status !== 'running') {
          throw new Error(
            `preassignedSessionId ${preassignedId}: row status is '${existing.status}', expected 'running' (only fresh, unfinalized rows are usable)`,
          );
        }
        sessionId = preassignedId;
      } else {
        const session = createSession(config.db, {
          model: config.provider.id,
          cwd: config.cwd,
          ...(config.parentSessionId !== undefined
            ? { parentSessionId: config.parentSessionId }
            : {}),
        });
        sessionId = session.id;
      }

      // bg manager creation MUST happen here, after sessionId is
      // resolved — every row insertBgProcess writes carries the
      // session_id FK, so a manager built before createSession would
      // crash on first spawn. The manager is short-lived: lives
      // until the outer finally cleans it up.
      //
      // Note: bg processes from the prior run of a resumed session
      // are NOT carried over. The previous run's harness terminated
      // them in its outer finally; this fresh manager starts empty.
      // Documented as an explicit boundary — resume restores
      // conversational context, not running children.
      if (config.bgLogDir !== undefined) {
        bgManager = createBgManager({
          db: config.db,
          sessionId,
          logDir: config.bgLogDir,
          // Propagate the harness's combined signal (caller abort +
          // wall-clock). A Ctrl+C mid-stream kills bg processes
          // immediately instead of waiting for runAgent's outer
          // finally to fire — matters when the loop is mid-provider-
          // request, where finally can be seconds away.
          abortSignal: signal,
          // Lifecycle observer: translate bg manager events into
          // HarnessEvents so the renderer can update its `bg N`
          // footer counter (spec UI.md §4.10.6) and audit captures
          // the same lifecycle the user sees. Event shape mirrors
          // BgManagerEvent's `kind` discriminant onto distinct
          // HarnessEvent types so the adapter's switch stays flat.
          onEvent: (event) => {
            if (event.kind === 'started') {
              safeEmit(config.onEvent, {
                type: 'bg_started',
                processId: event.processId,
                command: event.command,
                label: event.label,
              });
            } else {
              safeEmit(config.onEvent, {
                type: 'bg_ended',
                processId: event.processId,
                status: event.status,
                exitCode: event.exitCode,
              });
            }
          },
        });
      }

      // Subagent dispatcher + handle store. Wired only when a
      // subagent registry is configured; both `task` (sync) and the
      // `task_async` family (async) flow through `spawnSubagentImpl`,
      // which centralizes the runSubagent option assembly and lets
      // callers pass a per-call signal override. The store wraps
      // the impl with bounded-concurrency slot semantics so multiple
      // `task_async` calls overlap up to the cap.
      if (config.subagentRegistry !== undefined) {
        spawnSubagentImpl = async (args, signalOverride, handleId) => {
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
            const spent =
              priorCostUsd +
              totalCostUsd +
              cumulativeChildCostUsd +
              rehydratedChildCostUsd +
              reserved;
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
                      const message =
                        persistErr instanceof Error ? persistErr.message : String(persistErr);
                      console.error(
                        `cost_progress persist failed for handle ${trackerHandleId}: ${message}`,
                      );
                    }
                    if (budget.maxCostUsd !== undefined) {
                      const reserved = trackerStore.getReservedChildCostUsd();
                      const total =
                        priorCostUsd +
                        totalCostUsd +
                        cumulativeChildCostUsd +
                        rehydratedChildCostUsd +
                        reserved;
                      if (total > budget.maxCostUsd && !capWatchdogFired) {
                        // Latch the fire-once flag BEFORE the
                        // cancellations run so a re-entrant
                        // `cost_update` that lands while
                        // cancelAll is still propagating sees
                        // `capWatchdogFired === true` and
                        // skips. The latch never resets — once
                        // the watchdog fires for a run, the
                        // operator banner has the data they
                        // need; subsequent cap-crosses (which
                        // only happen because cumulative cost
                        // doesn't decrease) carry no new signal.
                        capWatchdogFired = true;
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
                        const cancelledCount =
                          trackerStore.inFlightCount() - trackerStore.queuedCount();
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

          const child = await runSubagent({
            definition: def,
            prompt: args.prompt,
            parentSessionId: sessionId,
            provider: config.provider,
            parentToolRegistry: rootRegistry,
            permissionEngine: config.permissionEngine,
            db: config.db,
            cwd: config.cwd,
            ...(onChildEventForwarder !== undefined ? { onChildEvent: onChildEventForwarder } : {}),
            ...(config.hooks !== undefined ? { hooksSnapshot: config.hooks } : {}),
            signal: combinedSignal,
            ...(config.softStopSignal !== undefined
              ? { softStopSignal: config.softStopSignal }
              : {}),
            subagentRegistry: registry,
            ...(config.planMode === true ? { planMode: true } : {}),
            ...(config.isCwdTrusted === true ? { cwdTrusted: true } : {}),
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
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
          if (Number.isFinite(childCostUsd)) {
            cumulativeChildCostUsd += childCostUsd;
          }
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
          };
        };
        const subagentCap = Math.max(
          1,
          Math.min(budget.maxConcurrentSubagents, MAX_CONCURRENT_SUBAGENTS_CAP),
        );
        // The store's spawnFn always passes the per-handle signal
        // through. The captured spawnSubagentImpl above combines it
        // with the run signal.
        const impl = spawnSubagentImpl;
        // Persist handles into `subagent_handles` so a parent
        // crash → resume cycle rehydrates rather than losing the
        // mapping. Always wired in production; the store itself
        // takes care of (a) inserting on spawn, (b) updating
        // child_session_id once the spawnFn returns, (c) settling
        // on terminal envelope, and (d) mass-converting any
        // running rows from a prior run into `resumed_session`
        // envelopes when this store loads.
        subagentHandleStore = createSubagentHandleStore({
          cap: subagentCap,
          spawnFn: async (args, perHandleSignal, handleId) => impl(args, perHandleSignal, handleId),
          persistTo: { db: config.db, parentSessionId: sessionId },
          // Re-emit parallel_status whenever the queued or
          // running count shifts — keeps the TUI footer's
          // `subagents R+Q/cap` chip in sync without polling.
          onStateChange: emitParallelStatus,
        });
        // On resume, rehydrated settled handles carry cost that
        // prior runs incurred but the `sessions.totalCostUsd`
        // column does NOT include (that column is parent-self
        // only). Without folding this in, the budget gate
        // silently lets a resumed run burn the same cap a
        // second time. Read once at construction; the store's
        // accumulator is a one-shot value snapshotted from the
        // rehydrated rows.
        //
        // Stored in `rehydratedChildCostUsd` rather than mutating
        // `priorCostUsd` because finish() persists `priorCostUsd
        // + totalCostUsd` back to `sessions.totalCostUsd`. Folding
        // child cost into priorCostUsd would re-persist it on
        // every resume, inflating sessions.totalCostUsd by the
        // settled-children sum each cycle and tripping
        // `maxCostUsd` prematurely on long-lived sessions even
        // when no new work runs. The budget gate sums both
        // priorCostUsd and rehydratedChildCostUsd; persistence
        // does not.
        rehydratedChildCostUsd = subagentHandleStore.getRehydratedChildCostUsd();
      }

      // Checkpoint manager. Only built when the caller opted in —
      // unit tests and programmatic callers usually don't, so we
      // skip the git probe entirely in that case. The probe itself
      // is best-effort: a non-git cwd yields available=false and
      // every snapshot becomes a no-op, which keeps the loop's
      // call sites uniform.
      //
      // The `checkpoints_unavailable` event (when the probe finds
      // no git) is emitted AFTER `session_start` so the bracketing
      // contract holds — every observer sees session_start as the
      // first event of a run. Captured to a local and replayed
      // below.
      let checkpointsUnavailableReason: string | null = null;
      if (config.enableCheckpoints === true) {
        const support = await detectCheckpointSupport(config.cwd);
        checkpointManager = createCheckpointManager({
          db: config.db,
          cwd: config.cwd,
          sessionId,
          available: support.available,
        });
        if (!support.available && support.reason !== null) {
          checkpointsUnavailableReason = support.reason;
        } else if (support.available) {
          // Lazy retention sweep. Fire-and-forget per CHECKPOINTS §2.5:
          // it must not block the harness from making progress (a
          // monorepo with thousands of refs could spend seconds in
          // ref deletion) AND it must not bubble its errors anywhere
          // the run depends on (purge throwing on a corrupt ref store
          // would otherwise bring down a session for a side-effect-
          // less cleanup).
          //
          // Safe under concurrent snapshots in the same session
          // because purge's age-cutoff (default 30d) is far beyond
          // any in-flight session's created_at; the current
          // session's rows are excluded by construction.
          const retentionDays = config.checkpointsRetentionDays;
          checkpointsPurgeInFlight = checkpointManager
            .purge(retentionDays !== undefined ? { olderThanDays: retentionDays } : {})
            .catch(() => {
              // Swallowed — see rationale above.
            });
        }
      }

      // Hydrate persisted messages BEFORE appending the new user
      // prompt. Two paths converge here:
      //   - Resume: the prior run's full transcript is on disk;
      //     load it so the model sees [old turns, new prompt].
      //   - Preassigned: the caller (subprocess parent) created
      //     the row and inserted the seed user message before
      //     spawning. We need to load that seed too — otherwise
      //     the child sees an empty conversation and appends a
      //     fresh prompt-from-config that would silently NOT match
      //     what the parent committed.
      // Both paths share the same fetch + alignment walk; only
      // the trigger condition differs.
      //
      // Bounded fetch: SQL returns at most (MAX + alignment
      // margin) rows, so a 50k-message session never materializes
      // in JS memory. The earlier implementation read the full
      // log into memory and sliced — defeating the cap and OOM-ing
      // on long-running sessions.
      //
      // droppedFromHead reported on the resume_truncated event
      // accounts for BOTH the rows that never left SQL (totalCount
      // - fetchedCount) and the rows the alignment walk skipped
      // inside the fetched slice. Kept count is what the model
      // actually sees in context.
      //
      // Carry forward the parent_id chain across resume /
      // preassigned. Without seeding lastMessageId from the prior
      // tail, the new user turn appends with parent_id=null and
      // starts a NEW root in the same session — the parent_id
      // graph forks at the boundary, breaking traversal/replay/
      // audit logic that walks parent links to reconstruct the
      // conversation tree. The persisted tail is already ordered
      // by seq (migration 007), so the tail is just the last
      // element of what we fetched (which IS the absolute tail
      // since the bounded fetch picks newest rows).
      let priorTailId: string | null = null;
      const preexistingId = resumeId ?? preassignedId;
      if (preexistingId !== undefined) {
        const tail = listMessageTailBySession(
          config.db,
          preexistingId,
          MAX_RESUME_MESSAGES + ALIGNMENT_FETCH_MARGIN,
        );
        const restored = messagesToProviderMessages(tail.messages);
        messages.push(...restored.messages);
        const fetchedCount = tail.messages.length;
        const droppedBeyondFetch = tail.totalCount - fetchedCount;
        const totalDropped = droppedBeyondFetch + restored.droppedFromHead;
        if (totalDropped > 0 && resumeId !== undefined) {
          // resume_truncated emits only on the resume path. The
          // preassigned path's seed is freshly inserted by the
          // parent (typically a single user message) and
          // truncation there would indicate something is off
          // with the parent's flow — but it's not a "user
          // resumed and lost context" event the renderer needs
          // to surface.
          safeEmit(config.onEvent, {
            type: 'resume_truncated',
            sessionId,
            kept: restored.messages.length,
            dropped: totalDropped,
          });
        }
        // Stranded-turn handling. If the last restored message is
        // `user` (either the original prompt that never got an
        // assistant response, or a tool_result whose follow-up
        // assistant turn never landed because the run aborted),
        // appending the resume's new user prompt would create
        // user→user on the wire — every provider 400s on that.
        // Insert an in-memory-only synthetic assistant placeholder
        // to satisfy alternation. Not persisted: each resume
        // re-derives it on demand from whatever shape the log is
        // in at that moment.
        //
        // The placeholder is ONLY needed when we're about to
        // append a new user prompt. On the preassigned path with
        // an empty userPrompt (the parent already seeded the
        // user turn), the seed itself IS the conversation and
        // we don't append again — so a trailing-user tail is
        // correct, not stranded.
        const inMemoryTail = messages[messages.length - 1];
        const willAppendUserPrompt = config.userPrompt.length > 0;
        if (willAppendUserPrompt && inMemoryTail !== undefined && inMemoryTail.role === 'user') {
          messages.push({ role: 'assistant', content: STRANDED_TURN_PLACEHOLDER });
        }
        const lastFetched = tail.messages[tail.messages.length - 1];
        if (lastFetched !== undefined) priorTailId = lastFetched.id;
      }

      // Skip appending when userPrompt is empty. The preassigned
      // path with parent-seeded conversation passes '' here; the
      // hydration above already loaded the seed, so a second
      // append with empty content would produce a zero-byte user
      // message that providers either reject or take literally.
      // The fresh-session path always supplies a non-empty
      // userPrompt (CLI guards against missing prompt before
      // bootstrap).
      if (config.userPrompt.length > 0) {
        const userMsg = appendMessage(config.db, {
          sessionId,
          role: 'user',
          content: config.userPrompt,
          // null on first turn (new session); tail id on resume
          // / preassigned so the chain stays connected.
          // appendMessage validates the parent belongs to the
          // same session.
          ...(priorTailId !== null ? { parentId: priorTailId } : {}),
        });
        lastMessageId = userMsg.id;
        messages.push({ role: 'user', content: config.userPrompt });
      } else if (priorTailId !== null) {
        // No new user message to append; the prior tail id
        // becomes the lastMessageId we report on the result and
        // the chain anchor for the assistant turn that follows.
        lastMessageId = priorTailId;
      }

      safeEmit(config.onEvent, { type: 'session_start', sessionId });
      // Emit the checkpoints-unavailable warning AFTER session_start
      // so observers can rely on session_start being the first
      // lifecycle event of a run. Without the order guarantee,
      // renderers that buffer until session_start as the bracket
      // signal would miss the warning entirely.
      if (checkpointsUnavailableReason !== null) {
        safeEmit(config.onEvent, {
          type: 'checkpoints_unavailable',
          reason: checkpointsUnavailableReason,
        });
      }
      // SessionStart hooks (spec AGENTIC_CLI.md §10.1). Fired
      // AFTER the renderer sees session_start so the operator's
      // hook is bracketed inside the visible session — a hook
      // that prints to stdout doesn't land before the UI's
      // session header. Awaited so audit lands; latency capped
      // by the dispatcher's chain timeout.
      await dispatchHooks({
        schema: 'v1',
        event: 'SessionStart',
        sessionId,
        data: {
          cwd: config.cwd,
          model: config.provider.id,
          profile: config.planMode === true ? 'plan' : 'default',
        },
      });

      // UserPromptSubmit (spec AGENTIC_CLI.md §10.1, blocking).
      // Fires when the run carries a fresh user prompt — operator
      // hook can scan for secrets, inject context, or refuse the
      // turn outright. Skipped on resume runs that just re-execute
      // the prior tail without new content (`config.userPrompt ===
      // ''`); there's nothing for an operator hook to gate.
      //
      // The user message has ALREADY been persisted (above, before
      // session_start emit) so the audit trail captures what the
      // operator's hook refused — operator can review attempts in
      // the messages table even when the LLM never saw them.
      // Block path: short-circuits to finish('userPromptBlocked',
      // reason). Stop hooks still fire (they're inside finish);
      // the session row is finalized as 'interrupted'.
      if (config.userPrompt.length > 0) {
        const ups = await dispatchHooks({
          schema: 'v1',
          event: 'UserPromptSubmit',
          sessionId,
          data: { prompt: config.userPrompt },
        });
        if (ups !== null && ups.blockedBy !== null) {
          const block = ups.blockedBy;
          const detail =
            block.reason === 'message' && block.message !== null && block.message.length > 0
              ? `denied by hook: ${block.message}`
              : `denied by ${block.spec.layer} hook ${block.spec.sourcePath}`;
          return await finish('userPromptBlocked', detail);
        }
      }

      while (true) {
        if (signal.aborted) {
          return isWallClockTimeout()
            ? await finish('maxWallClockMs')
            : await finish('aborted', undefined, 'hard');
        }
        // Cooperative stop: spec UI.md §3 soft interrupt. The check
        // sits at the top of the loop so the just-completed step's
        // tool calls + their results are persisted before exiting.
        // This gives the operator the "model finishes the step then
        // stops" semantic without burning tokens on a re-prompt the
        // operator already cancelled. Distinct from the hard signal
        // above — soft never preempts in-flight work.
        if (config.softStopSignal?.aborted) {
          return await finish('aborted', undefined, 'soft');
        }
        if (steps >= budget.maxSteps) return await finish('maxSteps');
        // Cost cap pre-check. Critical on resume: a session whose
        // priorCostUsd already crossed budget.maxCostUsd would
        // otherwise issue one billed provider call before the
        // post-turn check fires. Documented as cumulative; this
        // closes the gap so the cap blocks IMMEDIATELY at run
        // start rather than after one wasted turn. Steady-state
        // (non-resume) runs land in the post-turn check first
        // and never reach this branch on a subsequent iteration.
        {
          const overage = costCapDetailIfExceeded();
          if (overage !== null) return await finish('maxCostUsd', overage);
        }

        steps += 1;
        safeEmit(config.onEvent, { type: 'step_start', stepN: steps });

        const resolvedMaxTokens = resolveMaxOutputTokens(budget, config.provider.capabilities);
        const req: GenerateRequest = {
          model: config.provider.id,
          // Snapshot the running message list so post-call mutations (the next
          // iteration appends assistant + tool_results) don't retroactively
          // change what the provider observed.
          messages: [...messages],
          max_tokens: resolvedMaxTokens,
          ...(config.systemPrompt !== undefined ? { system: config.systemPrompt } : {}),
          ...(tools.length > 0 ? { tools } : {}),
          ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
          ...(config.topP !== undefined ? { top_p: config.topP } : {}),
          ...(config.thinkingBudget !== undefined
            ? { thinking_budget: config.thinkingBudget }
            : {}),
          ...(config.seedInEval !== undefined ? { seed_in_eval: config.seedInEval } : {}),
        };

        let collected: Awaited<ReturnType<typeof collectStep>>;
        try {
          // Wrap the provider stream so the combined abort signal (user +
          // wall-clock) actually reaches the for-await inside collectStep.
          // The Provider interface doesn't propagate signals to the SDK,
          // so without this a hung HTTP request blocks indefinitely and
          // neither Ctrl+C nor maxWallClockMs can interrupt it.
          // Stream wrapping order is load-bearing:
          //   1. generateWithRetry produces the raw stream.
          //   2. stallWatchdog wraps inside-out so silent stalls
          //      throw StepStallError; reset on every yield.
          //   3. abortableIterable wraps OUTSIDE so external
          //      aborts (Ctrl+C, wall-clock) take precedence over
          //      stall detection.
          // Inverting (1) and (2) would let the stall timer
          // count time the consumer spends processing each event
          // (e.g. heavy renderer work between deltas) against
          // the stall budget, which would falsely trip on slow
          // consumers rather than real provider hangs.
          collected = await collectStep(
            abortableIterable(
              stallWatchdog(
                generateWithRetry(config.provider, req, DEFAULT_RETRY),
                budget.maxStepStallMs,
              ),
              signal,
            ),
            (ev) => safeEmit(config.onEvent, { type: 'provider_event', event: ev }),
          );
        } catch (e) {
          // The provider request was sent (and likely billed for input
          // tokens) before the throw. Always flip the aggregate flag —
          // even if we recover partial usage, totals are by definition
          // a lower bound when the turn ended in error.
          usageComplete = false;

          // Recover whatever the stream emitted before the throw.
          // Adapters yield `usage` from their `finally` block precisely
          // for this case, so a failed turn that already received
          // input/cache numbers from the provider can still be charged.
          // CollectStepError carries the partial CollectedStep; non-
          // wrapped errors (extreme: collectStep itself crashed before
          // catching) have no recoverable state.
          if (e instanceof CollectStepError) {
            const partial = e.partial;
            if (partial.usageSeen) {
              const partialCost = computeCost(config.provider.capabilities, partial.usage);
              totalUsage = addUsage(totalUsage, partial.usage);
              totalCostUsd += partialCost;
              emitCostUpdate(partialCost);
              // Note: we deliberately do NOT check budget.maxCostUsd here.
              // The provider error path is about to call finish('providerError')
              // unconditionally — surfacing maxCostUsd instead when the partial
              // cost crossed the cap would mask the underlying failure (the
              // provider crash IS the actionable signal). The cumulative cost
              // is still persisted via priorCostUsd + totalCostUsd at finish(),
              // so the next resume sees the correct starting point and the
              // cap will fire there if the run continues.
            }
          }

          // SDK throws when the abort signal fires mid-call (Ctrl+C or
          // wall-clock timeout). Reroute to the matching ExitReason so the
          // user sees `interrupted` exit code 130 instead of a generic
          // `error` from `providerError`. Hard signal by definition —
          // soft can't preempt a provider call (it only fires at the
          // next step boundary).
          if (signal.aborted) {
            return isWallClockTimeout()
              ? await finish('maxWallClockMs')
              : await finish('aborted', undefined, 'hard');
          }
          // Step-stall watchdog fired (no provider events for
          // budget.maxStepStallMs). Distinct from providerError
          // — the connection didn't crash, it just went silent.
          // Operator sees `stepStalled` in audit and the TUI's
          // permanent chip renders the cause cleanly instead of
          // a generic "Error".
          const stallCause = e instanceof CollectStepError ? e.cause : e;
          if (stallCause instanceof StepStallError) {
            return await finish('stepStalled', stallCause.message);
          }
          const cause = e instanceof CollectStepError ? e.cause : e;
          const detail =
            cause instanceof Error ? cause.message || cause.name || String(cause) : String(cause);
          return await finish('providerError', detail);
        }

        // Build assistant content blocks: text first, then tool_uses, mirroring
        // the order the model produced them. Empty text is omitted.
        const assistantContent: ProviderContentBlock[] = [];
        if (collected.text.length > 0) {
          assistantContent.push({ type: 'text', text: collected.text });
        }
        for (const tu of collected.tool_uses) {
          const block: ProviderToolUseBlock = {
            type: 'tool_use',
            id: tu.id,
            name: tu.name,
            input: tu.input,
          };
          assistantContent.push(block);
        }

        const turnCostUsd = computeCost(config.provider.capabilities, collected.usage);
        totalUsage = addUsage(totalUsage, collected.usage);
        totalCostUsd += turnCostUsd;
        emitCostUpdate(turnCostUsd);
        // ANY assistant turn that completes without a usage event is
        // unmeasured — every successful provider call bills input tokens
        // for the prompt, even when the model emits no text, no
        // tool_use, and no thinking. Stream errors and aborts don't
        // reach here (they exit via providerError/aborted finish paths),
        // so we're only counting turns that the provider actually
        // accepted and processed. Flipping the flag tells the renderer
        // to mark aggregate cost as a lower bound.
        if (!collected.usageSeen) usageComplete = false;

        // When the adapter never emitted a `usage` event, persist NULL on
        // the token/cost columns instead of zeroes. Future analytics can
        // then distinguish "no measurement" from "measured zero" — both
        // are legal but mean different things (e.g., a stream that aborted
        // before message_stop vs. a turn that genuinely produced nothing).
        const assistantMsg = appendMessage(config.db, {
          sessionId,
          role: 'assistant',
          parentId: lastMessageId,
          content: assistantContent.length > 0 ? assistantContent : '',
          tokensIn: collected.usageSeen ? collected.usage.input : null,
          tokensOut: collected.usageSeen ? collected.usage.output : null,
          cachedTokens: collected.usageSeen ? collected.usage.cache_read : null,
          cacheCreationTokens: collected.usageSeen ? collected.usage.cache_creation : null,
          costUsd: collected.usageSeen ? turnCostUsd : null,
        });
        lastMessageId = assistantMsg.id;
        if (assistantContent.length > 0) {
          messages.push({ role: 'assistant', content: assistantContent });
        }

        // Stream errors (normalizer-level: malformed tool_use args, orphan
        // tool_use_stop, etc.) mean the provider produced output we couldn't
        // structure correctly. The most common case is a malformed JSON
        // arguments stream — `tool_use_stop` is dropped and the call vanishes
        // from `tool_uses`. If we then exited as `done` because the array
        // is empty, the run reports success while silently losing the
        // model's intent. Surface this as a step-level failure instead.
        // The assistant message is already persisted above so the audit
        // trail keeps whatever text did come through.
        if (collected.errors.length > 0) {
          const detail = collected.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
          return await finish('providerError', `stream errors: ${detail}`);
        }

        // Cost cap check after the assistant turn lands and is persisted.
        // We exit AFTER the audit row is written so the user can see the
        // turn that pushed them over the cap when they query the session
        // log. Provider/stream errors above take precedence — the cap is
        // for clean spend, not for surfacing already-broken turns.
        {
          const overage = costCapDetailIfExceeded();
          if (overage !== null) return await finish('maxCostUsd', overage);
        }

        // No tool uses → check the stop_reason before declaring success.
        // `end_turn`, `stop_sequence`, and `refusal` are all "model finished
        // speaking" (the refusal IS the response, even if it's a no). But
        // `max_tokens` means the per-call output cap truncated the answer
        // mid-stream; reporting `done` here would silently hand the user
        // an incomplete response with exit code 0. Surface it as an
        // `exhausted` exit so callers know to retry with a higher cap or
        // route to compaction (M2).
        if (collected.tool_uses.length === 0) {
          if (collected.stop_reason === 'max_tokens') {
            return await finish(
              'maxOutputTokens',
              `provider truncated at max_tokens (cap=${resolvedMaxTokens})`,
            );
          }
          return await finish('done');
        }

        // Snapshot before any of this step's tool_uses run. Spec §12 +
        // CHECKPOINTS.md §2.1: granularity is per-step, not per-tool —
        // a refactor of 5 files = 5 edits in the same step ⇒ 1
        // checkpoint that captures the pre-refactor tree, so `/undo`
        // returns the user atomically to the state before the step.
        //
        // Triggers iff at least one declared tool_use's tool has
        // `metadata.writes === true`. We inspect the registry here —
        // not the policy — because the question is "could this step
        // mutate the working tree", and policy denials happen later
        // (in invokeTool). A tool that's about to be policy-denied
        // still doesn't move files, so we'd take a snapshot for nothing
        // — but the no-op skip in CheckpointManager catches it (the
        // working tree didn't change, write-tree matches the prior
        // checkpoint, no row written). Cheap defense in depth.
        //
        // had_bash: true iff at least one tool in this step has side
        // effects that escape cwd (DB writes, network calls, process
        // spawns) — these are NOT reversed by checkpoint restore. The
        // tool's own `metadata.escapesCwd` is the source of truth;
        // the explicit name list (`bash`, `bash_background`,
        // `bash_kill`) is a defense-in-depth fallback for external
        // tool definitions that haven't set the flag yet. Variable
        // name kept as `hadBash` to match the persisted column;
        // `escapesCwd` is the conceptual rename for a future cleanup.
        if (checkpointManager !== undefined) {
          let hasWrites = false;
          let hadBash = false;
          for (const tu of collected.tool_uses) {
            const tool = config.toolRegistry.get(tu.name);
            if (tool === null) continue;
            if (tool.metadata.writes) hasWrites = true;
            if (
              tool.metadata.escapesCwd === true ||
              tu.name === 'bash' ||
              tu.name === 'bash_background' ||
              tu.name === 'bash_kill'
            ) {
              hadBash = true;
            }
          }
          if (hasWrites) {
            // PreCheckpoint hooks (spec AGENTIC_CLI.md §10.1).
            // Fired BEFORE the snapshot so an operator hook can
            // record context (e.g., dump tree of dirty paths,
            // tag the working tree with a marker). Fire-and-
            // forget per spec line 1041 — non-blocking events
            // don't gate the snapshot. The snapshot's git ops
            // (add/commit on the shadow ref) are already
            // optimized; bound any operator latency to their
            // own hook timeout.
            void dispatchHooks({
              schema: 'v1',
              event: 'PreCheckpoint',
              sessionId,
              data: { stepN: steps },
            });
            try {
              const outcome = await checkpointManager.snapshot({
                stepId: assistantMsg.id,
                hadBash,
                stepN: steps,
              });
              if (outcome.checkpointId !== null && outcome.gitRef !== null) {
                safeEmit(config.onEvent, {
                  type: 'checkpoint_created',
                  checkpointId: outcome.checkpointId,
                  gitRef: outcome.gitRef,
                  stepId: assistantMsg.id,
                  hadBash,
                });
              }
            } catch {
              // Snapshot failures must not break the step. The most
              // likely cause is a transient git issue (locked refs
              // mid-`git gc`, stale lock file, fs error). The harness
              // proceeds without a checkpoint for this step — `/undo`
              // would skip past it to the prior surviving checkpoint,
              // which is the conservative outcome. The DB row would
              // not have been written (insertCheckpoint is the last
              // step inside snapshot()), so audit stays consistent.
            }
          }
        }

        // Step-scoped helpers shared by serial and parallel paths.
        // Lifted out of the per-tu loop so a step that emits N
        // tool_uses doesn't reconstruct the spawnSubagent closure
        // N times, and so the parallel path can dispatch through
        // the same `invokeOne` worker the serial path uses.

        // Bridge from the run-scoped `spawnSubagentImpl` to the
        // legacy synchronous tool surface. The legacy `task` tool
        // expects `(args) => Promise<SpawnSubagentResult>`; the
        // run impl exposes a richer `(args, signalOverride?)`
        // shape so the handle store can carry a per-handle
        // signal. The `if`-block aliases the impl into a const
        // so TS narrowing survives the closure — `let`-declared
        // optionals can re-widen inside a lambda even when the
        // source is never reassigned after initialization.
        let spawnSubagentClosure:
          | ((args: SpawnSubagentArgs) => Promise<SpawnSubagentResult>)
          | undefined;
        if (spawnSubagentImpl !== undefined) {
          const impl = spawnSubagentImpl;
          spawnSubagentClosure = (args) => impl(args);
        }

        const buildCtx = (tu: CollectedToolUse): ToolContext => ({
          signal,
          cwd: config.cwd,
          sessionId,
          stepId: assistantMsg.id,
          permissions: config.permissionEngine.view(),
          permissionCheck: (toolName, category, args) =>
            config.permissionEngine.check(toolName, category, args),
          todoStore,
          ...(bgManager !== undefined ? { bgManager } : {}),
          ...(spawnSubagentClosure !== undefined ? { spawnSubagent: spawnSubagentClosure } : {}),
          ...(subagentHandleStore !== undefined ? { subagentHandleStore } : {}),
          subagentDepth: config.subagentDepth ?? 0,
          // Cost budget tracker (spec ORCHESTRATION.md §3.5).
          // Returns the cumulative spend (parent self-cost +
          // run-scoped child cost cumulative + pessimistic
          // reservation for in-flight async children) and the
          // cap. Reads from the run-level `cumulativeChildCostUsd`
          // counter rather than the store's settled-child
          // sum, so a resumed run does NOT double-count
          // rehydrated handles whose cost flowed via prior
          // sessions. `task_async` reads this pre-spawn for
          // immediate UX feedback; the dispatcher
          // (`spawnSubagentImpl`) re-checks as the load-bearing
          // gate.
          getCostBudget: () => ({
            spent:
              priorCostUsd +
              totalCostUsd +
              cumulativeChildCostUsd +
              rehydratedChildCostUsd +
              (subagentHandleStore?.getReservedChildCostUsd() ?? 0),
            cap: budget.maxCostUsd,
          }),
          // Subagent budget lookup. Returns the definition's
          // `budget.maxCostUsd` worst-case spend for the named
          // subagent, or null when the name doesn't resolve.
          // `task_async` uses this to compute the pessimistic
          // reservation for the spawn it's about to issue.
          getSubagentBudgetEstimate: (name: string): number | null => {
            const def = config.subagentRegistry?.byName.get(name);
            if (def === undefined) return null;
            const cost = def.budget.maxCostUsd;
            return Number.isFinite(cost) && cost > 0 ? cost : 0;
          },
          // Sorted list of available subagent names. Empty when
          // no registry wired. `task_async` reads this to
          // populate the `subagent.unknown` error's
          // `available` field — same shape as sync `task`.
          getKnownSubagentNames: (): string[] =>
            config.subagentRegistry !== undefined
              ? Array.from(config.subagentRegistry.byName.keys()).sort()
              : [],
          // Pre-spawn refusal recorder (audit fix #3,
          // migration 023). Each subagent tool calls this
          // immediately before returning its
          // `subagent.budget_exhausted` / `subagent.unknown`
          // / `subagent.depth_exceeded` tool error. Fail-soft
          // try/catch — a DB throw at audit time MUST NOT
          // shadow the model-visible refusal: the error is
          // already on its way back; losing the audit row is
          // strictly worse than crashing the harness, but
          // crashing because we couldn't audit is worse than
          // either.
          recordGateDecision: (input) => {
            try {
              insertSubagentGateDecision(config.db, {
                parentSessionId: sessionId,
                decisionType: input.decisionType,
                toolName: input.toolName,
                requestedName: input.requestedName,
                details: input.details,
              });
            } catch (e) {
              // Inner try wraps `console.error` itself: in stdio
              // edge cases (EPIPE, exhausted stderr) the error
              // sink can throw, which would escape the outer
              // catch and propagate up through the tool's
              // execute path — defeating the entire fail-soft
              // promise. Audit data is the LEAST important
              // signal here; the tool-error return MUST land
              // even when both the DB write AND its diagnostic
              // fail.
              try {
                const message = e instanceof Error ? e.message : String(e);
                console.error(
                  `gate decision persist failed (${input.decisionType} for '${input.requestedName}'): ${message}`,
                );
              } catch {
                // Truly nothing left to do — let the tool error
                // through.
              }
            }
          },
          ...(config.memoryRegistry !== undefined ? { memoryRegistry: config.memoryRegistry } : {}),
          ...(config.confirmMemoryWrite !== undefined
            ? { confirmMemoryWrite: config.confirmMemoryWrite }
            : {}),
          ...(config.confirmMemoryUserScope !== undefined
            ? { confirmMemoryUserScope: config.confirmMemoryUserScope }
            : {}),
          // Trust state — required on ToolContext, optional on
          // HarnessConfig. Default-false at the harness layer is
          // the fail-closed answer when bootstrap (or a test
          // harness) didn't supply one.
          isCwdTrusted: config.isCwdTrusted ?? false,
          // Operator-facing warn channel. Closure captures the
          // current tool call's id + name so the adapter can
          // attribute the warning to the right invocation.
          // Always wired — tools that don't use it just don't
          // call it. Optional in ToolContext for headless / SDK
          // contexts that don't construct via the harness; here
          // we always set it because we know the onEvent sink.
          emitWarn: (message: string) =>
            safeEmit(config.onEvent, {
              type: 'tool_warning',
              toolUseId: tu.id,
              toolName: tu.name,
              message,
            }),
          // Hook chain — bound to the same dispatcher invoke-tool
          // already uses. Tools fire blocking events (today only
          // memory_write fires MemoryWrite); chain failure is
          // null-returned so tools fail-open per spec line 1057.
          fireHook: dispatchHooks,
        });

        // Per-tu worker. Emits tool_invoking, dispatches through
        // invokeTool (permission check + checkpoint hook + tool
        // exec + audit), then emits tool_decided / tool_finished.
        // Returns a shape rich enough for the post-batch
        // consecutive-error replay plus the tool_result the
        // harness must persist.
        const invokeOne = async (
          tu: CollectedToolUse,
        ): Promise<{ toolResult: ProviderToolResultBlock; failed: boolean }> => {
          safeEmit(config.onEvent, {
            type: 'tool_invoking',
            toolUseId: tu.id,
            toolName: tu.name,
            args: tu.input,
          });
          const inv = await invokeTool(
            {
              toolUseId: tu.id,
              toolName: tu.name,
              args: tu.input,
              messageId: assistantMsg.id,
            },
            {
              db: config.db,
              registry: config.toolRegistry,
              engine: config.permissionEngine,
              ctx: buildCtx(tu),
              ...(config.planMode === true ? { planMode: true } : {}),
              ...(config.confirmPermission !== undefined
                ? { confirmPermission: config.confirmPermission }
                : {}),
              fireHook: dispatchHooks,
              signal,
            },
          );
          if (inv.decision !== null) {
            safeEmit(config.onEvent, {
              type: 'tool_decided',
              toolUseId: tu.id,
              decision: inv.decision,
            });
          }
          safeEmit(config.onEvent, {
            type: 'tool_finished',
            toolUseId: tu.id,
            toolName: tu.name,
            failed: inv.failed,
            durationMs: inv.durationMs,
            ...(inv.denied === true ? { denied: true } : {}),
          });
          return { toolResult: inv.toolResult, failed: inv.failed };
        };

        // Pre-batch abort gate. Both paths defer to the same check
        // up here — without this, a hard abort or a soft cooperative
        // stop landing between the provider call and the dispatch
        // could still kick off tool work the harness was asked not
        // to do. Wall-clock-vs-user-abort distinction matches the
        // top-of-loop check (without it a wall-clock timeout
        // landing here would get misreported as a user abort).
        if (signal.aborted) {
          return isWallClockTimeout()
            ? await finish('maxWallClockMs')
            : await finish('aborted', undefined, 'hard');
        }
        if (config.softStopSignal?.aborted === true) {
          return await finish('aborted', undefined, 'soft');
        }

        // Pre-batch degenerate-loop check (spec ORCHESTRATION.md
        // §1.6: "we do this BEFORE invocation so we can refuse
        // cheaply"). Iterates in tool_use order so the bail
        // message names the FIRST tu whose hash trips the cap,
        // mirroring the audit-friendly behavior the per-tu serial
        // path used to give. Fail-fast: as soon as one tu repeats
        // `maxRepeatedToolHash` times in the sliding window, the
        // entire step is refused — no tool runs.
        //
        // Detection runs against a LOCAL COPY of
        // `recentToolHashes` — the global buffer is only mutated
        // when a tool actually dispatches (serial loop body /
        // parallel `safeInvokeOne`). Without the local-copy
        // pattern, an early step exit (signal.aborted,
        // softStopSignal, maxToolErrors mid-batch) would leave
        // hashes in the global buffer for tools that never ran,
        // and a later step could trip `degenerateLoop` against
        // unexecuted call counts. The local pre-check still
        // detects in-batch duplicates AND batch-vs-history
        // duplicates, just without the side effect on the
        // global buffer.
        const preBatchHashes = [...recentToolHashes];
        for (const tu of collected.tool_uses) {
          const h = hashToolCall(tu.name, tu.input);
          preBatchHashes.push(h);
          if (preBatchHashes.length > HASH_WINDOW) preBatchHashes.shift();
          const repeats = preBatchHashes.filter((x) => x === h).length;
          if (repeats >= budget.maxRepeatedToolHash) {
            return await finish(
              'degenerateLoop',
              `tool ${tu.name} called ${repeats} times with identical args in last ${HASH_WINDOW} calls`,
            );
          }
        }

        // Decide between the parallel and serial paths. Spec
        // ORCHESTRATION.md §1.3: every tool_use in the step must
        // carry `metadata.parallel_safe === true` for the harness
        // to dispatch in parallel. A single non-flagged tool
        // collapses the entire batch back to serial — mixing
        // modes inside one step would force the harness to pick
        // which order writes happen in vs. which reads can race,
        // and the simpler "all-or-nothing" invariant keeps
        // tool_result ordering deterministic for the model and
        // the audit log.
        //
        // The cap clamp matches `MAX_CONCURRENT_TOOL_CALLS_CAP`.
        // Operators can lower the budget to 1 to force serial
        // for a run without changing tool metadata.
        const parallelCap = Math.max(
          1,
          Math.min(budget.maxConcurrentToolCalls, MAX_CONCURRENT_TOOL_CALLS_CAP),
        );
        // Defense in depth against malformed metadata: a tool
        // that declares BOTH `parallel_safe: true` and
        // `writes: true` is a contract violation (the
        // ToolMetadata comment forbids it explicitly). The 6
        // builtins flagged today are clean, but a future plugin
        // / MCP-imported tool could declare both — refusing the
        // parallel path in that case keeps the FS-race
        // invariant load-bearing at runtime, not just at
        // documentation. A failed-but-still-parallel-safe tool
        // also gets caught here: any `writes` tool collapses
        // the batch to serial, which is the conservative
        // outcome.
        const allParallelSafe =
          collected.tool_uses.length >= 2 &&
          parallelCap >= 2 &&
          collected.tool_uses.every((tu) => {
            const tool = config.toolRegistry.get(tu.name);
            if (tool === null) return false;
            if (tool.metadata.writes === true) return false;
            return tool.metadata.parallel_safe === true;
          });

        const toolResults: ProviderToolResultBlock[] = [];

        if (allParallelSafe) {
          // Parallel path. Spec ORCHESTRATION.md §1.3.
          //
          // - All N tool_uses dispatch through `runPool` with a
          //   worker count clamped at `parallelCap`. Result
          //   indices preserve the original order so the
          //   tool_result blocks land in the shape Anthropic /
          //   OpenAI / Gemini all expect (tool_result blocks
          //   paired index-aligned with the assistant's tool_use
          //   blocks for that turn).
          // - Tool failures DO NOT cancel siblings (§1.3
          //   "falha de A não cancela B"). The pool waits for
          //   every worker to settle, then we fold the results.
          // - `consecutiveErrors` is replayed in original
          //   tool_use order AFTER the batch settles. This
          //   preserves the "5 consecutive failures" semantics:
          //   if A,B,C all fail in one parallel batch and the
          //   prior step ended at 2 failures, the counter is
          //   now 5 (audit + replay match the serial path that
          //   would have executed A,B,C in sequence).
          // - On bail, EVERY result the batch produced is
          //   persisted (D167 — superseding D158's trim). The
          //   parallel batch already executed every sibling
          //   tool — its `tool_call` rows are in the DB,
          //   committed inside `invokeTool`. Trimming the
          //   message would leave orphan tool_calls referenced
          //   by an assistant tool_use block whose paired
          //   tool_result is missing — replay/recap consumers
          //   would diverge from the audit log. The bail still
          //   exits the run with `maxToolErrors`; the message
          //   accurately reflects what physically happened.
          // - Hard abort mid-batch: workers honor `ctx.signal`,
          //   so individual invokeTool calls return ToolError
          //   `aborted`. The pool still settles all workers
          //   (they return quickly via their own abort branch);
          //   the next top-of-step abort check exits with
          //   `aborted` / `maxWallClockMs`.
          // - Soft abort mid-batch: workers do NOT inspect
          //   `softStopSignal` — by spec design. The cooperative
          //   stop semantics is "complete the current step"
          //   (D173): the batch is the unit of work for one
          //   step, so we let every worker settle, persist the
          //   tool_results normally, and let the next
          //   top-of-step soft check (line ~497) exit with
          //   `aborted` / `'soft'` BEFORE the next provider
          //   call. Per-worker soft inspection would surface
          //   `aborted` tool_results for siblings that hadn't
          //   yet started — a hybrid state the spec doesn't
          //   describe and the model would have to translate.
          //   Keeping the batch atomic preserves the simple
          //   contract.
          // - `safeInvokeOne` wraps `invokeOne` with a
          //   try/catch (D168 — defense vs. `runPool`'s
          //   `Promise.all`-shaped failure mode). The contract
          //   for `invokeTool` is "tool errors return as data,
          //   never as throws"; if a future regression breaks
          //   that, a single throw would reject `Promise.all`
          //   and orphan sibling workers in flight. The wrapper
          //   converts unexpected throws into a synthesized
          //   error envelope so the pool always settles every
          //   worker.
          const safeInvokeOne = async (
            tu: CollectedToolUse,
          ): Promise<{ toolResult: ProviderToolResultBlock; failed: boolean }> => {
            // Pre-dispatch abort guard. Mirror the serial path's
            // top-of-iteration `if (signal.aborted) finish(...)`
            // — the run signal MUST stop dispatch of queued
            // tool_uses, not just signal already-running tools
            // to self-cancel. Without this guard, `runPool`
            // workers continue dequeuing after Ctrl+C / wall-
            // clock landed, invoking tools whose own
            // `ctx.signal` self-check is the only thing that
            // would prevent side effects. Soft-stop also routes
            // here so a cooperative cancel mid-batch behaves
            // identically.
            //
            // The synthesized result is a placeholder: the
            // post-pool abort gate (right below) discards
            // `toolResults` entirely on `signal.aborted` /
            // `softStopSignal.aborted`, mirroring the serial
            // path's "no partial tool_result message on abort"
            // contract. We still need to RETURN something so
            // `runPool` settles every worker. `failed: false`
            // keeps the outcome out of `consecutiveErrors` —
            // an aborted dispatch is not a tool failure.
            if (signal.aborted || config.softStopSignal?.aborted === true) {
              return {
                toolResult: {
                  type: 'tool_result',
                  tool_use_id: tu.id,
                  name: tu.name,
                  content: 'tool dispatch skipped: run aborted before invocation',
                  is_error: true,
                },
                failed: false,
              };
            }
            // Track the dispatch hash NOW (after abort guard,
            // before invokeOne). Workers that take the
            // abort-skipped branch above NEVER reach this line,
            // so unexecuted calls don't pollute the global
            // `recentToolHashes`. JS is single-threaded so
            // concurrent workers' pushes serialize without
            // races; the buffer's only invariant is "every
            // entry corresponds to a real dispatch", which
            // this site preserves.
            const callHash = hashToolCall(tu.name, tu.input);
            recentToolHashes.push(callHash);
            if (recentToolHashes.length > HASH_WINDOW) recentToolHashes.shift();
            // Track the dispatched-tool count for the
            // `parallel_status` event. The runPool worker
            // calls this wrapper for one tu; bracket the
            // invokeOne with increment/decrement so the live
            // figure reflects "tools actually inside their
            // execute() right now". JS single-threaded
            // serializes these mutations across workers, so
            // the value is monotonic per transition.
            parallelToolsRunning += 1;
            emitParallelStatus();
            try {
              return await invokeOne(tu);
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              return {
                toolResult: {
                  type: 'tool_result',
                  tool_use_id: tu.id,
                  name: tu.name,
                  content: `internal harness error: ${message}`,
                  is_error: true,
                },
                failed: true,
              };
            } finally {
              parallelToolsRunning -= 1;
              emitParallelStatus();
            }
          };
          // Snapshot the cap BEFORE the pool runs so the
          // first emit (from the first worker entering
          // safeInvokeOne) carries the right denominator. The
          // pool's actual concurrency is `min(cap,
          // tool_uses.length)` so we use that — matches what
          // an operator counts visually as "tools running /
          // tools possible right now".
          parallelToolsCap = Math.max(1, Math.min(parallelCap, collected.tool_uses.length));
          emitParallelStatus();
          const outcomes = await runPool(collected.tool_uses, parallelCap, safeInvokeOne);
          // Reset cap after the batch settles. With cap=0 the
          // TUI footer's `tools R/cap` chip suppresses,
          // returning the operator's view to "no parallel
          // tools right now".
          parallelToolsCap = 0;
          emitParallelStatus();

          // Post-pool abort gate. Mirrors the serial path's
          // per-iteration check — once the run signal flipped
          // mid-batch, finish() takes precedence over message
          // append + bailCounter handling. Discarding the
          // partial toolResults preserves the existing
          // contract: an interrupted run does NOT leave a
          // half-baked tool_result message in the transcript.
          // Some workers may have produced real results before
          // the abort landed; those are still authoritative
          // in-memory but the conservative choice (matching
          // serial) is to skip the append.
          if (signal.aborted) {
            return isWallClockTimeout()
              ? await finish('maxWallClockMs')
              : await finish('aborted', undefined, 'hard');
          }
          // Local rebind forces TS to re-narrow on a fresh
          // read; the `: boolean` annotation breaks the
          // optional-chain undefined narrowing. Same trick as
          // the serial path's per-iteration soft-abort
          // re-check.
          const softAbortedPostPool: boolean = config.softStopSignal?.aborted ?? false;
          if (softAbortedPostPool) {
            return await finish('aborted', undefined, 'soft');
          }
          let bailCounter = -1;
          for (const o of outcomes) {
            toolResults.push(o.toolResult);
            if (o.failed) {
              consecutiveErrors += 1;
            } else {
              consecutiveErrors = 0;
            }
            // Snapshot the counter the FIRST time it crosses
            // the cap. Any later outcome (a sibling success
            // would reset to 0; a sibling failure would keep
            // climbing) shouldn't change the reason we report —
            // the run was condemned at the moment of the first
            // crossing.
            if (consecutiveErrors >= budget.maxToolErrors && bailCounter === -1) {
              bailCounter = consecutiveErrors;
            }
          }
          if (bailCounter !== -1) {
            const partialMsg = appendMessage(config.db, {
              sessionId,
              role: 'user',
              parentId: lastMessageId,
              content: toolResults,
            });
            lastMessageId = partialMsg.id;
            messages.push({ role: 'user', content: toolResults });
            return await finish('maxToolErrors', `${bailCounter} consecutive tool errors`);
          }
        } else {
          // Serial path — historical behavior. Sibling iterations
          // honor signal / softStop between calls so a Ctrl+C
          // lands as soon as the in-flight tool returns instead
          // of after the last tu of the step.
          for (const tu of collected.tool_uses) {
            if (signal.aborted) {
              return isWallClockTimeout()
                ? await finish('maxWallClockMs')
                : await finish('aborted', undefined, 'hard');
            }
            // Re-check via local assignment forces TS to re-narrow
            // on every iteration — without this, the outer
            // top-of-step soft check would have narrowed the
            // value at this scope. The `: boolean` annotation
            // breaks TS's narrowing of the optional chain even
            // though the runtime read is fresh; the chained
            // `?? false` collapses the optional-chain undefined
            // to false at the type level.
            const softAborted: boolean = config.softStopSignal?.aborted ?? false;
            if (softAborted) {
              return await finish('aborted', undefined, 'soft');
            }
            // Track the dispatch hash NOW (after abort/soft
            // checks, before invokeOne). The pre-batch detection
            // ran against a local copy; this is the only site
            // that mutates the global `recentToolHashes`. Skipped
            // tools (signal.aborted between iterations) never
            // reach this line, so unexecuted calls don't
            // pollute the buffer.
            const callHash = hashToolCall(tu.name, tu.input);
            recentToolHashes.push(callHash);
            if (recentToolHashes.length > HASH_WINDOW) recentToolHashes.shift();
            const inv = await invokeOne(tu);
            toolResults.push(inv.toolResult);
            if (inv.failed) {
              consecutiveErrors += 1;
            } else {
              consecutiveErrors = 0;
            }
            if (consecutiveErrors >= budget.maxToolErrors) {
              // Persist the partial tool_result message before
              // bailing so the session history reflects what
              // actually happened. Mirror it in the in-memory
              // `messages` array for symmetry with the normal
              // path; nothing reads it post-bail today, but a
              // future refactor that does (resume, replay) gets
              // a consistent view.
              const partialMsg = appendMessage(config.db, {
                sessionId,
                role: 'user',
                parentId: lastMessageId,
                content: toolResults,
              });
              lastMessageId = partialMsg.id;
              messages.push({ role: 'user', content: toolResults });
              return await finish('maxToolErrors', `${consecutiveErrors} consecutive tool errors`);
            }
          }
        }

        // Persist tool_results back as a user message; mirror them in the
        // running provider message list for the next turn.
        const resultMsg = appendMessage(config.db, {
          sessionId,
          role: 'user',
          parentId: lastMessageId,
          content: toolResults,
        });
        lastMessageId = resultMsg.id;
        messages.push({ role: 'user', content: toolResults });

        // Compaction trigger check. Estimate the FULL outbound prompt
        // — messages + system + tool schemas — against the threshold.
        // Tool schemas alone run 2-4k tokens each per CONTEXT_TUNING.md
        // §2.1; a long system prompt adds another 0.5-3k. Counting only
        // `messages` undercounts the trigger and lets the next request
        // sail over the cap when the surrounding overhead is what's
        // pushing it close.
        //
        // estimatePromptTokens is the local chars/4 heuristic: free
        // (no HTTP), conservative (overestimates by ~10-25% vs real
        // tokenizers), good enough for a 70%-of-window threshold that
        // already includes a buffer.
        //
        // DB messages stay untouched; only the in-memory `messages`
        // array sent to the provider gets rewritten. Audit + replay can
        // re-derive from the full history if they ever need a different
        // compaction policy.
        // Skip when the budget is exhausted: compaction would issue a
        // billed summary call right before the loop's top-of-iteration
        // check exits with `maxSteps` anyway. Same logic as the
        // signal.aborted guard — don't burn tokens on work whose
        // result will never be used.
        if (
          !signal.aborted &&
          steps < budget.maxSteps &&
          config.provider.capabilities.context_window > 0
        ) {
          const promptTokens = estimatePromptTokens(messages, {
            ...(config.systemPrompt !== undefined ? { system: config.systemPrompt } : {}),
            ...(tools.length > 0 ? { tools } : {}),
          });
          const contextWindow = config.provider.capabilities.context_window;
          const triggerAt = budget.compactionThreshold * contextWindow;
          // Guard: requires at least goal + something-to-fold + an
          // assistant boundary for the tail. compactMessages will skip
          // (and emit a noisy started/finished pair) for shorter
          // histories; check here so we don't fire the events at all.
          // `+ 2` accounts for the assistant-boundary alignment the
          // module performs — naive `1 + tail` could pass even when
          // the alignment shift collapses the middle to empty.
          if (promptTokens > triggerAt && messages.length >= budget.compactionPreserveTail + 3) {
            // PreCompact hook chain (spec AGENTIC_CLI.md §10.1,
            // blocking). Fired BEFORE the compaction_started event
            // so an operator hook that refuses compaction (e.g.,
            // policy: preserve full transcript for audit) skips
            // both the LLM call AND the renderer's "compacting…"
            // signal — the operator's intent is the compaction
            // never happened. block_silent / block_message both
            // skip; failClosed error/timeout same. fail-open on
            // dispatch error per spec line 1057.
            const preCompact = await dispatchHooks({
              schema: 'v1',
              event: 'PreCompact',
              sessionId,
              data: { promptTokens, threshold: triggerAt },
            });
            if (preCompact !== null && preCompact.blockedBy !== null) {
              // Skip compaction this turn. Loop continues with the
              // un-compacted message list; if tokens still over
              // threshold next turn, the hook fires again. The
              // hook_runs row is the audit trail.
              continue;
            }
            safeEmit(config.onEvent, {
              type: 'compaction_started',
              promptTokens,
              threshold: triggerAt,
              contextWindow,
            });
            const compactStart = Date.now();
            const compaction = await compactMessages(config.provider, messages, {
              preserveTail: budget.compactionPreserveTail,
              signal,
            });
            // In-place replace so the caller's reference (none today,
            // but defensive) sees the new history without reassignment.
            messages.length = 0;
            messages.push(...compaction.messages);

            // Compaction's LLM call (when it ran) is a billed provider
            // request — fold its usage into session totals. Skipping
            // this would systematically underreport spend on every
            // compacting session, defeating the whole point of the
            // per-session cost tracking. The 'skipped' strategy never
            // made a call so contributes zero (emptyUsage); 'fallback'
            // contributes whatever partial usage arrived before the
            // failure (some providers emit usage on stream errors).
            const compactionCost = computeCost(config.provider.capabilities, compaction.usage);
            totalUsage = addUsage(totalUsage, compaction.usage);
            totalCostUsd += compactionCost;
            emitCostUpdate(compactionCost);
            // If the compaction call MADE a provider request (llm or
            // fallback strategy) but didn't see usage telemetry, the
            // session total is now a lower bound — same conservative
            // logic as the per-turn check.
            if (compaction.strategy !== 'skipped' && !compaction.usageSeen) {
              usageComplete = false;
            }

            const finishedEvent: HarnessEvent = {
              type: 'compaction_finished',
              strategy: compaction.strategy,
              foldedCount: compaction.foldedCount,
              durationMs: Date.now() - compactStart,
              usage: compaction.usage,
              costUsd: compactionCost,
              ...(compaction.reason !== undefined ? { reason: compaction.reason } : {}),
            };
            safeEmit(config.onEvent, finishedEvent);

            // Compaction's billed call can push the cumulative
            // total past the cap on its own. Check after the
            // event is emitted (renderers should still see the
            // compaction_finished event) but before the next
            // top-of-loop iteration would issue a provider call.
            const overage = costCapDetailIfExceeded();
            if (overage !== null) return await finish('maxCostUsd', overage);
          }
        }
      }
    } catch (e) {
      return await guardedFinish(e);
    }
  } finally {
    // Drain the lazy retention sweep BEFORE anything else in the
    // finally fires. The caller (cli/run.ts) is allowed to close the
    // DB right after runAgent returns; without this drain the purge
    // would race against db.close() and hit a closed sqlite handle.
    // The .catch() chain at construction already absorbed errors, so
    // the await here is purely a synchronization point.
    if (checkpointsPurgeInFlight !== undefined) {
      try {
        await checkpointsPurgeInFlight;
      } catch {
        // Already swallowed at construction; defensive.
      }
    }
    // Drain the subagent handle store before bgManager cleanup —
    // each subagent run holds its own bg processes, and we want
    // those rows to land before the parent's bg manager tears
    // its own pids down. Drain cancels every still-running record
    // and awaits all promises (including the cancelled-before-
    // dispatch synthesis), so a hard parent abort still leaves
    // children with a clean termination point. Errors are
    // swallowed; the store's allSettled already absorbs them.
    if (subagentHandleStore !== undefined) {
      try {
        await subagentHandleStore.drain('parent_drain');
      } catch {
        // Defensive — drain itself uses Promise.allSettled, so
        // this shouldn't fire in practice. Catching keeps the
        // cleanup path resilient to any future code path that
        // synchronously throws before the await.
      }
    }
    if (bgManager !== undefined) {
      try {
        await bgManager.cleanup();
      } catch {
        // Best-effort; cleanup failures must not mask the run result
        // or escape the harness boundary. Any zombies left behind
        // are visible via the background_processes audit table.
      }
    }
    // Defensive: drop the in-memory TodoList for this session.
    // The store is currently a function-local Map (created on
    // line ~125) so GC reclaims it when runAgent returns — the
    // clear is redundant in today's ownership model. Kept for
    // forward compatibility: if the store is ever hoisted to a
    // process-level singleton (e.g., daemon mode running multiple
    // sessions in one process), this hook is what prevents
    // accumulation. Idempotent on unknown / empty sessionId.
    todoStore.clear(sessionId);
  }
};
