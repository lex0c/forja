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

import type { PolicyLayer } from '../permissions/index.ts';

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
  // Distinct-name memory count surfaced in the footer's right
  // column as `mem N`. Dedupe-by-name matches what the operator
  // sees in the eager prompt section. Optional: producers that
  // didn't wire memory (one-shot SDK, replay tools) omit the
  // field; renderer skips the segment when undefined or zero.
  memoryCount?: number;
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
  // Mirrors HarnessResult.abortCause. Only meaningful when
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

// Self-critique pass live indicator (AGENTIC_CLI.md §5.4,
// ORCHESTRATION.md §6). Bracket events that fire around the critic
// LLM call. The harness emits `critique_started` /
// `critique_finished`; the adapter translates them into these
// UIEvents so the live region renders a chip during the otherwise-
// silent window (up to `maxOverheadMs`, default 3s) between the
// executor's `assistant:end` and the modal opening.
//
// Without this, an operator who opted into critique sees the
// generating spinner stop and then... nothing for several seconds.
// Looks identical to a hang.
export type CritiqueStartEvent = BaseEvent & {
  type: 'critique:start';
  // Step index from the harness loop. Lets renderers correlate the
  // chip with the step it's reviewing (no current consumer; future
  // /critique slash command may pair them).
  stepN: number;
  // True iff the proposed step would invoke at least one
  // `writes:true` tool. Mirrors the modal's framing: a writes-step
  // critique deserves a stronger chip color than an end-of-step
  // text-only review.
  toolPlanWrites: boolean;
};
export type CritiqueEndEvent = BaseEvent & {
  type: 'critique:end';
  stepN: number;
};

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
  // Optional grouping id (`subagentId` for tool calls fired
  // inside a subagent run). When set, the renderer indents the
  // chip and swaps its glyph to a nesting marker (`|_`) so the
  // operator visually attributes nested tool calls to their
  // owner. Top-level tool calls (parent harness) leave this
  // absent. Carried verbatim from `tool:start` through the
  // active-tool record into the `PermanentItem` so the chip
  // renderer can read it back at end time without re-deriving.
  parentId?: string;
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
  // Pattern that would be promoted onto the engine's session
  // allowlist on `session-allow`. Drives option 2's label ("Yes,
  // don't ask again for: <X>"). Distinct from `rule` because the
  // engine also fires confirm without a matched rule (compound-
  // command guard, missing-arg, etc.) — for those, the bridge
  // derives a literal from args (the bash command, the fs path,
  // the URL host) so option 2 still reflects what addSessionAllow
  // will actually register. When omitted, option 2's label falls
  // back to "Yes, allow all <tool> during this session" — the
  // pre-promotion vague wording, accurate when no promotion will
  // happen (subagent-proxied confirms today; legacy events).
  sessionAllowTarget?: string;
  // Policy layer that holds the matching rule (PolicyLayer in
  // permissions/types.ts). When set alongside `rule`, the reducer
  // renders "matched rule: <rule> (<layer> policy)" so the operator
  // knows which YAML to edit. Optional for backwards compat with
  // synthesized events / subagent-proxied confirms.
  layer?: PolicyLayer;
  reason?: string;
  // Subagent attribution. Set when the ask was proxied from a
  // child subagent over IPC (spec docs/spec/IPC.md §7). The
  // reducer renders a prefix in the modal preview so the
  // operator distinguishes parent vs child requests. Undefined
  // for the parent's own confirms.
  subagent?: { sessionId: string; name: string };
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
// Live update of how many other ask*s are queued behind the active
// modal. Producer (modal-manager) emits one when the modal opens
// (snapshot of `queue.length` at drain time) and again every time
// a new ask enqueues while the modal is up. Reducer updates the
// active modal's `queueDepth` when promptId matches; mismatches
// drop silently (a stale event arriving after the matching modal
// already resolved). Renderer surfaces the depth as a title
// suffix so the operator sees the queue grow / shrink in real
// time instead of being blindsided when answering one modal
// auto-pops the next.
export type ModalQueueDepthEvent = BaseEvent & {
  type: 'modal:queue-depth';
  promptId: string;
  // Number of asks waiting BEHIND this active one — does NOT
  // include the active modal itself. Zero when the active is
  // the only ask in flight.
  depth: number;
};
export type TrustAskEvent = BaseEvent & {
  type: 'trust:ask';
  promptId: string;
  path: string;
  agentsMd: boolean;
};

