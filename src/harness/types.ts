import type { Broker } from '../broker/index.ts';
import type {
  ConfirmCritiqueRequest,
  CritiqueAnswer,
  CritiqueConfig,
  CritiqueStrategy,
} from '../critique/index.ts';
import type { FailureEventSink } from '../failures/index.ts';
import type { HookSpec } from '../hooks/index.ts';
import type { EagerExposure, MemoryRegistry } from '../memory/index.ts';
import type { OutcomeSink } from '../outcomes/index.ts';
import type { Decision, PermissionEngine, PolicySource } from '../permissions/index.ts';
import type { Provider, StreamEvent, UsageInfo } from '../providers/index.ts';
import type { DB } from '../storage/index.ts';
import type { ContextPinsStore } from '../storage/repos/context-pins.ts';
import type { SessionStatus } from '../storage/repos/sessions.ts';
import type { SubagentSet } from '../subagents/load.ts';
import type { TelemetrySink } from '../telemetry/index.ts';
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
  | {
      // Emitted on resume after the auto-rehydrate block was
      // prepended to the operator's first user prompt
      // (STATE_MACHINE.md §7.6 + RECAP.md §3.2). Renderer surface
      // is the visibility line `🔄 Resumed from <status> — N
      // decisions, M pins, K todos rehydrated`. `degraded` is
      // true when the projection had no goal text or signal —
      // the block is still emitted for an honest "Resumed at"
      // marker but contains no recap content.
      type: 'resume_rehydrated';
      sessionId: string;
      previousStatus: SessionStatus;
      decisionCount: number;
      pinCount: number;
      todoCount: number;
      truncated: boolean;
      degraded: boolean;
    }
  | {
      // Emitted when the auto-rehydrate path threw mid-projection
      // (corrupt audit log, missing session, etc.) and the harness
      // fell back to an unrehydrated prompt. The operator's resume
      // proceeds — auto-rehydrate is defense-in-depth, not a
      // correctness path — but the diagnostic surfaces so the
      // operator knows the `[resume_context]` block they expected
      // is missing and why.
      type: 'resume_rehydrate_failed';
      sessionId: string;
      reason: string;
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
  // Emitted the instant a tool's body starts executing — after the
  // permission engine, the modal, and PreToolUse hooks. Lets the TUI
  // rebase the tool card's clock to exclude the human wait at the
  // permission modal from the shown duration.
  | { type: 'tool_execution_started'; toolUseId: string }
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
      // Human-readable failure reason for non-denied errors (unknown
      // tool, tool returned a ToolError, tool threw and was wrapped).
      // Absent for success and for denied (denials surface their
      // reason via the `tool_decided` event's `decision.reason`,
      // which the renderer routes through `summary` separately).
      // The TUI uses this on the `└─` connector to surface the
      // cause without forcing the operator to grep audit logs.
      errorMessage?: string;
      // True when the tool capped its own output (bash `max_bytes`,
      // grep / glob `max_results`, the read_file window). The TUI
      // shows a `… output truncated` hint on the finished card so
      // the operator knows the result has more behind `ctrl+o`.
      // Absent for failures (a ToolError carries no `truncated`)
      // and for tools whose output shape has no truncation notion.
      outputTruncated?: boolean;
      // Non-zero exit code of a command tool (bash). The tool itself
      // succeeded (`failed: false`); this is the command's own exit.
      // The TUI shows `exit N` so a failed command doesn't read as a
      // success. Absent for exit 0 and tools with no exit code.
      exitCode?: number;
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
      // §13.6 degraded banner (slice 92). Emitted by the harness
      // loop's `DegradedBannerEmitter` while the engine is in
      // `degraded` state: once immediately on the FIRST tool call
      // after the transition, then every N tool calls (default
      // 10). Renderers display a non-suppressible banner with the
      // reason + a hint to run `agent doctor`. Spec line 905-908.
      //
      // `firstEmission` lets renderers format the initial entry
      // differently from recurring nudges ("⚠ Sandbox no longer
      // available" first, then "⚠ Sandbox still unavailable"
      // subsequently).
      type: 'sandbox_degraded_active';
      sessionId: string;
      reason: string;
      firstEmission: boolean;
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
      // Stable reason code, a string superset that includes
      // every `ExitReason` plus subagent-specific failures
      // (`worktree_create_failed`, `subprocess_spawn_failed`,
      // `subprocess_crashed`, `heartbeat_stale`,
      // `ipc_version_mismatch`, etc). Forwarded so the parent's
      // TUI can render an honest cause label instead of the
      // bare `status` enum, which loses the distinction between
      // budget exhaustion and crash. Typed as `string` rather
      // than the harness's `ExitReason` because the subagent
      // runtime's reason set is intentionally wider — locking
      // the event type to `ExitReason` would force every
      // subagent-specific failure to be remapped at the
      // boundary and lose information.
      reason?: string;
      summary: string;
      durationMs: number;
      costUsd: number;
    }
  | {
      // Per-turn cost delta, emitted right after the harness
      // appends a provider call's usage to its `totalCostUsd`
      // counter. Producer is the harness loop (loop.ts). The
      // event flows over IPC for subagent runs so the parent
      // can track in-flight child spend in real time and enforce
      // the shared `maxCostUsd` cap (spec ORCHESTRATION.md
      // §3.5). `delta` is the cost of the latest turn alone
      // (compaction calls also fire this event with their own
      // delta); `cumulative` is the running self-cost of THIS
      // session (does NOT include prior-run cost; the parent
      // already tracks `priorCostUsd` separately).
      type: 'cost_update';
      delta: number;
      cumulative: number;
    }
  | {
      // Parallelism observability snapshot (spec
      // ORCHESTRATION.md §1.3 / §3.3). Emitted by the harness
      // whenever the in-flight or queued counts change — the
      // TUI footer turns it into the `subagents R+Q/cap` and
      // `tools R/cap` chips. Without this, the operator only
      // saw "subagents 5" without knowing how many of those
      // were running vs queued behind the cap, and the
      // parallel tool batch was visible only as N concurrent
      // cards with no aggregate.
      //
      // Fields:
      //   - `subagentsRunning`: handles whose spawn has been
      //     dispatched (passed the slot semaphore) and whose
      //     IIFE has not yet settled.
      //   - `subagentsQueued`: handles created but still
      //     waiting on `acquireSlot`. Sum (running + queued)
      //     equals the model's "tasks I emitted that haven't
      //     finished yet" count.
      //   - `subagentsCap`: configured cap for concurrent
      //     dispatch (`maxConcurrentSubagents`).
      //   - `toolsRunning`: tools currently in flight in the
      //     parallel-tool dispatcher pool. 0 outside a parallel
      //     batch (or during the serial path, since serial
      //     never has more than 1 in flight at once).
      //   - `toolsCap`: pool concurrency for the current
      //     batch (`Math.min(maxConcurrentToolCalls,
      //     MAX_CONCURRENT_TOOL_CALLS_CAP)`). 0 when no batch
      //     is active.
      type: 'parallel_status';
      subagentsRunning: number;
      subagentsQueued: number;
      subagentsCap: number;
      toolsRunning: number;
      toolsCap: number;
    }
  | {
      // Cost-cap watchdog fired (spec ORCHESTRATION.md §3.5).
      // Cumulative parent + child spend (settled + reserved +
      // live) crossed `maxCostUsd` mid-run; the harness
      // signaled `cancelAll('cap_watchdog')` on every active
      // handle. The TUI converts this to a permanent banner
      // line so the operator sees the cause — without it, the
      // active subagent rows just disappear and the operator
      // has to root-cause via `/sessions` or audit logs.
      // Carries `cancelledCount` (how many active handles got
      // the abort) and the cumulative figure that crossed the
      // cap so the banner reads concretely ("3 subagents
      // cancelled — cumulative spend $5.12 exceeded cap
      // $5.00"). The cap value is included for the same
      // reason: a banner that just says "cap exceeded" forces
      // the operator to look up which cap.
      type: 'cap_watchdog_fired';
      cancelledCount: number;
      cumulativeUsd: number;
      capUsd: number;
    }
  | {
      // Soft cost-cap crossed (spec ORCHESTRATION.md §3.5.0).
      // Emitted once when the run's cumulative cost first
      // crosses `budget.softCostUsd`; never re-emitted. The
      // run continues — this is a regression signal, not a
      // termination. Renderer surfaces it as a permanent warn
      // line ("· task <name> over budget estimate ($X.XX > $Y.YY)").
      type: 'cost_soft_cap_warn';
      threshold: number;
      cumulative: number;
    }
  | {
      // Self-critique pass entered for this step (ORCHESTRATION.md
      // §6). Producer is the harness loop right BEFORE it issues
      // the critic LLM call. Renderer can show a one-line "running
      // critique..." indicator without needing to know the
      // mode/threshold. Lifecycle bracket: every `critique_started`
      // is followed by exactly one `critique_finished` for the
      // same `stepN`.
      type: 'critique_started';
      stepN: number;
      // True iff the proposed step would invoke at least one
      // `writes:true` tool. Drives the renderer's framing — a
      // writes-step critique deserves stronger UI than an end-of-
      // step text critique (operator is about to mutate files).
      toolPlanWrites: boolean;
    }
  | {
      // Self-critique pass concluded. Producer is the harness loop
      // after `runCritique` returns AND any `confirmCritique` modal
      // has resolved. `strategy` mirrors the engine's output
      // (`llm` | `skipped` | `failed`); when `strategy='llm'`,
      // `filteredCount` is how many issues crossed the threshold.
      // `decision` is the operator's choice (only set when the
      // modal opened, i.e. `filteredCount > 0`). `costUsd` is the
      // critic call's billed spend — folded into `total_cost_usd`
      // separately from `step.cost_usd` per ORCHESTRATION §6.3.
      type: 'critique_finished';
      stepN: number;
      strategy: CritiqueStrategy;
      filteredCount: number;
      rawCount: number;
      overallConfidence: number;
      durationMs: number;
      costUsd: number;
      // `'no_modal'` when no issues crossed the threshold (the
      // modal never opened); the engine's strategy decided
      // outright. Otherwise carries the operator's answer.
      decision: CritiqueAnswer | 'no_modal';
      // Optional human-readable detail (e.g., the reason
      // `skipped`/`failed` carried, or which decision was made
      // explicitly when `decision === 'no_modal'`).
      reason?: string;
    }
  // Session-end terse line (RECAP §3.3). Emitted right before
  // `session_finished` when the harness successfully projected
  // the recap and rendered the deterministic terse output. The
  // TUI surfaces `markdown` as an info line in the scrollback
  // above the session:end footer; headless callers can ignore
  // it. Failure to project (DB lock, no messages) skips the
  // event entirely — operator still gets `session_finished`,
  // never a missing exit. `cacheHit` distinguishes a fresh
  // projection from a re-render of an unchanged intermediate
  // (rare but possible when /recap was already run during the
  // session and nothing changed since).
  | {
      type: 'recap_terse_ready';
      sessionId: string;
      markdown: string;
      cacheHit: boolean;
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
  // Per-step stall watchdog (spec AGENTIC_CLI.md §5 line 372).
  // When the provider stream is silent — no text_delta, no
  // thinking_delta, no tool_use_*, no message_stop — for this
  // many milliseconds, the harness aborts the step with
  // `stepStalled`. Distinct from `maxWallClockMs` (whole-session
  // cap) and `maxOutputTokens` (truncation by token count) —
  // catches the "provider call opened but never streams anything
  // back" failure mode that previously surfaced as a silent
  // multi-minute hang. Reset on every stream event so a slow but
  // progressing turn doesn't trip the gate. Set to 0 to disable.
  maxStepStallMs: number;
  // Optional ceiling on output tokens per provider call. When set,
  // the harness clamps the per-request `max_tokens` to
  // `min(maxOutputTokensPerCall, provider.capabilities.output_max_tokens)`.
  // When unset (the default), the harness uses the provider's
  // declared capability ceiling — no silent 4096 truncation on
  // models that advertise a larger output window. Playbooks declare
  // `sampling.max_tokens` to take an explicit override; that flows
  // in via this field and is still clamped to the capability cap so
  // an over-declared playbook can't bypass the provider's hard
  // limit. Never part of session-wide budget — this is a per-call
  // shaping knob, not a cumulative tally.
  maxOutputTokensPerCall?: number;
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
  // Hard cap on total spend for this run, in USD. AGENTIC_CLI.md §5
  // declares a default of 5 — cost is the engagement gate; step
  // count (`maxSteps`) is the runaway-loop backstop. Three states:
  //   - field absent: merge with DEFAULT_BUDGET picks up 5 USD.
  //   - field === undefined: operator explicitly opted out (e.g.
  //     via `/budget cost off`); the loop skips the cost gate.
  //   - field is a number: that exact cap.
  // The undefined-as-opt-out shape requires `number | undefined`
  // (not just `?:`) under `exactOptionalPropertyTypes` so a partial
  // override can carry the explicit disable signal through the
  // spread merge.
  // The harness aborts with `maxCostUsd` after the FIRST
  // cost-increasing event whose running total crosses the cap
  // (provider turn or compaction call). Compared per-event with
  // `>` so a `maxCostUsd: 0` config means "no spend allowed" —
  // the first paid turn trips the gate. Honored across resumes
  // via the cumulative tracker (priorCostUsd + totalCostUsd is
  // what the cap compares against, NOT just the per-run total).
  maxCostUsd?: number | undefined;
  // Soft warning threshold for cost (spec ORCHESTRATION.md
  // §3.5.0). When set and the run's cumulative cost crosses
  // it, the harness emits a `cost_soft_cap_warn` event ONCE
  // (idempotent — not re-emitted on every subsequent
  // cost_update). The run does NOT terminate at this
  // threshold; only `maxCostUsd` (the hard cap) does. Used
  // primarily by subagents — the parent forwards the
  // playbook's declared `max_cost_usd` here as a regression
  // signal, while leaving the child's hard cap to the global
  // budget. Absent (or set to 0) → no soft warning fires.
  softCostUsd?: number | undefined;
  // Maximum number of tool calls the harness will dispatch in
  // parallel within a single step. Only active when EVERY
  // `tool_use` in the step has `metadata.parallel_safe === true`
  // (mixed batches fall back to fully-serial). Default 5 mirrors
  // `ORCHESTRATION.md §11` ("Tool calls em flight (DAG): 5
  // default / 16 hard cap"). The same matrix governs the DAG
  // executor, but the step loop and the DAG executor share the
  // cap because they share the underlying invoke-tool pipeline
  // — no reason to have two budgets for the same physical
  // resource.
  //
  // Setting `1` effectively disables parallelism (keeps the
  // serial path live for every step). The harness clamps to
  // [1, 16] internally.
  maxConcurrentToolCalls: number;
  // Maximum number of in-flight `task_async` subagent spawns
  // for this run. The handle store admits more `spawn` calls
  // than the cap (handles return immediately) but only
  // `maxConcurrentSubagents` of them are dispatched into a
  // child run at any moment; the rest queue. Spec
  // `ORCHESTRATION.md §11`: default 3, hard cap 8.
  //
  // Setting `1` collapses `task_async` to "spawn-immediately
  // but only one runs at a time", which is observable as
  // serial-but-with-handles. Useful for budget-constrained
  // runs that still want to use the handle/await surface.
  maxConcurrentSubagents: number;
}

