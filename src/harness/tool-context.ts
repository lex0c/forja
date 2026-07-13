// Tool-context builder extracted from the harness loop's runAgent (N6 — reduce
// the god-object). `buildCtx` — the ~200-line ToolContext assembly, the single
// most dependency-heavy inline construction in the loop — moves here as
// `buildToolContext(tu, deps)`. Every tool invocation in a step is dispatched
// with a ToolContext built here (permissions view, the todo/working-state/pins
// stores, the subagent spawn closure + budget lookups, the scope-filtered memory
// registry + retrieval runner, the warn/diff channels, the broker). It takes an
// explicit snapshot of the ~15 run/step locals it used to close over instead of
// capturing them. Behavior is preserved verbatim: the returned object literal is
// byte-for-byte the old closure body (the free variables are destructured from
// `deps` under the SAME names, so no field changed). The loop keeps a thin
// `buildCtx` wrapper so the per-tool call site is unchanged; the tools / harness
// suites are the net.
import type { BgManager } from '../bg/manager.ts';
import type { HookChainResult, HookEventPayload } from '../hooks/index.ts';
import type { MemoryRegistry } from '../memory/registry.ts';
import { buildRetrievalRunner } from '../retrieval/index.ts';
import { insertSubagentGateDecision } from '../storage/index.ts';
import type { ContextPinsStore } from '../storage/repos/context-pins.ts';
import type { SubagentHandleStore } from '../subagents/handle-store.ts';
import type { TodoStore } from '../todo/index.ts';
import type { ToolContext } from '../tools/index.ts';
import type { SearchToolsResult, SpawnSubagentArgs, SpawnSubagentResult } from '../tools/types.ts';
import type { WorkingStateStore } from '../working-state/index.ts';
import type { CollectedToolUse } from './collect.ts';
import type { CostAccountant } from './cost-accountant.ts';
import { safeEmit } from './emit.ts';
import type { HarnessConfig, RunBudget } from './types.ts';

export interface BuildToolContextDeps {
  signal: AbortSignal;
  config: HarnessConfig;
  sessionId: string;
  // The assistant message id for THIS step (the tool_result parent / checkpoint stepId).
  assistantMsgId: string;
  searchTools: (query: string) => SearchToolsResult;
  todoStore: TodoStore;
  workingStateStore: WorkingStateStore;
  bgManager: BgManager | undefined;
  spawnSubagentClosure: ((args: SpawnSubagentArgs) => Promise<SpawnSubagentResult>) | undefined;
  subagentHandleStore: SubagentHandleStore | undefined;
  acct: CostAccountant;
  budget: RunBudget;
  // Scope-filtered per the run's trust posture (project_shared excluded on a
  // non-confirmed shared-corpus probe); undefined on headless / no-memory runs.
  effectiveMemoryRegistry: MemoryRegistry | undefined;
  contextPinsStore: ContextPinsStore;
  dispatchHooks: (payload: HookEventPayload) => Promise<HookChainResult | null>;
}

