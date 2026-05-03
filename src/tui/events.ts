// UI event catalog. Spec: UI.md §3.
//
// This is the contract between the harness (producer) and the TUI
// renderer (consumer). The same union also feeds NDJSON serialization
// in headless mode (UI.md §7) — see the `--json` adapter.
//
// Naming follows the spec: kebab-cased domain prefix, colon, lifecycle
// suffix. `tool:start` / `tool:delta` / `tool:end` instead of
// camelCased `toolStart`, because the prefix groups events when a
// future filter wants e.g. all `tool:*`.
//
// Payloads are kept minimal — the renderer reads what it needs, and
// audit/persistence happens elsewhere via the harness's own event
// stream (see src/harness/types.ts HarnessEvent). When this catalog
// and HarnessEvent diverge in shape, an adapter sits between them
// (introduced in a later step).

// Common metadata. `ts` is wall-clock ms since epoch — useful for
// rendering "elapsed" without the renderer holding its own clock.
interface BaseEvent {
  ts: number;
}

// Status line / session lifecycle.
export type SessionStartEvent = BaseEvent & {
  type: 'session:start';
  sessionId: string;
  // Source-of-truth for status line render. Most fields stay
  // constant for the session; cost/steps update via step:budget.
  profile: 'autonomous' | 'orchestrated' | 'hybrid';
  project: string;
  model: string;
  // Plan mode (read-only profile, harness refuses write tools).
  // Surfaced in the footer's right column. Optional — absent is
  // equivalent to false; producers that don't know plan-mode state
  // can omit the field.
  planMode?: boolean;
};

// One-shot welcome banner (UI.md §4.10.9). Emitted by the REPL at
// boot; producers MUST NOT emit twice. Pure permanent — the reducer
// pushes it to scrollback and never references it again. Three blocks
// (title / identity / env) separated by blank lines.
//
// Env entries discriminate on `kind` so the renderer can apply the
// right palette per spec §4.10.9:
//   - `flag` → `✓ {name}` (or `✓ {name} ({count})`) painted `success`
//     for binary capability indicators (checkpoints, memory). Items
//     in the off state are NOT emitted — the line lists what exists,
//     never what's missing.
//   - `meta` → `{key}: {value}` painted `dim` for non-binary metadata
//     (subagents count, policy descriptor).
// Empty array → renderer omits the env block entirely.
export type SessionBannerEnvEntry =
  | { kind: 'flag'; name: string; count?: number }
  | { kind: 'meta'; key: string; value: string };
export type SessionBannerEvent = BaseEvent & {
  type: 'session:banner';
  app: string;
  version: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  cwd: string;
  env: SessionBannerEnvEntry[];
};
export type SessionEndEvent = BaseEvent & {
  type: 'session:end';
  sessionId: string;
  reason: 'done' | 'maxSteps' | 'maxCostUsd' | 'aborted' | 'error' | string;
  // Wall-clock duration of the run, in ms (mirrors
  // `HarnessResult.durationMs`). Powers the turn-end marker's
  // "Cogitated for 1m23s" rendering (UI.md §3.2). Optional only for
  // legacy / replay paths that don't have timing — production
  // emitters always set it.
  durationMs?: number;
  // Mirrors HarnessResult.abortCause (1.g.2). Only meaningful when
  // reason === 'aborted' — discriminates operator-initiated cooperative
  // ('soft') from preemptive ('hard'). NDJSON consumers and the
  // scrollback footer use this to distinguish "operator nudged" from
  // "operator escalated"; the in-flight footer cue (`esc to interrupt`
  // → `esc again to force`) was the live signal, this is its
  // post-session counterpart.
  abortCause?: 'soft' | 'hard';
};

// User input was submitted. Renderer flushes the input box and
// prints the echoed line as scrollback.
export type UserSubmitEvent = BaseEvent & {
  type: 'user:submit';
  text: string;
};

// Input box edit. Emitted by the REPL loop on every keystroke that
// mutated `InputState`, so the reducer keeps `state.input` current
// and the renderer redraws. Cheap event — value/cursor straight from
// `applyKey(...).next`. Producer (REPL editor handler) also drives
// `user:submit` separately when Enter is hit; the reducer clears
// `state.input` in that branch, so the post-submit `input:update`
// (if any) lands on a fresh empty buffer.
export type InputUpdateEvent = BaseEvent & {
  type: 'input:update';
  value: string;
  cursor: number;
};