export const DEFAULT_BUDGET: RunBudget = {
  // `maxSteps` is the runaway-loop BACKSTOP, not the engagement
  // gate. AGENTIC_CLI.md §5 frames cost as the primary gate;
  // sessions that need many small steps (large refactor, multi-
  // file audit) shouldn't be cut by step count if the cost cap is
  // honored. 200 leaves headroom while still bounding genuine loop
  // pathology (degenerate-loop tracker hits much earlier).
  maxSteps: 200,
  maxWallClockMs: 10 * 60 * 1000,
  maxToolErrors: 5,
  maxRepeatedToolHash: 3,
  // 90s default step-stall watchdog. Long enough that legitimate
  // slow turns (extended thinking with high budget, large
  // structured outputs) don't trip; short enough that a hung
  // provider call fails source-aware before the operator
  // wonders whether the agent is still alive. The reported bug
  // (subagent silent for 3m+ after 12 parallel reads) would
  // have aborted at 90s with `stepStalled`.
  maxStepStallMs: 90_000,
  // `maxOutputTokensPerCall` intentionally unset — runtime resolves
  // against the provider capability via `resolveMaxOutputTokens`.
  compactionThreshold: 0.7,
  compactionPreserveTail: 3,
  // Spec-declared default cost cap (AGENTIC_CLI.md §5 line 333).
  // Operator opts out via `/budget cost off`, which writes an
  // explicit `undefined` so the spread-merge propagates the
  // disable signal instead of falling back to 5.
  maxCostUsd: 5,
  maxConcurrentToolCalls: 5,
  maxConcurrentSubagents: 3,
};

