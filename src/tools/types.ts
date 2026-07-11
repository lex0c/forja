import type { BgManager } from '../bg/index.ts';
import type { Broker } from '../broker/index.ts';
import type { FileDiff } from '../diff/line-diff.ts';
import type { HookChainResult, HookEventPayload } from '../hooks/index.ts';
import type { MemoryRegistry } from '../memory/index.ts';
import type {
  Decision,
  PermissionsView,
  PolicyCategory,
  SandboxProfile,
  ToolArgs,
} from '../permissions/index.ts';
import type { ProviderToolInputSchema } from '../providers/index.ts';
import type { ReminderScheduler } from '../reminders/index.ts';
import type { RetrieveFn } from '../retrieval/index.ts';
import type { SkillCatalog } from '../skills/index.ts';
import type { ContextPinsStore } from '../storage/repos/context-pins.ts';
import type { SubagentHandleStore } from '../subagents/handle-store.ts';
import type { WorktreeOutcome } from '../subagents/types.ts';
import type { TodoStore } from '../todo/index.ts';
import type { WorkingStateStore } from '../working-state/index.ts';

// Per CONTRACTS §2: tool errors are *data*, not exceptions. The harness
// catches stray throws and converts them, but tools are expected to
// surface known failure modes via this shape.
export interface ToolError {
  is_error: true;
  error_code: string;
  error_message: string;
  retryable: boolean;
  hint?: string;
  details?: Record<string, unknown>;
}

export type ToolResult<O> = O | ToolError;

// Accepts `unknown` so callers holding a value of indeterminate
// shape (e.g., the `summarize` hook receives `result: unknown`)
// can narrow without a multi-step cast. The duck-type check is
// the same regardless of compile-time shape.
export const isToolError = (r: unknown): r is ToolError =>
  typeof r === 'object' && r !== null && (r as { is_error?: unknown }).is_error === true;

// Display hints from CONTRACTS §2 cláusula 7. Pure metadata for the UI;
// the harness ignores them.
export type DisplayHint = 'table' | 'list' | 'diff' | 'raw' | 'auto';