// Streaming assistant text.
export type AssistantStartEvent = BaseEvent & {
  type: 'assistant:start';
  messageId: string;
};
export type AssistantDeltaEvent = BaseEvent & {
  type: 'assistant:delta';
  messageId: string;
  text: string;
};
// Per-turn token usage. Spec UI.md §4.10.5 — the live "Generating…"
// chip shows `(Xs · ↑ N tokens)` when this lands; the final
// scrollback line shows `Generated N tokens in Xs`. Producers that
// don't expose token counts (or providers that emit usage only at
// stop) just don't emit this — the chip falls back to `(Xs)`.
//
// Anthropic emits cumulative running totals; OpenAI emits the final
// total only at stop. We treat the latest non-null field as canonical
// (max over the stream) so a hypothetical incremental shape stays
// monotonic.
//
// `cacheRead` and `cacheCreation` are surfaced but not rendered today
// — they fold into the cost computation downstream and may surface
// in a future "expand chip" panel. The renderer only pulls
// `outputTokens` for the chip counter.
export type AssistantUsageEvent = BaseEvent & {
  type: 'assistant:usage';
  messageId: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
};
export type AssistantEndEvent = BaseEvent & {
  type: 'assistant:end';
  messageId: string;
};

// Extended thinking (Anthropic) / reasoning (OpenAI). Discrete from
// assistant deltas — never persisted, never shown verbatim.
export type ThinkingStartEvent = BaseEvent & { type: 'thinking:start'; messageId: string };
export type ThinkingDeltaEvent = BaseEvent & {
  type: 'thinking:delta';
  messageId: string;
  // Content is opaque to the renderer (just a duration counter).
  // We keep the field for headless replay tools.
  text?: string;
};
export type ThinkingEndEvent = BaseEvent & { type: 'thinking:end'; messageId: string };

// Tool calls. The producer (adapter) resolves the tool's name into a
// vocab pair (`activeVerb` shown while running, `finalVerb` after
// completion) plus a `subject` line — typically the path / command /
// query the tool acted on. Renderer never sees the raw JSON args by
// default; the `(ctrl+o to expand)` flow surfaces them on demand.
// See `src/tui/tool-vocab.ts` for the vocabulary table.
export type ToolStartEvent = BaseEvent & {
  type: 'tool:start';
  toolId: string;
  // Internal tool name (`read_file`, `bash`, …) — kept for audit /
  // filtering. Renderer uses `activeVerb` / `finalVerb` for display.
  name: string;
  activeVerb: string;
  finalVerb: string;
  // One-line subject under `└─ `; null when args don't carry the
  // expected field (renderer drops the connector line).
  subject: string | null;
};
export type ToolDeltaEvent = BaseEvent & {
  type: 'tool:delta';
  toolId: string;
  // Free-form output chunk (bash stdout, etc.).
  text: string;
};
export type ToolEndEvent = BaseEvent & {
  type: 'tool:end';
  toolId: string;
  status: 'done' | 'error' | 'denied';
  durationMs: number;
  // One-line summary the final tool card prints (UI.md §4.1). The
  // producer composes this — it knows the tool semantics.
  summary?: string;
};