// Build the per-tool ToolContext for one tool_use in the current step. The
// returned object is the exact shape the old inline `buildCtx` produced.
export const buildToolContext = (tu: CollectedToolUse, deps: BuildToolContextDeps): ToolContext => {
  const {
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
  } = deps;
  return {
    signal,
    cwd: config.cwd,
    sessionId,
    stepId: assistantMsgId,
    permissions: config.permissionEngine.view(),
    permissionCheck: (toolName, category, args) =>
      config.permissionEngine.check(toolName, category, args),
    // Deferred-tool reveal (AGENTIC_CLI §7.6), top level only — a subagent
    // runs a pre-narrowed whitelist (the curation), so nothing is deferred
    // and tool_search has nothing to reveal there.
    ...((config.subagentDepth ?? 0) === 0 ? { searchTools } : {}),
    todoStore,
    workingStateStore,
    // Session-monotonic step number for working-state staleness stamps
    // (WORKING_STATE.md §6) — read from the store, which carries it across
    // REPL turns (vs the per-run `steps` that resets each runAgent call).
    getStepNumber: () => workingStateStore.currentStep(sessionId),
    ...(bgManager !== undefined ? { bgManager } : {}),
    // Session-scoped reminder scheduler (ORCHESTRATION.md §3B.9).
    // Owned by the REPL (like the bgManagerHolder); the loop just
    // forwards it to the reminder tools. Absent in one-shot runs.
    ...(config.reminderScheduler !== undefined
      ? { reminderScheduler: config.reminderScheduler }
      : {}),
    ...(spawnSubagentClosure !== undefined ? { spawnSubagent: spawnSubagentClosure } : {}),
    ...(subagentHandleStore !== undefined ? { subagentHandleStore } : {}),
    // Slice 157 (review — phase 2 of macOS /tmp isolation). Per-
    // CLI-run sandbox tmpdir. Tools that wrap argv via
    // `maybeWrapSandboxArgv` forward this so the SBPL profile
    // scopes write access on darwin. Undefined on linux (already
    // isolated by `bwrap --tmpfs /tmp`) or when bootstrap mkdir
    // failed (graceful fallback to pre-slice-156 behavior).
    ...(config.sandboxTmpdir !== undefined ? { sandboxTmpdir: config.sandboxTmpdir } : {}),
    // Boot sandbox tool → drives the wrap's fail-closed posture in
    // tools that spawn (grep): a tool present at boot but gone now is a
    // mid-session loss → tool error, not a silent unsandboxed run.
    ...(config.sandboxBootTool !== undefined ? { sandboxBootTool: config.sandboxBootTool } : {}),
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
      spent: acct.cumulativeSpend(subagentHandleStore?.getReservedChildCostUsd() ?? 0),
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
    ...(effectiveMemoryRegistry !== undefined ? { memoryRegistry: effectiveMemoryRegistry } : {}),
    // Retrieval subsystem runner (slice 4.9). Wired when the
    // memory registry is configured — db is always available
    // since harness can't run without it. retrieve_context
    // tool surfaces 'retrieval.unavailable' when this is
    // absent (headless / SDK runs without memory).
    //
    // Uses the same `effectiveMemoryRegistry` the tool ctx
    // exposes, so the retrieval and direct-tool surfaces stay
    // at parity on the trust posture (both filter excluded
    // scopes; one couldn't legitimately bypass the other).
    // `memoryExcludeScopes` still flows into the retrieval
    // runner because the retrieval pipeline plumbs it
    // separately (e.g., into the BM25 view's own filter
    // path) — defense in depth: even if the wrapper missed
    // something at some surface, the explicit memoryExcludeScopes
    // there continues to enforce the same policy.
    ...(effectiveMemoryRegistry !== undefined
      ? {
          retrieveContext: buildRetrievalRunner({
            db: config.db,
            sessionId,
            memoryRegistry: effectiveMemoryRegistry,
            ...(config.memoryExcludeScopes !== undefined && config.memoryExcludeScopes.length > 0
              ? { memoryExcludeScopes: config.memoryExcludeScopes }
              : {}),
          }),
        }
      : {}),
    ...(config.confirmMemoryWrite !== undefined
      ? { confirmMemoryWrite: config.confirmMemoryWrite }
      : {}),
    ...(config.confirmMemoryUserScope !== undefined
      ? { confirmMemoryUserScope: config.confirmMemoryUserScope }
      : {}),
    ...(config.clarify !== undefined ? { clarify: config.clarify } : {}),
    ...(config.meshManager !== undefined ? { meshManager: config.meshManager } : {}),
    // Built once per run above (REPL-injected or a fresh wrapper over
    // the db), so pin_context works in any mode (like the todolist),
    // not just the interactive REPL.
    contextPinsStore,
    ...(config.skillCatalog !== undefined ? { skillCatalog: config.skillCatalog } : {}),
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
    // Display-only diff channel (sibling of emitWarn). The
    // structured before→after goes to the TUI card; it never enters
    // the model-facing tool_result.
    emitDiff: (diff) =>
      safeEmit(config.onEvent, {
        type: 'tool_diff',
        toolUseId: tu.id,
        toolName: tu.name,
        diff,
      }),
    // Hook chain — bound to the same dispatcher invoke-tool
    // already uses. Tools fire blocking events (today only
    // memory_write fires MemoryWrite); chain failure is
    // null-returned so tools fail-open per spec line 1057.
    fireHook: dispatchHooks,
    // Broker for exec-tagged tools (PERMISSION_ENGINE.md
    // §13.7). When bootstrap wired one through HarnessConfig,
    // the bash tool routes through `broker.execute`. Absent
    // ⇒ bash returns `bash.spawn_failed` (fail-loud).
    ...(config.broker !== undefined ? { broker: config.broker } : {}),
  };
};