export interface ToolMetadata {
  category: PolicyCategory;
  // Side effect declarations. `writes: true` triggers checkpoint creation
  // in the harness (Step 5+).
  writes: boolean;
  network?: boolean;
  exec?: boolean;
  // Side effects of this tool may escape `ctx.cwd` — bash, network
  // calls, process spawns, anything that writes outside the work-tree.
  // Drives the warning in `--undo` (CHECKPOINTS.md §2.6) because such
  // effects are NOT reversed by a working-tree restore. Defaults to
  // false; the bash family opts in. The harness also keeps a name
  // fallback (`bash`, `bash_background`, `bash_kill`) as defense in
  // depth so external tool definitions added without setting the flag
  // still get the warning.
  escapesCwd?: boolean;
  // Tool depends on `ToolContext.bgManager` to function. The
  // canonical case is the bash-background family
  // (`bash_background`, `bash_kill`) which dispatches through the
  // session-scoped BgManager; without it they surface a clean
  // tool-error at runtime. The validator pulls that runtime
  // error forward to bootstrap-time so a subagent author whose
  // whitelist includes a bg-bound tool finds out before first
  // invocation.
  requiresBgManager?: boolean;
  // Tool depends on `ToolContext.reminderScheduler` (ORCHESTRATION.md
  // §3B.9) — the `reminder` family. Same role as `requiresBgManager`:
  // without the scheduler the tool surfaces a clean tool-error, and the
  // side-effect oracle treats it as a side effect (arming a timer that
  // can wake a turn is an effect even though no fs write happens). The
  // scheduler is REPL-only (one-shot/subagent runs have no next turn to
  // wake), so a subagent whitelist including a reminder tool is caught.
  requiresReminderScheduler?: boolean;
  // Tool needs an interactive operator confirmation surface to run
  // (today only `memory_write`, which awaits the modal-bridge
  // callback before persisting). Subagents are headless from the
  // operator's perspective — they have no modal pipe back to the
  // parent REPL — so a tool flagged this way has no path to run
  // inside a subagent and the subagent validator rejects whitelists
  // that include it. Distinct axis from `writes`: a write tool can
  // run in a worktree-isolated subagent, but a confirm-bound tool
  // can't run in ANY subagent until parent↔child IPC grows a
  // confirm channel (spec §11). Defaults to false; only memory_write
  // opts in today.
  requiresOperatorConfirm?: boolean;
  // Tool is kept OUT of the base model-facing surface (AGENTIC_CLI §7.6):
  // registered and dispatchable, but absent from the `tools` array a turn
  // sends until `tool_search` reveals it. Trims selection pressure (principle
  // 3) — the base surface should cover the common path, and only niche
  // alternatives / rare self-contained management land here. NOT a permission
  // gate: a revealed deferred tool runs under the same policy as any other.
  // Defaults to false (visible). The reveal is sticky for the session; the
  // loop rebuilds `tools = base + revealed`.
  deferred?: boolean;
  // Window-relative deferral (CONTEXT_TUNING §2.2). When set, the tool leaves
  // the base surface whenever the active `context_window` is BELOW this token
  // threshold — i.e. it is base on large windows but deferred (reachable via
  // `tool_search`) on small ones. Independent of the static `deferred` flag:
  // `deferred: true` means always-deferred, while `deferBelowTokens` marks a
  // base-but-dispensable tool that leans out only when the window is tight. The
  // window-tier constants live in `src/tools/context-budget.ts`. The minimal
  // action core (read_file/glob/bash/edit_file/write_file/tool_search + session
  // state) never opts in; heavier discovery (grep/git/memory_read/memory_search)
  // and subagent orchestration (task*) may, on a tight window — the exact set is
  // an operator/eval choice, not an invariant. A non-positive (unknown) window
  // disables this arm — the tool stays visible — matching the compaction gate.
  deferBelowTokens?: number;
  idempotent: boolean;
  // Opt-in to parallel execution within a step (spec
  // ORCHESTRATION.md §1.3). When EVERY tool_use the model emits in
  // a single step has `parallel_safe === true`, the harness
  // dispatches them through a bounded pool instead of the default
  // serial loop. A single non-`parallel_safe` tool_use in the
  // batch falls back to fully-serial execution (no partial
  // parallelism — keeps invariants simple and order deterministic).
  //
  // Only declare `true` for tools whose execution is naturally
  // independent of OTHER concurrent tool calls in the same
  // process: read-only filesystem reads, in-memory lookups against
  // immutable state, lexical/grep searches. Tools with
  // `writes: true` MUST NOT declare it (FS race). Tools that
  // touch session-bound mutable state (todo store, bg manager
  // state machine, IPC channels) MUST NOT declare it. Tools that
  // require operator confirmation MUST NOT declare it (modal
  // serialization is per-modal-manager, not per-tool).
  //
  // `bash` is intentionally NOT flagged: whether a given command is
  // read-only is a runtime property of its args, not a static
  // property of the tool, and spec §9.1 documents that such hints
  // aren't a security boundary. Letting a runtime hint gate
  // parallelism would let an adversarial model amplify a race.
  //
  // Default false is the safe choice — opt-in keeps every existing
  // tool serial until it's been audited for parallel safety.
  parallel_safe?: boolean;
  display?: DisplayHint;
  // Optional cost hints; informational only in M1.
  cost?: {
    latency_ms_typical?: number;
    max_output_bytes?: number;
  };
  // Deterministic output summarizer. The harness calls this AFTER
  // `tool.execute()` settles AND AFTER the raw result is persisted
  // to the `tool_calls.output` audit column — only the model-facing
  // copy (the next-turn `tool_result.content`) is reduced.
  //
  // Tools with outputs that can grow into tens of KB (bash stdout,
  // grep hit lists, glob match arrays) attach a summarizer that
  // returns a shrunken result of the SAME shape. The harness
  // prepends a `[forja:output_summarized policy=X original_bytes=N]`
  // marker so the model knows what it's reading is a digest, not
  // the full output, and can re-invoke the tool with narrower args
  // if it needs detail.
  //
  // Implementations MUST be pure (no I/O, no time-dependence) so
  // audit-replay reproduces the same digest.
  summarize?: (result: unknown, args: Record<string, unknown>) => SummarizedOutput;
}

// Does this tool's metadata declare a side effect a narrowed subagent envelope can NEVER
// cover? The envelope gate (engine §10.3, branch b) consults it for tools whose resolver
// emits ZERO capabilities: with nothing in the envelope to cover, an opaque side effect
// must be refused. Covers fs writes, process exec, bg / reminder lifecycle, AND network
// egress / cwd escape — mesh_send / fetch_url send data OUTSIDE the sandbox, so `writes`
// is false but the egress IS the side effect. ONE source so the two oracle wiring points
// (cli/bootstrap.ts, cli/subagent-child.ts) can't drift apart — they did: network /
// escapesCwd was missed, letting mesh_send pass under `effectiveCapabilities: []`.
export const isEnvelopeSideEffect = (m: ToolMetadata): boolean =>
  m.writes === true ||
  m.exec === true ||
  m.requiresBgManager === true ||
  m.requiresReminderScheduler === true ||
  m.network === true ||
  m.escapesCwd === true;

// Result of a `ToolMetadata.summarize` call. Carries the reduced
// result object (same shape as the raw result), a flag indicating
// whether any reduction actually happened, and the diagnostic
// fields the harness encodes into the marker.
export interface SummarizedOutput {
  // The result object the harness JSON-stringifies into the
  // model's `tool_result.content`. Same shape as the raw result;
  // only the heavy string fields inside are shorter.
  result: unknown;
  // True iff at least one byte was dropped. When false, the harness
  // sends the raw result through unchanged and emits no marker.
  reduced: boolean;
  // Pre-summary byte count of the JSON-serialized raw result.
  // Surfaced in the marker so the model sees the magnitude of
  // what was elided.
  originalBytes: number;
  // Policy label — drives the marker text. Free-form; the tool
  // and the harness share the strings.
  policy: string;
}

