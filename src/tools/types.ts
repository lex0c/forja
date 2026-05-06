import type { BgManager } from '../bg/index.ts';
import type { HookChainResult, HookEventPayload } from '../hooks/index.ts';
import type { MemoryRegistry } from '../memory/index.ts';
import type { Decision, PermissionsView, PolicyCategory, ToolArgs } from '../permissions/index.ts';
import type { ProviderToolInputSchema } from '../providers/index.ts';
import type { SubagentHandleStore } from '../subagents/handle-store.ts';
import type { WorktreeOutcome } from '../subagents/types.ts';
import type { TodoStore } from '../todo/index.ts';

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

export const isToolError = <O>(r: ToolResult<O>): r is ToolError =>
  typeof r === 'object' && r !== null && (r as ToolError).is_error === true;

// Display hints from CONTRACTS §2 cláusula 7. Pure metadata for the UI;
// the harness ignores them.
export type DisplayHint = 'table' | 'list' | 'diff' | 'raw' | 'auto';

export interface ToolMetadata {
  category: PolicyCategory;
  // Side effect declarations. `writes: true` triggers checkpoint creation
  // in the harness (Step 5+).
  writes: boolean;
  // Plan-mode predicate. When the harness is in plan mode and
  // the tool has `writes: true`, this decides per-invocation
  // whether the call may proceed. Three forms:
  //   - omitted: every invocation blocked in plan mode (default
  //     for write_file/edit_file — they ALWAYS mutate, the gate
  //     here IS bullet-proof).
  //   - `true`: every invocation allowed regardless of args.
  //     Equivalent to "plan mode trusts this tool unconditionally".
  //   - function: per-call predicate that inspects args. The
  //     canonical case is `bash` — it CAN write, but the model
  //     declares intent via `args.read_only`. Boolean-only would
  //     either block legitimate inspections (git status, ls, cat)
  //     or silently allow `echo x > file`. The predicate lets the
  //     tool author encode the rule that `read_only === true` is
  //     the gate.
  //
  // IMPORTANT: the predicate form is best-effort, NOT a security
  // boundary. It catches honest models that forget to declare
  // intent. It does NOT catch confused or adversarial models that
  // declare `read_only: true` while sending `echo x > file` —
  // observed in practice. Real protection
  // for adversarial inputs requires sandbox (spec §9.1, M3+).
  // The `writes: true` + omitted-predicate combo IS bullet-proof
  // because the harness never executes the tool. Use that for
  // tools that should never run in plan mode period.
  planSafe?: boolean | ((args: Record<string, unknown>) => boolean);
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
  // `bash` is intentionally NOT flagged even though `args.read_only`
  // exists: the flag is a model declaration, not a static property,
  // and spec §9.1 documents it's not a security boundary. Letting a
  // runtime hint gate parallelism would let an adversarial model
  // amplify a race.
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
}

export interface ToolContext {
  signal: AbortSignal;
  cwd: string;
  sessionId: string;
  stepId: string;
  permissions: PermissionsView;
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
  // Background process manager for the current session. Optional so
  // existing tools that don't need bg orchestration aren't forced to
  // declare a dependency. Tools that DO need it (`bash_background`,
  // `bash_output`, `bash_kill`) surface a clean error when absent
  // rather than dereferencing undefined.
  bgManager?: BgManager;
  // Session-bound TodoList store. Optional so existing tools that
  // don't need it aren't forced to declare a dependency. The
  // todo_write tool surfaces a clean error when absent rather than
  // dereferencing undefined. Per spec §7.4, the list does NOT
  // persist across sessions; the harness creates a fresh store at
  // session start and clears it at session end.
  todoStore?: TodoStore;
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
  // the harness when a subagent registry is wired and the run is
  // not in plan mode. `task_async` calls `store.spawn(args)` to
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
  // Hook chain dispatch — generic per-event funnel built in the
  // harness loop. Tools fire blocking events (MemoryWrite, future
  // event-bearing tools) and inspect `blockedBy` on the result.
  // Returns null when no hooks are configured OR the dispatcher
  // itself failed (fail-open per spec line 1057). Optional —
  // headless / one-shot ToolContexts without a wired-through
  // harness leave it unset; tools degrade to "no hook gate".
  fireHook?: (payload: HookEventPayload) => Promise<HookChainResult | null>;
}

// Inputs the `task` tool passes through to the harness's subagent
// runner. Kept narrow on purpose — the tool already validates the
// model-supplied args; this type is just the spawn-side contract.
export interface SpawnSubagentArgs {
  name: string;
  prompt: string;
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
  aborted: 'tool.aborted',
  // Tools whose category gate is too coarse for their actual side
  // effects (wait_for / monitor) self-gate per leaf condition and
  // surface this code when the policy denies a leaf. Distinct from
  // the harness-level deny (which short-circuits before tool.execute
  // runs and uses the model-facing `tool_decided` event).
  permissionDenied: 'permission.denied',
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