// Permission/trust/memory write/plan review/critique modals.
// Payloads carry exactly what the modal needs to render. The
// renderer's modal handler (UI.md §5.5) resolves a promise on the
// other side; the producer awaits that promise.
export type PermissionAskEvent = BaseEvent & {
  type: 'permission:ask';
  promptId: string;
  toolName: string;
  command: string;
  cwd: string;
  // Optional risk hint — when present, modal shows the "why?" detail.
  rule?: string;
  reason?: string;
};
// Modal resolution event. Renamed from `permission:answer` because
// the same event flows for every modal flavor (trust answers `yes`/
// `no`, plan-review answers `yes`/`edit`/`no`, etc.) — naming it
// after just the permission flavor was misleading. Decision is a
// flavor-specific string; consumers that care about the union
// narrow per-flavor by reading the original `*:ask` event.
//
// `cancel` is the universal "user closed without deciding" value
// across flavors (returned on Esc); audit can tell it from explicit
// rejection.
export type ModalAnswerEvent = BaseEvent & {
  type: 'modal:answer';
  promptId: string;
  decision: string;
};
// In-modal navigation event. The manager fires on ↑/↓/Tab/Shift+Tab;
// reducer updates only `state.modal.selectedIndex` when the promptId
// matches the open modal. Avoids re-emitting `*:ask` (which would
// rebuild the modal contents from scratch).
export type ModalSelectEvent = BaseEvent & {
  type: 'modal:select';
  promptId: string;
  selectedIndex: number;
};
export type TrustAskEvent = BaseEvent & {
  type: 'trust:ask';
  promptId: string;
  path: string;
  agentsMd: boolean;
};
// `scope` mirrors `MemoryScope` from `src/memory/types.ts`. We re-declare
// instead of importing so the TUI layer doesn't depend on memory's
// internal types — but the values must stay in sync. If memory adds a
// new scope, this union changes too.
export type MemoryScopeForUI = 'user' | 'project_shared' | 'project_local';
export type MemoryWriteAskEvent = BaseEvent & {
  type: 'memory:write:ask';
  promptId: string;
  scope: MemoryScopeForUI;
  name: string;
  body: string;
};
export type PlanReviewEvent = BaseEvent & {
  type: 'plan:review';
  promptId: string;
  steps: string[];
  estimatedCalls: number;
  estimatedCostUsd: number;
};
export type CritiqueAskEvent = BaseEvent & {
  type: 'critique:ask';
  promptId: string;
  issues: { severity: 'low' | 'medium' | 'high'; confidence: number; message: string }[];
};

// Todo list (live region above the operation chips, spec §4.3 / §4.10.6).
// The full list is sent on every update — small enough that delta
// tracking buys nothing, and the producer (TodoStore.set wrapper in
// the harness loop) already deals in full lists per spec §7.4 ("o
// model passa a lista intencionada inteira; sem semantics de merge").
//
// Shape mirrors `TodoItem` in `src/todo/index.ts` exactly. Re-declared
// here instead of imported so the TUI layer doesn't depend on the
// todo subsystem's types — but the values must stay in sync. If the
// TodoStore enum changes, this union changes too.
//
// `failed` is reserved for forward-compat: spec §4.3 lists `✗ failed`
// as a glyph, the renderer wires it, but the TodoStore enum doesn't
// expose it today (the tool rejects invalid lists at write time, not
// at render time). A future extension that lets a step mark a todo as
// failed will surface here without a renderer change.
export type TodoStatusForUI = 'pending' | 'in_progress' | 'done' | 'failed';
export interface TodoItemForUI {
  content: string;
  activeForm: string;
  status: TodoStatusForUI;
}
export type TodoUpdateEvent = BaseEvent & {
  type: 'todo:update';
  items: TodoItemForUI[];
};

// Subagent lifecycle. The renderer groups by subagentId in the live
// region; on `subagent:end` the group collapses to a one-line summary.
export type SubagentStartEvent = BaseEvent & {
  type: 'subagent:start';
  subagentId: string;
  name: string;
  goal: string;
};
export type SubagentUpdateEvent = BaseEvent & {
  type: 'subagent:update';
  subagentId: string;
  progress: string;
};
export type SubagentEndEvent = BaseEvent & {
  type: 'subagent:end';
  subagentId: string;
  status: 'done' | 'error';
  summary: string;
  durationMs: number;
};

// Background processes.
export type BgStartEvent = BaseEvent & { type: 'bg:start'; processId: string; command: string };
export type BgUpdateEvent = BaseEvent & { type: 'bg:update'; processId: string; status: string };
// `cause` discriminates HOW the process ended:
//   - 'exited': natural exit (process returned without external signal).
//   - 'killed': operator-initiated termination (kill() or cleanup()).
// `exitCode` is the OS-reported value; null when the OS reaped before
// we could read it. `signal` (when present) carries the actual POSIX
// signal name (e.g. 'SIGTERM') — distinct from `cause`, which describes
// intent. Today no producer fills `signal`; the field is reserved for
// when the manager surfaces signal-derived exits explicitly.
export type BgEndEvent = BaseEvent & {
  type: 'bg:end';
  processId: string;
  cause: 'exited' | 'killed';
  exitCode: number | null;
  signal?: string;
};

// Budget / checkpoint signals consumed by the status line.
export type StepBudgetEvent = BaseEvent & {
  type: 'step:budget';
  steps: number;
  maxSteps: number;
  costUsd: number;
  maxCostUsd?: number;
};
export type CheckpointCreateEvent = BaseEvent & {
  type: 'checkpoint:create';
  checkpointId: string;
  stepN: number;
};