// Modal bridge contract for the `clarify` tool (CONTRACTS §2.6.5e,
// STATE_MACHINE §12). Shared by every hop of the chain
// (ToolContext.clarify, HarnessConfig.clarify, the REPL bridge) so the
// shape has ONE source of truth instead of being hand-synced across
// files. The response keeps `escalated` (STATE_MACHINE §12 edit-goal)
// even though the current ModalManager producer only emits
// resolved/skipped — the narrower ClarifyManagerAnswer stays assignable.
export interface ClarifyBridgeRequest {
  question: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  why_it_matters?: string;
  // Producer-side cancellation (the tool's `ctx.signal`: wall-clock /
  // user abort combined by the harness). Forwarded to the modal so a
  // hard budget/cancel closes the prompt immediately instead of waiting
  // on the operator or the 60s timeout. Mirrors confirmPermission's
  // req.signal.
  signal?: AbortSignal;
}
export interface ClarifyBridgeResponse {
  outcome: 'resolved' | 'skipped' | 'escalated';
  chosen_option_id?: string;
  user_text?: string;
}

export interface ToolContext {
  signal: AbortSignal;
  cwd: string;
  sessionId: string;
  stepId: string;
  // The active tool_call row's id, populated by the harness in
  // `invoke-tool.ts` right after `createToolCall`. Tools that emit
  // per-call audit rows (currently only memory_read / memory_search
  // for the provenance trail in MEMORY.md §11.2) thread this into
  // the registry so each exposure links back to its causal call.
  // Optional because test contexts and legacy entrypoints
  // construct ToolContext without going through the harness loop —
  // those callers get no provenance row, which mirrors how
  // bgManager / todoStore degrade cleanly when absent.
  toolCallId?: string;
  // Migration 058 — id of the `approvals` row that admitted this
  // tool call. Populated by invoke-tool after `recordApproval` lands
  // the allow row. Only tools that spawn subagents (`task` family)
  // read this — it threads through SpawnSubagentArgs into
  // `subagent_runs.parent_approval_id` so the audit chain is
  // one-hop instead of multi-hop via messages/tool_calls.
  // Optional because test contexts construct ToolContext without
  // going through invoke-tool.
  approvalId?: string;
  permissions: PermissionsView;
  // §6.5 sandbox profile the engine planner chose for THIS call.
  // Populated by `invoke-tool.ts` from `decision.sandboxProfile`
  // when the engine was constructed with sandbox inputs. Tools
  // that spawn child processes (currently `bash`) consume this to
  // wrap argv via `buildBwrapArgv(...)`. Undefined when the planner
  // didn't run (legacy / test path), when category is `misc`, or
  // when the decision didn't reach the planner stage (state-reject,
  // resolver-refuse).
  sandboxProfile?: SandboxProfile;
  // Slice 157 (review — phase 2 of macOS /tmp isolation). Per-CLI-run
  // tmpdir on macOS, undefined elsewhere. Tools that spawn child
  // processes via `maybeWrapSandboxArgv` forward this into the
  // `tmpdir` field so the SBPL profile scopes write access. Tools
  // ALSO merge `TMPDIR=<this>` into the child's env so
  // mktemp / NSTemporaryDirectory / Python tempfile honor the scope.
  // Plumbed by the harness from `HarnessConfig.sandboxTmpdir`. See
  // `PERMISSION_ENGINE.md §6.5` for the threat model.
  sandboxTmpdir?: string;
  // Sandbox tool detected at boot ('bwrap'/'sandbox-exec'), or undefined if
  // none was available. Plumbed from `HarnessConfig.sandboxBootTool`. Tools
  // that spawn child processes use it to drive the wrap's `failClosed`: a
  // tool present at boot but unresolvable now is a mid-session loss → fail
  // closed (tool error) rather than a silent unsandboxed run.
  sandboxBootTool?: 'bwrap' | 'sandbox-exec';
  // Recursion depth of the CURRENT run inside a subagent chain.
  // 0 (or unset) = top-level user session. The harness threads
  // this from `HarnessConfig.subagentDepth` so tools that spawn
  // children (`task` / `task_async`) can pre-flight the depth
  // gate at the call site instead of the deeper-down dispatcher.
  // Optional + default-zero so test contexts that don't model
  // chain state still construct cleanly.
  subagentDepth?: number;
  // Run-level cost accounting (spec ORCHESTRATION.md §3.5).
  // Returns the cap and the cumulative cost incurred so far.
  // `spent` includes parent self-cost (priorCostUsd +
  // totalCostUsd) AND settled child costs AND the
  // pessimistic reservation for in-flight children. `cap` is
  // undefined when the run has no maxCostUsd configured —
  // every projected total fits under "no cap".
  // Used by `task_async` to refuse new spawns when the cap
  // would be crossed; the in-flight reservation is what
  // protects against the footgun where 3 concurrent
  // task_async calls each pass an "I see room" check
  // because no settled child cost has landed yet.
  getCostBudget?: () => { spent: number; cap: number | undefined };
  // Lookup helper for subagent budget estimates. Returns the
  // definition's `budget.maxCostUsd` (worst-case spend) for the
  // named subagent, or null when the name doesn't resolve.
  // `task_async` uses this to compute the pessimistic
  // reservation for the spawn it's about to issue. Separated
  // from a full `subagentRegistry` exposure to keep tools
  // that spawn children from reaching into definition shapes
  // they don't need to read.
  //
  // The `null` return is load-bearing: it distinguishes
  // "subagent not registered" from "registered with zero
  // cost". `task_async` reads `null` as fail-fast (refuse
  // before issuing a handle the eventual `task_await` would
  // bounce). Callers MUST NOT coalesce `null` to `0`.
  getSubagentBudgetEstimate?: (name: string) => number | null;
  // Lists the names of subagents available in the current run.
  // Empty array when no registry is wired or the registry is
  // empty. `task_async` uses this to populate the
  // `subagent.unknown` error's `available` field — same shape
  // as the sync `task` tool's error path. Sorted for stable
  // ordering across calls so audit consumers see a
  // deterministic list.
  getKnownSubagentNames?: () => string[];
  // Audit recorder for pre-spawn refusals (spec
  // ORCHESTRATION.md §3.5, audit fix #3). Called by `task` /
  // `task_sync` / `task_async` immediately before returning a
  // `subagent.budget_exhausted`, `subagent.unknown`, or
  // `subagent.depth_exceeded` tool error. Persists into
  // `subagent_gate_decisions`.
  //
  // The harness wraps the underlying repo write in a fail-soft
  // try/catch — DB throws degrade audit completeness without
  // affecting the model's view (the tool error is already
  // about to return). Tools that don't have a recorder wired
  // (test contexts without the harness) get `undefined` and
  // skip the call; audit data is not load-bearing for
  // correctness.
  //
  // The recorder is a single-call surface so each refusal site
  // can write its decision in one line — keeps tool code lean
  // and hides the db/sessionId binding inside the harness.
  recordGateDecision?: (input: {
    decisionType:
      | 'budget_exhausted'
      | 'unknown_subagent'
      | 'depth_exceeded'
      | 'subagent_escalation';
    toolName: 'task' | 'task_sync' | 'task_async';
    requestedName: string;
    details: Record<string, unknown>;
  }) => void;
  // Background process manager for the current session. Optional so
  // existing tools that don't need bg orchestration aren't forced to
  // declare a dependency. Tools that DO need it (`bash_background`,
  // `bash_output`, `bash_kill`) surface a clean error when absent
  // rather than dereferencing undefined.
  bgManager?: BgManager;
  // Session-bound TodoList store. Optional so existing tools that
  // don't need it aren't forced to declare a dependency. The
  // todo tools surface a clean error when absent rather than
  // dereferencing undefined. Per spec §7.4, the list does NOT
  // persist across sessions; the harness creates a fresh store at
  // session start and clears it at session end.
  todoStore?: TodoStore;
  // Session-bound working-state panel store (WORKING_STATE.md). Optional, same
  // pattern as todoStore: working_state_update surfaces a clean error when
  // absent. In-memory, dies at session end — no persistence (§0.5).
  workingStateStore?: WorkingStateStore;
  // Current monotonic step number of the run, for stamping working-state
  // staleness (atStep / updatedAtStep — WORKING_STATE.md §6). Lazy getter,
  // mirroring getCostBudget: the counter lives in the loop closure. Undefined
  // in test/legacy contexts (the tool falls back to step 0).
  getStepNumber?: () => number;
  // Session-scoped reminder scheduler (ORCHESTRATION.md §3B.9). Optional,
  // same pattern as `bgManager`/`todoStore`: the `reminder` family
  // surfaces a clean error when absent (e.g. one-shot `run.ts`, which has
  // no next turn for a reminder to wake) rather than dereferencing
  // undefined. In-memory, dies at session exit — no persistence.
  reminderScheduler?: ReminderScheduler;
  // Per-call permission predicate. The harness wires this to
  // `permissionEngine.check`. Tools whose category gate is too coarse
  // for their actual side effects (notably `wait_for` and `monitor`,
  // which are category='misc' but do fs/network probes per leaf
  // condition) call this before each gated leaf to enforce the
  // existing fs/web policy sections. REQUIRED — making it optional
  // would silently re-introduce the misc-bypass any time a future
  // entrypoint constructs a ToolContext without going through the
  // harness loop. Tests inject an explicit allow-all (or a custom
  // predicate to exercise deny paths) via makeCtx.
  permissionCheck: (toolName: string, category: PolicyCategory, args: ToolArgs) => Decision;
  // Spawn a subagent (spec §11). Set by the harness when a subagent
  // registry was wired via HarnessConfig.subagentRegistry; absent
  // when no subagents are available. The `task` tool surfaces a
  // clean error in that case rather than dereferencing undefined.
  // The harness binds parent_session_id from this context's
  // sessionId so the link is captured automatically.
  spawnSubagent?: (args: SpawnSubagentArgs) => Promise<SpawnSubagentResult>;
  // Async subagent handle store (spec ORCHESTRATION.md §3). Set by
  // the harness when a subagent registry is wired. `task_async`
  // calls `store.spawn(args)` to
  // get a handle; `task_await` and `task_cancel` use the same
  // store instance. Run-scoped — the same store survives across
  // every step in a single `runAgent` call so a handle returned
  // in step 3 is awaitable in step 7. Drained in the run's outer
  // finally so a parent abort tears every running spawn down
  // before SQLite closes. Absent ⇒ the three async-subagent
  // tools surface `subagent.unavailable` (matching the legacy
  // `task` tool shape when no registry is configured).
  subagentHandleStore?: SubagentHandleStore;
  // Memory subsystem registry (spec MEMORY.md). Set by the harness
  // when memory was wired via HarnessConfig.memoryRegistry. The
  // memory_read / memory_list / memory_search tools surface a
  // clean error when absent rather than dereferencing undefined,
  // matching the bgManager / todoStore patterns. Read events are
  // logged to memory_events at the registry layer; the tool just
  // dispatches.
  memoryRegistry?: MemoryRegistry;
  // Skill catalog (spec SKILLS.md). Set by the harness when skills
  // were wired via HarnessConfig.skillCatalog. The skill_invoke /
  // skill_list / skill_show tools surface a clean error when absent
  // rather than dereferencing undefined — same pattern as
  // memoryRegistry. The catalog owns its own audit emit (recordEvent
  // → skill_events); the tools just dispatch.
  skillCatalog?: SkillCatalog;
  // Retrieval subsystem runner (spec RETRIEVAL.md §15.4). Set by
  // the harness when both memoryRegistry AND db are wired — the
  // pipeline needs both for its view + compression-resolver
  // dependencies. Absent in headless callers that didn't wire
  // either. The `retrieve_context` tool surfaces a clean
  // `retrieval.unavailable` error when this is undefined.
  retrieveContext?: RetrieveFn;
  // Modal confirm hook for the `memory_write` tool (MEMORY.md §5.1).
  // Set by the harness when `HarnessConfig.confirmMemoryWrite` is
  // wired. Absent in headless / non-interactive runs — the
  // memory_write tool then rejects with `headless_mode` per spec
  // §5.1.6, mirroring the bgManager-absent pattern.
  confirmMemoryWrite?: (req: {
    scope: 'user' | 'project_shared' | 'project_local';
    name: string;
    body: string;
  }) => Promise<'yes' | 'no' | 'cancel'>;
  // Second-confirm hook for user-scope writes (MEMORY.md §7.2.5).
  // Fired by `memory_write` AFTER `confirmMemoryWrite` returns
  // yes AND the proposed scope is `user`. Pairs with
  // `confirmMemoryWrite` in production: REPL wires both, headless
  // wires neither. When `confirmMemoryWrite` is set but this is
  // NOT (programmer error or partial test wiring), user-scope
  // writes are refused with `headless_mode` to fail-closed.
  confirmMemoryUserScope?: (req: {
    name: string;
    body: string;
  }) => Promise<'yes' | 'no' | 'cancel'>;
  // Pinned context store (CONTEXT_TUNING.md §12.4). Set by the
  // harness when context_pins persistence is wired (default in
  // production REPL; off in degenerate test contexts). The
  // pin_context tool and `/pin` slash command consume this; tools
  // surface a clean error when absent rather than dereferencing
  // undefined. Persistent — backed by SQLite, not an in-memory
  // map — so pins survive `/resume` per §12.4.4.
  contextPinsStore?: ContextPinsStore;
  // Modal bridge for the `clarify` tool (CONTRACTS §2.6.5e,
  // STATE_MACHINE §12). The model emits `clarify(...)` to ask the
  // operator instead of presuming; `medium`/`high` routes here for a
  // form-modal answer (`low` auto-resolves inside the tool). The REPL
  // wires it through the ModalManager; headless / subagent leave it
  // unset and the tool returns `clarify.modal_unavailable`. Shape is
  // the shared ClarifyBridge{Request,Response}.
  clarify?: (req: ClarifyBridgeRequest) => Promise<ClarifyBridgeResponse>;
  // Mesh subsystem handle (MESH.md §9) — the mesh_peers / mesh_send tools reach
  // the manager through here. REPL-wired; headless/subagent leave it unset and
  // the tools surface `mesh.unavailable`.
  meshManager?: import('../mesh/manager.ts').MeshManager;
  // Trust state of `cwd` resolved at session start (AGENTIC_CLI.md
  // §9.1). Required so any future tool that needs trust info gets
  // an explicit value rather than an undefined fallback that could
  // silently allow privileged behavior. memory_write consumes this
  // (MEMORY.md §7.2.1: `inferred` writes refused in untrusted
  // cwds); `user_explicit` writes go through regardless. The
  // default-true convention in tests' makeCtx mirrors the
  // post-trust-prompt reality of the REPL flow.
  isCwdTrusted: boolean;
  // Operator-facing warning channel. Tools call this to surface
  // non-error notices that should land in the live region as a
  // `warn` line. Today only memory_read uses it (spec §7.2.7:
  // `[memory: untrusted]` marker when a body with
  // `trust: untrusted` is returned). Optional — when absent (one-
  // shot SDK without an event sink), the call is a no-op and the
  // tool's normal output remains the only carrier.
  emitWarn?: (message: string) => void;
  // Display-only structured diff (before→after) for a write/edit tool.
  // Routed to the TUI card via a `tool_diff` HarnessEvent; deliberately
  // NOT in the model-facing tool_result. Optional like emitWarn — tools
  // that produce no diff just don't call it; headless/SDK contexts omit
  // it.
  emitDiff?: (diff: FileDiff) => void;
  // Deferred-tool search (AGENTIC_CLI §7.6). Wired by the harness loop at the
  // TOP LEVEL only (subagents don't defer — their whitelist is the curation).
  // The `tool_search` tool calls this to look up deferred tools by keyword or
  // `select:name1,name2` and REVEAL the matches (sticky for the session); the
  // matched wire defs come back so the model gets the schemas in the result and
  // can call them next turn. Absent ⇒ tool_search returns
  // `tool_search.unavailable` (subagent / headless without the wiring).
  searchTools?: (query: string) => SearchToolsResult;
  // Hook chain dispatch — generic per-event funnel built in the
  // harness loop. Tools fire blocking events (MemoryWrite, future
  // event-bearing tools) and inspect `blockedBy` on the result.
  // Returns null when no hooks are configured OR the dispatcher
  // itself failed (fail-open per spec line 1057). Optional —
  // headless / one-shot ToolContexts without a wired-through
  // harness leave it unset; tools degrade to "no hook gate".
  fireHook?: (payload: HookEventPayload) => Promise<HookChainResult | null>;
  // Broker for exec-tagged tools (PERMISSION_ENGINE.md §13.7). Tools
  // whose execution requires OS-level isolation (currently `bash`)
  // dispatch through `broker.execute(request)` instead of calling
  // `Bun.spawn` directly. The broker owns sandbox mounting + worker
  // lifecycle (slices 78–81). REQUIRED for exec tools — bashTool
  // returns `bash.spawn_failed` when this is absent. Optional on
  // the type because read/glob/grep/edit/write don't need it.
  // Tests inject a degenerate in-process broker via
  // `tests/tools/_helpers.ts#makeCtx`; bootstrap (slice 82) wires a
  // production broker for the live REPL.
  broker?: Broker;
}