// Resolve the effective `max_tokens` for a provider request:
//   - explicit budget override clamps to the capability ceiling
//   - absent override defaults to the capability ceiling
// Centralized here so the loop, the banner, and any future call
// site (recap, critique) share one resolution rule. Returns a
// finite positive integer; callers can pass it directly as
// `max_tokens`.
export const resolveMaxOutputTokens = (
  budget: Pick<RunBudget, 'maxOutputTokensPerCall'>,
  capabilities: { output_max_tokens: number },
): number => {
  const cap = capabilities.output_max_tokens;
  const override = budget.maxOutputTokensPerCall;
  if (override === undefined) return cap;
  return Math.min(override, cap);
};

// Single source of truth for "what does a partial budget actually
// resolve to". The loop and any read-only consumer (banner, slash
// `/budget` show, future surfaces) MUST go through this helper so
// they observe the same effective values. Pre-helper, the loop
// did `{ ...DEFAULT_BUDGET, ...config.budget }` (per-field merge)
// while the banner did `config.budget ?? DEFAULT_BUDGET` (whole-
// object fallback) — the two diverged when an operator supplied a
// partial budget object: the banner saw only the partial fields,
// the loop saw the partial overlaid on DEFAULT_BUDGET. Today only
// `maxOutputTokensPerCall` had a non-default-driven consumer, so
// the gap was harmless; routing both call sites through one
// helper closes the latent divergence before a future field
// reintroduces it.
//
// `Partial<RunBudget>` mirrors what `HarnessConfig.budget`
// accepts. The spread copies `undefined` overrides verbatim
// (operator opt-out for `maxCostUsd`), so the resulting
// `RunBudget` may legitimately carry `maxCostUsd: undefined`
// despite the type being `RunBudget`.
export const effectiveBudget = (partial?: Partial<RunBudget>): RunBudget => ({
  ...DEFAULT_BUDGET,
  ...(partial ?? {}),
});