// Wipe the visible scrollback (terminal Ctrl+L behavior). Renderer
// writes ANSI clear-screen + redraws the live region. Scrollback
// above the visible area stays accessible (xterm `\x1b[2J\x1b[H`
// doesn't touch it). Distinct from a session reset — LiveState is
// untouched.
export type ScreenClearEvent = BaseEvent & {
  type: 'screen:clear';
};

// Slash autocomplete state update. Spec UI.md §5.3. Producer (REPL
// editor handler) emits when input enters / exits slash mode or
// when navigation changes the highlighted suggestion. `suggestions`
// empty + selectedIdx -1 means "exit slash mode" (reducer clears
// state.slash to null). Otherwise the reducer mirrors the payload
// onto state.slash for the renderer.
export type SlashUpdateEvent = BaseEvent & {
  type: 'slash:update';
  suggestions: { name: string; description: string }[];
  selectedIdx: number;
};

// Informational scrollback line. Spec UI.md §6.1 — not an error,
// not a warning; just plain output the renderer should not paint
// in any alarm color. Slash command output (/help, /sessions,
// /cost, etc.) uses this so the operator doesn't see help text in
// the same yellow as a lock-conflict warning.
export type InfoEvent = BaseEvent & {
  type: 'info';
  message: string;
};

// Diagnostics + interrupts.
export type ErrorEvent = BaseEvent & {
  type: 'error';
  message: string;
  // When set, the producer expects the run to terminate; renderer
  // surfaces a permanent line and stops accepting input.
  fatal?: boolean;
};
export type WarnEvent = BaseEvent & {
  type: 'warn';
  message: string;
};
export type InterruptEvent = BaseEvent & {
  type: 'interrupt';
  // 'soft' = Esc once / single Ctrl+C: model finishes the step then
  // stops. 'hard' = double-tap: cancel tool in flight immediately.
  level: 'soft' | 'hard';
};

// Idle Ctrl+C double-tap exit gate (UI.md §5.4 + §4.10.6 footer cue).
// First press at idle/empty-buffer arms the gate; the footer flips to
// `Press Ctrl-C again to exit` (warn) for a 2s window. A second press inside
// the window exits 130; any other input or the timeout cancels.
//
// Producer responsibility: REPL emits `interrupt:exit-arm` on the first
// press, schedules a timer that emits `interrupt:exit-cancel` on
// expiry, and emits `interrupt:exit-cancel` on any other key/event
// that should disarm. Reducer is dumb — it just flips state.exitArmed.
export type InterruptExitArmEvent = BaseEvent & {
  type: 'interrupt:exit-arm';
};
export type InterruptExitCancelEvent = BaseEvent & {
  type: 'interrupt:exit-cancel';
};

// Discriminated union — the renderer matches on `type` and the
// compiler narrows the payload.
export type UIEvent =
  | SessionStartEvent
  | SessionBannerEvent
  | SessionEndEvent
  | UserSubmitEvent
  | InputUpdateEvent
  | AssistantStartEvent
  | AssistantDeltaEvent
  | AssistantUsageEvent
  | AssistantEndEvent
  | ThinkingStartEvent
  | ThinkingDeltaEvent
  | ThinkingEndEvent
  | ToolStartEvent
  | ToolDeltaEvent
  | ToolEndEvent
  | PermissionAskEvent
  | ModalAnswerEvent
  | ModalSelectEvent
  | TrustAskEvent
  | MemoryWriteAskEvent
  | PlanReviewEvent
  | CritiqueAskEvent
  | TodoUpdateEvent
  | SubagentStartEvent
  | SubagentUpdateEvent
  | SubagentEndEvent
  | BgStartEvent
  | BgUpdateEvent
  | BgEndEvent
  | StepBudgetEvent
  | CheckpointCreateEvent
  | ScreenClearEvent
  | SlashUpdateEvent
  | InfoEvent
  | ErrorEvent
  | WarnEvent
  | InterruptEvent
  | InterruptExitArmEvent
  | InterruptExitCancelEvent;

export type UIEventType = UIEvent['type'];

// Type-level helper: narrow UIEvent to a specific kind by its `type`.
export type UIEventOf<T extends UIEventType> = Extract<UIEvent, { type: T }>;