// A deferred tool surfaced by tool_search (AGENTIC_CLI §7.6). Carries exactly
// what the model needs to call it next turn: the same name/description/schema
// the base surface would have shown, minus the per-turn cost of always showing
// it. Field names mirror the Tool shape (inputSchema), not the provider wire
// (input_schema) — the harness adapter does that translation.
export interface ToolSearchHit {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface SearchToolsResult {
  // Matched deferred tools, already revealed (sticky) by the search call.
  tools: ToolSearchHit[];
  // Names from a `select:` query that matched no deferred tool — surfaced so the
  // model learns the name was wrong rather than silently getting fewer tools.
  notFound: string[];
}

// Inputs the `task` tool passes through to the harness's subagent
// runner. Kept narrow on purpose — the tool already validates the
// model-supplied args; this type is just the spawn-side contract.
//
// Capability inheritance (PERMISSION_ENGINE.md §10.1):
//   - `declaredCapabilities` — capability strings the model
//     requested for the child via the `capabilities` task arg.
//     Tool layer parses + validates the strings; this field
//     carries them through verbatim so the spawn factory's
//     intersection guard sees the exact bytes the model sent.
//   - `parentCapabilities` — capability strings the harness loop
//     snapshots from the parent's active policy at spawn time.
//     The factory intersects declared ∩ parent; any declared cap
//     NOT covered by some parent cap is `excess` and the spawn
//     is refused with `subagent_escalation`.
//
// Both fields are optional. Legacy callers (no capabilities
// declared in the task() invocation, OR a harness that doesn't
// yet wire parentCapabilities into the ctx) skip the §10 guard
// — the spawn proceeds under the existing toolset gating. Slice 9
// lands the primitive + opt-in plumbing; a later slice wires
// parentCapabilities derivation from policy automatically.
export interface SpawnSubagentArgs {
  name: string;
  prompt: string;
  declaredCapabilities?: readonly string[];
  parentCapabilities?: readonly string[];
  // Migration 058 — approval row that authorized the parent's task
  // tool call. Threaded into `subagent_runs.parent_approval_id` so
  // the audit chain stays one-hop from the run back to the policy
  // decision. Optional because (a) test fixtures construct
  // SpawnSubagentArgs without invoke-tool, (b) the verify-semantic
  // scheduler bypasses the approval path entirely (forensics via
  // memory_verify_attempts.subagent_run_session_id instead).
  parentApprovalId?: string;
}

// Result discriminated by `kind` so the calling tool can map an
// unknown subagent name into a tool error (model error) without
// confusing it with an executed-but-failed run (child error). The
// `depth_exceeded` and `budget_exhausted` variants are also
// model-recoverable signals — the model should stop nesting /
// stop spawning and finish the work itself, or wait for in-flight
// reservations to release.
export type SpawnSubagentResult =
  | {
      kind: 'unknown_subagent';
      requested: string;
      available: string[];
    }
  | {
      kind: 'depth_exceeded';
      requested: string;
      depth: number;
      maxDepth: number;
    }
  | {
      // Refused at spawn preflight (PLAYBOOKS.md §1.1): the playbook
      // declared a `model` the catalog can't resolve / instantiate
      // (unknown id or missing credential). Model-fixable — fix the
      // frontmatter `model`, wire the provider credential, or omit
      // `model` to inherit the session model. The tool layer maps this
      // onto a `subagent.playbook_model_unavailable` tool error.
      kind: 'playbook_model_unavailable';
      requested: string;
      model: string;
      reason: string;
    }
  | {
      // Refused by the cost-cap gate in `spawnSubagentImpl`
      // (spec ORCHESTRATION.md §3.5). `spent` includes parent
      // self-cost + cumulative child cost (settled, sync + async)
      // + pessimistic reservation (in-flight async). `estimate`
      // is the worst-case for this would-be spawn from
      // `definition.budget.maxCostUsd`. `projected = spent +
      // estimate`, the value that crossed `cap`. Both `task`
      // and `task_async` map this onto a `subagent.budget_exhausted`
      // tool error with the same `details` shape.
      kind: 'budget_exhausted';
      requested: string;
      spent: number;
      estimate: number;
      projected: number;
      cap: number;
    }
  | {
      // PERMISSION_ENGINE.md §10.1: refused because the declared
      // capability set is NOT a subset of the parent's. `excess`
      // is the formatted-string form of every declared capability
      // the spawn factory could not match against parentCapabilities.
      // The tool layer maps this onto `subagent.escalation` with
      // `excess` in `details` so the operator can see exactly which
      // capability the model asked for that wasn't already
      // exercisable by the parent.
      kind: 'subagent_escalation';
      requested: string;
      excess: string[];
    }
  | {
      kind: 'ran';
      output: string;
      sessionId: string;
      status: 'done' | 'interrupted' | 'exhausted' | 'error';
      reason: string;
      costUsd: number;
      steps: number;
      durationMs: number;
      // Optional advisory: the run completed but the audit
      // snapshot persistence failed. Surfaced so the calling
      // tool can echo it in its envelope; the run's outcome
      // (status/reason/cost/etc.) is still authoritative.
      auditFailure?: { code: string; message: string };
      // Worktree lifecycle outcome (spec §11.2). Shape pinned in
      // `WorktreeOutcome`. Present only when the spawned definition
      // declared `isolation: worktree`.
      worktree?: WorktreeOutcome;
      // `git worktree add` itself failed before the child loop
      // could start. Combined with `status='error'` /
      // `reason='worktree_create_failed'` so non-`done` mapping
      // catches it; the field is advisory detail for diagnostics.
      worktreeError?: { code: string; message: string };
      // Attribution for cancel-driven settles (spec
      // ORCHESTRATION.md §3.5 audit fix). Set by the handle
      // store when a record was explicitly cancelled via
      // `cancel`/`cancelAll`/`drain`; carries WHO triggered
      // it (model = explicit task_cancel, cap_watchdog =
      // automatic kill on cap-cross, parent_drain = harness
      // shutdown). Orthogonal to the `reason` / `status`
      // strings — those describe the OUTCOME, this describes
      // the SOURCE. Persisted into
      // `subagent_handles.settled_payload.cancelSource`.
      // Absent when the run wasn't explicitly cancelled
      // (status === 'done', wall-clock timeout at the child
      // layer, etc.) so postmortem queries don't get false
      // attribution.
      cancelSource?: 'model' | 'cap_watchdog' | 'parent_drain';
      // Free-form diagnostic detail forwarded from the child's
      // `HarnessResult.detail` across IPC. Carries the actual
      // cause of a non-`done` exit (e.g. provider error message
      // for `reason='providerError'`) so `task` / `task_await`
      // can append it to their tool-error string instead of
      // surfacing the bare categorical reason. Absent for
      // success and for failure paths with no extra text.
      detail?: string;
    };

export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: ProviderToolInputSchema;
  outputSchema?: object;
  metadata: ToolMetadata;
  execute(args: I, ctx: ToolContext): Promise<ToolResult<O>>;
}