// Hard cap for the parallel pool — even an explicit caller config of
// `maxConcurrentToolCalls: 100` is clamped to this to bound resource
// pressure (file descriptors, SQLite WAL writers, hook chain fanout).
// Mirrors `ORCHESTRATION.md §11`.
export const MAX_CONCURRENT_TOOL_CALLS_CAP = 16;

// Hard cap for `task_async` slot semaphore. Mirrors
// `ORCHESTRATION.md §11`. The harness clamps `maxConcurrentSubagents`
// to `[1, 8]` at the consumer; configs that ask for more are
// silently capped (operator gets the cap behavior, not a refusal).
export const MAX_CONCURRENT_SUBAGENTS_CAP = 8;

// Why the loop stopped. `done` is the only success path; everything else
// is the harness intervening for safety or budget reasons.
//
// Single source of truth — the runtime tuple is the canonical list and
// `ExitReason` derives from it. Consumers that need a runtime allowlist
// (eval YAML loader, future audit replay, telemetry filters) MUST
// import `EXIT_REASONS` instead of hand-rolling their own mirror; that
// pattern silently drifts when a new reason is added (the loader's
// inline list missed `stepStalled` and then `critiqueAborted` until
// this refactor — both bypassed compile-time coverage because the
// loader cast `as <inline-union>` instead of `as ExitReason`).
export const EXIT_REASONS = [
  'done', // model emitted text without tool_use
  'maxSteps',
  'maxWallClockMs',
  'maxOutputTokens', // provider truncated the response at max_tokens
  'maxCostUsd', // running cumulative cost crossed budget.maxCostUsd
  'maxToolErrors',
  'degenerateLoop',
  'stepStalled', // provider stream silent for `maxStepStallMs` mid-step
  'aborted', // user cancelled via signal
  'providerError', // unrecoverable provider failure (network, 4xx)
  'internalError', // uncaught throw in the harness path (typically SQLite)
  'scriptExhausted', // mock provider drained — only seen in tests
  'userPromptBlocked', // a UserPromptSubmit hook refused this turn
  'critiqueAborted', // operator chose `abort` from a self-critique modal
] as const;

