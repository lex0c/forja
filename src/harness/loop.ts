import { createHash } from 'node:crypto';
import { type BgManager, createBgManager } from '../bg/index.ts';
import {
  type CheckpointManager,
  createCheckpointManager,
  detectCheckpointSupport,
} from '../checkpoints/index.ts';
import { maybeRewriteBashCommand } from '../feedback/dispatch-rewrite.ts';
import { emitToolCallOutcome } from '../feedback/outcome-emitter.ts';
import { buildScopeChain } from '../feedback/scope-detect.ts';
import { dispatchChain, type HookChainResult, type HookEventPayload } from '../hooks/index.ts';
import { resolveRepoRoot } from '../memory/paths.ts';
import type { RecalledMemory } from '../memory/proactive-recall.ts';
import { createScopeFilteredRegistry, type MemoryRegistry } from '../memory/registry.ts';
import {
  createSemanticVerifyScheduler,
  type SemanticVerifyScheduler,
} from '../memory/verify-semantic-scheduler.ts';
import {
  deriveParentCapabilities,
  formatCapability,
  intersectCapabilities,
  parseCapability,
} from '../permissions/capabilities.ts';
import { createDegradedBannerEmitter } from '../permissions/degraded-banner.ts';
import { computeCost } from '../providers/cost.ts';
import type { ProviderToolDef, ProviderToolResultBlock, StreamEvent } from '../providers/index.ts';
import { projectRecap } from '../recap/projection.ts';
import { buildResumeContext, shouldSkipResumeContext } from '../recap/resume-context.ts';
import { redactSecrets } from '../sanitize/secrets.ts';
import { createSession, getSession, reopenSession, type SessionStatus } from '../storage/index.ts';
import { createContextPinsStore } from '../storage/repos/context-pins.ts';
import { createDispatchRewrite } from '../storage/repos/dispatch-rewrites.ts';
import { getEagerProvenanceKeys, recordProvenance } from '../storage/repos/memory-provenance.ts';
import { createSubagentHandleStore, type SubagentHandleStore } from '../subagents/handle-store.ts';
import { createTodoStore, type TodoStore } from '../todo/index.ts';
import { rankDeferredTools } from '../tools/builtin/tool-search.ts';
import { isDeferred, isSmallWindow } from '../tools/context-budget.ts';
import type { ToolContext } from '../tools/index.ts';
import type {
  SearchToolsResult,
  SpawnSubagentArgs,
  SpawnSubagentResult,
  ToolSearchHit,
} from '../tools/types.ts';
import { createWorkingStateStore, type WorkingStateStore } from '../working-state/index.ts';
import { StepStallError } from './abortable.ts';
import { buildAssistantContent } from './assistant-content.ts';
import { type CollectedStep, type CollectedToolUse, CollectStepError } from './collect.ts';
import { runMaybeCompact } from './compaction-controller.ts';
import { CostAccountant } from './cost-accountant.ts';
import { resolveProviderEffort } from './effort.ts';
import { safeEmit } from './emit.ts';
import {
  type ExhaustionSynthesisResult,
  endsWithSettledAnswer,
  synthesizeOnExhaustion,
} from './exhaustion-synthesis.ts';
import { invokeTool } from './invoke-tool.ts';
import {
  createProactiveRecall,
  injectProactiveMemoryBlock,
  type ProactiveRecallCacheEntry,
  recordProactiveExposures,
  resolveCachedRecall,
} from './proactive-memory-inject.ts';
import { buildGenerateRequest, collectProviderStep } from './provider-turn.ts';
import { MAX_RESUME_MESSAGES } from './resume.ts';
import { type HydrateInfo, SessionContext } from './session-context.ts';
import { injectStaticGuidance } from './static-guidance.ts';
import { dispatchSubagent } from './subagent-dispatcher.ts';
import { finalizeSession, type TerminalSessionStatus } from './terminal.ts';
import { buildToolContext } from './tool-context.ts';
import {
  type ExitReason,
  effectiveBudget,
  type HarnessConfig,
  type HarnessEvent,
  type HarnessResult,
  isRecapEnabled,
  MAX_CONCURRENT_SUBAGENTS_CAP,
  MAX_CONCURRENT_TOOL_CALLS_CAP,
  type RunBudget,
  resolveMaxOutputTokens,
} from './types.ts';
import {
  createVerifyState,
  MAX_VERIFY_ATTEMPTS,
  recordToolForVerify,
  unsatisfiedVerifyCommands,
  verifyGateNudge,
} from './verify-gate.ts';
import { injectWorkingStateBlock } from './working-state-inject.ts';

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
  maxContextTokens: 'exhausted',
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
  maxContextTokens: 'exhausted',
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

// One-line blurb for the tool_search catalog: the description's first sentence,
// capped. Enough for the model to decide whether to reveal the tool, at ~1/4 the
// tokens of the full schema it replaces in the base surface.
const toolBlurb = (desc: string): string => {
  const dot = desc.indexOf('. ');
  const firstSentence = dot > 0 ? desc.slice(0, dot + 1) : desc;
  return firstSentence.length > 110 ? `${firstSentence.slice(0, 107)}...` : firstSentence;
};

// The deferred tools that are ALSO surface-available right now: deferred AND
// past the same operator-confirm / reminder-scheduler gates the base filter
// applies. A headless run (no confirmPermission / reminderScheduler) hides
// memory_write / reminder_* via those gates even when revealed — so advertising
// them in the catalog or "revealing" them via tool_search would dead-end the
// model on a tool that never enters the surface. Single source of truth for both
// the catalog and the searchTools reveal pool, so the two can't diverge from the
// base filter.
const availableDeferredTools = (config: HarnessConfig) => {
  // Window-relative deferral (CONTEXT_TUNING §2.2): a tool is deferred either by
  // its static `deferred` flag or because the live window is below its
  // `deferBelowTokens` tier. Read live so a mid-session `/model` swap re-leans
  // the catalog on the next turn (buildToolDefs re-runs per turn). Optional-chained:
  // an absent/partial provider (test stubs, degraded config) reads as 0 = unknown
  // window, which disables the window-relative arm (static behavior preserved).
  const contextWindow = config.provider?.capabilities?.context_window ?? 0;
  return config.toolRegistry
    .list()
    .filter(
      (t) =>
        isDeferred(t.metadata, contextWindow) &&
        (config.confirmPermission !== undefined || t.metadata.requiresOperatorConfirm !== true) &&
        (config.reminderScheduler !== undefined || t.metadata.requiresReminderScheduler !== true),
    );
};

// A `requiresOperatorConfirm` tool can only run where an operator
// surface is wired: the REPL wires the confirm hooks (confirmPermission
// + clarify + the memory confirms), while headless one-shot / SDK
// callers leave them unset. Offering such a tool there is a lie — the
// model would call it and get `*.modal_unavailable`, after being nudged
// toward it by the "Ask, don't presume" constraint. `confirmPermission`
// is the marker of an interactive operator session (always wired by the
// REPL, never by `run.ts`), so gate on it: the model only sees these
// tools when they can actually resolve, and otherwise falls back to
// recording the assumption.
export const buildToolDefs = (
  config: HarnessConfig,
  revealed?: ReadonlySet<string>,
): ProviderToolDef[] => {
  const operatorPresent = config.confirmPermission !== undefined;
  // The reminder family only resolves against a session-scoped scheduler
  // (ORCHESTRATION.md §3B.9), which only the interactive REPL builds — a
  // one-shot run and a subagent have no next turn to wake, so they get no
  // scheduler. Hide those tools from the surface there rather than show a
  // tool the model would only get `scheduler_unavailable` from. Same
  // shape as the operator-confirm gate above.
  const reminderAvailable = config.reminderScheduler !== undefined;
  // Deferred tools (AGENTIC_CLI §7.6) leave the base surface until `tool_search`
  // reveals them; `revealed` is sticky for the session, so a tool fetched in one
  // turn rides every later turn's list. Only at the TOP LEVEL — a subagent
  // (depth > 0) runs against a registry already narrowed to its `tools[]`
  // whitelist, which IS the curation, so a whitelisted-but-deferred tool must
  // stay directly visible (no tool_search round-trip in a headless child).
  const applyDeferral = (config.subagentDepth ?? 0) === 0;
  // Window-relative deferral tier (CONTEXT_TUNING §2.2): on top of the static
  // `deferred` flag, a base-but-dispensable tool leaves the surface when the live
  // window is below its `deferBelowTokens`. Read live so a `/model` swap re-leans
  // the surface next turn (buildToolDefs re-runs per turn, top-of-loop rebuild).
  // Optional-chained: absent/partial provider → 0 = unknown window → window arm
  // disabled (static behavior preserved for test stubs and degraded configs).
  const contextWindow = config.provider?.capabilities?.context_window ?? 0;
  // Catalog appended to tool_search's description: the deferred tools NOT yet
  // revealed (name + one-line blurb), generated from the registry so it never
  // drifts from what's actually deferred. This is how the model learns what it
  // can search for. Empty when nothing is deferred (or in a subagent) — then
  // tool_search carries only its base description.
  const catalogTools = applyDeferral
    ? availableDeferredTools(config).filter((t) => revealed?.has(t.name) !== true)
    : [];
  const catalog =
    catalogTools.length > 0
      ? `\n\nDeferred tools — search to reveal, then call (stays available for the session):\n${catalogTools
          .map((t) => `- ${t.name} — ${toolBlurb(t.description)}`)
          .join('\n')}`
      : '';
  return config.toolRegistry
    .list()
    .filter((t) => operatorPresent || t.metadata.requiresOperatorConfirm !== true)
    .filter((t) => reminderAvailable || t.metadata.requiresReminderScheduler !== true)
    .filter(
      (t) =>
        !applyDeferral || !isDeferred(t.metadata, contextWindow) || revealed?.has(t.name) === true,
    )
    .map((t) => ({
      name: t.name,
      description: t.name === 'tool_search' ? `${t.description}${catalog}` : t.description,
      input_schema: t.inputSchema,
    }));
};

// Strip `name` from the tool model so it stays inside our domain — providers
// expect their own format already constructed by the adapter.

