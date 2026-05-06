import type { HookSpec } from '../hooks/index.ts';
import type { MemoryRegistry } from '../memory/index.ts';
import type { Decision, PermissionEngine } from '../permissions/index.ts';
import type { Provider, StreamEvent, UsageInfo } from '../providers/index.ts';
import type { DB } from '../storage/index.ts';
import type { SubagentSet } from '../subagents/load.ts';
import type { TodoItem } from '../todo/index.ts';
import type { ToolRegistry } from '../tools/index.ts';

// Lifecycle events the harness emits during a run. Synchronous (fire and
// forget) so renderers stay simple and the loop never waits on UI work.
// Persistence happens via SQLite separately — these events are for live
// observers (TTY renderer, NDJSON output, future telemetry).
export type HarnessEvent =
  | { type: 'session_start'; sessionId: string }
  | {
      // Emitted only on resume when the persisted message log
      // exceeded MAX_RESUME_MESSAGES and the older tail was
      // dropped. Renderers can show "resumed with N of M
      // messages, M-N dropped" so the user knows part of the
      // history is no longer in context.
      type: 'resume_truncated';
      sessionId: string;
      kept: number;
      dropped: number;
    }
  | { type: 'step_start'; stepN: number }
  | { type: 'provider_event'; event: StreamEvent }
  | {
      type: 'tool_invoking';
      toolUseId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | { type: 'tool_decided'; toolUseId: string; decision: Decision }
  | {
      // Operator-facing warning emitted by a tool MID-execution
      // (no failure — the tool still returns success). Used today
      // by `memory_read` to surface `[memory: untrusted]` per
      // spec §7.2.7 ("UI mostra `[memory: untrusted]` em qualquer
      // memória `untrusted` carregada"). Adapter translates to a
      // `warn` UIEvent in the live region; NDJSON consumers see
      // the harness-side shape verbatim. Distinct from `warn`
      // events the harness emits for non-tool concerns (resume
      // truncation, etc.) so audit can attribute them to a
      // specific tool call.
      type: 'tool_warning';
      toolUseId: string;
      toolName: string;
      message: string;
    }
  | {
      type: 'tool_finished';
      toolUseId: string;
      toolName: string;
      failed: boolean;
      durationMs: number;
      // True specifically when the failure was a denial (policy `deny`
      // or user rejected a `confirm` modal). Disambiguates from
      // execution errors after an allowed/confirmed tool — without
      // this, a user-rejected confirm and a tool that crashed AFTER
      // approval are both `failed: true` and audit/UI can't tell
      // them apart. Absent for non-failure outcomes.
      denied?: boolean;
    }
  | {
      type: 'compaction_started';
      // Token count that crossed the threshold — what we observed
      // BEFORE the next request would have gone out.
      promptTokens: number;
      threshold: number;
      contextWindow: number;
    }
  | {
      type: 'compaction_finished';
      strategy: 'llm' | 'fallback' | 'skipped';
      foldedCount: number;
      durationMs: number;
      // Usage and cost the compaction call itself incurred. The
      // summary call is a billed provider request — surfacing it
      // here lets renderers show "session cost includes $X for
      // compaction" instead of silently underreporting.
      usage: UsageInfo;
      costUsd: number;
      reason?: string;
    }
  | {
      // Emitted ONCE per step, after the harness has decided that
      // the step's tool_uses include at least one tool with
      // `writes: true` and the snapshot succeeded. Spec §12: a
      // step that doesn't write produces no event; a step whose
      // working tree was identical to the prior snapshot ALSO
      // produces no event (the no-op skip in CheckpointManager).
      type: 'checkpoint_created';
      checkpointId: string;
      gitRef: string;
      stepId: string;
      // Mirrors the persisted had_bash flag — true when the
      // step that produced the checkpoint also ran bash. Renderers
      // use this to show a hint that `--undo` won't reverse
      // bash side effects.
      hadBash: boolean;
    }
  | {
      // Emitted at session_start when the harness was asked to
      // enable checkpoints but the cwd is not a git repository.
      // The renderer surfaces this as a one-line warning so the
      // user knows `/undo` won't be there for this run. Distinct
      // from `enableCheckpoints=false` (no event emitted).
      type: 'checkpoints_unavailable';
      reason: string;
    }
  | {
      // Background process started. Fires once per process right
      // after `bash_background` (or any future bg-spawning tool)
      // succeeds in `BgManager.spawn`. The TUI uses this to
      // increment its `bg N` footer counter; persistence captures
      // the same row through audit.
      type: 'bg_started';
      processId: string;
      command: string;
      label: string | null;
    }
  | {
      // Background process exited. Fires once per process from
      // inside the manager's `exitedSettled` handler — natural exit
      // and kill-induced exit converge here exactly once. `exitCode`
      // is null when the OS reaped before we could read it (e.g.
      // DB error swallow path). Spawn-time failure does not emit
      // (D147); the caller sees the exception synchronously.
      type: 'bg_ended';
      processId: string;
      status: 'exited' | 'killed';
      exitCode: number | null;
    }
  | {
      // Emitted whenever the session-bound TodoStore is mutated via
      // `set` — i.e. INSIDE the `todo_write` tool's execute(), right
      // after the list lands in the store and BEFORE the tool returns.
      // The harness sees `todo_updated` fire between `tool_invoking`
      // and `tool_finished` for the same toolUseId. Producer is the
      // harness loop (wraps the bare store with an emitting set;
      // clear() is intentionally NOT wired — spec §7.4 treats list
      // teardown at session-end as cleanup, not a planning event).
      // Items are deep-cloned by the store before emission so
      // observers can't reach back into store state.
      type: 'todo_updated';
      sessionId: string;
      items: TodoItem[];
    }
  | {
      // Lifecycle bracket for a subagent the parent harness just
      // spawned via `task`. Producer is the harness loop's
      // spawnSubagent closure (loop.ts), emitted right BEFORE the
      // child runs. Without this event, the parent's TUI sees no
      // signal that work shifted to a child — the operator stares
      // at a blank live region for the duration of the child's
      // run. Adapter translates to UIEvent `subagent:start`; the
      // renderer renders a collapsed group keyed by `subagentId`.
      // `subagentId` is the child session id (also exposed as
      // `RunSubagentResult.sessionId` upstream); `name` is the
      // subagent definition name (e.g. `explore`); `prompt` is
      // the child's seed prompt — short renderers truncate it.
      type: 'subagent_start';
      subagentId: string;
      name: string;
      prompt: string;
    }
  | {
      // Live progress signal from a running subagent. Producer is
      // the harness loop's spawnSubagent closure as it forwards
      // HarnessEvents the child emits over IPC (spec docs/spec/IPC.md
      // §3.2). The wrapped `lastEvent` carries the most recent
      // HarnessEvent the child fired so the parent's reducer can
      // compute a one-line progress string (step counter, last
      // tool name, etc.) without needing to model the full child
      // state. Stream-shaped: zero or many between
      // `subagent_start` and `subagent_finished`. The wrapped
      // event MUST NOT itself be a `subagent_*` variant — nested
      // subagent observability is dropped at the boundary because
      // the parent renders only its direct children.
      type: 'subagent_progress';
      subagentId: string;
      lastEvent: HarnessEvent;
    }
  | {
      // Closing bracket for a subagent run. Emitted by the
      // spawnSubagent closure after `runSubagent` resolves — once
      // per `subagent_start`. Carries the terminal outcome the
      // parent will render in the collapsed group: `status` (the
      // child's HarnessResult.status: 'done'/'error'/'interrupted'),
      // `summary` (a short human-readable line — the renderer
      // typically uses the child's `output` first line, truncated),
      // `durationMs` (wall-clock from start to finish, parent's
      // perspective), `costUsd` (the child's reported authoritative
      // cost; 0 when the child died before publishing).
      type: 'subagent_finished';
      subagentId: string;
      status: HarnessResult['status'];
      summary: string;
      durationMs: number;
      costUsd: number;
    }
  | { type: 'session_finished'; result: HarnessResult };

// Budget caps for an autonomous run. Per AGENTIC_CLI §5: every limit has
// soft (warning) and hard (terminate) thresholds. M1 enforces hard caps
// only; warnings show up when the UI lands in Step 6.
export interface RunBudget {
  maxSteps: number;
  maxWallClockMs: number;
  maxToolErrors: number;
  // Sliding window: if `maxRepeatedToolHash` of the last 5 tool calls hash
  // identically, abort with `degenerate_loop`.
  maxRepeatedToolHash: number;
  // Cap on output tokens per provider call (passed straight through as
  // `max_tokens`). Not part of session-wide budget.
  maxOutputTokensPerCall: number;
  // Fraction of `provider.capabilities.context_window` at which the
  // harness triggers compaction. AGENTIC_CLI §6 / ORCHESTRATION §4.1
  // recommend 0.7 — leaves 30% headroom for the compaction call
  // itself plus the next response. Set to 1.0 to effectively disable.
  compactionThreshold: number;
  // Lower bound on trailing turns preserved literally during
  // compaction. ORCHESTRATION §4.6 recommends 3. Effective preserved
  // count may be `+1` because the compaction module aligns the tail
  // boundary to an assistant message (keeps tool_use → tool_result
  // pairs intact); when the requested boundary lands on a user the
  // module walks back one position. preserveTail=0 still preserves
  // the trailing assistant + its tool_result for the same reason.
  compactionPreserveTail: number;
  // Hard cap on total spend for this run, in USD. Optional —
  // absent = no cap, preserves the existing "let other budgets
  // contain the run" behavior. When set, the harness aborts with
  // `maxCostUsd` after the FIRST cost-increasing event whose
  // running total crosses the cap (provider turn or compaction
  // call). Compared per-event with `>` so a `maxCostUsd: 0` config
  // means "no spend allowed" — the first paid turn trips the gate.
  // Honored across resumes via the cumulative tracker (priorCostUsd
  // + totalCostUsd is what the cap compares against, NOT just the
  // per-run total).
  maxCostUsd?: number;
}

export const DEFAULT_BUDGET: RunBudget = {
  maxSteps: 50,
  maxWallClockMs: 10 * 60 * 1000,
  maxToolErrors: 5,
  maxRepeatedToolHash: 3,
  maxOutputTokensPerCall: 4096,
  compactionThreshold: 0.7,
  compactionPreserveTail: 3,
};

// Why the loop stopped. `done` is the only success path; everything else
// is the harness intervening for safety or budget reasons.
export type ExitReason =
  | 'done' // model emitted text without tool_use
  | 'maxSteps'
  | 'maxWallClockMs'
  | 'maxOutputTokens' // provider truncated the response at max_tokens
  | 'maxCostUsd' // running cumulative cost crossed budget.maxCostUsd
  | 'maxToolErrors'
  | 'degenerateLoop'
  | 'aborted' // user cancelled via signal
  | 'providerError' // unrecoverable provider failure (network, 4xx)
  | 'internalError' // uncaught throw in the harness path (typically SQLite)
  | 'scriptExhausted' // mock provider drained — only seen in tests
  | 'userPromptBlocked'; // a UserPromptSubmit hook refused this turn

export interface HarnessConfig {
  provider: Provider;
  toolRegistry: ToolRegistry;
  permissionEngine: PermissionEngine;
  db: DB;
  // Directory where bg-aware tools' stdout/stderr log files are
  // written. When set, the harness creates a session-scoped
  // BgManager after createSession and threads it through
  // ToolContext so `bash_background`/`bash_output`/`bash_kill` can
  // dispatch through it. The manager is owned by the harness
  // (cleanup runs in the session-end finally) — callers who need
  // pre-existing managers for testing build them directly with
  // createBgManager. When absent, bg-aware tools surface a clean
  // tool-error.
  bgLogDir?: string;
  cwd: string;
  systemPrompt?: string;
  userPrompt: string;
  budget?: Partial<RunBudget>;
  signal?: AbortSignal;
  // Cooperative-stop signal (spec UI.md §3, soft interrupt). When
  // aborted, the harness completes the current step (provider call
  // + any tool execution that was already in flight) and exits with
  // `reason: 'aborted'` BEFORE issuing the next provider request.
  // Distinct from `signal` (hard abort) which preempts in-flight
  // work — operator UX: first Esc/Ctrl+C asks the loop to stop at
  // the next safe boundary, second Esc/Ctrl+C kills mid-tool.
  // Optional — when absent, the loop only honors the hard signal,
  // preserving the legacy behavior.
  softStopSignal?: AbortSignal;
  // Synchronous observer for lifecycle events. Throws are caught and
  // discarded so a buggy renderer doesn't kill the loop.
  onEvent?: (event: HarnessEvent) => void;
  // Plan mode (AGENTIC_CLI §5): read-only profile. The harness
  // refuses tools with `metadata.writes === true` before
  // execution — even if policy would have allowed it. This is
  // harness-level, not policy-level, so write_file/edit_file
  // are blocked regardless of permission hierarchy state.
  //
  // Tools that opt in via `metadata.planSafe` (boolean or
  // predicate) MAY run in plan mode. The bash tool uses a
  // predicate that gates on `args.read_only === true`. This
  // gate is best-effort, NOT a security boundary: a model that
  // declares read_only:true on a mutating command (observed
  // with Haiku 4.5 sending `echo > file` with read_only:true)
  // bypasses the gate. For adversarial protection, use sandbox
  // (spec §9.1, M3+). For accidental-write protection from
  // honest models, the predicate is sufficient.
  planMode?: boolean;
  // Sampling temperature passed straight through to every
  // provider call this run makes. When unset, each provider
  // applies its own default (Anthropic 1.0, OpenAI 1.0, etc).
  // Setting `0` makes runs deterministic — required for evals
  // and any workflow that needs repeatable output. Tunable per
  // workflow per `TOKEN_TUNING.md`.
  temperature?: number;
  // Resume mode (AGENTIC_CLI §2.1): when set, the harness skips
  // createSession and uses this id instead. Persisted messages for
  // the session are loaded into the in-memory `messages` array
  // before the new userPrompt is appended, so the model sees the
  // full prior conversation as context. The session is reopened
  // (status flipped back to 'running') so completeSession at the
  // end of the resumed run doesn't trip its 'must be running'
  // guard. Caller is responsible for verifying the id exists
  // before constructing the config.
  resumeFromSessionId?: string;
  // Use a session id that the CALLER already created — skips both
  // `createSession` (the fresh-session path) and `reopenSession`
  // (the resume path). Spec §11 subprocess subagents use this:
  // the parent process creates the child session row + audit
  // rows BEFORE spawning the child binary; the child runs the
  // harness against the pre-existing id and never touches the
  // session lifecycle. The row MUST exist and be in `status =
  // 'active'` (the just-created shape from `createSession`); the
  // harness will append messages, run the loop, and call
  // `completeSession` at the end exactly as a fresh run would.
  //
  // Mutually exclusive with `resumeFromSessionId` — preassigned
  // is "I already created the row, use that id" while resume is
  // "the row already exists from a prior run, reopen it". Setting
  // both is a programmer bug; the harness throws.
  //
  // Mutually exclusive with `parentSessionId` at the runtime
  // level too: the parent_session_id is set by the caller during
  // their own `createSession`, not threaded through here. Setting
  // both is harmless (parentSessionId is ignored on the
  // preassigned path) but indicates a confused construction.
  preassignedSessionId?: string;
  // Checkpoint subsystem (M3 §12). When true, the harness probes
  // `cwd` once at startup and, if the directory is a git repo,
  // takes a snapshot before every step that runs a tool with
  // `writes: true`. Default false: explicit opt-in keeps the cost
  // off the hot path for unit tests and short-lived programmatic
  // callers. The CLI bootstrap turns it on for real runs.
  //
  // Disabling checkpoints does NOT disable write tools — the
  // harness still executes them, just without the rollback safety
  // net. CHECKPOINTS.md §2.2 documents the trade-off.
  enableCheckpoints?: boolean;
  // Override the default checkpoint retention (CHECKPOINTS.md §2.5,
  // default 30 days). When checkpoints are enabled, the harness
  // fires a fire-and-forget purge at session start that drops
  // checkpoint rows + refs older than this. Set to a small number
  // in tests that need to exercise the cleanup path; leave unset in
  // production to use the spec default.
  checkpointsRetentionDays?: number;
  // Subagent linkage (spec §11). When set, createSession writes
  // this id into sessions.parent_session_id so the audit trail can
  // walk parent → child without the runtime tracking it separately.
  // Mutually exclusive with `resumeFromSessionId` — a resumed run
  // already has its parent id persisted, and resume reuses the
  // existing row instead of creating a new one. The runtime
  // (`subagents/runtime.ts`) is the only intended caller; nothing
  // stops a test from setting it directly.
  parentSessionId?: string;
  // Subagent registry made available to the `task` tool. When set,
  // the harness wires `ToolContext.spawnSubagent` to a closure that
  // resolves names against this set and dispatches `runSubagent`
  // with the parent's deps (provider, db, registry, engine). Absent
  // = `task` tool surfaces a clean error if invoked.
  subagentRegistry?: SubagentSet;
  // Root tool registry for SUBAGENT WHITELIST VALIDATION through
  // a nested task() chain. The harness's `toolRegistry` is what
  // the CURRENT run can execute (narrowed to the subagent's
  // whitelist for child runs); but a child that wants to spawn a
  // grandchild must validate the grandchild's whitelist against
  // the ROOT registry, NOT against its own narrowed view —
  // otherwise a coordinator subagent with `tools: [task]` couldn't
  // spawn a worker with `tools: [read_file]` because read_file
  // isn't in the coordinator's narrowed registry. Set by the
  // top-level bootstrap (or implicitly defaults to `toolRegistry`
  // when unset, which is the top-level case).
  rootToolRegistry?: ToolRegistry;
  // Recursion depth of THIS run inside a subagent chain. 0 (or
  // unset) = the top-level user session. The harness's spawn closure
  // increments this when calling `runSubagent` so the child knows
  // its own depth and can refuse a further spawn at MAX_SUBAGENT_DEPTH.
  // Set by the runtime, NOT by callers — programmatic users build
  // top-level configs and let the runtime manage chain state.
  subagentDepth?: number;
  // Memory subsystem registry (spec MEMORY.md). When set, the
  // harness threads it through ToolContext so memory_list /
  // memory_read / memory_search can dispatch. Absent = those tools
  // surface a clean tool-error when invoked. The registry is
  // constructed by the CLI bootstrap (or by tests building a
  // HarnessConfig directly) and owns its own audit/persistence
  // wiring; the harness just hands it through.
  memoryRegistry?: MemoryRegistry;
  // Async hook the harness calls when the permission engine returns
  // a `confirm` decision. Caller resolves true to allow the call
  // (recorded as confirm_yes) or false to deny (confirm_no). When
  // unset, `confirm` decisions fall back to deny-with-reason — the
  // legacy headless behavior. Interactive callers (REPL) wire this
  // to their modal manager; one-shot mode leaves it unset.
  confirmPermission?: (req: {
    toolName: string;
    args: Record<string, unknown>;
    cwd: string;
    prompt: string;
    // Subagent attribution. Set by the parent harness's
    // spawnSubagent closure when proxying a child's
    // `permission:ask` (spec docs/spec/IPC.md §7). The TUI
    // renderer keys on this to prefix the modal so the
    // operator distinguishes parent vs child requests.
    subagent?: { sessionId: string; name: string };
    // Producer-driven cancellation. When set, the implementation
    // (REPL bridge) forwards to ModalManager so a producer-side
    // event (typically: subagent died with the modal still open)
    // closes the modal and resolves to deny without operator
    // input. Used by the subagent permission proxy; invoke-tool
    // (the parent's own confirm path) leaves it unset because
    // it already handles abort via raceAgainstAbort at the
    // call site.
    signal?: AbortSignal;
  }) => Promise<boolean>;
  // Trust state of `cwd` (AGENTIC_CLI.md §9.1, MEMORY.md §7.2.1).
  // True when the cwd is in the persisted `trusted_dirs.json` at
  // bootstrap time. False when storage is unavailable, the file
  // is missing/corrupt, or the cwd hasn't been confirmed yet.
  // Threaded through to `ToolContext.isCwdTrusted` so tools can
  // self-gate when a path's trust matters (today only
  // `memory_write` consumes it — refuses `inferred` writes in
  // untrusted cwds). Defaults to false at the harness layer
  // (fail-closed); production callers always set it from
  // bootstrap, tests opt in via the makeCtx helper which
  // defaults to true (post-trust-prompt reality).
  isCwdTrusted?: boolean;
  // Async hook for memory_write modal confirmation (MEMORY.md §5.1).
  // Caller resolves with the operator's decision so the tool layer
  // can map it onto an audit row + the writer call. Per spec: 'yes'
  // proceeds with the persist, 'no' is an explicit reject (audit
  // gets `refused`), 'cancel' is an Esc/timeout (audit gets
  // `refused` with reason='cancelled'). When unset, the
  // memory_write tool falls back to "headless / no-modal", which
  // per spec §5.1.6 means the write is rejected. Interactive
  // callers (REPL) wire this to `modalManager.askMemoryWrite`;
  // one-shot mode leaves it unset.
  confirmMemoryWrite?: (req: ConfirmMemoryWriteRequest) => Promise<MemoryWriteAnswer>;
  // Async hook for the user-scope second-confirm modal (MEMORY.md
  // §7.2.5). The `memory_write` tool fires this AFTER
  // `confirmMemoryWrite` returns yes AND the proposed scope is
  // `user`. Caller (REPL) wires it to
  // `modalManager.askMemoryUserScope`. When unset, the tool
  // refuses user-scope writes with `headless_mode` (paired with
  // confirmMemoryWrite — production wires both, headless wires
  // neither). Body is included so the modal can re-render the
  // exact bytes; spec doesn't require it but it gives the
  // operator a second look at the content before the
  // cross-session blast hits.
  confirmMemoryUserScope?: (req: ConfirmMemoryUserScopeRequest) => Promise<MemoryWriteAnswer>;
  // Hook specs resolved at boot (spec AGENTIC_CLI.md §10). Already
  // ordered enterprise → user → project; the dispatcher iterates
  // in order and short-circuits on first block (for blocking
  // events). Empty/undefined = no hooks; all dispatch sites turn
  // into a no-op filter — no perf cost beyond an empty array
  // walk.
  hooks?: readonly HookSpec[];
}

// Producer-facing args for `confirmMemoryWrite`. Mirrors
// `MemoryWriteAskArgs` from modal-manager.ts but lives in the
// harness layer so tools don't import the TUI module. The body is
// the EXACT bytes about to land on disk; the modal renders it
// verbatim so the operator can spot prompt-injection attempts
// before approving.
export interface ConfirmMemoryWriteRequest {
  scope: 'user' | 'project_shared' | 'project_local';
  name: string;
  body: string;
}

// Producer-facing args for `confirmMemoryUserScope`. No `scope`
// field by construction — the caller has already established
// it's a user-scope write before invoking this. Mirrors
// `MemoryUserScopeAskArgs` from modal-manager.ts.
export interface ConfirmMemoryUserScopeRequest {
  name: string;
  body: string;
}

// Same union as `MemoryWriteAnswer` in modal-manager.ts. Re-declared
// here so the harness layer doesn't pull on the TUI module.
export type MemoryWriteAnswer = 'yes' | 'no' | 'cancel';

export interface HarnessResult {
  status: 'done' | 'interrupted' | 'exhausted' | 'error';
  reason: ExitReason;
  sessionId: string;
  steps: number;
  durationMs: number;
  // Aggregated token usage across all provider turns this run. Only
  // turns that reported usage contribute; see `usageComplete`.
  usage: UsageInfo;
  // Total cost computed from `usage` × the provider's pricing. Same
  // completeness caveat as `usage`.
  costUsd: number;
  // True iff every assistant turn this session emitted a `usage`
  // event. False when at least one turn produced output but no usage
  // (compat endpoints that drop stream_options, mid-stream failures,
  // older SDKs without telemetry). Renderers should mark partial
  // results as estimates so the user doesn't read the cost as final.
  usageComplete: boolean;
  // Final assistant message id, if any was produced.
  lastMessageId?: string;
  // Optional human-readable detail for diagnostics (e.g., the provider
  // error message, or which tool exhausted the error budget).
  detail?: string;
  // When `reason === 'aborted'`, discriminates whether the abort was
  // operator-initiated cooperative ('soft' — let in-flight work
  // finish then exit cleanly) or preemptive ('hard' — kill mid-tool
  // / mid-stream). Undefined for any other reason — the discriminator
  // is meaningless when the loop exited for budget caps, done, or a
  // non-abort error. Audit log + future telemetry need this to
  // distinguish "operator nudged" from "operator escalated";
  // without this discriminator, both Esc and Esc-Esc would produce identical HarnessResults.
  abortCause?: 'soft' | 'hard';
}