export type ExitReason = (typeof EXIT_REASONS)[number];

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
  // Nucleus sampling cutoff in (0, 1]. Same passthrough story as
  // `temperature` — provider applies its own default when unset.
  // Playbook frontmatter `sampling.top_p` (`PLAYBOOKS.md` §1.1)
  // flows here when the parent spawns a subagent.
  topP?: number;
  // Extended-thinking budget in tokens. 0 explicitly disables;
  // positive integers cap the model's hidden reasoning. Only the
  // Anthropic adapter applies a dedicated budget surface today;
  // adapters that cannot map the value drop it (the request
  // surface expresses intent, per-provider effort follows). Tied
  // to `PLAYBOOKS.md` §1.1 `sampling.thinking_budget`.
  thinkingBudget?: number;
  // Determinism intent flag (`PLAYBOOKS.md` §1.1
  // `sampling.seed_in_eval`). When true, the playbook author
  // declared the run wants seeded generation for reproducibility.
  // The harness forwards verbatim onto GenerateRequest; provider
  // adapters that support seeding (OpenAI / Google) translate to
  // their seed surface, those without (Anthropic) drop the
  // field — same best-effort convention `topP` and
  // `thinkingBudget` follow.
  seedInEval?: boolean;
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
  // S5 CRIT/H2 hardening. Scopes that must be excluded from
  // retrieval (`retrieve_context` tool) for this session. Mirrors
  // the eager-load exclusion the bootstrap applies to
  // `assembleMemorySection` when the shared-corpus trust probe
  // returned a non-confirmed outcome (verify_failed / deferred /
  // revoked). Without this, the model could fetch project_shared
  // bodies via retrieve_context even though the system prompt
  // already excluded them — partial fail-closed. Absent / empty
  // = no exclusion.
  memoryExcludeScopes?: ReadonlyArray<import('../memory/index.ts').MemoryScope>;
  // S11 LLM-judge semantic verifier (MEMORY.md §11.x / Phase 2).
  // DEFAULT ON since Slice Q (post-S13). When true: every step
  // boundary polls memory_provenance for newly-exposed factual
  // memories (type=project / reference) and dispatches the
  // verify-semantic subagent (gated by cost / dispatch caps + the
  // memory_verify_attempts dedup table). Opt-out:
  //   - `/memory governance disable verify` (per-project, persisted
  //     in `.agent/config.toml [memory] verify_semantic_llm = false`)
  //   - `--no-memory-verify-llm` (session-only)
  // Optional in the type so test fixtures + programmatic callers
  // that don't model memory governance can omit the field (loop.ts
  // treats undefined as "off"); CLI bootstrap ALWAYS sets it
  // explicitly post-Slice-Q.
  memorySemanticVerify?: boolean;
  // Source provenance for /memory governance status rendering + the
  // first-run banner suppression. Boot resolves which layer
  // produced `memorySemanticVerify`'s value. Optional because
  // legacy fixtures don't populate it.
  memorySemanticVerifySource?: 'cli' | 'project-config' | 'user-config' | 'default';
  // S13 LLM-judge conflict detector (MEMORY.md §11.x / Phase 2).
  // DEFAULT ON since Slice Q. Mirror of memorySemanticVerify
  // optionality.
  memoryConflictDetect?: boolean;
  memoryConflictDetectSource?: 'cli' | 'project-config' | 'user-config' | 'default';
  // S3 LLM-judge override detector (MEMORY.md §11.x / Phase 2, spec
  // §6.5.2). When true: every step boundary polls
  // memory_override_events for memories whose override counter
  // tripped the threshold (3 events in 24h) and dispatches the
  // verify-override subagent (gated by cost / dispatch caps + the
  // memory_verify_override_attempts cooldown). Opt-out via slash +
  // config will mirror S11/S13 (S3.5 follow-up adds the loader
  // + CLI flag + slash subcommand). Optional in type so callers
  // pre-S3.5 omit (loop treats undefined as "off").
  memoryOverrideDetect?: boolean;
  memoryOverrideDetectSource?: 'cli' | 'project-config' | 'user-config' | 'default';
  // Inventory of memories that landed in the eager-load section
  // of the system prompt (MEMORY.md §11.2 — provenance, surface
  // 'eager'). Populated by the CLI bootstrap from
  // assembleMemorySection. The harness loop emits one
  // memory_provenance row per entry right after createSession —
  // that's the first moment a sessionId exists to link against
  // (eager loading happens BEFORE the session is created, so the
  // record has to be deferred). Absent / empty ⇒ no eager
  // exposures (headless tests, registries with no memories).
  //
  // The inventory pins hash + state-at-exposure at boot, NOT at
  // emit time — the operator may rewrite a file between assembly
  // and session start. The spec semantic is "the bytes the model
  // saw at boot", which freezes at assembly.
  eagerExposures?: readonly EagerExposure[];
  // Pinned context store (CONTEXT_TUNING.md §12.4). When set, the
  // harness threads it through ToolContext so the pin_context tool
  // can dispatch. Absent ⇒ pin_context surfaces `pin.store_
  // unavailable` cleanly. Same shape as memoryRegistry above: the
  // REPL constructs once at boot via createContextPinsStore(db)
  // and hands it through. The /pin slash command consumes the
  // SAME store instance via SlashContext.contextPinsStore — both
  // surfaces share the underlying table.
  contextPinsStore?: ContextPinsStore;
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
    // Provenance of the matching policy rule. Mirrors
    // `ConfirmPermissionRequest.source` in invoke-tool.ts —
    // forwarded verbatim from the engine's Decision so the
    // modal can render layer + rule in the operator's prompt.
    // Optional for backwards compat with non-engine
    // synthesizers (tests, future inline-permission contexts).
    source?: PolicySource;
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
  // Slice 181 — global kill switch resolved at boot via
  // `resolveHookConfig`. When true, the dispatcher short-circuits
  // the chain (no spawn, no audit, no matcher evaluation) even
  // when `hooks` is non-empty. Bootstrap reads this from the
  // top-level `disable_all_hooks` key in any hooks.toml layer
  // (OR'd across layers). Default false. Spec AGENTIC_CLI.md
  // §10.3.3.
  disableAllHooks?: boolean;
  // Test seam: subprocess spawn factory threaded through
  // `runSubagent` so the harness can exercise the full
  // `task` / `task_async` chain without forking a real Bun
  // process. Production callers omit; the harness's
  // `spawnSubagentImpl` forwards this verbatim to `runSubagent`,
  // which uses the default `Bun.spawn` factory when absent.
  // Lives on the harness config (not the runtime call site)
  // because the `task` family invokes runSubagent indirectly —
  // tests need a way to reach the spawn point through the
  // wider step loop.
  spawnChildProcess?: import('../subagents/runtime.ts').SpawnChildProcess;
  // Self-critique pass config (AGENTIC_CLI.md §5.4,
  // ORCHESTRATION.md §6). When absent, defaults merge with
  // `DEFAULT_CRITIQUE_CONFIG` (mode='off') and the loop never
  // pays the critique cost. Setting `mode = 'on_writes' |
  // 'always'` enables the gate.
  critique?: Partial<CritiqueConfig>;
  // Provider used for the critic LLM call. When unset, the
  // executor's provider is reused (cheapest wiring; the spec
  // recommends a separate cheap model like Haiku, but for
  // single-vendor runs the same provider is acceptable).
  // Operator-facing config (`critique.model = 'anthropic/...'`)
  // resolves to a Provider here at boot time.
  critiqueProvider?: Provider;
  // Hook the harness calls when the critic flags issues that
  // crossed the threshold. Caller resolves with the operator's
  // decision (`ignore` proceeds with the proposal as-is,
  // `redo` re-runs the step with a hint message,
  // `abort` finishes the run with `critiqueAborted`,
  // `cancel` is treated as `abort` for safety). When unset,
  // the harness defaults to `ignore` — the critique cost is
  // still paid and the result is audited, but the run never
  // blocks on a missing modal. Interactive callers (REPL) wire
  // this to `modalManager.askCritique`; one-shot mode leaves
  // it unset.
  confirmCritique?: (req: ConfirmCritiqueRequest) => Promise<CritiqueAnswer>;
  // Broker for exec-tagged tools (PERMISSION_ENGINE.md §13.7). The
  // bash family routes through `broker.execute(request)` instead of
  // spawning directly from main. Bootstrap (`src/cli/bootstrap.ts`)
  // constructs an in-process broker wired to the bash worker
  // handler; future security-mode flips can swap in a spawn-based
  // broker without touching the harness or tool code. Optional on
  // the type so headless / SDK callers without exec needs don't
  // have to construct one; bash surfaces `bash.spawn_failed` when
  // absent.
  broker?: Broker;
  // §18 telemetry sink (slice 111, R10 #48). When wired, the
  // harness emits structured events for cross-cutting signals
  // that don't fit the audit row shape — currently `sandbox
  // .degraded_active` (the §13.6 recurring banner heartbeat).
  // Pre-slice the SandboxDegradedActiveEvent type was declared
  // and a scrubbing handler existed (slice 92), but the harness
  // loop only emitted to `config.onEvent` — the telemetry pipe
  // was unwired and the metric stream documented in spec §18
  // was unfireable.
  //
  // Production wiring binds an OTEL-bound sink via bootstrap;
  // tests pass a recording sink to assert emission shape.
  // Sinks MUST NOT throw — the harness wraps every call in
  // try/catch defensively (slice 70 contract). When undefined,
  // every telemetry event is dropped silently.
  telemetry?: TelemetrySink;
  // failure_events sink (slice 130). When wired, the harness threads
  // this through `createBgManager` so `sandbox.mid_session_loss`
  // probes hit a real sink + into `handle-store`'s `persistTo` so
  // `storage.lock_contention`/`storage.persist_failed` rows land.
  // Bootstrap also receives a sink directly so `sandbox.tool_unavailable`
  // emits at boot. Without this field wired by the CLI / SDK caller,
  // the slice-130 emit sites stay inert — every probe / catch path
  // short-circuits on `failureSink === undefined`. Production CLI
  // bootstrap (slice 130 fixup) constructs `createSqliteFailureSink({
  // db })` and passes here. Tests can wire a noop sink to keep the
  // suite hermetic.
  failureSink?: FailureEventSink;
  // The sandbox tool detected at boot (bwrap | sandbox-exec | null).
  // Paired with `failureSink` to enable the bg manager's mid-session
  // loss probe — comparing CURRENT `Bun.which(...)` against this
  // BOOT state is what distinguishes "always unavailable" (audited
  // at bootstrap as `sandbox.tool_unavailable`) from "available
  // then lost" (audited from bg manager as `sandbox.mid_session_loss`).
  // CLI bootstrap sources via `detectSandboxAvailability` and
  // forwards here; tests pin a constant.
  sandboxBootTool?: 'bwrap' | 'sandbox-exec';
  // outcome_signals sink (slice 131). When wired, the harness
  // emits a `tool_error` outcome_signal on every failed tool
  // invocation that was authorized by the engine (failed=true,
  // not denied). Spec §6.3.2 calibration: these signals link
  // decisions to observed bad outcomes. Optional — without it,
  // tool errors only land in `tool_calls.status='error'` and
  // calibration scripts have to recover them via join. Production
  // CLI bootstrap constructs `createSqliteOutcomeSink({ db })`
  // and passes here.
  outcomeSink?: OutcomeSink;
  // Slice 157 (review — phase 2 of macOS /tmp isolation). Per-CLI-run
  // tmpdir that scoped-sandbox spawns redirect their TMPDIR into.
  // CLI bootstrap calls `acquireSandboxTmpdir({ sessionId: <ULID> })`
  // once, registers cleanup at process exit, and forwards the
  // resolved path here. The harness then:
  //   1. Builds it into every ToolContext so tools like `grep` /
  //      `bash` pass it to `maybeWrapSandboxArgv.tmpdir`.
  //   2. Forwards it into `createBgManager` so background spawns
  //      apply the same scoping.
  //
  // `undefined` on linux (bwrap's `--tmpfs /tmp` already isolates)
  // and on darwin when mkdir failed at bootstrap (graceful fallback
  // to the pre-slice-156 blanket /tmp allow). Tools that read this
  // and find undefined just omit the tmpdir option to maybeWrap.
  sandboxTmpdir?: string;
  // Audit retention config (AUDIT.md §1.2). When `runGcOnStop` is
  // true, the loop calls `runGc({force: true, ...})` at session end
  // after the operator's Stop hooks fire — built-in retention sweep
  // without crontab wiring (AGENTIC_CLI §2.1.3 "Stop hook
  // integration"). Optional so existing call sites (subagent
  // runtime, unit tests that don't care about session-end gc) keep
  // working without populating it; default-undefined skips the
  // built-in trigger entirely (same as `runGcOnStop = false`).
  auditRetention?: import('../audit/config-loader.ts').RetentionConfig;
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