export const runAgent = async (config: HarnessConfig): Promise<HarnessResult> => {
  const budget: RunBudget = effectiveBudget(config.budget, config.effort);
  const startMs = Date.now();

  // Combine the caller's abort signal with a wall-clock timer so the cap
  // fires even when a provider call hangs mid-step (between-step checks
  // miss this case). AbortSignal.any composes them; either firing aborts
  // downstream provider/tool work via the canonical signal.
  const wallClockController = new AbortController();
  const wallClockTimer = setTimeout(() => wallClockController.abort(), budget.maxWallClockMs);
  const callerSignal = config.signal ?? new AbortController().signal;
  const signal = AbortSignal.any([callerSignal, wallClockController.signal]);

  // Single in-memory source of truth for this run's conversation
  // (project_message_single_source). Resolved in the session-decision
  // block below — reused (REPL multi-turn), hydrated from the DB log
  // (resume/preassigned), or fresh. `| undefined` only until that
  // block runs; a guard right after it narrows the rest of the loop.
  let ctx: SessionContext | undefined;
  // Resume-truncation diagnostics captured by hydrateFromDb (resume path).
  let hydrateInfo: HydrateInfo | null = null;
  // Deferred-tool surface (AGENTIC_CLI §7.6). `revealed` accumulates the tools
  // tool_search has surfaced; `tools` is rebuilt from base+revealed whenever it
  // grows (sticky). `toolsDirty` defers the rebuild to the top of the next
  // iteration so a reveal mid-step takes effect on the next provider call — one
  // cache invalidation per fetch, then stable.
  // Sourced from config so a multi-turn caller (REPL) injects ONE set and reveals
  // stay sticky ACROSS turns (each turn re-runs runAgent); a one-shot run gets a
  // fresh per-run set — sticky within that run. Same contract as todoStore.
  const revealed = config.revealedTools ?? new Set<string>();
  let toolsDirty = false;
  let tools = buildToolDefs(config, revealed);
  // Search + reveal closure wired into ctx.searchTools at the top level only.
  // Ranking is the pure `rankDeferredTools` (unit-tested); here we just map the
  // matched names back to live tools, REVEAL them (sticky → `toolsDirty` forces
  // a rebuild next iteration), and return wire hits so the model gets the
  // schemas in the result.
  const searchTools = (query: string): SearchToolsResult => {
    // Same gated pool as the catalog: a deferred tool the operator/reminder gates
    // would still drop is not revealable (else `select:memory_write` headless
    // returns a fake hit the surface never honors).
    const deferred = availableDeferredTools(config);
    const { names, notFound } = rankDeferredTools(deferred, query);
    const byName = new Map(deferred.map((t) => [t.name, t]));
    const hits: ToolSearchHit[] = [];
    for (const name of names) {
      const tool = byName.get(name);
      if (tool === undefined) continue;
      if (!revealed.has(name)) {
        revealed.add(name);
        toolsDirty = true;
      }
      hits.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
    }
    return { tools: hits, notFound };
  };
  const recentToolHashes: string[] = [];
  const HASH_WINDOW = 10;

  let steps = 0;
  let consecutiveErrors = 0;
  // Claim-time verify gate (STATE_MACHINE §3.2.1). Opt-in: an empty
  // `verify.commands` makes the gate a no-op. `verifyState` accumulates
  // mutation + passing-verify-command evidence across the run; `verifyAttempts`
  // bounds the re-nudge at `no_tool_use`.
  const verifyCommands = config.verify?.commands ?? [];
  const verifyState = createVerifyState();
  let verifyAttempts = 0;
  // A budget exhaustion (maxSteps synthesis / maxCostUsd) finishes with an
  // answer in hand but no room to nudge for verification — trace an unverified
  // edit so those exits aren't a silent bypass of the gate's guarantee, matching
  // the no_tool_use exhaustion's accept-with-trace. No-op when the gate is off
  // or the run verified / never mutated.
  const traceUnverifiedAtExhaustion = (): void => {
    const unsatisfied = unsatisfiedVerifyCommands(verifyState, verifyCommands);
    if (unsatisfied.length > 0) {
      console.error(
        `forja: verify gate — budget exhausted with an unverified edit; not confirmed: ${unsatisfied.join(', ')}`,
      );
    }
  };
  let sessionId = '';
  // Repo root for scope-chain resolution. `config.cwd` is the
  // invocation directory; an operator starting the CLI from a
  // subdirectory of a repo would otherwise see policy / outcome
  // scope_ids fragment per-subdirectory, so a `repo`-scoped policy
  // promoted from one folder wouldn't apply when dispatching from
  // another. `resolveRepoRoot` runs `git rev-parse --show-toplevel`
  // once per run (cheap — config.cwd is stable across the session
  // by the resume cwd-mismatch check) and falls back to config.cwd
  // outside a git checkout. Language detection benefits too:
  // markers (package.json, Cargo.toml, etc.) live at the repo root,
  // not in arbitrary subdirectories.
  const repoRoot = resolveRepoRoot(config.cwd);
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
  // todo tools see a fresh list, and torn down in the outer
  // finally so accumulated state from a long-lived process doesn't
  // leak across sessions. Spec §7.4: not persisted, work-state only.
  //
  // The bare store is a pure data structure; observability is layered
  // on at the harness boundary by wrapping `set` to emit a
  // `todo_updated` HarnessEvent after the write lands. Wrapping rather
  // than mutating the store keeps test contexts that build a store
  // directly free of the emit dependency. `clear` is NOT wrapped —
  // session-end cleanup is not a planning event (D132).
  // Injected by a multi-turn caller (REPL) so the list persists across
  // turns; a one-shot run gets a fresh per-run store (cleared below).
  const baseTodoStore = config.todoStore ?? createTodoStore();
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
    // nextId is not an observable mutation — it just hands out the next
    // id; the row lands via a later set() that emits. Plain pass-through.
    nextId: (sid) => baseTodoStore.nextId(sid),
    clear: (sid) => baseTodoStore.clear(sid),
  };
  // Working-state panel store — same ownership + emit pattern as todoStore.
  // Injected by the REPL so the panel persists across turns; a one-shot run
  // gets a fresh per-run store (cleared below). The set() wrapper emits
  // `working_state_updated` so the TUI / telemetry can track mutation rate
  // (WORKING_STATE.md §4.4). clear() stays unwrapped — session-end cleanup.
  const baseWorkingStateStore = config.workingStateStore ?? createWorkingStateStore();
  const workingStateStore: WorkingStateStore = {
    get: (sid) => baseWorkingStateStore.get(sid),
    set: (sid, state) => {
      baseWorkingStateStore.set(sid, state);
      safeEmit(config.onEvent, {
        type: 'working_state_updated',
        sessionId: sid,
        state: baseWorkingStateStore.get(sid),
      });
    },
    nextId: (sid) => baseWorkingStateStore.nextId(sid),
    tickStep: (sid) => baseWorkingStateStore.tickStep(sid),
    currentStep: (sid) => baseWorkingStateStore.currentStep(sid),
    clear: (sid) => baseWorkingStateStore.clear(sid),
  };
  // Like the todo store: the REPL injects a contextPinsStore so /pin and
  // pin_context share one; a one-shot run gets a fresh wrapper over the same
  // db. Built once per run (the store is stateless over the db) and reused in
  // buildCtx, rather than re-wrapping on every tool call.
  const contextPinsStore = config.contextPinsStore ?? createContextPinsStore(config.db);
  // §4.4 P2 — proactive memory injection. Built once, primary-agent-only
  // (`subagentDepth === 0`, the same primary signal the sibling memory
  // detectors gate on — a subagent must not proactively inject), when the
  // flag is on and a registry is wired. The view is trusted+active+
  // loadBodies (I3) and mirrors the trust-probe scope posture. `undefined`/false
  // → the injection site below is a no-op. (Product default is ON, resolved into
  // config.memoryProactiveInject by bootstrap.)
  const proactiveRecall =
    config.memoryProactiveInject === true &&
    (config.subagentDepth ?? 0) === 0 &&
    config.memoryRegistry !== undefined
      ? createProactiveRecall({
          registry: config.memoryRegistry,
          ...(config.memoryExcludeScopes !== undefined && config.memoryExcludeScopes.length > 0
            ? { excludeScopes: config.memoryExcludeScopes }
            : {}),
        })
      : undefined;
  // Per-session recall cache (the P3 gate): recompute only when the working-
  // state focus changes; re-inject the cached result each step. Function-
  // local — dies with the run, like todoStore.
  const proactiveCache = new Map<string, ProactiveRecallCacheEntry>();
  // The recall for the CURRENT step, computed at the top of the loop (before
  // maybeCompact) so its injected body size is counted in the compaction /
  // output-fit decision; the injection site below consumes it. `recomputed`
  // drives the provenance write (recompute = the working-state focus changed).
  let proactiveRecalled: RecalledMemory[] = [];
  let proactiveRecomputed = false;
  // Cost/budget accountant (N2 — extracted to cost-accountant.ts). Owns the
  // run's cost state (per-run totals, prior-run cumulative, this-run + prior-run
  // child cost, the soft-cap latch) and the write seam runAgent already used
  // inline: recordUsage / markUsageIncomplete / emitCostUpdate / costCapDetail —
  // the exact callbacks it injects into `synthesizeOnExhaustion`. HarnessResult
  // reports the per-run totals (acct.runCostUsd / runUsage) while the persisted
  // column stays cumulative (prior + run). `getSessionId` and
  // `getReservedChildCostUsd` are lazy because `sessionId` (400) starts '' and
  // the handle store (426) is built later; the resume seed / child rehydrate
  // arrive via seedFromResume / setRehydratedChildCost during init.
  const acct = new CostAccountant({
    db: config.db,
    onEvent: config.onEvent,
    getSessionId: () => sessionId,
    maxCostUsd: budget.maxCostUsd,
    softCostUsd: budget.softCostUsd,
    getReservedChildCostUsd: (excludeHandleId) =>
      subagentHandleStore?.getReservedChildCostUsd(excludeHandleId) ?? 0,
  });
  // Thin closures over the accountant's function-valued seam so the many
  // existing call sites (and the `synthesizeOnExhaustion` injection) keep their
  // exact spelling. Arrow wrappers rather than bare `acct.method` references
  // because a class method passed unbound would lose `this`.
  const emitCostUpdate = (delta: number): void => acct.emitCostUpdate(delta);
  const costCapDetailIfExceeded = (): string | null => acct.costCapDetail();

  // Captured at resume init BEFORE reopenSession flips the row to
  // `running`. Used by the auto-rehydrate block (RECAP §3.2 +
  // STATE_MACHINE §7.6) for the skip-on-terminal predicate AND for
  // the `previousStatus` field in the emitted `[resume_context]`
  // event. Reading status from a fresh `getSession` after
  // `reopenSession` would always see `running` and (a) bypass the
  // `done`/`exhausted`/`error` skip gate and (b) report the
  // operator's prior status as `running` in the rehydrate event,
  // which is wrong on both counts.
  let preResumeStatus: SessionStatus | null = null;

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
  // Held in a mutable object so the extracted dispatcher
  // (subagent-dispatcher.ts) can set the latch across dispatches within the run.
  const capWatchdog = { fired: false };

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
    // Slice 181 — disableAllHooks short-circuit. Skip the chain
    // entirely when the kill switch is on, even with hooks
    // configured. The dispatcher honors the flag too (defense in
    // depth), but short-circuiting here avoids the wrapper
    // Promise + cleanup churn. Returning null mirrors the
    // "no hooks configured" path so call sites don't branch on
    // the discriminator.
    if (config.disableAllHooks === true) return null;
    if (config.hooks === undefined || config.hooks.length === 0) return null;
    const chain = (async (): Promise<HookChainResult | null> => {
      try {
        return await dispatchChain(config.hooks ?? [], payload, config.cwd, {
          db: config.db,
          sessionId: sessionId.length > 0 ? sessionId : null,
          ...(config.disableAllHooks !== undefined
            ? { disableAllHooks: config.disableAllHooks }
            : {}),
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

  // Idempotency backstop for `session_finished`: the harness contract is to
  // emit it EXACTLY once. Today `finish` is total — nothing throws after the
  // emit — so a double-emit is unreachable, but that once-only property rests
  // entirely on that discipline with no guard. If a future throwing `await`
  // ever lands after the emit, the outer catch → guardedFinish → finish would
  // re-enter and emit a second `session_finished`. This flag makes the
  // once-only invariant explicit and regression-proof (first step of the
  // terminal-FSM extraction, N1).
  let sessionFinishedEmitted = false;
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
    // N1: the session-end sequence (persist row, build result, outcome
    // signals, Stop hooks, gc-on-Stop, drain, recap) moved to
    // `finalizeSession` in terminal.ts — it takes an explicit snapshot of run
    // state instead of closing over these locals. This closure keeps only the
    // two bits that MUST live with the run: clearing the wall-clock timer
    // (above) and the guarded once-only `session_finished` emit (below).
    const result = await finalizeSession({
      config,
      reason,
      status: exitToStatus[reason],
      harnessStatus: exitToHarnessStatus[reason],
      ...(detail !== undefined ? { detail } : {}),
      ...(abortCause !== undefined ? { abortCause } : {}),
      sessionId,
      priorCostUsd: acct.priorCostUsd,
      totalCostUsd: acct.runCostUsd,
      priorUsageComplete: acct.priorUsageComplete,
      usageComplete: acct.runUsageComplete,
      totalUsage: acct.runUsage,
      steps,
      startMs,
      ctx,
      dispatchHooks,
      pendingHookChains,
    });
    if (!sessionFinishedEmitted) {
      sessionFinishedEmitted = true;
      safeEmit(config.onEvent, { type: 'session_finished', result });
    }
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
    acct.markUsageIncomplete();
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
  // maxWallClockMs window (default 24h).
  //
  // The outer try/finally is the session-end cleanup hook for any bg
  // processes (`bash_background` & co, M3 §7.3). Spawned processes
  // outlive a single turn, so when the loop exits — naturally, on
  // budget, on abort, or on internalError — we send SIGTERM to every
  // still-running child. Best-effort: cleanup errors are swallowed
  // so they don't mask the run's HarnessResult, and the DB is
  // converged via markRunningAsKilled inside cleanup() regardless of
  // whether the OS kill landed.
  //
  // S11 — declared outside the try so the outer finally can call
  // .shutdown() on it. Constructed inside the try once sessionId is
  // resolved (the scheduler captures it). Undefined when opt-in is
  // off / definition unavailable / running as a subagent child.
  let semanticVerifyScheduler: SemanticVerifyScheduler | undefined;
  // S13 parallel: conflict-detector scheduler. Same lifecycle posture
  // (top-level only, optional, declared at outer scope so the finally
  // block can shutdown() even on early throws).
  let conflictDetectorScheduler:
    | import('../memory/verify-conflict-scheduler.ts').ConflictDetectorScheduler
    | undefined;
  // S3 — verify-override scheduler. Same lifecycle posture (top-level
  // only, optional, declared at outer scope so the finally block can
  // shutdown() even on early throws).
  let overrideVerifyScheduler:
    | import('../memory/verify-override-scheduler.ts').OverrideVerifyScheduler
    | undefined;
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
      // Resume budget semantics: `steps` / `consecutiveErrors` and the
      // CostAccountant's per-run accumulators (run usage / cost /
      // usageComplete) start at zero/true — they drive HarnessResult,
      // which is per-run telemetry that has to stay self-consistent
      // (zero usage means zero cost, etc.). The CUMULATIVE state (prior
      // + this run) lives separately in the accountant's prior fields
      // and is only used at completeSession time so the persisted
      // column reflects the session's lifetime cost. The resume seed
      // lands via `acct.seedFromResume(...)` below. This separation
      // closes the bug where seeding the per-run cost from the row made
      // costUsd report cumulative while usage stayed per-run.
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
      const liveCtx = config.sessionContext;
      // Mutually exclusive: a live context (REPL reuse) skips all DB
      // derivation; resume reopens a finalized session; preassigned
      // uses a caller-created row. More than one set is a programmer
      // bug — fail loud rather than guess intent.
      if ([liveCtx, resumeId, preassignedId].filter((x) => x !== undefined).length > 1) {
        throw new Error(
          'HarnessConfig: sessionContext, resumeFromSessionId, and preassignedSessionId are mutually exclusive',
        );
      }
      if (liveCtx !== undefined) {
        // Reuse path (REPL multi-turn): the caller owns a live,
        // already-compacted context — NO hydrate. Still reopen + carry
        // cumulative cost exactly like resume, so this turn's
        // completeSession sees a 'running' row and the lifetime total
        // stays correct across turns.
        const existing = getSession(config.db, liveCtx.sessionId);
        if (existing === null) {
          throw new Error(`sessionContext refers to unknown session ${liveCtx.sessionId}`);
        }
        if (existing.cwd !== config.cwd) {
          throw new Error(
            `sessionContext session ${liveCtx.sessionId}: cwd '${existing.cwd}' != config cwd '${config.cwd}'`,
          );
        }
        acct.seedFromResume(existing.totalCostUsd, existing.usageComplete);
        // Fresh-process resume that pre-hydrated its own context (the
        // `--resume-mode full|summary` paths): snapshot the pre-resume status
        // BEFORE reopenSession flips it to 'running', so the auto-rehydrate
        // block below runs for this first turn exactly as the
        // resumeFromSessionId path does. Plain REPL reuse leaves this null →
        // no rehydrate (the live context already saw the recap).
        if (config.resumeWithSessionContext === true) {
          preResumeStatus = existing.status;
        }
        reopenSession(config.db, liveCtx.sessionId);
        sessionId = liveCtx.sessionId;
        ctx = liveCtx;
      } else if (resumeId !== undefined) {
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
        acct.seedFromResume(existing.totalCostUsd, existing.usageComplete);
        // Snapshot the pre-resume status BEFORE `reopenSession`
        // flips the row to 'running'. The auto-rehydrate block
        // far below depends on this — re-reading the row at that
        // point would always see 'running', losing the
        // `done`/`exhausted`/`error` skip semantics and reporting
        // a wrong `previousStatus` in the rehydrate event.
        preResumeStatus = existing.status;
        reopenSession(config.db, resumeId);
        sessionId = resumeId;
        const hydrated = SessionContext.hydrateFromDb(config.db, resumeId);
        ctx = hydrated.ctx;
        hydrateInfo = hydrated.info;
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
        // Preassigned (subagent first boot): hydrate from the single
        // seed the parent wrote. No resume_truncated — not a resumed
        // history; hydrateInfo stays null so the diagnostics block skips.
        ctx = SessionContext.hydrateFromDb(config.db, preassignedId).ctx;
      } else {
        const session = createSession(config.db, {
          model: config.provider.id,
          cwd: config.cwd,
          ...(config.parentSessionId !== undefined
            ? { parentSessionId: config.parentSessionId }
            : {}),
        });
        sessionId = session.id;
        ctx = SessionContext.createFresh(config.db, sessionId);
      }
      // Every branch above set ctx; narrow it for the rest of the loop.
      // The closures defined later (finish, maybeCompact) capture the
      // wider `| undefined` and guard it themselves.
      if (ctx === undefined) {
        throw new Error('internal: session context not resolved');
      }

      // Eager-load provenance emit (MEMORY.md §11.2, S1/T1.4).
      // The CLI bootstrap froze the inventory at system-prompt
      // assembly time; this is the first moment a sessionId
      // exists to link the exposures against. One row per
      // (session, memory) with surface='eager' and
      // tool_call_id=NULL — eager-load happens BEFORE any tool
      // call exists, so the FK is intentionally absent.
      //
      // Idempotency gate: ask the repo which (scope, name) pairs
      // are already recorded for this session and emit only the
      // missing ones. An earlier shape used a coarse "any eager
      // row exists?" probe (hasEagerProvenance); on resume after
      // a previous emit that succeeded for SOME exposures then
      // hit a transient SQLITE_BUSY / write failure, the next
      // boot saw "some rows exist" and skipped backfill of the
      // rest, permanently dropping the missing entries from the
      // provenance trail. Per-key gating restores the contract:
      // every system-prompt body ends up with a matching eager
      // row, even across multiple partial resumes.
      //
      // Subagent first boots also use preassignedSessionId but
      // have zero eager rows yet, so they emit normally — the
      // existing-set is just empty.
      //
      // Best-effort: a DB failure here MUST NOT abort startup
      // (provenance is observability, not correctness — same
      // posture as registry.auditExposure). Failures land on
      // stderr as AUDIT DRIFT. A read failure on the lookup
      // itself (rare — `SELECT` paths don't ordinarily contend
      // with the WAL writer lock) falls through to the
      // `existing.has` checks below treating every exposure as
      // missing, which is safe under "ALL rows exist already"
      // (next emit duplicates, schema has no UNIQUE so duplicates
      // accumulate) — accept that cost vs. an unhandled throw
      // out of startup.
      if (config.eagerExposures !== undefined && config.eagerExposures.length > 0) {
        let existing: Set<string>;
        try {
          existing = getEagerProvenanceKeys(config.db, sessionId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `memory: AUDIT DRIFT: failed to read eager provenance keys for session ${sessionId}: ${redactSecrets(msg)}\n`,
          );
          existing = new Set();
        }
        for (const exposure of config.eagerExposures) {
          if (existing.has(`${exposure.scope}/${exposure.name}`)) continue;
          try {
            recordProvenance(config.db, {
              sessionId,
              toolCallId: null,
              memoryScope: exposure.scope,
              memoryName: exposure.name,
              surface: 'eager',
              memoryContentHash: exposure.memoryContentHash,
              memoryStateAtExposure: exposure.memoryStateAtExposure,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Redact — SQLite errors may echo bound parameter
            // values (the inventory's hash + state). Mirrors
            // registry.ts AUDIT DRIFT redaction pattern.
            process.stderr.write(
              `memory: AUDIT DRIFT: failed to record eager exposure for ${exposure.name} (${exposure.scope}): ${redactSecrets(msg)}\n`,
            );
          }
        }
      }

      // Skills surfaced/filtered audit (SKILLS.md §0.7, RETRIEVAL
      // §3.4.5): one skill_events row per catalog entry and per
      // filtered file, attributed to this session. Like the
      // eager-exposure emit above this runs on every boot — fresh,
      // preassigned, and resumed — so recordSurface carries its own
      // per-session idempotency gate. Best-effort: it swallows DB
      // failures rather than aborting the turn.
      if (config.skillCatalog !== undefined) {
        config.skillCatalog.recordSurface({ sessionId, cwd: config.cwd });
      }

      // S2/verify_failed heuristic rolled back per policy:
      // "todo o lifecycle de memória um llm-judge decide; sem
      // heurísticas locais sobre texto". The verify scheduler +
      // ProjectVerifier (regex path extraction + existsSync)
      // shipped initially and were removed when their value-vs-
      // false-positive analysis revealed the same fundamental
      // limitation as S4's text heuristic: regex over prose
      // can't distinguish assertion from historical mention.
      // S11 (Phase 2 LLM-judge) is the replacement; until that
      // lands, no verify-cycle runs in-session. The
      // `verify_failed` trigger name is preserved for S11
      // emission via the generic /memory audit --trigger filter.

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
        const bgHolder = config.bgManagerHolder;
        if (bgHolder?.manager !== undefined) {
          // Session-scoped reuse (spec ORCHESTRATION.md §3B.1): a prior
          // turn already built the manager and stored it in the holder.
          // Reuse it so background processes survive the turn boundary
          // instead of being torn down + rebuilt empty each turn. The
          // cross-turn event sink is already wired into it.
          //
          // The reused manager keeps the sessionId it was BUILT with
          // (the first turn's), not this turn's. In the REPL that's the
          // same id (sessionContext reuse reopens the same row), but
          // even if a later turn resolved a different id, the manager
          // stays self-consistent: it writes bg rows and answers
          // bash_list/bash_output under its own stable id. That's the
          // desired scope — "this REPL's bg processes" under one id.
          bgManager = bgHolder.manager;
        } else {
          bgManager = createBgManager({
            db: config.db,
            sessionId,
            logDir: config.bgLogDir,
            // One-shot run (no holder): propagate the harness's combined
            // signal (caller abort + wall-clock) so a Ctrl+C mid-stream
            // kills bg processes immediately instead of waiting for the
            // outer finally. Session-scoped (holder present): do NOT wire
            // it — the manager OUTLIVES the turn (§3B.1); a per-turn
            // signal would SIGKILL surviving processes the moment the
            // spawning turn ends. The REPL owns teardown via
            // `manager.cleanup()` at session exit.
            ...(bgHolder === undefined ? { abortSignal: signal } : {}),
            // Slice 130 fixup #1: thread failure_events sink +
            // boot-time sandbox tool so the `sandbox.mid_session_loss`
            // probe in bg/manager actually fires in production.
            // Both fields are optional on CreateBgManagerOptions, so
            // headless/SDK callers that don't supply them keep
            // pre-slice-130 behavior.
            ...(config.failureSink !== undefined ? { failureSink: config.failureSink } : {}),
            ...(config.sandboxBootTool !== undefined
              ? { sandboxBootTool: config.sandboxBootTool }
              : {}),
            // Slice 157 (phase 2): bg manager threads the per-CLI-run
            // sandbox tmpdir into every bg spawn so long-running bg
            // processes get the same scoped /tmp on darwin as
            // foreground tools.
            ...(config.sandboxTmpdir !== undefined ? { sandboxTmpdir: config.sandboxTmpdir } : {}),
            // Lifecycle observer: translate bg manager events into
            // HarnessEvents so the renderer can update its `bg N`
            // footer counter (spec UI.md §4.10.6) and audit captures
            // the same lifecycle the user sees.
            onEvent: (event) => {
              const harnessEvent: HarnessEvent =
                event.kind === 'started'
                  ? {
                      type: 'bg_started',
                      processId: event.processId,
                      command: event.command,
                      label: event.label,
                    }
                  : {
                      type: 'bg_ended',
                      processId: event.processId,
                      status: event.status,
                      exitCode: event.exitCode,
                    };
              // Cross-turn sink (REPL holder) routes to the current
              // turn's observer or, when idle, the notification channel
              // (§3B.3, later slice). One-shot: the per-run onEvent —
              // single turn, no holder.
              if (bgHolder !== undefined) bgHolder.onEvent(harnessEvent);
              else safeEmit(config.onEvent, harnessEvent);
            },
          });
          // Store the freshly-built manager so later turns reuse it.
          if (bgHolder !== undefined) bgHolder.manager = bgManager;
        }
      }

      // S11 — semantic-verify scheduler (MEMORY.md §11.x). Created
      // once per top-level session when the opt-in flag is set AND
      // the verify-semantic definition is loaded. Top-level only:
      // subagent children don't run their own scheduler (avoids
      // recursive verification + their session has no
      // memory_provenance trail meaningful for the detector).
      //
      // The scheduler captures runtime deps that don't exist
      // outside the loop scope (provider, parentToolRegistry,
      // permissionEngine), so creation lives here rather than in
      // bootstrap. Lifecycle: poll() fires at each step boundary
      // (end of the while(true) below); shutdown() drains in the
      // outer finally.
      // semanticVerifyScheduler is declared in the outer scope so
      // the outer finally can shutdown() it even on early throw.
      // R6 — runtime defense in depth. `parseArgs` already refuses
      // `--memory-verify-llm` / `--no-memory-verify-llm` in subagent
      // context (F12 + Slice Q), but a programmatic caller / future
      // code path that builds HarnessConfig directly could still set
      // `memorySemanticVerify` with `subagentDepth > 0`. Stay silent
      // ⇒ operator wonders why verify never fires. Emit a diagnostic
      // and continue without wiring the scheduler. Post-Slice-Q the
      // default is ON; opt-out is `/memory governance disable verify`
      // (persisted) or `--no-memory-verify-llm` (session-only).
      if (config.memorySemanticVerify === true && (config.subagentDepth ?? 0) > 0) {
        process.stderr.write(
          'memory: verify_semantic_disabled: cannot run inside a subagent context (refused at runtime)\n',
        );
      }
      // R6 — guard on memoryRegistry availability. Pre-fix the cast
      // `as MemoryRegistry` would land `undefined` into the scheduler
      // and every poll would TypeError on `registry.peek(...)`. The
      // outer catch swallows the throw silently every step; operator
      // sees nothing. Now we mirror the verify-def absent path and
      // refuse construction loudly when registry is missing.
      if (
        config.memorySemanticVerify === true &&
        (config.subagentDepth ?? 0) === 0 &&
        config.subagentRegistry !== undefined
      ) {
        const verifyDef = config.subagentRegistry.byName.get('verify-semantic');
        if (verifyDef !== undefined && config.memoryRegistry === undefined) {
          process.stderr.write(
            'memory: verify_semantic_disabled: --memory-verify-llm set but memory registry not wired\n',
          );
        } else if (verifyDef !== undefined && config.memoryRegistry !== undefined) {
          semanticVerifyScheduler = createSemanticVerifyScheduler({
            db: config.db,
            registry: config.memoryRegistry as MemoryRegistry,
            definition: verifyDef,
            parentSessionId: sessionId,
            cwd: config.cwd,
            provider: config.provider,
            parentToolRegistry: config.toolRegistry,
            permissionEngine: config.permissionEngine,
            // S5 mirror — when bootstrap excluded scopes via the
            // shared-corpus trust gate, the scheduler honors the
            // same posture so the verify-semantic subagent never
            // sees bodies the operator marked untrusted.
            ...(config.memoryExcludeScopes !== undefined
              ? { memoryExcludeScopes: config.memoryExcludeScopes }
              : {}),
            // F9 + R1: forward parent-runtime envelope into each
            // dispatch so the verify child runs under the parent's
            // resolved verdicts (hard signal, Ctrl-C, trust, hooks,
            // capabilities) rather than defaults. `signal` is the
            // combined caller+wall-clock abort; without it the
            // dispatch hangs until the subagent's own 10-min budget
            // and operator Ctrl-C×2 cannot interrupt.
            signal,
            ...(config.softStopSignal !== undefined
              ? { softStopSignal: config.softStopSignal }
              : {}),
            ...(config.isCwdTrusted !== undefined ? { cwdTrusted: config.isCwdTrusted } : {}),
            ...(config.hooks !== undefined ? { hooksSnapshot: config.hooks } : {}),
            ...(config.spawnChildProcess !== undefined
              ? { spawnChildProcess: config.spawnChildProcess }
              : {}),
            // PERMISSION_ENGINE.md §10.1: seal the verify subagent's
            // effective envelope. Mirror the task-tool spawn shape
            // (loop.ts:1289) — intersect parent's envelope against
            // the playbook's declared capabilities.
            //
            // Pre-R2 the loop passed the parent's FULL envelope
            // verbatim because verify-semantic.md didn't declare
            // capabilities and the loader didn't expose the field.
            // That reintroduced the exact gap migration 040 fixed
            // (audit row recorded "child ran under parent's full
            // envelope" when the operator's intent was a read-only
            // fact-checker).
            //
            // The verify-semantic playbook declares `read-fs:**`
            // (the minimum its read_file / grep / glob whitelist
            // needs to inspect repo state). The intersection narrows
            // that to whatever subset of read-fs the parent grants.
            // An earlier R2 draft used `capabilities: []` (intending
            // "pure-LLM") — but every read_file call in the child
            // engine would then have been refused with `subagent
            // capability outside declared envelope`, degrading the
            // fact-checker into a hallucination engine. Empty
            // declared envelope means the child can't call
            // capability-resolving tools AT ALL; only misc-category
            // tools survive.
            //
            // Excess (declared cap not covered by parent) is logged
            // as a stderr warning but doesn't refuse the spawn — an
            // operator who scoped reads to `src/**` should still get
            // a verifier that can verify `src/**` claims rather than
            // losing the detector entirely.
            effectiveCapabilities: ((): readonly string[] => {
              const declaredRaw = verifyDef.capabilities ?? [];
              const declared = declaredRaw.map(parseCapability);
              const parent =
                config.permissionEngine.effectiveCapabilities() ??
                deriveParentCapabilities(config.permissionEngine.policy());
              const { effective, excess } = intersectCapabilities(parent, declared);
              if (excess.length > 0) {
                process.stderr.write(
                  `memory: verify_semantic_envelope_narrowed: ${excess
                    .map(formatCapability)
                    .join(
                      ', ',
                    )} not covered by parent envelope; verify may degrade on those reads\n`,
                );
              }
              return effective.map(formatCapability);
            })(),
          });
        } else {
          process.stderr.write(
            'memory: verify_semantic_disabled: --memory-verify-llm set but verify-semantic definition not loaded\n',
          );
        }
      }

      // S13 — conflict detector scheduler. Same wiring posture as
      // the verify-semantic scheduler above: top-level only, gated on
      // memory registry availability, capabilities sealed via
      // intersect.
      if (config.memoryConflictDetect === true && (config.subagentDepth ?? 0) > 0) {
        process.stderr.write(
          'memory: verify_conflict_disabled: cannot run inside a subagent context (refused at runtime)\n',
        );
      }
      if (
        config.memoryConflictDetect === true &&
        (config.subagentDepth ?? 0) === 0 &&
        config.subagentRegistry !== undefined
      ) {
        const conflictDef = config.subagentRegistry.byName.get('verify-conflict');
        if (conflictDef !== undefined && config.memoryRegistry === undefined) {
          process.stderr.write(
            'memory: verify_conflict_disabled: --memory-conflict-llm set but memory registry not wired\n',
          );
        } else if (conflictDef !== undefined && config.memoryRegistry !== undefined) {
          const { createConflictDetectorScheduler } = await import(
            '../memory/verify-conflict-scheduler.ts'
          );
          conflictDetectorScheduler = createConflictDetectorScheduler({
            db: config.db,
            registry: config.memoryRegistry as MemoryRegistry,
            definition: conflictDef,
            parentSessionId: sessionId,
            cwd: config.cwd,
            provider: config.provider,
            parentToolRegistry: config.toolRegistry,
            permissionEngine: config.permissionEngine,
            ...(config.memoryExcludeScopes !== undefined
              ? { memoryExcludeScopes: config.memoryExcludeScopes }
              : {}),
            signal,
            ...(config.softStopSignal !== undefined
              ? { softStopSignal: config.softStopSignal }
              : {}),
            ...(config.isCwdTrusted !== undefined ? { cwdTrusted: config.isCwdTrusted } : {}),
            ...(config.hooks !== undefined ? { hooksSnapshot: config.hooks } : {}),
            ...(config.spawnChildProcess !== undefined
              ? { spawnChildProcess: config.spawnChildProcess }
              : {}),
            effectiveCapabilities: ((): readonly string[] => {
              const declaredRaw = conflictDef.capabilities ?? [];
              const declared = declaredRaw.map(parseCapability);
              const parent =
                config.permissionEngine.effectiveCapabilities() ??
                deriveParentCapabilities(config.permissionEngine.policy());
              const { effective, excess } = intersectCapabilities(parent, declared);
              if (excess.length > 0) {
                process.stderr.write(
                  `memory: verify_conflict_envelope_narrowed: ${excess
                    .map(formatCapability)
                    .join(
                      ', ',
                    )} not covered by parent envelope; verify may degrade on those reads\n`,
                );
              }
              return effective.map(formatCapability);
            })(),
          });
        } else {
          process.stderr.write(
            'memory: verify_conflict_disabled: --memory-conflict-llm set but verify-conflict definition not loaded\n',
          );
        }
      }

      // S3 — verify-override scheduler. Same wiring posture as
      // verify-semantic + verify-conflict: top-level only, gated on
      // memory registry availability, capabilities sealed via
      // intersect.
      if (config.memoryOverrideDetect === true && (config.subagentDepth ?? 0) > 0) {
        process.stderr.write(
          'memory: verify_override_disabled: cannot run inside a subagent context (refused at runtime)\n',
        );
      }
      if (
        config.memoryOverrideDetect === true &&
        (config.subagentDepth ?? 0) === 0 &&
        config.subagentRegistry !== undefined
      ) {
        const overrideDef = config.subagentRegistry.byName.get('verify-override');
        if (overrideDef !== undefined && config.memoryRegistry === undefined) {
          process.stderr.write(
            'memory: verify_override_disabled: memoryOverrideDetect set but memory registry not wired\n',
          );
        } else if (overrideDef !== undefined && config.memoryRegistry !== undefined) {
          const { createOverrideVerifyScheduler } = await import(
            '../memory/verify-override-scheduler.ts'
          );
          overrideVerifyScheduler = createOverrideVerifyScheduler({
            db: config.db,
            registry: config.memoryRegistry as MemoryRegistry,
            definition: overrideDef,
            parentSessionId: sessionId,
            cwd: config.cwd,
            provider: config.provider,
            parentToolRegistry: config.toolRegistry,
            permissionEngine: config.permissionEngine,
            ...(config.memoryExcludeScopes !== undefined
              ? { memoryExcludeScopes: config.memoryExcludeScopes }
              : {}),
            signal,
            ...(config.softStopSignal !== undefined
              ? { softStopSignal: config.softStopSignal }
              : {}),
            ...(config.isCwdTrusted !== undefined ? { cwdTrusted: config.isCwdTrusted } : {}),
            ...(config.hooks !== undefined ? { hooksSnapshot: config.hooks } : {}),
            ...(config.spawnChildProcess !== undefined
              ? { spawnChildProcess: config.spawnChildProcess }
              : {}),
            // Capability envelope intersect — same shape as verify-
            // semantic / verify-conflict. The verify-override.md
            // declares EMPTY tools[] so the intersected envelope is
            // empty too — no capability-resolving tools land in the
            // child's gate. Mismatch (declared cap not covered by
            // parent) stderr-logs as a warning; pure-empty declared
            // → no warning, the loop just hands the child no tools.
            effectiveCapabilities: ((): readonly string[] => {
              const declaredRaw = overrideDef.capabilities ?? [];
              const declared = declaredRaw.map(parseCapability);
              const parent =
                config.permissionEngine.effectiveCapabilities() ??
                deriveParentCapabilities(config.permissionEngine.policy());
              const { effective, excess } = intersectCapabilities(parent, declared);
              if (excess.length > 0) {
                process.stderr.write(
                  `memory: verify_override_envelope_narrowed: ${excess
                    .map(formatCapability)
                    .join(
                      ', ',
                    )} not covered by parent envelope; verify may degrade on those reads\n`,
                );
              }
              return effective.map(formatCapability);
            })(),
          });
        } else {
          process.stderr.write(
            'memory: verify_override_disabled: memoryOverrideDetect set but verify-override definition not loaded\n',
          );
        }
      }

      // §13.6 degraded banner emitter (slice 92). One emitter per
      // runAgent invocation. State changes outside the run (engine
      // degraded/restored between sessions) don't carry the counter
      // across — each run gets a fresh first-emission semantics for
      // its own degraded-transition timeline. The emitter is cheap
      // (single state read per tool call); invoking it
      // unconditionally is simpler than gating on engine state at
      // the call site.
      const degradedBannerEmitter = createDegradedBannerEmitter({
        getState: () => config.permissionEngine.state(),
        // §13.6 reason plumbing (slice 93). Reads the root cause
        // from the engine's state controller history; renderers
        // surface it in the banner ("⚠ Sandbox no longer available
        // (bwrap binary missing)"). Undefined → empty reason, banner
        // falls back to the suffix-less form.
        getReason: () => config.permissionEngine.getDegradedReason() ?? '',
        onFire: (event) => {
          // §13.6 harness observer (renderers, NDJSON, future
          // UI adapters). Unchanged from slice 92.
          safeEmit(config.onEvent, {
            type: 'sandbox_degraded_active',
            sessionId: event.sessionId,
            reason: event.reason,
            firstEmission: event.firstEmission,
          });
          // §18 telemetry emit (slice 111, R10 #48). Pre-slice
          // SandboxDegradedActiveEvent was a declared type with
          // a scrubbing handler (slice 92) but no emit site —
          // operators with OTEL dashboards saw `sandbox.degraded
          // _active_total` flat-line even when banners were
          // firing. The defensive try/catch matches slice 70's
          // sink contract (sinks MUST NOT throw; observability
          // bugs MUST NOT break the harness loop).
          if (config.telemetry !== undefined) {
            try {
              config.telemetry.emit({
                kind: 'sandbox.degraded_active',
                ts: Date.now(),
                sessionId: event.sessionId,
                reason: event.reason,
                firstEmission: event.firstEmission,
              });
            } catch {
              // Telemetry sink threw — log site is the harness;
              // we can't surface it without risking the same
              // broken sink consuming our error. Swallow.
            }
          }
        },
      });

      // Subagent dispatcher + handle store. Wired only when a
      // subagent registry is configured; both `task` (sync) and the
      // `task_async` family (async) flow through `spawnSubagentImpl`,
      // a thin wrapper that binds the run deps and delegates to
      // `dispatchSubagent` (subagent-dispatcher.ts) — which centralizes
      // the refusal gates, the cost/capability checks, the runSubagent
      // option assembly, and the cost watchdog. Callers pass a per-call
      // signal override. The store wraps the impl with bounded-concurrency
      // slot semantics so multiple `task_async` calls overlap up to the cap.
      if (config.subagentRegistry !== undefined) {
        spawnSubagentImpl = (args, signalOverride, handleId) =>
          dispatchSubagent(args, signalOverride, handleId, {
            config,
            budget,
            acct,
            signal,
            sessionId,
            getHandleStore: () => subagentHandleStore,
            capWatchdog,
          });
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
          // Slice 130 fixup #1: thread failure_events sink so the
          // catch path in handle-store (around the settle persist
          // call) emits structured `storage.lock_contention` /
          // `storage.persist_failed` rows. Field is optional —
          // when caller doesn't wire failureSink, persistence
          // failures still log to stderr (pre-slice-130 posture).
          persistTo: {
            db: config.db,
            parentSessionId: sessionId,
            ...(config.failureSink !== undefined ? { failureSink: config.failureSink } : {}),
          },
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
        acct.setRehydratedChildCost(subagentHandleStore.getRehydratedChildCostUsd());
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
          // Anchor git ops at the worktree root so snapshot/restore
          // cover the whole worktree even when config.cwd is a
          // subdirectory of the repo (CHECKPOINTS §2.6). null on the
          // unavailable path; the manager's `?? cwd` fallback handles it.
          ...(support.gitRoot !== null ? { gitRoot: support.gitRoot } : {}),
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

      // Resume diagnostics + alternation. The context was already
      // hydrated from the DB log in the session-decision block (which
      // also seeded the parent_id anchor from the persisted tail);
      // here we surface the truncation it reported (resume path only)
      // and repair alternation before the new prompt is appended.
      if (hydrateInfo !== null && resumeId !== undefined && hydrateInfo.totalDropped > 0) {
        // resume_truncated is resume-only: a preassigned seed is freshly
        // inserted by the parent, so truncation there is a parent-flow
        // bug, not the "user resumed and lost context" the renderer shows.
        safeEmit(config.onEvent, {
          type: 'resume_truncated',
          sessionId,
          kept: hydrateInfo.kept,
          dropped: hydrateInfo.totalDropped,
        });
        // Slice 178 (hardening M1): make the truncation queryable
        // post-hoc so a forensic audit can tell the model worked from a
        // subset of the log, not just infer it from a "didn't remember"
        // report. Best-effort — never block the resume.
        if (config.failureSink !== undefined) {
          try {
            config.failureSink.emit({
              code: 'storage.resume_truncated',
              classe: 'storage',
              recovery_action: 'degraded',
              user_visible: true,
              session_id: sessionId,
              payload: {
                kept: hydrateInfo.kept,
                dropped: hydrateInfo.totalDropped,
                dropped_beyond_fetch: hydrateInfo.droppedBeyondFetch,
                dropped_by_alignment: hydrateInfo.droppedByAlignment,
                max_resume_messages: MAX_RESUME_MESSAGES,
              },
            });
          } catch (e) {
            process.stderr.write(
              `forja: failed to persist storage.resume_truncated event: ${e instanceof Error ? e.message : String(e)}\n`,
            );
          }
        }
      }
      // Stranded-turn repair (in-memory only, not persisted): if the
      // hydrated tail is a user and we're about to append a new prompt,
      // a synthetic assistant keeps the wire alternating. No-op on the
      // reuse path (a live turn ends on an assistant) and on the
      // preassigned-empty-prompt path (the seed IS the conversation).
      ctx.ensureAlternation(config.userPrompt.length > 0);

      // Auto-rehydrate on `--resume` (STATE_MACHINE §7.6 +
      // RECAP §3.2). Prepends a literal `[resume_context]` block
      // to the operator's first user prompt so the next turn has
      // access to the goal text, recent decisions, pins, and
      // notDone items from the audit log. Pure projection (no
      // LLM, no provider call) so it stays inside the resume
      // init's latency envelope; any exception falls through to
      // an unrehydrated prompt — the operator gets a working
      // resume instead of a hard failure.
      let effectiveUserPrompt = config.userPrompt;
      // Gate on `preResumeStatus !== null`, which is set ONLY by the two
      // resume entries: the resumeFromSessionId path, and the reuse path when
      // `resumeWithSessionContext` is set (full/summary). So this one condition
      // covers both — plain REPL reuse and fresh/preassigned leave it null.
      if (
        isRecapEnabled(config) &&
        config.userPrompt.length > 0 &&
        preResumeStatus !== null &&
        !shouldSkipResumeContext(preResumeStatus)
      ) {
        // `preResumeStatus` was captured BEFORE `reopenSession`
        // flipped the row to 'running'. Using it here preserves
        // the §7.6 skip-on-terminal contract (don't rehydrate a
        // `done`/`exhausted`/`error` session — those finished
        // cleanly and resume is just continuation, not recovery)
        // and reports the true prior status in the emitted event.
        try {
          const intermediate = projectRecap(config.db, {
            // `sessionId` (not `resumeId`): equals resumeId on the resume path
            // and liveCtx.sessionId on the full/summary reuse path.
            scope: { kind: 'session_specific', sessionId },
            now: Date.now(),
          });
          const block = buildResumeContext({
            intermediate,
            previousStatus: preResumeStatus,
            resumedAt: Date.now(),
          });
          effectiveUserPrompt = `${block.text}\n\n${config.userPrompt}`;
          safeEmit(config.onEvent, {
            type: 'resume_rehydrated',
            sessionId,
            previousStatus: preResumeStatus,
            decisionCount: block.decisionCount,
            pinCount: block.pinCount,
            todoCount: block.todoCount,
            truncated: block.truncated,
            degraded: block.degraded,
          });
        } catch (e) {
          // Don't let rehydrate failure break resume. The plain
          // prompt still works; auto-rehydrate is defense-in-
          // depth, not a correctness path. Emit a diagnostic so
          // the operator sees WHY their `[resume_context]` block
          // is missing — silently swallowing would leave them
          // wondering whether the spec's §7.6 promise was even
          // attempted.
          const reason = e instanceof Error ? e.message : String(e);
          safeEmit(config.onEvent, {
            type: 'resume_rehydrate_failed',
            sessionId,
            reason,
          });
        }
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
        // The context's anchor (hydrated tail, or '' on a fresh run)
        // becomes this message's parentId, keeping the DB chain
        // connected; appendUser advances it.
        ctx.appendUser(
          effectiveUserPrompt,
          config.systemPromptHash ?? null,
          config.userPromptSource ?? 'operator',
        );
      }
      // else: no new user message. The context's anchor is already the
      // hydrated tail (or '' on a fresh/empty run), which the following
      // assistant turn chains onto — no priorTailId bookkeeping needed.

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
          profile: 'default',
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

      // Compaction check, factored out so it runs at the TOP of the loop —
      // before EVERY provider call, not only after tool_results. That closes
      // three overflow gaps the post-tool-result-only site left open: the
      // first call of a resumed session (up to MAX_RESUME_MESSAGES restored),
      // a turn that crosses the threshold without tool_results, and the start
      // of each run. N4: the ~290-line body moved to `runMaybeCompact` in
      // compaction-controller.ts (an explicit snapshot of run state instead of
      // closing over ~13 locals); this thin wrapper reads the per-iteration
      // state (ctx / steps / tools / proactiveRecalled) live and threads the
      // cost seam. Returns a cost-cap detail when its billed summary pushed the
      // cumulative over the cap (caller must finish), else null.
      const maybeCompact = (force = false): Promise<string | null> =>
        runMaybeCompact({
          force,
          ctx,
          signal,
          steps,
          budget,
          config,
          tools,
          workingStateStore,
          sessionId,
          proactiveRecalled,
          dispatchHooks,
          recordUsage: (usage, cost, usageSeen) => acct.recordUsage(usage, cost, usageSeen),
          emitCostUpdate,
          costCapDetail: costCapDetailIfExceeded,
        });

      // Pre-terminal synthesis turn (STATE_MACHINE.md §2.2 / ORCHESTRATION.md
      // §8.2): a run that spent its whole step budget on tool calls would
      // otherwise return EMPTY output. `synthesizeOnExhaustion` — extracted to
      // exhaustion-synthesis.ts so its decision + orchestration are unit-testable
      // in isolation — makes ONE tool-less provider call before the → exhausted
      // transition and RETURNS the cost-cap overage (or null) so the caller can
      // finish maxCostUsd vs maxSteps. The CostAccountant (`acct`) owns the
      // mutable run totals; the injected `recordUsage` / `markUsageIncomplete`
      // delegate to it and are the single write seam, and the cost-cap /
      // compaction closures pass straight through.
      const runSynthesis = async (): Promise<ExhaustionSynthesisResult> => {
        if (ctx === undefined) return { costOverage: null, truncation: null };
        return synthesizeOnExhaustion({
          ctx,
          config,
          budget,
          signal,
          costCapDetailIfExceeded,
          maybeCompact,
          recordUsage: (usage, cost, usageSeen) => acct.recordUsage(usage, cost, usageSeen),
          markUsageIncomplete: () => acct.markUsageIncomplete(),
          emit: (event) => safeEmit(config.onEvent, event),
          emitCostUpdate,
        });
      };

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
        if (steps >= budget.maxSteps) {
          // Pre-terminal synthesis turn (STATE_MACHINE.md §2.2): give the run
          // a chance to write its answer before the budget closes it out.
          const synth = await runSynthesis();
          // A Ctrl+C / wall-clock timeout DURING that best-effort turn is
          // swallowed by its catch; honor it here before classifying as
          // exhaustion — abort takes precedence over the budget exit, matching
          // the top-of-loop ordering above.
          if (signal.aborted) {
            return isWallClockTimeout()
              ? await finish('maxWallClockMs')
              : await finish('aborted', undefined, 'hard');
          }
          // The synthesis emitted a final answer, but the run is out of steps so
          // it cannot nudge for verification the way the no_tool_use gate does.
          // Apply the gate's EXHAUSTION behavior here too (STATE_MACHINE §3.2.1):
          // accept the answer but TRACE an unverified edit so a low /
          // just-exhausted step budget isn't a silent bypass of the guarantee.
          traceUnverifiedAtExhaustion();
          // The synthesis can be the FIRST turn to cross the hard cost cap; a
          // breach must surface as maxCostUsd, not be masked as step exhaustion.
          if (synth.costOverage !== null) return await finish('maxCostUsd', synth.costOverage);
          // The synthesis call itself can truncate (max_tokens) or overflow the
          // window — the final report is incomplete, so surface maxOutputTokens /
          // maxContextTokens like a normal turn instead of a clean maxSteps.
          if (synth.truncation !== null)
            return await finish(synth.truncation.reason, synth.truncation.detail);
          return await finish('maxSteps');
        }
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

        // Rebuild the tool surface if tool_search revealed new tools last step
        // (AGENTIC_CLI §7.6). `revealed` only grows, so this fires once per fetch
        // and then stays put — the base prefix stays cache-stable between fetches.
        // MUST run before maybeCompact: the compaction gate estimates prompt size
        // from `tools`, so a stale (pre-reveal, smaller) array could skip
        // compaction near the threshold while the actual request below carries
        // the just-revealed schema (e.g. retrieve_context ~0.5k) and tips over.
        if (toolsDirty) {
          tools = buildToolDefs(config, revealed);
          toolsDirty = false;
        }

        // §4.4 — compute the proactive recall BEFORE maybeCompact so its body
        // size is counted in the compaction / output-fit decision (the block is
        // appended to the request below, AFTER this gate). The injection site
        // consumes this same result; `recomputed` drives its provenance write.
        // Best-effort I/O (frontmatter peek + BM25): a failure leaves it empty.
        proactiveRecalled = [];
        proactiveRecomputed = false;
        if (proactiveRecall !== undefined) {
          try {
            const focusKey = workingStateStore.get(sessionId).focus?.text ?? '';
            const res = await resolveCachedRecall(
              proactiveCache,
              sessionId,
              focusKey,
              proactiveRecall,
              config.userPrompt,
            );
            proactiveRecalled = res.recalled;
            proactiveRecomputed = res.recomputed;
          } catch (err) {
            process.stderr.write(
              `forja: proactive memory recall failed (continuing without it): ${
                err instanceof Error ? err.message : String(err)
              }\n`,
            );
          }
        }

        // Compact BEFORE the provider call when over threshold (see
        // maybeCompact above). Runs every iteration, so it covers the first
        // call of a resumed/long session — the post-tool-result-only site
        // missed it, sending one over-window request that 400s.
        {
          const compactOverage = await maybeCompact();
          if (compactOverage !== null) return await finish('maxCostUsd', compactOverage);
        }

        steps += 1;
        // Advance the session-monotonic working-state step in lockstep. Unlike
        // `steps` (per-run, reset each runAgent call), this lives in the store
        // and survives across REPL turns, so staleness stays monotonic for the
        // whole session (WORKING_STATE.md §6).
        const wsStep = workingStateStore.tickStep(sessionId);
        safeEmit(config.onEvent, { type: 'step_start', stepN: steps });

        const resolvedMaxTokens = resolveMaxOutputTokens(budget, config.provider.capabilities);
        // Provider reasoning-effort for this request: an explicit
        // `providerEffort` (what an inherited subagent config carries)
        // wins, else derive from the operator's `effort` level.
        const reqEffort = resolveProviderEffort(config);
        // Snapshot the running message list so post-call mutations (the next
        // iteration appends assistant + tool_results) don't retroactively
        // change what the provider observed.
        const reqMessages = [...ctx.getMessages()];
        // Inject the working-state panel at the bottom of [current_turn]
        // (appended to the last user message) — max-attention, cache-neutral,
        // alternation-safe (WORKING_STATE.md §5). No-op when the panel is empty.
        const ws = workingStateStore.get(sessionId);
        injectWorkingStateBlock(reqMessages, ws, wsStep);
        // §4.4 — inject the proactive recall onto the reqMessages tail (below the
        // working-state panel) so it rides the uncached turn — never the cached
        // prefix (I1) and never the persisted history (I2). The recall itself ran
        // at the top of the loop (before maybeCompact, so its body size was counted
        // in the compaction decision); here we append the cached result and, on
        // recompute (focus changed), record the I5 exposure (one row per memory per
        // focus, not per step). Best-effort: the provenance write re-peeks each
        // memory (I/O), so guard it — a nudge must fail to nothing.
        if (proactiveRecalled.length > 0) {
          // Inject returns ONLY the memories the body budget actually rendered; record
          // provenance for that subset, not the full recall — a memory dropped by the
          // cap never reached the provider and must not get a surface='proactive' row.
          const injected = injectProactiveMemoryBlock(reqMessages, proactiveRecalled);
          if (proactiveRecomputed && config.memoryRegistry !== undefined && injected.length > 0) {
            try {
              recordProactiveExposures(
                config.db,
                config.memoryRegistry,
                sessionId,
                injected,
                config.memoryExcludeScopes,
              );
            } catch (err) {
              process.stderr.write(
                `forja: proactive provenance write failed (continuing): ${
                  err instanceof Error ? err.message : String(err)
                }\n`,
              );
            }
          }
        }
        // Static operating guidance sits directly below the working-state panel
        // at the bottom of [current_turn]. Injected after the panel (so it stays
        // below) but gated to the primary agent: subagents have no working-state
        // machinery, so they leave `enableStaticGuidance` off (set only by the
        // main CLI bootstrap). Unlike the panel this is constant, not no-op'd.
        // Lean the per-step guidance on a tight window (CONTEXT_TUNING §2.2):
        // it rides the uncached tail, so on a small (often no-cache local) model
        // its re-paid cost is a bigger fraction of the budget. Re-picked per step
        // off the live window so a /model swap re-tiers, like the prefix shaping.
        if (config.enableStaticGuidance)
          injectStaticGuidance(
            reqMessages,
            isSmallWindow(config.provider?.capabilities?.context_window ?? 0),
          );
        const req = buildGenerateRequest({
          config,
          messages: reqMessages,
          maxTokens: resolvedMaxTokens,
          tools,
          effort: reqEffort,
        });

        // Verify-gate output buffering. If the gate is armed entering this turn
        // (code mutated, a declared verify-command still unsatisfied, retries
        // left), a tool-call-free answer THIS turn will be suppressed by the
        // gate below — but the provider streams its `text_delta`s live, so a
        // one-shot renderer would print the rejected claim before the gate
        // fires. Hold this turn's answer text out of the live event stream and
        // either flush it (turn isn't suppressed) or drop it (gate suppresses).
        // Buffers only the render EVENTS — `collected` still captures the full
        // text, so history/persistence are unaffected.
        const verifyArmed =
          verifyCommands.length > 0 &&
          verifyAttempts < MAX_VERIFY_ATTEMPTS &&
          unsatisfiedVerifyCommands(verifyState, verifyCommands).length > 0;
        const bufferedAnswer: StreamEvent[] = [];
        const flushBufferedAnswer = (): void => {
          for (const ev of bufferedAnswer) {
            safeEmit(config.onEvent, { type: 'provider_event', event: ev });
          }
          bufferedAnswer.length = 0;
        };
        // Whether we're still holding this turn's answer text. Set false the
        // moment a tool_use appears: a tool call means the turn is NOT a
        // suppressible final answer, so the held preamble must flush BEFORE the
        // tool's events (else the live render shows the tool card ahead of the
        // text that preceded it, and the TUI orphans the block) and the rest of
        // the turn streams live.
        let holdingAnswer = verifyArmed;

        let collected: CollectedStep;
        try {
          // The provider call + stream drain (the four-primitive load-bearing
          // composition: retry → stall-watchdog → abort → collect) lives in
          // `collectProviderStep`. The verify-gate output buffering rides in via
          // the `onEvent` callback, which keeps its loop-local state
          // (holdingAnswer / bufferedAnswer) here.
          collected = await collectProviderStep({
            provider: config.provider,
            req,
            maxStepStallMs: budget.maxStepStallMs,
            signal,
            onEvent: (ev) => {
              // A tool call settles that this turn is not a suppressible final
              // answer: flush the held preamble BEFORE the tool's events (keeping
              // the model's emission order) and stop holding for the rest of it.
              if (holdingAnswer && ev.kind === 'tool_use_start') {
                flushBufferedAnswer();
                holdingAnswer = false;
              }
              // Hold the answer text while still possibly-suppressible; every
              // other event (tool deltas, stream errors, usage) streams live.
              if (holdingAnswer && ev.kind === 'text_delta') {
                bufferedAnswer.push(ev);
                return;
              }
              safeEmit(config.onEvent, { type: 'provider_event', event: ev });
            },
          });
        } catch (e) {
          // collectProviderStep threw, so this turn produced no settled answer the
          // gate could suppress — flush any answer text buffered for the verify gate
          // (partial text the provider streamed before the error) so it isn't
          // silently swallowed by the buffering. No-op unless the gate was armed.
          flushBufferedAnswer();
          // The provider request was sent (and likely billed for input
          // tokens) before the throw. Always flip the aggregate flag —
          // even if we recover partial usage, totals are by definition
          // a lower bound when the turn ended in error.
          acct.markUsageIncomplete();

          // Recover whatever the stream emitted before the throw.
          // Adapters yield `usage` from their `finally` block precisely
          // for this case, so a failed turn that already received
          // input/cache numbers from the provider can still be charged.
          // CollectStepError carries the partial CollectedStep; non-
          // wrapped errors (extreme: the collect step itself crashed before
          // catching) have no recoverable state.
          if (e instanceof CollectStepError) {
            const partial = e.partial;
            if (partial.usageSeen) {
              const partialCost = computeCost(config.provider.capabilities, partial.usage);
              acct.recordUsage(partial.usage, partialCost, partial.usageSeen);
              emitCostUpdate(partialCost);
              // Display cue AFTER the rollup write above. This site
              // never persists a message row (the turn died before
              // settling), so the cue only surfaces the cost side —
              // token chips legitimately stay put; usage_complete
              // marks the totals as a lower bound.
              safeEmit(config.onEvent, { type: 'usage_persisted' });
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

        // Build assistant content blocks (reasoning-first, then text, then
        // tool_uses; reasoning omitted on a no-text/no-tool turn to avoid an
        // empty wire message). See `buildAssistantContent`.
        const assistantContent = buildAssistantContent(collected);

        const turnCostUsd = computeCost(config.provider.capabilities, collected.usage);
        // ANY assistant turn that completes without a usage event is
        // unmeasured — every successful provider call bills input tokens
        // for the prompt, even when the model emits no text, no
        // tool_use, and no thinking. Stream errors and aborts don't
        // reach here (they exit via providerError/aborted finish paths),
        // so we're only counting turns that the provider actually
        // accepted and processed. `usageSeen=false` marks the aggregate
        // as a lower bound for the renderer.
        acct.recordUsage(collected.usage, turnCostUsd, collected.usageSeen);

        // When the adapter never emitted a `usage` event, persist NULL on
        // the token/cost columns instead of zeroes. Future analytics can
        // then distinguish "no measurement" from "measured zero" — both
        // are legal but mean different things (e.g., a stream that aborted
        // before message_stop vs. a turn that genuinely produced nothing).
        const assistantMsgId = ctx.appendAssistant(
          assistantContent,
          {
            usageSeen: collected.usageSeen,
            tokensIn: collected.usage.input,
            tokensOut: collected.usage.output,
            cacheRead: collected.usage.cache_read,
            cacheCreation: collected.usage.cache_creation,
            costUsd: turnCostUsd,
          },
          config.systemPromptHash ?? null,
          // The provider reasoning-effort resolved for THIS request
          // (migration 074) — records the effort that produced the turn.
          reqEffort ?? null,
          // The model that billed THIS turn (migration 077) — per-turn provenance
          // so historical cost surfaces resolve metering from the models actually
          // used, not the session's initial model. A /model switch changes it.
          config.provider.id,
        );

        // After appendAssistant so the post-persist contract holds:
        // the message row carrying this response's tokens is
        // queryable when these fire. Before the stream-errors check
        // below — a turn that errored still billed, and its
        // providerError finish path must not swallow the
        // announcements. `usage_persisted` is the display cue and
        // fires for EVERY settled response; `cost_update` is the
        // billing event and skips zero deltas (zero-priced local
        // models never emit it).
        emitCostUpdate(turnCostUsd);
        safeEmit(config.onEvent, { type: 'usage_persisted' });

        // Resolve the buffered answer text (only non-empty when `verifyArmed`).
        // Flush it now UNLESS the verify gate is about to suppress THIS turn —
        // i.e. the gate is reached (no earlier terminal exit) and its condition
        // holds: a tool-call-free, settled answer with the gate still armed.
        // When that is true the buffer rides to the gate's `continue`, which
        // drops it; in EVERY other outcome (errors, caps, tool calls, accept)
        // the text streams normally. This predicate MUST mirror the early-exit
        // checks between here and the gate (errors / cost cap / max_tokens /
        // context-window) so a preempting return never silently drops the text.
        const gateWillSuppress =
          verifyArmed &&
          collected.errors.length === 0 &&
          costCapDetailIfExceeded() === null &&
          collected.tool_uses.length === 0 &&
          collected.stop_reason !== 'max_tokens' &&
          collected.stop_reason !== 'model_context_window_exceeded' &&
          endsWithSettledAnswer(ctx.getMessages());
        if (!gateWillSuppress) flushBufferedAnswer();

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
          if (overage !== null) {
            traceUnverifiedAtExhaustion();
            return await finish('maxCostUsd', overage);
          }
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
          // Window overflow (input + output exhausted the context window).
          // Same honesty leg as max_tokens — a truncated answer must not exit
          // as `done`. Distinct reason because the fix differs: compact /
          // shrink the input, not raise the per-call output cap.
          if (collected.stop_reason === 'model_context_window_exceeded') {
            return await finish(
              'maxContextTokens',
              'provider stopped at the context window limit (model_context_window_exceeded); reduce input or rely on compaction',
            );
          }
          // Claim-time verify gate (STATE_MACHINE §3.2.1). If the run mutated a
          // file without all declared verify-commands passing AFTER the last
          // edit, suppress this answer, nudge the model to run them, and
          // re-generate — bounded by MAX_VERIFY_ATTEMPTS. Opt-in: an empty
          // `verify.commands` makes `unsatisfiedVerify` empty ⇒ skipped.
          // Deterministic: real mutation tracking + bash exit codes + declared
          // commands, never model prose (the ProjectVerifier failure this avoids).
          const unsatisfiedVerify = unsatisfiedVerifyCommands(verifyState, verifyCommands);
          // Only gate a SETTLED answer (non-empty assistant text). An empty /
          // reasoning-only turn is NOT mirrored into the live array (an empty
          // assistant message is dropped), so its tail is the prior `user`
          // turn — appending the nudge there would emit two consecutive `user`
          // messages and the next request would 400. `endsWithSettledAnswer`
          // ⇒ the tail is a real assistant answer, so the nudge keeps the
          // assistant → user → assistant alternation. It is also the right
          // semantics: the gate suppresses a CLAIM, and an empty turn is none.
          if (
            unsatisfiedVerify.length > 0 &&
            verifyAttempts < MAX_VERIFY_ATTEMPTS &&
            endsWithSettledAnswer(ctx.getMessages())
          ) {
            verifyAttempts += 1;
            // Synthetic user nudge (system source, persisted for replay). The
            // assistant answer stays in history; the model then runs the
            // commands (gated by permissions) and re-emits its final answer.
            ctx.appendUser(verifyGateNudge(unsatisfiedVerify), null, 'system');
            continue;
          }
          // Gate satisfied, off, or exhausted — after MAX_VERIFY_ATTEMPTS nudges
          // the gate accepts the answer (it is a nudge, not a hard trap).
          if (unsatisfiedVerify.length > 0 && verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
            // Exhausted: accept the unverified claim but TRACE it (stderr is the
            // log surface — stdout stays pure). The structured
            // `verify_gate_exhausted` audit EVENT + TUI rendering is a deferred
            // follow-up: adding a HarnessEvent variant pulls in the exhaustive
            // event switches (`tui/state.ts` `: never`) — see docs/TODO.md H3.6.
            console.error(
              `forja: verify gate accepted an unverified answer after ${verifyAttempts} nudge(s); not confirmed: ${unsatisfiedVerify.join(', ')}`,
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
                stepId: assistantMsgId,
                hadBash,
                stepN: steps,
              });
              if (outcome.checkpointId !== null && outcome.gitRef !== null) {
                safeEmit(config.onEvent, {
                  type: 'checkpoint_created',
                  checkpointId: outcome.checkpointId,
                  gitRef: outcome.gitRef,
                  stepId: assistantMsgId,
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

        // Scope-filtered registry for tool-facing surfaces. When the
        // shared-corpus trust probe lands a non-confirmed outcome
        // (verify_failed / deferred / revoked), bootstrap sets
        // `memoryExcludeScopes: ['project_shared']`; without the
        // wrapper, the tool context's `memoryRegistry` would still
        // expose the unfiltered registry to memory_list /
        // memory_read / memory_search, letting the model enumerate
        // and read project_shared bodies under a fail-closed trust
        // state — direct bypass of the trust gate that eager-load
        // and retrieve_context already respect. Wrap once per run
        // here so every tool invocation downstream sees the same
        // filtered view; `retrieveContext` builds against the same
        // wrapped registry below for surface symmetry.
        const effectiveMemoryRegistry =
          config.memoryRegistry !== undefined &&
          config.memoryExcludeScopes !== undefined &&
          config.memoryExcludeScopes.length > 0
            ? createScopeFilteredRegistry(config.memoryRegistry, config.memoryExcludeScopes)
            : config.memoryRegistry;

        const buildCtx = (tu: CollectedToolUse): ToolContext =>
          buildToolContext(tu, {
            signal,
            config,
            sessionId,
            assistantMsgId,
            searchTools,
            todoStore,
            workingStateStore,
            bgManager,
            spawnSubagentClosure,
            subagentHandleStore,
            acct,
            budget,
            effectiveMemoryRegistry,
            contextPinsStore,
            dispatchHooks,
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
          // FEEDBACK_ADAPTATION §9.1 dispatch rewrite. When the
          // model issues a bash command whose leading binary has an
          // active L1 alias policy in the operator's scope chain,
          // rewrite before the permission engine + tool dispatch
          // see the call. CRITICAL: the engine sees the REWRITTEN
          // command, so target validation (bare-binary name only,
          // no shell metas) lives inside maybeRewriteBashCommand
          // — a poisoned action_json with shell injection would
          // otherwise bypass the allow-list.
          //
          // Audit gap (declared follow-up): the pre-rewrite command
          // is NOT structurally persisted today. tool_calls.input
          // captures the rewritten value; stderr below captures the
          // rewrite event. A future slice adds a dispatch_rewrites
          // audit table linking the policy id to the original
          // command — operator forensic queries need it. For now
          // operators trace via /agent policy history <id>.
          // Tracks the L1 signature that drove a successful rewrite
          // (null when no rewrite happened). Threaded into the
          // outcome emitter so the policy's signature keeps
          // accumulating evidence after promotion — without this,
          // the post-rewrite command's bash-parser pass would
          // either pick the rewritten binary (not in alias table)
          // or nothing, and the policy's effectiveness signal
          // would go dark immediately after promotion.
          let appliedL1Signature: string | null = null;
          // Pending rewrite audit deferred until after invokeTool
          // creates the tool_calls row. `tu.id` is the provider's
          // tool_use id; `tool_calls.id` is a separate UUID that
          // invokeTool generates inside the same call. Persisting
          // here with tu.id would always hit the FK on
          // dispatch_rewrites.tool_call_id → tool_calls.id and
          // fall into the catch path — the behavior change happened
          // but the structured audit row never landed.
          let pendingRewriteAudit: {
            policyId: string;
            actionSignature: string;
            originalCommand: string;
            rewrittenCommand: string;
            matchedScope: 'global' | 'language' | 'repo' | 'user' | 'session';
          } | null = null;
          if (tu.name === 'bash' && typeof tu.input.command === 'string') {
            const originalCommand = tu.input.command;
            const rewrite = maybeRewriteBashCommand(
              config.db,
              originalCommand,
              buildScopeChain({ sessionId, repoCwd: repoRoot }),
            );
            if (
              rewrite.rewritten &&
              rewrite.appliedPolicyId !== null &&
              rewrite.appliedSignature !== null &&
              rewrite.matchedScope !== null
            ) {
              appliedL1Signature = rewrite.appliedSignature;
              tu.input = { ...tu.input, command: rewrite.command };
              pendingRewriteAudit = {
                policyId: rewrite.appliedPolicyId,
                actionSignature: rewrite.appliedSignature,
                originalCommand,
                rewrittenCommand: rewrite.command,
                matchedScope: rewrite.matchedScope as
                  | 'global'
                  | 'language'
                  | 'repo'
                  | 'user'
                  | 'session',
              };
            }
          }
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
              messageId: assistantMsgId,
            },
            {
              db: config.db,
              registry: config.toolRegistry,
              engine: config.permissionEngine,
              ctx: buildCtx(tu),
              ...(config.confirmPermission !== undefined
                ? { confirmPermission: config.confirmPermission }
                : {}),
              ...(config.systemPromptHash !== undefined
                ? { systemPromptHash: config.systemPromptHash }
                : {}),
              fireHook: dispatchHooks,
              signal,
              onExecutionStart: () => {
                safeEmit(config.onEvent, { type: 'tool_execution_started', toolUseId: tu.id });
              },
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
            ...(inv.errorMessage !== undefined ? { errorMessage: inv.errorMessage } : {}),
            ...(inv.outputTruncated === true ? { outputTruncated: true } : {}),
            ...(inv.exitCode !== undefined ? { exitCode: inv.exitCode } : {}),
            ...(inv.resultDetail !== undefined ? { resultDetail: inv.resultDetail } : {}),
          });
          // Verify-gate accounting (STATE_MACHINE §3.2.1): fold this settled tool
          // into the run's mutation/verification evidence so the claim-time gate
          // at no_tool_use is deterministic. No-op when the gate is off.
          // Use the EXECUTED args (`inv.effectiveArgs`) — a PreToolUse hook can
          // rewrite a `bun test` call into another command that exits 0, and the
          // gate must match what actually ran, not the model's pre-hook args.
          // A fresh mutation re-arms the gate (starts a new verification cycle),
          // so reset the per-cycle nudge budget — otherwise a later edit inherits
          // attempts spent on an earlier one and, once the run-wide count hits the
          // max, every subsequent post-edit claim is accepted with only a warning.
          if (
            recordToolForVerify(
              verifyState,
              verifyCommands,
              tu.name,
              inv.effectiveArgs ?? tu.input,
              inv.failed,
              inv.exitCode,
            )
          ) {
            verifyAttempts = 0;
          }
          // Persist the dispatch-rewrite audit row now that invokeTool
          // created the tool_calls row that the FK points at. Skipped
          // when invokeTool returned an empty toolCallId (unknown
          // tool — no tool_call row to anchor against). Best-effort:
          // FK / IO failure stderr-logs and lets the rewrite proceed;
          // the behavior change already happened on tu.input mutation
          // upstream, only the forensic surface degrades.
          if (pendingRewriteAudit !== null && inv.toolCallId !== '') {
            try {
              createDispatchRewrite(config.db, {
                toolCallId: inv.toolCallId,
                sessionId,
                policyId: pendingRewriteAudit.policyId,
                actionSignature: pendingRewriteAudit.actionSignature,
                originalCommand: pendingRewriteAudit.originalCommand,
                rewrittenCommand: pendingRewriteAudit.rewrittenCommand,
                matchedScope: pendingRewriteAudit.matchedScope,
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              process.stderr.write(
                `forja adaptation: dispatch_rewrites insert failed for tool_call=${inv.toolCallId} (${msg})\n`,
              );
            }
          }
          // Slice 131 wire: when a tool execution fails AFTER
          // permission allowed it (failed=true, denied!=true)
          // AND we have an approval_seq from the decision, emit
          // an outcome_signal kind=tool_error. Calibration sweeps
          // use this as a weak proxy for "the allow decision led
          // to a bad outcome". Best-effort: outcome-sink failure
          // surfaces to stderr but never crashes the loop. Skip
          // denied paths — denials are by construction the
          // engine refusing the call; outcome of a deny is
          // already encoded in the decision itself.
          if (
            config.outcomeSink !== undefined &&
            inv.failed === true &&
            inv.denied !== true &&
            inv.decision?.approvalSeq !== undefined
          ) {
            try {
              config.outcomeSink.emit({
                approval_seq: inv.decision.approvalSeq,
                signal_kind: 'tool_error',
                payload: {
                  tool_name: tu.name,
                  duration_ms: inv.durationMs,
                  ...(inv.errorMessage !== undefined ? { error_message: inv.errorMessage } : {}),
                },
              });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              process.stderr.write(
                `forja outcome_signals: tool_error wire failed for approval_seq=${inv.decision.approvalSeq} (${msg})\n`,
              );
            }
          }
          // FEEDBACK_ADAPTATION §3.1 loop quente write — emit a
          // `outcomes` row capturing the (action_signature, tier,
          // result) tuple for the dispatch. Coexists with the
          // outcome_signals emission above per AUDIT.md §1.1.1:
          // the two tables record different audit dimensions and
          // never dual-write the same fact. The signal_kind=
          // 'tool_error' block above feeds the permission engine's
          // calibration; THIS row feeds the loop frio adaptation
          // engine (3.4). Best-effort — failures stderr but don't
          // crash. Denied calls are skipped inside the emitter (no
          // body ran, no action_signature outcome to record).
          emitToolCallOutcome(config.db, {
            sessionId,
            toolCallId: inv.toolCallId,
            toolName: tu.name,
            failed: inv.failed,
            ...(inv.denied === true ? { denied: true } : {}),
            durationMs: inv.durationMs,
            ...(inv.errorMessage !== undefined ? { errorMessage: inv.errorMessage } : {}),
            // Pass tool input so the emitter can derive L1 alias
            // signatures from bash commands (3.5a). Other tools
            // ignore the input; only `bash` carries a `command`
            // field the parser inspects.
            toolInput: tu.input,
            // When a dispatch rewrite manifested, pin the L1
            // signature to the policy's — the post-rewrite
            // command's leading binary (rg) isn't in the alias
            // table, so without this override the emitter would
            // skip the L1 row entirely and the policy would lose
            // its evidence stream immediately after promotion
            // (3.6d).
            ...(appliedL1Signature !== null ? { appliedL1Signature } : {}),
            // Pass the scope chain so outcomes land at scope=repo
            // (when detected). Without this, every outcome lands
            // at scope=session and repo/user/language-scoped
            // policies never accumulate evidence (3.7b — fixes
            // H1 from the branch review).
            scopeChain: buildScopeChain({ sessionId, repoCwd: repoRoot }),
          });
          // §13.6 degraded banner heartbeat (slice 92). Fires after
          // every tool call; emitter is cheap + queries engine state
          // internally. Emits a `sandbox_degraded_active` harness
          // event on first-entry to degraded + every N calls
          // thereafter (default 10).
          degradedBannerEmitter.notifyToolCall(sessionId);
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
            ctx.appendToolResults(toolResults, config.systemPromptHash ?? null);
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
              // The bail returns mid-`for` — the tool_uses after this
              // one never run. Every tool_use in the assistant turn
              // must still be answered by a tool_result, or the
              // persisted history is invalid: the provider 400s on the
              // next request ("tool_use without tool_result") and the
              // session is unrecoverable. Synthesize an error result
              // for each tool_use this round never reached.
              const answered = new Set(toolResults.map((r) => r.tool_use_id));
              for (const pending of collected.tool_uses) {
                if (answered.has(pending.id)) continue;
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: pending.id,
                  name: pending.name,
                  content: 'Tool not executed — run stopped after consecutive tool errors.',
                  is_error: true,
                });
              }
              ctx.appendToolResults(toolResults, config.systemPromptHash ?? null);
              return await finish('maxToolErrors', `${consecutiveErrors} consecutive tool errors`);
            }
          }
        }

        // Persist tool_results back as a user message; mirror them in the
        // running provider message list for the next turn.
        ctx.appendToolResults(toolResults, config.systemPromptHash ?? null);

        // Compaction now runs at the TOP of the loop (maybeCompact, before
        // every provider call) — see above. No post-tool-result trigger here
        // anymore: the next iteration's top-of-loop check folds whatever this
        // turn's tool_results just added, and the single site keeps "every
        // provider call is preceded by a compaction check" structural.

        // S11/S13/S3 — detector scheduler ticks at step boundary
        // (MEMORY.md §11.x / T11.9 + T13.x + S3.4). Each scheduler
        // polls its source surface (memory_provenance / memory_events
        // / memory_override_events), runs gates, and dispatches AT
        // MOST one verification before the next provider call.
        // Awaited (not fire-and-forget) so the dispatch's cost
        // lands in the session totals before the next iteration's
        // cost-cap check.
        //
        // Cost wiring (post-review fix): each detector's LLM-judge
        // dispatch is a real billed call but only tracked in
        // scheduler-local counters until this helper folds the delta
        // into the accountant's child cost (`acct.addChildCost`).
        // Pre-fix, a session at/near `maxCostUsd` could still run
        // verify-* dispatches because `costCapDetailIfExceeded()` only
        // consults the accountant's cumulative spend (prior + run +
        // child + rehydrated + reserved) — never the scheduler
        // counters. With default-on detectors,
        // operator's hard cap was silently exceeded by the
        // detector spend. The helper folds delta in + fires a
        // cost_update event (with the FULL composite cumulative
        // so the renderer's footer reflects reality) + immediately
        // checks the cap so a burst that pushes past doesn't wait
        // for the next top-of-loop check.
        //
        // Best-effort: scheduler failures stderr-log here AND
        // inside the scheduler implementation (defense in depth
        // against programmer errors that escape the inner catch).
        const chargeSchedulerThenCheckCap = async (
          scheduler:
            | {
                poll: () => Promise<void>;
                getCounters: () => { costUsdSpent: number };
              }
            | undefined,
          label: 'verify_semantic' | 'verify_conflict' | 'verify_override',
        ): Promise<string | null> => {
          if (scheduler === undefined) return null;
          const before = scheduler.getCounters().costUsdSpent;
          try {
            await scheduler.poll();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`memory: ${label}_poll_unhandled: ${redactSecrets(msg)}\n`);
          }
          const after = scheduler.getCounters().costUsdSpent;
          const delta = after - before;
          if (delta > 0) {
            acct.addChildCost(delta);
            safeEmit(config.onEvent, {
              type: 'cost_update',
              delta,
              // Child-inclusive cumulative (self + this run's children),
              // deliberately distinct from emitCostUpdate's self-only figure:
              // this charge is child spend that lives in the children's own
              // session rows, not the parent's rollup.
              cumulative: acct.priorCostUsd + acct.runCostUsd + acct.cumulativeChildCostUsd,
            });
          }
          return costCapDetailIfExceeded();
        };

        const semanticOverage = await chargeSchedulerThenCheckCap(
          semanticVerifyScheduler,
          'verify_semantic',
        );
        if (semanticOverage !== null) return await finish('maxCostUsd', semanticOverage);

        const conflictOverage = await chargeSchedulerThenCheckCap(
          conflictDetectorScheduler,
          'verify_conflict',
        );
        if (conflictOverage !== null) return await finish('maxCostUsd', conflictOverage);

        const overrideOverage = await chargeSchedulerThenCheckCap(
          overrideVerifyScheduler,
          'verify_override',
        );
        if (overrideOverage !== null) return await finish('maxCostUsd', overrideOverage);
      }
    } catch (e) {
      return await guardedFinish(e);
    }
  } finally {
    // Shut down the semantic-verify scheduler first. Subsequent
    // poll() calls no-op; any in-flight dispatch from the last
    // poll already awaited above (the loop awaits per-step), so
    // nothing remains in flight here. Idempotent — safe to call
    // even when the scheduler was never created.
    semanticVerifyScheduler?.shutdown();
    conflictDetectorScheduler?.shutdown();
    overrideVerifyScheduler?.shutdown();
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
    // Tear the bg manager down — but ONLY when the loop owns it (no
    // holder = one-shot run). When a holder was INJECTED (the REPL,
    // spec ORCHESTRATION.md §3B.1), the manager is session-scoped and
    // its processes must SURVIVE the turn; killing them here would
    // reintroduce the exact "background dies at turn end" bug the holder
    // fixes. The REPL owns teardown via `manager.cleanup()` at session
    // exit. Mirrors the `todoStore` ownership check below.
    if (bgManager !== undefined && config.bgManagerHolder === undefined) {
      try {
        await bgManager.cleanup();
      } catch {
        // Best-effort; cleanup failures must not mask the run result
        // or escape the harness boundary. Any zombies left behind
        // are visible via the background_processes audit table.
      }
    }
    // Drop the in-memory TodoList for this session — but ONLY when the
    // loop owns the store (one-shot run, store created above). When the
    // store was INJECTED (the REPL, where it must survive across turns),
    // the caller owns teardown; clearing here would wipe the list between
    // every turn — the exact bug the injection fixes. Idempotent.
    if (config.todoStore === undefined) {
      todoStore.clear(sessionId);
    }
    // Same ownership contract for the working-state panel: clear only when the
    // loop owns it (one-shot run). An injected store (REPL) survives the turn;
    // the caller owns teardown. Idempotent.
    if (config.workingStateStore === undefined) {
      workingStateStore.clear(sessionId);
    }
  }
};
