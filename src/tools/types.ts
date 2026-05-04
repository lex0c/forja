import type { BgManager } from '../bg/index.ts';
import type { HookChainResult, HookEventPayload } from '../hooks/index.ts';
import type { MemoryRegistry } from '../memory/index.ts';
import type { Decision, PermissionsView, PolicyCategory, ToolArgs } from '../permissions/index.ts';
import type { ProviderToolInputSchema } from '../providers/index.ts';
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
  // observed in practice (M2 / Step 6.5 baseline). Real protection
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
  // invocation. For the M3/4.2a subagent runtime, bgManager is
  // never wired into the child harness (worktree subagents share
  // the parent's bg log dir, which is unsafe); 4.2b will revisit
  // by giving worktree subagents their own bg dir.
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
// `depth_exceeded` variant is also a model-recoverable signal —
// the model should stop nesting `task()` calls and finish the work
// itself.
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