// Standard error codes used across builtins. Centralized so failure modes
// are enumerable (CONTRACTS §2.5 criterion 5).
export const ERROR_CODES = {
  notFound: 'fs.not_found',
  isDirectory: 'fs.is_directory',
  notDirectory: 'fs.not_directory',
  readFailed: 'fs.read_failed',
  writeFailed: 'fs.write_failed',
  invalidPath: 'fs.invalid_path',
  binaryFile: 'fs.binary',
  ambiguousMatch: 'edit.ambiguous_match',
  oldStringNotFound: 'edit.old_string_not_found',
  oldEqualsNew: 'edit.old_equals_new',
  oldStringEmpty: 'edit.old_string_empty',
  globPatternEscapes: 'glob.pattern_escapes_root',
  invalidArg: 'tool.invalid_arg',
  bashTimeout: 'bash.timeout',
  bashSpawnFailed: 'bash.spawn_failed',
  ripgrepMissing: 'grep.ripgrep_missing',
  ripgrepFailed: 'grep.ripgrep_failed',
  gitMissing: 'git.missing',
  gitFailed: 'git.failed',
  gitNotRepo: 'git.not_a_repo',
  gitDenied: 'git.policy_denied',
  // git_apply_patch: structured patch failures. `malformed` = unparseable /
  // empty / no hunk; `unsupported` = multi-file / rename / copy / binary (out
  // of scope for the single-file tool); `contextMismatch` = `git apply --check`
  // rejected the patch against the current file; `pathMismatch` = the patch's
  // header path doesn't resolve to the gated `path` arg or escapes the worktree;
  // `applyFailed` = git apply failed after --check passed (rare; file untouched).
  patchMalformed: 'patch.malformed',
  patchUnsupported: 'patch.unsupported',
  patchContextMismatch: 'patch.context_mismatch',
  patchPathMismatch: 'patch.path_mismatch',
  patchApplyFailed: 'patch.apply_failed',
  aborted: 'tool.aborted',
  // Tools whose category gate is too coarse for their actual side
  // effects (wait_for / monitor) self-gate per leaf condition and
  // surface this code when the policy denies a leaf. Distinct from
  // the harness-level deny (which short-circuits before tool.execute
  // runs and uses the model-facing `tool_decided` event).
  permissionDenied: 'permission.denied',
  // Todo CRUD: a todo_update / todo_get referenced an id not in the
  // session's list — a stale reference or a typo in the model's call.
  todoNotFound: 'todo.not_found',
  // Mesh tools (mesh_peers / mesh_send).
  meshUnavailable: 'mesh.unavailable',
  meshNoSuchPeer: 'mesh.no_such_peer',
  // The peer was reachable in discovery but the send failed (connect refused, or
  // the socket closed mid-send) — distinct from no_such_peer so the model can retry
  // rather than re-run discovery for a peer that isn't there (§6.5).
  meshPeerLost: 'mesh.peer_lost',
  // The peer is serving but momentarily at its inbound-connection ceiling
  // (admission control) — transient; the model waits briefly and retries the same
  // send, it does NOT re-run discovery (the peer is alive, unlike peer_lost).
  meshAtCapacity: 'mesh.at_capacity',
  // mesh_send message is over the peer byte cap — distinct from no_such_peer so
  // the model shortens the request instead of re-running discovery.
  meshMessageTooLarge: 'mesh.message_too_large',
  // tool_search ran without the harness wiring (ctx.searchTools) — a subagent
  // or headless run where the deferred-tool surface (AGENTIC_CLI §7.6) doesn't
  // apply. The base surface is already the full whitelist there; nothing to
  // reveal.
  toolSearchUnavailable: 'tool_search.unavailable',
  // fetch_url failure modes (SECURITY_GUIDELINE.md §9.1).
  // `invalid_url` = malformed / non-http(s) input the resolver didn't
  // already refuse; `policy_denied` = a redirect hop was blocked by the
  // re-gate (SSRF / deny / cross-host to an unapproved host);
  // `unsupported_type` = response Content-Type is binary (image/pdf/...),
  // which the tool can't render to text; `failed` = network error,
  // timeout, or abort.
  fetchInvalidUrl: 'fetch.invalid_url',
  fetchPolicyDenied: 'fetch.policy_denied',
  fetchUnsupportedType: 'fetch.unsupported_type',
  fetchFailed: 'fetch.failed',
} as const;

export const toolError = (
  code: string,
  message: string,
  options: { retryable?: boolean; hint?: string; details?: Record<string, unknown> } = {},
): ToolError => ({
  is_error: true,
  error_code: code,
  error_message: message,
  retryable: options.retryable ?? false,
  ...(options.hint !== undefined ? { hint: options.hint } : {}),
  ...(options.details !== undefined ? { details: options.details } : {}),
});