// Shared-corpus trust re-confirmation (MEMORY.md §6.5.2 `trust_revoked`
// detector, §7.2 rule 8). Fires AFTER bootstrap when the operator
// previously confirmed trust for this scope-root but the corpus' SHA-256
// fingerprint has since changed — typically because a `git pull` brought
// in commits that modify `.agent/memory/shared/`. Distinct from
// `trust:ask` (first-visit cwd trust) in both trigger and consequence:
//
//   - trust:ask resolves `yes` → cwd added to `trusted_dirs.json`.
//     A `no/cancel` → operator hasn't entered the REPL at all yet, so
//     we exit cleanly with no side-effects.
//   - shared-trust:ask resolves `yes` → the new corpus hash is stamped
//     into `shared_corpus_trust`. A `no/cancel` → operator stays in the
//     REPL but the bulk-invalidate path runs against every state=active
//     shared memory (T5.3), the trust row is cleared so the NEXT boot
//     re-prompts, and `trust_revoked` is the eviction-event trigger.
//
// `path` is the absolute shared-corpus root (`<repo>/.agent/memory/shared`)
// rather than the cwd — operator distinguishes "I trusted this cwd" from
// "the shared/ within it just changed". `corpusFiles` is the current
// inventory the operator would be re-confirming (name + byte length); no
// prior snapshot is rendered because the substrate only stores ONE
// aggregate hash. If/when per-file hashing lands as a follow-up, this
// event grows a `changedFiles` field — additive, no breaking change to
// the existing producer (the empty default keeps current consumers happy).
export type SharedTrustAskEvent = BaseEvent & {
  type: 'shared-trust:ask';
  promptId: string;
  path: string;
  // Snapshot of the current corpus the operator is being asked to
  // re-confirm. Each entry is one `.md` file at the corpus root —
  // filename plus byte length so the operator can spot suspicious
  // size growth ("foo.md is suddenly 50KB?") without the modal
  // rendering raw bodies inline (would explode preview height for
  // large corpora and re-expose the very content under review).
  corpusFiles: readonly { name: string; bytes: number }[];
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

// User-scope second-confirm modal (spec MEMORY.md §7.2.5: "Memória
// user-global precisa dois prompts (write + escopo) — vai afetar
// todas as sessões, exige fricção extra"). Producer: `memory_write`
// tool fires this AFTER the first `memory:write:ask` resolves yes
// AND the proposed scope is `user`. Distinct event type rather than
// reusing `memory:write:ask` so the modal can render a
// scope-specific warning ("this memory will load in EVERY session
// on this machine") and the audit trail can distinguish first-
// vs-second-prompt rejection.
export type MemoryUserScopeAskEvent = BaseEvent & {
  type: 'memory:user-scope:ask';
  promptId: string;
  name: string;
  body: string;
};

// Generic confirmation modal for memory destructive / move
// operations (spec MEMORY.md §6.3 + §5.4 + §5.5). One flavor with
// caller-supplied copy lets `/memory delete`, `/memory promote
// shared`, and `/memory demote local` share the modal pipeline
// without each carrying a dedicated event type. The producer
// (slash command) constructs `title` / `subject` / `preview` to
// match the action; reducer just renders them. `action` lets
// audit trace which operator path opened the modal — distinct
// from `memory:write:ask` so the audit row's stage tag stays
// unambiguous.
export type MemoryActionAskEvent = BaseEvent & {
  type: 'memory:action:ask';
  promptId: string;
  // Discriminator for audit + telemetry. Reducer doesn't branch
  // on it; the slash command does to pick the right `action`
  // value when emitting the resulting `memory_events` row.
  action: 'delete' | 'promote' | 'demote' | 'restore' | 'quarantine';
  title: string;
  subject: string;
  preview: string[];
  // Question line under the preview ("Confirm delete?", "Promote
  // to shared?", etc.). Producer-supplied so the wording matches
  // the operation's verb tense.
  question: string;
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
  // True iff the proposed step would invoke at least one
  // `writes:true` tool. Drives the modal's framing — a writes-step
  // critique deserves a stronger headline ("about to mutate files
  // — review before continuing") than an end-of-step text-only
  // critique. Optional for backward compat with producers that
  // predate Slice C; absent ⇒ false (treated as text-only).
  toolPlanWrites?: boolean;
};

// History wipe confirmation (HISTORY.md §2.3 `/history clear`). Three
// options: Yes (clear) / Yes-and-disable (clear + write
// `.agent/no-history`) / No. Default selection is the last (No),
// matching the conservative-default convention used by every other
// confirm flavor (D5/D65). `entryCount` lets the modal render the
// blast radius up front ("wipe N entries permanently") so the
// operator can't misclick into losing more than they meant to.
export type HistoryClearAskEvent = BaseEvent & {
  type: 'history-clear:ask';
  promptId: string;
  entryCount: number;
  // Absolute path of the project whose history would be wiped —
  // surfaced in the modal subject so an operator with multiple
  // REPLs open can tell which one they're confirming against.
  projectRoot: string;
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
  // Cumulative cost reported by the child via the `cost_update`
  // HarnessEvent stream (spec ORCHESTRATION.md §3.5). Optional
  // because most progress events (step_start, tool_invoking,
  // etc.) don't carry cost; only the adapter's `cost_update`
  // case populates it. Reducer treats `undefined` as "no
  // change" — preserves the prior `liveCostUsd` rather than
  // zeroing.
  cumulativeCostUsd?: number;
};
export type SubagentEndEvent = BaseEvent & {
  type: 'subagent:end';
  subagentId: string;
  // Full harness status — `done` | `interrupted` | `exhausted` |
  // `error`. The renderer was previously collapsing this to
  // `done | error` and the operator lost the cause distinction
  // ("Did it run out of budget? Did I cancel it? Did the
  // provider blow up?"). Surface full status so the scrollback
  // chip can render an honest cause label.
  status: 'done' | 'interrupted' | 'exhausted' | 'error';
  // Stable reason code from the harness — `maxCostUsd`,
  // `maxSteps`, `maxWallClockMs`, `aborted`, `degenerate_loop`,
  // `providerError`, `done`, etc. Optional: older producers /
  // fallback paths may not set it. The renderer uses it to
  // refine the verb ("Exhausted (cost cap)" vs the bare
  // "Exhausted").
  reason?: string;
  // Child's authoritative spend at settle. Renderer surfaces
  // this in the chip when the run was budget-related so the
  // operator sees "spent $0.59 of a $0.30 cap" rather than just
  // "Failed".
  costUsd: number;
  summary: string;
  durationMs: number;
};

// Parallelism observability snapshot (spec ORCHESTRATION.md
// §1.3 / §3.3). Emitted every time the running / queued
// counts change (handle spawn / dispatch / settle for
// subagents; safeInvokeOne enter/exit for parallel tools).
// The footer's `subagents R+Q/cap` and `tools R/cap` chips
// read from `state.parallelStatus`, populated by the
// reducer on this event.
export type ParallelStatusEvent = BaseEvent & {
  type: 'parallel:status';
  subagentsRunning: number;
  subagentsQueued: number;
  subagentsCap: number;
  toolsRunning: number;
  toolsCap: number;
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

// Provider call lifecycle bracket — covers the gap between
// `step_start` (harness asked the provider for the next turn) and
// the first provider event landing on the renderer (text_delta /
// thinking_delta / tool_use_start). The harness adapter emits
// `provider:waiting:start` on step_start and
// `provider:waiting:end` on the first provider_event of that
// step.
//
// Without this bracket, a step where the model thinks for 30-60s
// (extended thinking with high max_tokens, slow cold start, model
// genuinely deliberating on a tool denial) shows nothing in the
// live region — operator perceives a hang. The waiting chip
// closes the visibility gap with an "Awaiting model… (Xs)"
// indicator that ticks while the provider call is in flight.
//
// Mutually exclusive with the thinking and assistant chips: once
// thinking_delta or text_delta arrives, the adapter emits the
// :end event AND the relevant start event in the same translate
// call, and the renderer's chip-slot picks the more specific
// indicator.
export type ProviderWaitingStartEvent = BaseEvent & {
  type: 'provider:waiting:start';
  stepN: number;
};
export type ProviderWaitingEndEvent = BaseEvent & {
  type: 'provider:waiting:end';
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

// Reverse-search overlay open/update. Spec HISTORY.md §2.2. Producer
// (REPL editor handler) emits on Ctrl+R (open / cycle), keystroke (re-
// search with the new query), or backspace (re-search with shorter
// query). Renderer mirrors the payload onto state.reverseSearch.
//
// `selectedIdx === -1` is the no-match shape — the line still renders
// with the typed query but appends `<empty>`. Closing the overlay is
// a separate event so producers don't need a sentinel shape.
export type ReverseSearchUpdateEvent = BaseEvent & {
  type: 'reverse-search:update';
  query: string;
  results: string[];
  selectedIdx: number;
};

// Reverse-search overlay close. Producer emits on Esc (cancel),
// Enter (accept + submit), or Tab (accept-to-edit). The reducer just
// drops state.reverseSearch — buffer mutation / submit are separate
// `input:update` / `user:submit` events the producer emits before
// closing.
export type ReverseSearchCloseEvent = BaseEvent & {
  type: 'reverse-search:close';
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

// Recap terse line surfaced by RECAP §3.3 auto-display surfaces
// (session-end + Alt+R). Distinct from `info` so the renderer can
// style it specifically: bold "recap:" prefix, secondary
// (bright-grey) color across the line. The terse renderer's
// markdown body lands in `message`; the renderer wraps it.
export type RecapTerseEvent = BaseEvent & {
  type: 'recap:terse';
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
  | CritiqueStartEvent
  | CritiqueEndEvent
  | ToolStartEvent
  | ToolDeltaEvent
  | ToolEndEvent
  | PermissionAskEvent
  | ModalAnswerEvent
  | ModalSelectEvent
  | ModalQueueDepthEvent
  | TrustAskEvent
  | SharedTrustAskEvent
  | MemoryWriteAskEvent
  | MemoryUserScopeAskEvent
  | MemoryActionAskEvent
  | PlanReviewEvent
  | CritiqueAskEvent
  | HistoryClearAskEvent
  | TodoUpdateEvent
  | SubagentStartEvent
  | SubagentUpdateEvent
  | SubagentEndEvent
  | ParallelStatusEvent
  | BgStartEvent
  | BgUpdateEvent
  | BgEndEvent
  | StepBudgetEvent
  | ProviderWaitingStartEvent
  | ProviderWaitingEndEvent
  | CheckpointCreateEvent
  | ScreenClearEvent
  | SlashUpdateEvent
  | ReverseSearchUpdateEvent
  | ReverseSearchCloseEvent
  | InfoEvent
  | RecapTerseEvent
  | ErrorEvent
  | WarnEvent
  | InterruptEvent
  | InterruptExitArmEvent
  | InterruptExitCancelEvent;

export type UIEventType = UIEvent['type'];

// Type-level helper: narrow UIEvent to a specific kind by its `type`.
export type UIEventOf<T extends UIEventType> = Extract<UIEvent, { type: T }>;
