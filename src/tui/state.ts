// Live region state + event reducer. Spec: UI.md §2.2, §3.
//
// `LiveState` captures everything currently rendered in the bottom 3-15
// lines of the terminal. The reducer (`applyEvent`) is pure: given a
// state and a UIEvent, it returns the next state plus an array of
// structured `PermanentItem` records the renderer turns into scrollback
// lines. Glyph + color decisions live downstream in `formatPermanent`
// (renderer.ts) — the reducer never sees `Capabilities`. The renderer
// wires the I/O around this — see renderer.ts.
//
// Wired so far: session lifecycle, user submit, assistant streaming,
// thinking, tool lifecycle (start/delta/end with preview cap), step
// budget, error/warn, interrupt, checkpoint, and the modal pattern
// (`*:ask` / `modal:answer` / `modal:select`). Subagent / bg /
// todo events accept silently and land alongside their render
// functions.

import type { SessionBannerEnvEntry, TodoItemForUI, UIEvent } from './events.ts';
import { buildPermissionOptions } from './modal-manager.ts';

// Bash family — every tool that's gated under `tools.bash` in the
// policy file. The reducer's permission:ask case routes all four
// to the same context label ("Bash command") and prefixes the
// action with "$ ". Single source so a future rename / addition
// can't drift between the label-decision and the prefix-decision.
const BASH_FAMILY: ReadonlySet<string> = new Set([
  'bash',
  'bash_background',
  'bash_output',
  'bash_kill',
]);

// Map a tool name to the modal's context label. Replaces the older
// "Run command" / "Subagent permission — <name>" titles with
// per-category framing that matches reference designs (see
// design/permission-modal-redesign.md). Subagent attribution is a
// suffix the reducer adds; this helper only handles the per-tool
// portion.
const PERMISSION_CONTEXT_LABEL_BY_TOOL: Readonly<Record<string, string>> = {
  bash: 'Bash command',
  bash_background: 'Bash command',
  bash_output: 'Bash command',
  bash_kill: 'Bash command',
  read_file: 'Accessing workspace:',
  write_file: 'Editing file',
  edit_file: 'Editing file',
  glob: 'Searching workspace',
  grep: 'Searching workspace',
  fetch_url: 'Network access',
};

const contextLabelForTool = (toolName: string): string =>
  PERMISSION_CONTEXT_LABEL_BY_TOOL[toolName] ?? 'Tool call';

export interface InputState {
  // Current value of the input box (multi-line allowed via `\n`).
  value: string;
  // Cursor position, in JS code units within `value`. UTF-16 surrogate
  // pairs are treated as two positions; renderers that care about
  // grapheme clusters can re-derive from `value`.
  cursor: number;
}

// Threshold below which a pending tool-end batch flushes as
// individual chips (no visual savings from coalescing 1-2 items).
// At/above the threshold, the batch flushes as a single
// `tool-end-batch` PermanentItem. Tuned to 3 because that's the
// smallest count where the operator visibly benefits from the
// summary chip (Read 3 files reads cleaner than three back-to-back
// "Read in 0.2s" chips with similar subjects).
export const TOOL_BATCH_COALESCE_THRESHOLD = 3;

// Item buffered inside `PendingToolEndBatch.items` — captures
// what each child child contributed so the flush helper can decide
// to emit individual `tool-end` items (when count < threshold) or
// summarize them as `tool-end-batch` (count >= threshold). Mirrors
// the relevant subset of the `tool-end` PermanentItem shape so
// flushing as individual items is a 1:1 map.
export interface PendingToolEndBatchItem {
  verb: string;
  subject: string | null;
  status: 'done' | 'error' | 'denied';
  durationMs: number;
  summary?: string;
}

// Reducer-side buffer for slice 3 (read coalescing). See
// `LiveState.pendingToolEndBatch` for the full lifecycle commentary.
export interface PendingToolEndBatch {
  // Tool name (e.g. 'read_file'). Batch only forms across
  // matching names — a different-name tool-end is a flush trigger.
  name: string;
  // Parent grouping (subagent id when set). Two batches with the
  // same name but different parentIds DO NOT merge — operator
  // attribution stays correct (parent's reads vs child's reads
  // surface as separate batches).
  parentId?: string;
  // Captured children, in completion order.
  items: PendingToolEndBatchItem[];
}

export interface ActiveTool {
  toolId: string;
  name: string;
  // Display vocabulary resolved by the adapter (UI.md §4.10.3-4).
  // Stored on the active record so the tool-end branch of the reducer
  // can pick the right verb without looking up tool-vocab again.
  activeVerb: string;
  finalVerb: string;
  // One-line subject for the `└─ ` sub-content line. null when the
  // tool's vocab entry has no extractor or args don't match the
  // expected shape — renderer drops the connector entirely.
  subject: string | null;
  // Grouping id propagated from `tool:start.parentId` (today: the
  // subagent id, when the tool fired inside a subagent run).
  // Absent for top-level tool calls. Read back by the tool-end
  // reducer branch so the resulting PermanentItem carries the
  // same attribution into the renderer. Optional so existing
  // test fixtures that build ActiveTool records directly stay
  // valid without per-record null annotations.
  parentId?: string;
  startedAt: number;
  // Last few lines of streaming output. Capped so a tool that emits
  // a megabyte of stdout doesn't bloat the live region — the full
  // content goes through the scrollback as `tool:delta` permanent
  // lines.
  preview: string[];
}

export interface StatusState {
  sessionId: string | null;
  profile: string | null;
  project: string | null;
  model: string | null;
  steps: number;
  maxSteps: number;
  costUsd: number;
  // null = no cap configured. Renderer shows steps/cost without budget
  // shading when cap absent.
  maxCostUsd: number | null;
  // Plan mode (read-only profile). Surfaced in the footer's right
  // column as a `plan` token between model and budget. Default false
  // on createInitialState; flipped by `session:start.planMode`.
  planMode: boolean;
  // Distinct-name memory count for the footer's `mem N` segment.
  // Snapshot at session:start; mid-session
  // memory_write success could bump the count, but we keep the
  // value boot-fresh for now (operators don't expect the footer to
  // animate per-memory-write — too much noise for too little
  // signal). 0 == no segment rendered.
  memoryCount: number;
}

export interface PendingAssistant {
  messageId: string;
  text: string;
  // Wall-clock when assistant:start fired. Live chip uses this to
  // render the duration counter (now - startedAt). Producer (adapter)
  // stamps event.ts from the same clock; we copy it onto the pending
  // record so the renderer doesn't need separate per-message timing.
  startedAt: number;
  // Latest known token counts for the turn. Null until the first
  // assistant:usage event lands. Anthropic streams cumulative; OpenAI
  // emits once at stop — both shapes resolve to "latest is canonical".
  // Reducer merges with `Math.max` so a hypothetical incremental
  // payload can't shrink the count.
  inputTokens: number | null;
  outputTokens: number | null;
  cacheRead: number | null;
  cacheCreation: number | null;
}

// One option in a confirm modal. Spec: UI.md §5.5 / §4.10.13.
//
// `key` is the hotkey that activates the option directly (typically
// '1','2','3' for numbered lists; can be a letter for mnemonics).
// `value` is the semantic answer the manager resolves with — a
// string union per flavor; permission uses 'yes' | 'session-allow' |
// 'no'. Cancel (Esc) is NOT a regular option — it returns 'cancel'
// distinct from 'no' so audit can tell explicit rejection from
// "user closed the modal without deciding".
//
// `shortcut` is an optional secondary key (e.g. 'shift+tab' for the
// session-allow option). Renderer shows it in parens after the label.
export interface ConfirmOption {
  key: string;
  label: string;
  value: string;
  shortcut?: string;
}

// Confirm-style modal. Spec: UI.md §5.5 / §4.10.13. Lives in
// `LiveState` so the renderer composes it; the modal-manager
// (src/tui/modal-manager.ts) owns the async lifecycle (promise +
// queue + bus dispatch). Default `selectedIndex` = last option per
// D5/D65 — last is conventionally the most conservative choice
// (No/Reject/Skip), so Enter without navigating triggers the safe
// outcome.
// One line of modal preview. Plain strings paint dim (the default
// for meta content); the object form lets a producer pick a
// stronger paint token for a specific line. Used today by the
// permission flavor:
//   - `secondary` for source attribution ("matched rule: X
//     (project policy)") so it breaks out of the dim baseline
//   - `bold` for the action row ("$ rm -rf ./build") so the
//     operator's eye lands on the command first
// New tones land here when a future flavor needs them; the
// renderer narrows on the discriminant.
export type PreviewLine = string | { text: string; tone: 'secondary' | 'bold' };

export interface ConfirmState {
  // ID assigned by the producer; threaded through `permission:ask` and
  // matched by `modal:answer` to resolve the right promise.
  promptId: string;
  // Flavor lets the renderer pick layout details and the reducer
  // route to the right answer shape. All confirm-shaped modals
  // (permission, trust, memory write, plan review, critique) share
  // this single state field — only one modal visible at a time.
  flavor:
    | 'permission'
    | 'trust'
    | 'memory-write'
    | 'memory-user-scope'
    | 'memory-action'
    | 'plan-review'
    | 'critique'
    | 'history-clear';
  // Title block: bold first line + dim subject. `subject` is
  // optional — null when the modal has no single target (some
  // critique modals).
  title: string;
  subject: string | null;
  // Tool-aware preview lines (diff for edit_file, command for bash,
  // etc.). Producer formats them; renderer paints each line dim by
  // default. To paint a single line with a stronger token (e.g.,
  // `secondary` for source attribution that must stand out from
  // the surrounding context), wrap it as `{ text, tone }`. Empty
  // array → preview block omitted entirely. Plain strings keep
  // working — every existing producer (memory-write body,
  // history-clear blast radius, etc.) continues to emit `string[]`
  // and gets the dim default.
  preview: readonly PreviewLine[];
  // Question in natural language ("Do you want to make this edit
  // to .gitignore?"). Optional — when absent, the title carries the
  // full question.
  question: string | null;
  options: ConfirmOption[];
  // Default = options.length - 1 per D5/D65. Caller that needs a
  // different default sets it explicitly.
  selectedIndex: number;
  // Footer hints, joined by ' · '. Always includes 'Esc to cancel';
  // producers add 'Tab to amend' etc. when the corresponding
  // features land.
  hints: string[];
  // Number of OTHER asks queued behind this active modal. Modal-
  // manager owns the queue and emits `modal:queue-depth` events
  // whenever the count changes (modal opens, new ask enqueues
  // while active). Starts at 0 when the modal opens; the renderer
  // surfaces a `(+N waiting)` title suffix when > 0 so the
  // operator isn't blindsided by another modal popping
  // immediately after answering. Updated live via the reducer's
  // `modal:queue-depth` case; cleared with the modal on
  // `modal:answer`.
  queueDepth: number;
}

// Permission flavor's answer values. Other flavors define their
// own semantic union; this one's union is the most common.
export type PermissionAnswer = 'yes' | 'session-allow' | 'no' | 'cancel';

// Slash command autocomplete state. Spec UI.md §5.3. Set when the
// input buffer starts with `/`; cleared when the user submits, Esc,
// or types a non-slash character. Suggestions come pre-sorted from
// the registry; renderer just displays the top entries with
// `selectedIdx` highlighted.
export interface SlashAutocomplete {
  // {name, description} per command — flat shape so the reducer
  // doesn't import from the slash subsystem (cycle avoidance).
  suggestions: { name: string; description: string }[];
  // Highlighted index within `suggestions`. -1 means "no selection"
  // (e.g., empty suggestions list when input is `/<unknown>`).
  selectedIdx: number;
}

// Reverse-search overlay (HISTORY.md §2.2). Active while the operator
// holds the search bar open with Ctrl+R; appears as a single line
// above the input box and absorbs keystrokes (the REPL editor handler
// gates its own logic when this is non-null).
//
// `results` is the most-recent-first list of history entries matching
// `query` (substring, case-insensitive). `selectedIdx` is which match
// is currently displayed in the search line; Ctrl+R pressed again
// cycles to older entries (selectedIdx + 1, clamped at results.length).
// Typing or backspace re-runs the search and resets selectedIdx to 0.
//
// `selectedIdx === -1` means "no selection" — happens when the query
// has zero matches; the search line still shows the (now editable)
// query but appends `<empty>` to signal nothing matched.
export interface ReverseSearchState {
  query: string;
  results: string[];
  selectedIdx: number;
}

export interface LiveState {
  input: InputState;
  status: StatusState;
  // Keyed by toolId so updates are O(1). Insertion order is preserved
  // by `Map`, so the renderer can iterate and produce stable layout.
  activeTools: Map<string, ActiveTool>;
  // Transient buffer for the renderer-side coalescing of consecutive
  // same-tool tool-end items (slice 3). Holds tool-end records that
  // share a `name` + `parentId` until a flush trigger arrives:
  // - tool:end with a different (name, parentId) → flush old, buffer new
  // - tool:start (matching or not) → flush
  // - any event that emits a top-level scrollback item → flush first
  // - session:start / session:end → flush
  //
  // On flush, if `items.length >= TOOL_BATCH_COALESCE_THRESHOLD`, the
  // batch emits a single `tool-end-batch` PermanentItem with N as the
  // count + N `|_` continuation subjects; otherwise each item emits
  // as its own `tool-end` (no visual savings, no fold). Null when
  // no batch is pending. The buffer is INTERNAL to the reducer —
  // renderer never reads it directly.
  pendingToolEndBatch: PendingToolEndBatch | null;
  pendingAssistant: PendingAssistant | null;
  // `messageId` carried alongside `startedAt` so the thinking
  // chip can hash a stable per-turn seed when picking its
  // spinner verb (`render/spinner-verbs.ts`). The reducer copies
  // it from the `thinking:start` event; without it the chip
  // would have no per-turn identity to hash and would either
  // collapse to a single static verb or drift to a non-stable
  // seed (timestamp-based picks can change mid-turn under clock
  // skew or replay).
  thinking: { startedAt: number; messageId: string } | null;
  // Self-critique pass live indicator (AGENTIC_CLI.md §5.4). Set by
  // `critique:start` (harness adapter translates `critique_started`)
  // and cleared by EITHER `critique:ask` (modal about to open —
  // critic call is over, the wait is now on the operator) OR
  // `critique:end` (idem `critique_finished`, when no modal opens).
  // The composer reads this to render a chip during the up-to-3s
  // critic call — without it, the live region goes silent between
  // executor `assistant:end` and the modal opening, which is
  // indistinguishable from a hang.
  //
  // The clear at `critique:ask` is load-bearing for honesty:
  // `critique_finished` only fires AFTER `confirmCritique` resolves,
  // so leaving the chip up after the modal opens would have its
  // elapsed counter tick across operator decision time. Operators
  // would read "Reviewing… (45s)" while the critic call had
  // actually completed in 2s and the remaining 43s was them
  // reading the modal — and "still reviewing" is exactly the
  // wrong UX cue when the surface is awaiting a human answer.
  //
  // `toolPlanWrites` mirrors the modal flag so the chip can
  // visually escalate when the proposal includes writes:true tool
  // calls (about-to-mutate critiques deserve a stronger color
  // than text-only end-of-step reviews).
  critique: { startedAt: number; stepN: number; toolPlanWrites: boolean } | null;
  // "Awaiting model" indicator. Set by `provider:waiting:start`
  // (which the harness adapter emits on `step_start` — i.e.,
  // right after the harness loop hands the request to the
  // provider). Cleared by `provider:waiting:end` (first provider
  // event of the step), `assistant:start`, `thinking:start`, or
  // any session-boundary event. Read by `compose.ts` to render
  // an "Awaiting model… (Xs)" chip in the live region between
  // step_start and the first provider event.
  //
  // Without this state, a step where the model takes 30-60s to
  // respond (extended thinking, slow cold start, deliberation
  // after a tool denial) shows NOTHING in the live region —
  // operator perceives a hang and reaches for Ctrl-C before the
  // step-stall watchdog (90s default) would have caught a real
  // problem.
  awaitingProvider: { stepN: number; startedAt: number } | null;
  // Active modal, or null when no modal is up. Composer (compose.ts)
  // replaces the input box with `renderModal(modal, caps)` whenever
  // this is non-null. Status line + tool cards stay visible.
  modal: ConfirmState | null;
  // Slash autocomplete popover, or null when not in slash mode.
  // Composer renders above the input box (between status and rule).
  slash: SlashAutocomplete | null;
  // Reverse-search overlay (HISTORY.md §2.2). Null when closed; a
  // ReverseSearchState while the operator is searching with Ctrl+R.
  // Mutually exclusive with slash mode at the producer level — REPL
  // refuses to open it while `state.slash !== null`.
  reverseSearch: ReverseSearchState | null;
  // Live TodoList. Empty array = no list section in compose. Replaced
  // wholesale on every `todo:update` per spec §7.4 ("o model passa a
  // lista intencionada inteira; sem semantics de merge").
  todos: TodoItemForUI[];
  // Background processes currently running, keyed by processId.
  // Footer (spec UI.md §4.10.6) renders a `bg N` token when size > 0.
  // Insertion via bg:start, removal via bg:end. Map preserves
  // insertion order so a future expanded tray can list in
  // chronological order. session:start clears (per-session scope).
  bgProcesses: Map<string, { processId: string; command: string }>;
  // Active subagents, keyed by subagentId (the child session id).
  // Live region renders one row per entry until the corresponding
  // `subagent:end` lands; on end the row is removed and a one-line
  // permanent summary is pushed to scrollback. Insertion via
  // `subagent:start`, mutated in place by `subagent:update`.
  // Insertion order preserved by Map so concurrent subagents
  // render in start order.
  subagents: Map<
    string,
    {
      subagentId: string;
      name: string;
      goal: string;
      // Most recent progress one-liner from the adapter
      // (`step N`, `running echo`, `tool foo done`, etc.). Empty
      // string before the first `subagent:update` arrives —
      // renderer shows the `goal` until then.
      progress: string;
      // Wall-clock when the start event landed. Renderers compute
      // duration as `now - startedAt` for the live row; the
      // permanent summary on end uses `subagent:end.durationMs`
      // from the producer (parent's runSubagent), which is the
      // authoritative span.
      startedAt: number;
      // Cumulative live cost reported by the child via the
      // `cost_update` HarnessEvent stream (spec ORCHESTRATION.md
      // §3.5). Updated on every `subagent:update` whose adapter-
      // observed inner type was `cost_update`. 0 until the first
      // cost update lands — children with `costUsd: 0` providers
      // (test mocks) stay at 0 and the renderer suppresses the
      // `$X.XX` segment, preserving the existing test-fixture
      // visual shape.
      liveCostUsd: number;
    }
  >;
  // Operator hit Esc once during a running turn (spec UI.md §4.10.6
  // "Soft-aborted (ainda processando)"). The footer swaps its
  // interrupt cue from "esc to interrupt" to "esc again to force"
  // until the run terminates. Cleared on session boundaries
  // (start/end) so a fresh turn begins clean. Hard interrupts have
  // no state effect today — they're emitted for audit but the
  // immediate-vs-cooperative cancellation distinction lives in a
  // future hard-abort slice.
  softInterrupted: boolean;
  // Parallelism observability snapshot (spec ORCHESTRATION.md
  // §1.3 / §3.3). Updated by `parallel:status` events fired by
  // the harness whenever the running / queued counts shift.
  // The footer reads this into `subagents R+Q/cap` and
  // `tools R/cap` chips. `null` before the first event lands
  // (idle session pre-task_async); the renderer treats null as
  // "no parallel activity" — both chips suppressed. Once any
  // parallel work happens, the field stays populated for the
  // remainder of the session even if every counter returns to
  // 0; the renderer suppresses individual chips at zero.
  parallelStatus: {
    subagentsRunning: number;
    subagentsQueued: number;
    subagentsCap: number;
    toolsRunning: number;
    toolsCap: number;
  } | null;
  // Idle Ctrl+C double-tap gate (UI.md §5.4 + §4.10.6). Non-null means
  // the operator pressed Ctrl+C once at idle with an empty buffer;
  // footer flips to `Press Ctrl-C again to exit` (warn). The REPL owns the
  // 2s timer + the second-press detection — the reducer just flips
  // the flag in response to `interrupt:exit-arm` / `:exit-cancel`.
  // `at` is the timestamp when armed (carried for tests / future
  // animation; not currently consulted by the renderer).
  exitArmed: { at: number } | null;
  // Set true after `session:end`; renderer uses to decide whether to
  // accept further input or stop redrawing.
  ended: boolean;
}

export const createInitialState = (): LiveState => ({
  input: { value: '', cursor: 0 },
  status: {
    sessionId: null,
    profile: null,
    project: null,
    model: null,
    steps: 0,
    maxSteps: 0,
    costUsd: 0,
    maxCostUsd: null,
    planMode: false,
    memoryCount: 0,
  },
  activeTools: new Map(),
  pendingToolEndBatch: null,
  pendingAssistant: null,
  thinking: null,
  critique: null,
  awaitingProvider: null,
  modal: null,
  slash: null,
  reverseSearch: null,
  todos: [],
  bgProcesses: new Map(),
  subagents: new Map(),
  parallelStatus: null,
  softInterrupted: false,
  exitArmed: null,
  ended: false,
});

// Maximum lines kept in a tool's preview window. Anything longer
// would push the live region past its budget (UI.md §2.2: max 15
// lines). The cap is conservative — renderer-side truncation can
// shrink further per layout.
const TOOL_PREVIEW_MAX_LINES = 5;

// Structured records representing scrollback entries the reducer wants
// the renderer to print. Glyph + color decisions live in the renderer
// (which sees `caps`), not here — keeping the reducer free of capability
// awareness. The renderer's `formatPermanent(item, caps)` turns each
// record into one or more output strings.
//
// Adding a new kind: extend the union, handle it in `formatPermanent`
// (renderer.ts), and emit from the relevant `applyEvent` branch.
export type PermanentItem =
  | {
      kind: 'session-footer';
      reason: string;
      // Wall-clock duration of the run; mirrors SessionEndEvent.
      // Renderer formats as `Cogitated for 1m23s` for `done`.
      // Optional for legacy paths that don't track timing.
      durationMs?: number;
      abortCause?: 'soft' | 'hard';
    }
  | {
      kind: 'session-banner';
      app: string;
      version: string;
      model: string;
      contextWindow: number;
      maxOutputTokens: number;
      cwd: string;
      // Mirror of SessionBannerEvent.env (UI.md §4.10.9). Renderer
      // discriminates on `kind` to pick the right palette per entry.
      env: SessionBannerEnvEntry[];
    }
  | { kind: 'user-submit'; text: string }
  | {
      kind: 'assistant';
      text: string;
      // Wall-clock duration of the assistant turn. Renderer uses it to
      // print the `Generated N tokens in Xs` chip header. null when the
      // producer didn't track timing (headless replay, synthetic
      // events) — renderer falls back to plain text only.
      durationMs: number | null;
      // Output tokens reported by `assistant:usage`. null when the
      // provider didn't emit a usage event (or the run ended before
      // one arrived). When null, the chip header omits the token clause
      // and reads `Generated in Xs`; when both are null, no header
      // line is printed at all.
      outputTokens: number | null;
    }
  | {
      kind: 'tool-end';
      name: string;
      // Final-state verb ('Read file', 'Executed', etc.) — picked by
      // the reducer from the active record. For error / denied
      // statuses, the renderer overrides with generic verbs ('Failed',
      // 'Denied') regardless of what the producer registered.
      verb: string;
      subject: string | null;
      status: 'done' | 'error' | 'denied';
      durationMs: number;
      summary?: string;
      // Set when this tool fired inside a parent (subagent today;
      // future: nested tool groups). Renderer indents the chip and
      // swaps the leading glyph to `|_` so the chip visually
      // belongs to its owner. Absent for top-level tool calls.
      parentId?: string;
    }
  | {
      // Coalesced batch of N consecutive same-name + same-parentId
      // tool-end items, emitted by the reducer when the pending
      // batch flushes with `count >= TOOL_BATCH_COALESCE_THRESHOLD`.
      // Reads as a single chip "Read 3 files in 0.6s" with the N
      // subjects as `|_` continuation lines underneath.
      kind: 'tool-end-batch';
      // Tool name — single value because the batch only forms across
      // matching names.
      name: string;
      // Headline verb. Pluralized for known file-shaped tools
      // (read_file → "Read N files", write_file → "Wrote N files",
      // etc.); generic `${verb} ×N` fallback for everything else.
      // Renderer overrides with "Failed" / "Denied" when status is
      // non-done, mirroring tool-end behavior.
      verb: string;
      count: number;
      // Sum of children's durations. For parallel batches this
      // overcounts vs wall-clock — the renderer labels it as
      // `in <total>` rather than `in <wall-clock>` so the operator
      // reads it as cumulative work, not elapsed time.
      totalDurationMs: number;
      // One subject per child, in completion order. Null subjects
      // (tools without a vocab subject extractor) are filtered out
      // before the batch flushes — a `|_ ` line with no payload
      // would be visual noise.
      subjects: string[];
      // Worst-of-children status. If any child failed → 'error';
      // else any denied → 'denied'; else 'done'. Honest about a
      // mixed batch — operator sees one chip but knows at least
      // one tool inside hit the bad path.
      status: 'done' | 'error' | 'denied';
      // Forwarded from the children (all share the same parentId
      // by the batch invariant). Optional only for symmetry with
      // tool-end; the field is absent only when all children were
      // top-level.
      parentId?: string;
    }
  | { kind: 'error'; message: string }
  | { kind: 'warn'; message: string }
  | { kind: 'info'; message: string }
  | {
      // Subagent run terminal summary, emitted from the
      // `subagent:end` reducer branch. Renderer formats as a
      // single line with the name, status glyph, summary
      // (truncated), and duration. Mirrors `tool-end`'s shape
      // intent: live row collapses, scrollback line carries the
      // outcome.
      kind: 'subagent_summary';
      ts: number;
      subagentId: string;
      name: string;
      // Full HarnessResult.status. Renderer maps this onto a
      // verb (`Done` / `Aborted` / `Exhausted` / `Error`) and a
      // glyph color so the operator sees the cause type at a
      // glance.
      status: 'done' | 'interrupted' | 'exhausted' | 'error';
      // Stable reason code (`maxCostUsd`, `maxSteps`, `aborted`,
      // `degenerate_loop`, etc). Optional. Renderer uses it to
      // refine the verb ("Exhausted (cost cap)") and decide
      // whether to surface costUsd.
      reason?: string;
      // Authoritative spend at settle. Surfaced by the renderer
      // when reason is budget-related so the operator sees how
      // much was burned vs the cap.
      costUsd: number;
      summary: string;
      durationMs: number;
    };

export interface ApplyResult {
  state: LiveState;
  // Structured records for the renderer to emit as scrollback. Empty
  // array = no scrollback output for this event. Strings happen later
  // in `formatPermanent` (renderer.ts) — that's where `caps` decides
  // glyphs (Unicode vs ASCII) and color (red error vs plain).
  permanent: PermanentItem[];
}

// Append output lines to a tool's preview, keeping only the last N.
const appendPreview = (tool: ActiveTool, text: string): ActiveTool => {
  // Split on `\n` but ignore a trailing empty line (common when the
  // chunk ended exactly at a newline — we don't want a phantom empty
  // preview row).
  const incoming = text.split('\n');
  if (incoming[incoming.length - 1] === '') incoming.pop();
  if (incoming.length === 0) return tool;
  const merged = [...tool.preview, ...incoming];
  const dropped = Math.max(0, merged.length - TOOL_PREVIEW_MAX_LINES);
  return { ...tool, preview: merged.slice(dropped) };
};

const cloneTools = (tools: Map<string, ActiveTool>): Map<string, ActiveTool> => new Map(tools);

// Pluralized headline verb for a coalesced batch. Hand-mapped for
// the file-shaped tools where "Read 3 files" reads more naturally
// than "Read file ×3"; everything else falls through to the
// generic `${verb} ×${count}` form. Kept inline (not a vocab
// extension) because the surface is small and the renderer-side
// fold is the only consumer; centralizing in vocab would add
// indirection without payoff.
const batchHeadlineVerb = (name: string, childVerb: string, count: number): string => {
  switch (name) {
    case 'read_file':
      return `Read ${count} files`;
    case 'write_file':
      return `Wrote ${count} files`;
    case 'edit_file':
      return `Edited ${count} files`;
    case 'bash':
      return `Executed ${count} commands`;
    case 'grep':
      return `Searched ${count} times`;
    case 'glob':
      return `Globbed ${count} times`;
    default:
      return `${childVerb} ×${count}`;
  }
};

// Worst-of children for the batch chip's status. Single failure
// poisons the chip — operator sees "error" and knows to look,
// rather than seeing "done" and missing one bad file in the
// middle of an otherwise-green run. Order matters: error >
// denied > done.
const batchWorstStatus = (
  items: readonly PendingToolEndBatchItem[],
): 'done' | 'error' | 'denied' => {
  let denied = false;
  for (const it of items) {
    if (it.status === 'error') return 'error';
    if (it.status === 'denied') denied = true;
  }
  return denied ? 'denied' : 'done';
};

// Flush the pending tool-end batch into PermanentItems. Returns
// the next state (with batch cleared) and the items to push.
// Behavior:
//   - batch null/empty → no-op, returns empty array
//   - count < TOOL_BATCH_COALESCE_THRESHOLD → emit each as an
//     individual `tool-end` (no visual fold; the buffer just
//     deferred them by one or two events)
//   - count >= threshold → emit a single `tool-end-batch` with
//     the children's subjects as continuation lines
// Exported for the test driver, which terminates without a
// natural flush trigger after the last `tool:end`. Production
// callers don't invoke this directly — the wrapped `applyEvent`
// flushes on the next scrollback-emitting event.
export const flushPendingToolEndBatch = (
  state: LiveState,
): { state: LiveState; permanent: PermanentItem[] } => {
  const batch = state.pendingToolEndBatch;
  if (batch === null || batch.items.length === 0) return { state, permanent: [] };
  const next: LiveState = { ...state, pendingToolEndBatch: null };
  if (batch.items.length < TOOL_BATCH_COALESCE_THRESHOLD) {
    const permanent: PermanentItem[] = batch.items.map((it) => ({
      kind: 'tool-end',
      name: batch.name,
      verb: it.verb,
      subject: it.subject,
      status: it.status,
      durationMs: it.durationMs,
      ...(it.summary !== undefined ? { summary: it.summary } : {}),
      ...(batch.parentId !== undefined ? { parentId: batch.parentId } : {}),
    }));
    return { state: next, permanent };
  }
  const totalDurationMs = batch.items.reduce((s, it) => s + it.durationMs, 0);
  const subjects = batch.items
    .map((it) => it.subject)
    .filter((s): s is string => s !== null && s !== '');
  const headlineVerb = batchHeadlineVerb(
    batch.name,
    batch.items[0]?.verb ?? batch.name,
    batch.items.length,
  );
  const status = batchWorstStatus(batch.items);
  const summary: PermanentItem = {
    kind: 'tool-end-batch',
    name: batch.name,
    verb: headlineVerb,
    count: batch.items.length,
    totalDurationMs,
    subjects,
    status,
    ...(batch.parentId !== undefined ? { parentId: batch.parentId } : {}),
  };
  return { state: next, permanent: [summary] };
};

// Inner switch — pure reducer that doesn't manage the
// pendingToolEndBatch flush lifecycle. Wrapper `applyEvent`
// composes the flush around it so the buffer logic stays
// localized to one place rather than threaded through every
// case that emits permanent items.
const applyEventInner = (state: LiveState, event: UIEvent): ApplyResult => {
  switch (event.type) {
    case 'session:start': {
      const status: StatusState = {
        ...state.status,
        sessionId: event.sessionId,
        profile: event.profile,
        project: event.project,
        model: event.model,
        planMode: event.planMode === true,
        memoryCount: event.memoryCount ?? 0,
      };
      // Boundary cleanup: soft-interrupt state and bg processes are
      // both per-session. A fresh session starts clean even if the
      // prior one ended mid-soft (operator hit Esc, then the run
      // terminated for another reason) or if the prior bg manager
      // somehow left dangling entries.
      //
      // When daemon mode / `--keep-bg` lands and bg
      // processes survive across turn/session boundaries, this reset
      // becomes a regression — the operator would lose the counter
      // for processes still running in the background. Replace the
      // unconditional reset with a producer-driven repopulation (the
      // bg manager would re-emit `bg:start` for surviving processes
      // on the new session_start). Today no path keeps bg alive
      // across sessions, so the reset is correct.
      // No permanent emission (UI.md §3.2). The user-submit inverse
      // bar (§4.10.8) already marks turn boundaries; emitting a
      // session-header line per turn just clutters scrollback with
      // the session UUID, which is operator-irrelevant in REPL mode
      // (relevant only for offline resume / audit, looked up via
      // separate CLI). Status state still updates so the footer
      // shows the current model / steps / cost.
      return {
        state: {
          ...state,
          status,
          softInterrupted: false,
          // Defense in depth: a fresh turn starting clears any
          // armed-exit gate from before. The REPL also emits
          // `interrupt:exit-cancel` on submit, but a session can
          // start via paths that bypass the editor (resume, headless
          // bridge), so the boundary reset closes the gap.
          exitArmed: null,
          bgProcesses: new Map(),
          subagents: new Map(),
          parallelStatus: null,
          // Per-session: a stale "Awaiting model" indicator from a
          // crashed prior run (e.g., resume after parent crash mid-
          // step) shouldn't carry into a fresh turn.
          awaitingProvider: null,
          // Drop any unflushed tool-end batch from a prior session
          // that didn't reach `session:end` cleanly (process killed
          // mid-stream, harness crash, headless invocation that
          // skipped the footer). The wrapper's "flush only when
          // inner emits permanent" rule otherwise lets a stale
          // batch survive into the new session and emit later as
          // scrollback under the wrong session boundary — wrong
          // chronology, misleading audit. We DROP rather than
          // FLUSH because emitting prior-session items inside the
          // new session's scrollback misattributes them; if the
          // prior session genuinely needed them, that path was the
          // one to flush (via session:end's permanent emit
          // triggering the wrapper, which it does).
          pendingToolEndBatch: null,
          ended: false,
        },
        permanent: [],
      };
    }

    case 'session:end': {
      // Drain any buffered tool-end batch into the scrollback
      // BEFORE the footer so the operator sees those tool calls
      // attributed to the session that just ended. The wrapper
      // already flushes around the footer's permanent emit, but
      // doing it explicitly here keeps the boundary semantics
      // local to the case (defensive against a future refactor
      // where session:end might emit no permanent or where the
      // wrapper's contract changes).
      const flushed = flushPendingToolEndBatch(state);
      // Boundary cleanup: clear the soft-interrupt flag so the
      // footer's "esc again to force" cue stops surfacing once the
      // run actually terminates (regardless of WHY it ended — could
      // be the soft-abort succeeding, could be done/error/maxSteps).
      // Also zero the bg counter: the harness emits `session_finished`
      // BEFORE its outer finally runs `bgManager.cleanup()`, so the
      // bg_ended events from cleanup land AFTER the operator has
      // already seen `session:end` in the footer. Without zeroing
      // here, the cue would briefly show `bg N` for processes the
      // harness already committed to killing — visually a zombie
      // tray. The late bg:end events still flow through (they're
      // dropped as no-ops by the unknown-processId branch).
      return {
        state: {
          ...flushed.state,
          softInterrupted: false,
          // Same boundary reset rationale as session:start (above).
          exitArmed: null,
          bgProcesses: new Map(),
          subagents: new Map(),
          parallelStatus: null,
          // Same rationale as session:start: a session ending mid-
          // step (abort, error) shouldn't leave the indicator armed
          // — the footer would then show "Awaiting model" against a
          // run that's already terminated.
          awaitingProvider: null,
          // Same boundary cleanup for the critique chip: a session
          // ending mid-critique (abort signal interrupted the
          // critic call, watchdog never closed) shouldn't leave a
          // dangling "Reviewing…" chip in the live region.
          critique: null,
          ended: true,
        },
        permanent: [
          ...flushed.permanent,
          {
            kind: 'session-footer',
            reason: event.reason,
            ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
            ...(event.abortCause !== undefined ? { abortCause: event.abortCause } : {}),
          },
        ],
      };
    }

    case 'session:banner':
      return {
        state,
        permanent: [
          {
            kind: 'session-banner',
            app: event.app,
            version: event.version,
            model: event.model,
            contextWindow: event.contextWindow,
            maxOutputTokens: event.maxOutputTokens,
            cwd: event.cwd,
            env: event.env,
          },
        ],
      };

    case 'user:submit':
      return {
        // Clear the input AND reset `ended` so the REPL loop's next
        // turn can keep drawing without needing a synthetic
        // session:start to revive the renderer. One-shot callers
        // close the renderer right after `session:end` anyway —
        // `ended` was a soft guard, not a contract.
        state: { ...state, input: { value: '', cursor: 0 }, ended: false },
        permanent: [{ kind: 'user-submit', text: event.text }],
      };

    case 'input:update':
      return {
        state: { ...state, input: { value: event.value, cursor: event.cursor } },
        permanent: [],
      };

    case 'assistant:start':
      // Clear `awaitingProvider` — the model has started
      // streaming so the "Awaiting model" indicator isn't
      // accurate anymore. The compose layer's chip-slot then
      // picks the assistant chip from `pendingAssistant`.
      return {
        state: {
          ...state,
          awaitingProvider: null,
          pendingAssistant: {
            messageId: event.messageId,
            text: '',
            startedAt: event.ts,
            inputTokens: null,
            outputTokens: null,
            cacheRead: null,
            cacheCreation: null,
          },
        },
        permanent: [],
      };

    case 'assistant:delta': {
      const current = state.pendingAssistant;
      // Late delta with no matching start — happens if the producer
      // emitted out of order or session resumed mid-stream. We open
      // a buffer on the fly rather than dropping content. startedAt
      // falls back to the delta's ts so the live duration counter
      // reads "from when we first knew about this turn" instead of
      // anchoring at 0 (which would render an absurd elapsed time).
      const buf = current ?? {
        messageId: event.messageId,
        text: '',
        startedAt: event.ts,
        inputTokens: null,
        outputTokens: null,
        cacheRead: null,
        cacheCreation: null,
      };
      return {
        state: { ...state, pendingAssistant: { ...buf, text: buf.text + event.text } },
        permanent: [],
      };
    }

    case 'assistant:usage': {
      const buf = state.pendingAssistant;
      // Out-of-order / unknown turn: drop. Synthesizing a pending
      // assistant from a usage event would render a chip with no text
      // and no startedAt anchor — worse than ignoring the count.
      if (buf === null || buf.messageId !== event.messageId) {
        return { state, permanent: [] };
      }
      // Monotonic merge: protects against a hypothetical provider
      // that emits a partial count after a complete one. Today
      // Anthropic is cumulative and OpenAI is one-shot — both shapes
      // are safe under Math.max.
      const merge = (prev: number | null, next: number): number =>
        prev === null ? next : Math.max(prev, next);
      return {
        state: {
          ...state,
          pendingAssistant: {
            ...buf,
            inputTokens: merge(buf.inputTokens, event.inputTokens),
            outputTokens: merge(buf.outputTokens, event.outputTokens),
            cacheRead: merge(buf.cacheRead, event.cacheRead),
            cacheCreation: merge(buf.cacheCreation, event.cacheCreation),
          },
        },
        permanent: [],
      };
    }

    case 'assistant:end': {
      const buf = state.pendingAssistant;
      const text = buf?.text ?? '';
      const durationMs = buf !== null ? event.ts - buf.startedAt : null;
      const outputTokens = buf?.outputTokens ?? null;
      // Emit a permanent ONLY when there's prose to land in
      // scrollback. Tool-only turns (Anthropic emits tool_use
      // blocks without accompanying text) used to also emit so the
      // formatter could render a `· Generated N tokens` chip above
      // the tool chips — that chip header was removed (UI.md §4.10.5,
      // duration goes to the turn-end marker §3.2 / tokens go to the
      // footer). Emitting an item the formatter would render as []
      // anyway forces the renderer through writeTransition (erase +
      // full-frame redraw) for no scrollback gain — wasteful under
      // tool-heavy flows and undermines the differential anti-flicker.
      const permanent: PermanentItem[] =
        text.length > 0 ? [{ kind: 'assistant', text, durationMs, outputTokens }] : [];
      return { state: { ...state, pendingAssistant: null }, permanent };
    }

    case 'thinking:start':
      // Clear `awaitingProvider` — extended thinking started
      // streaming, the more specific indicator takes the slot.
      return {
        state: {
          ...state,
          awaitingProvider: null,
          thinking: { startedAt: event.ts, messageId: event.messageId },
        },
        permanent: [],
      };

    case 'thinking:end':
    case 'thinking:delta':
      // Delta events don't change state — duration is computed at render
      // time from `startedAt`. End clears the indicator.
      return {
        state: event.type === 'thinking:end' ? { ...state, thinking: null } : state,
        permanent: [],
      };

    case 'critique:start':
      // Self-critique pass started. Open the chip — composer
      // (compose.ts) reads `state.critique` and renders a
      // "Reviewing… (Xs)" line during the otherwise-silent window
      // while the critic LLM call is in flight. Mutually exclusive
      // with thinking / pendingAssistant / awaitingProvider — the
      // executor's `assistant:end` fires before critique starts,
      // so those states are already null by the time this hits.
      return {
        state: {
          ...state,
          critique: {
            startedAt: event.ts,
            stepN: event.stepN,
            toolPlanWrites: event.toolPlanWrites,
          },
        },
        permanent: [],
      };

    case 'critique:end':
      // Close the chip. The next operator-visible surface is
      // either the modal (when issues crossed threshold) or the
      // next assistant turn (when no issues OR ignore was chosen).
      return { state: { ...state, critique: null }, permanent: [] };

    case 'tool:start': {
      const tool: ActiveTool = {
        toolId: event.toolId,
        name: event.name,
        activeVerb: event.activeVerb,
        finalVerb: event.finalVerb,
        subject: event.subject,
        ...(event.parentId !== undefined ? { parentId: event.parentId } : {}),
        startedAt: event.ts,
        preview: [],
      };
      const next = cloneTools(state.activeTools);
      next.set(event.toolId, tool);
      return { state: { ...state, activeTools: next }, permanent: [] };
    }

    case 'tool:delta': {
      const tool = state.activeTools.get(event.toolId);
      // Delta for an unknown tool: drop. Producer error or out-of-order
      // event after `tool:end`. Don't synthesize a tool from a delta —
      // we'd lack name/args.
      if (tool === undefined) return { state, permanent: [] };
      const next = cloneTools(state.activeTools);
      next.set(event.toolId, appendPreview(tool, event.text));
      return { state: { ...state, activeTools: next }, permanent: [] };
    }

    case 'tool:end': {
      const tool = state.activeTools.get(event.toolId);
      const nextTools = cloneTools(state.activeTools);
      nextTools.delete(event.toolId);
      if (tool === undefined) return { state: { ...state, activeTools: nextTools }, permanent: [] };
      // Non-`done` chips bypass the buffer entirely — emit the
      // tool-end PermanentItem immediately AND flush whatever's
      // pending so the chronological order stays correct.
      //
      // Why: a denied or errored tool is a signal the operator
      // needs to see fast. The buffer's purpose is to coalesce
      // SAME-tool successful runs; a failure mid-stream isn't
      // coalesce-friendly anyway (the user's reported scenario:
      // a denied bash chip sat in the buffer for 51s because the
      // agent paused, leaving the operator staring at "Read 6
      // files" with no signal that the next tool was blocked by
      // policy). Emitting on the spot fixes that UX.
      //
      // Trade-off: a batch where one read fails in the middle
      // of an otherwise-green run no longer coalesces — the
      // failure flushes the partial buffer and emits its own
      // chip, then the surviving items continue in a fresh
      // buffer. That's strictly more honest: operator sees the
      // failure boundary instead of one batch chip with
      // worst-of status.
      if (event.status !== 'done') {
        const flushed = flushPendingToolEndBatch(state);
        const item: PermanentItem = {
          kind: 'tool-end',
          name: tool.name,
          verb: tool.finalVerb,
          subject: tool.subject,
          status: event.status,
          durationMs: event.durationMs,
          ...(event.summary !== undefined ? { summary: event.summary } : {}),
          ...(tool.parentId !== undefined ? { parentId: tool.parentId } : {}),
        };
        return {
          state: { ...flushed.state, activeTools: nextTools },
          permanent: [...flushed.permanent, item],
        };
      }
      const incoming: PendingToolEndBatchItem = {
        verb: tool.finalVerb,
        subject: tool.subject,
        status: event.status,
        durationMs: event.durationMs,
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
      };
      const pending = state.pendingToolEndBatch;
      const matches =
        pending !== null && pending.name === tool.name && pending.parentId === tool.parentId;
      if (matches) {
        // Extend the existing batch; emit nothing yet. The flush
        // happens when a non-matching event arrives.
        const extended: PendingToolEndBatch = {
          ...pending,
          items: [...pending.items, incoming],
        };
        return {
          state: { ...state, activeTools: nextTools, pendingToolEndBatch: extended },
          permanent: [],
        };
      }
      // Different name/parentId (or no batch): flush whatever's
      // pending and start a new batch with the incoming item.
      const flushed = flushPendingToolEndBatch(state);
      const fresh: PendingToolEndBatch = {
        name: tool.name,
        ...(tool.parentId !== undefined ? { parentId: tool.parentId } : {}),
        items: [incoming],
      };
      return {
        state: { ...flushed.state, activeTools: nextTools, pendingToolEndBatch: fresh },
        permanent: flushed.permanent,
      };
    }

    case 'step:budget': {
      const status: StatusState = {
        ...state.status,
        steps: event.steps,
        maxSteps: event.maxSteps,
        costUsd: event.costUsd,
        maxCostUsd: event.maxCostUsd ?? null,
      };
      return { state: { ...state, status }, permanent: [] };
    }

    case 'provider:waiting:start': {
      // Open the "Awaiting model" indicator. Idempotent on
      // resume / re-emit: the second start within the same step
      // refreshes `startedAt` to the latest, which keeps the
      // displayed elapsed time monotonic against the freshest
      // signal of when the harness handed off the request.
      return {
        state: {
          ...state,
          awaitingProvider: { stepN: event.stepN, startedAt: event.ts },
        },
        permanent: [],
      };
    }

    case 'provider:waiting:end': {
      // Close the indicator. Safe to fire when nothing is open —
      // `assistant:start` / `thinking:start` already handle that
      // case via their own clears, and a duplicate end shouldn't
      // throw.
      if (state.awaitingProvider === null) return { state, permanent: [] };
      return { state: { ...state, awaitingProvider: null }, permanent: [] };
    }

    case 'checkpoint:create':
      // No live element yet — checkpoint flash on status line lands
      // with the status-line render function.
      return { state, permanent: [] };

    case 'screen:clear':
      // Pure renderer concern — state untouched. Renderer subscribes
      // separately and writes the ANSI clear escape.
      return { state, permanent: [] };

    case 'slash:update': {
      // Empty suggestions + selectedIdx -1 → exit slash mode. Any
      // other shape is "(re)open with these suggestions".
      const empty = event.suggestions.length === 0 && event.selectedIdx === -1;
      return {
        state: {
          ...state,
          slash: empty ? null : { suggestions: event.suggestions, selectedIdx: event.selectedIdx },
        },
        permanent: [],
      };
    }

    case 'reverse-search:update':
      return {
        state: {
          ...state,
          reverseSearch: {
            query: event.query,
            results: event.results,
            selectedIdx: event.selectedIdx,
          },
        },
        permanent: [],
      };

    case 'reverse-search:close':
      // Idempotent: if already closed, the reducer no-ops. Producer
      // emits unconditionally on Esc/Enter/Tab so the close path
      // doesn't need to track whether the overlay is up.
      if (state.reverseSearch === null) return { state, permanent: [] };
      return { state: { ...state, reverseSearch: null }, permanent: [] };

    case 'error':
      return { state, permanent: [{ kind: 'error', message: event.message }] };

    case 'warn':
      return { state, permanent: [{ kind: 'warn', message: event.message }] };

    case 'info':
      return { state, permanent: [{ kind: 'info', message: event.message }] };

    case 'interrupt':
      // Spec UI.md §4.10.6: soft interrupt flips the footer cue from
      // "esc to interrupt" to "esc again to force". Hard interrupt
      // has no state effect today — it's emitted for audit, but the
      // immediate-vs-cooperative cancellation distinction lives in
      // a future hard-abort slice. Idempotent: a second soft event
      // (operator hit Esc twice rapidly while the loop is still
      // tearing down) leaves softInterrupted true.
      if (event.level === 'soft') {
        return { state: { ...state, softInterrupted: true }, permanent: [] };
      }
      return { state, permanent: [] };

    case 'interrupt:exit-arm':
      // UI.md §5.4 idle Ctrl+C gate. Idempotent: re-arming while
      // already armed refreshes `at` so the operator's most recent
      // press is the one whose 2s window counts (the producer also
      // resets the timer; this is just defensive consistency).
      return { state: { ...state, exitArmed: { at: event.ts } }, permanent: [] };

    case 'interrupt:exit-cancel':
      // Disarm. Producer emits this on: any other key, timeout
      // expiry, submit, modal open, session boundary. Idempotent
      // when already null.
      if (state.exitArmed === null) return { state, permanent: [] };
      return { state: { ...state, exitArmed: null }, permanent: [] };

    // ─── Modal events ──────────────────────────────────────────────
    // Each `*:ask` raises a confirm-shaped modal with `selected = 'no'`
    // by default (UI.md §5.5 D5). The matching `*:answer` (or
    // `modal:answer`) clears the modal.
    // Producer (modal-manager) is responsible for re-emitting if
    // multiple modals queue up; the reducer never queues itself.
    case 'permission:ask': {
      // Layout follows design/permission-modal-redesign.md. Three
      // structural pieces:
      //
      //   1. Context label (was "title"+"subject"): per-tool framing
      //      ("Bash command", "Editing file", "Network access"...).
      //      Subagent attribution becomes a parenthesized suffix on
      //      the same label — no separate "subagent:" preview line.
      //   2. Action block (preview): blank line, action, blank line,
      //      then conditional cwd + source attribution. The blank
      //      lines around the action are load-bearing — they make
      //      the action read as a deliberate decision instead of a
      //      config row, matching reference terminal designs.
      //   3. Options + footer: option 2's label promotes the matched
      //      rule pattern ("Yes, don't ask again for: rm -rf *")
      //      via buildPermissionOptions — same source the manager
      //      uses for selection clamping, so labels and count can't
      //      drift. Footer gains "Tab to amend" and
      //      "Ctrl+E to explain" hints — handlers land in later
      //      slices; the hint reservation pre-flows the footer.

      const options = buildPermissionOptions(event.toolName, event.rule);

      // Anti-spoof: only the agent's `name` (the definition's
      // declared name from the agents/*.md frontmatter) reaches the
      // label — never a string the child generated.
      const baseLabel = contextLabelForTool(event.toolName);
      const titleStr =
        event.subagent !== undefined
          ? `${baseLabel} (subagent: ${event.subagent.name})`
          : baseLabel;

      const previewLines: PreviewLine[] = [];
      // Action block. Bash family carries the "$ " shell prefix; fs/
      // web tools display the path/url verbatim. The 4-space lead
      // (this stored line) + the renderer's 2-space indent = 6
      // visible spaces, matching the design mockup's deeper indent.
      // Bold paint highlights the command — operator's eye lands
      // here first when triaging a confirm.
      const actionPrefix = BASH_FAMILY.has(event.toolName) ? '$ ' : '';
      previewLines.push('');
      previewLines.push({
        text: `    ${actionPrefix}${event.command}`,
        tone: 'bold',
      });
      previewLines.push('');

      // cwd: always shown for now — subagent-proxied asks land in a
      // worktree path that's worth surfacing, and parent's own asks
      // historically showed cwd too. Conditional rendering (hide on
      // session-cwd match) is a future slice once we have access to
      // the session cwd in the reducer.
      previewLines.push(`cwd: ${event.cwd}`);

      // Source attribution lifts to the `secondary` paint so it
      // visually breaks out of the dim baseline. Operator scanning
      // a sea of confirms during a multi-step turn can find the
      // YAML-edit hint without re-reading every line.
      if (event.rule !== undefined) {
        const layerLabel =
          event.layer === undefined
            ? ''
            : event.layer === 'default'
              ? ' (built-in default)'
              : ` (${event.layer} policy)`;
        previewLines.push({
          text: `matched rule: ${event.rule}${layerLabel}`,
          tone: 'secondary',
        });
      } else if (event.layer !== undefined && event.layer !== 'default') {
        previewLines.push({
          text: `no rule matched in ${event.layer} policy`,
          tone: 'secondary',
        });
      }

      // Trailing blank line before the option list. Without this,
      // the source-attribution row visually fuses with option 1
      // ("matched rule: X" + "1. Yes" read as a continuous block).
      // The blank separates source attribution from the decision
      // surface so the operator's eye registers them as different
      // sections of the same modal.
      previewLines.push('');

      return {
        state: {
          ...state,
          modal: {
            promptId: event.promptId,
            flavor: 'permission',
            title: titleStr,
            // Subject dropped: the context label IS the subject row
            // now. Keeping a separate subject would re-render the
            // category and create the same triple-statement of the
            // action that the redesign aims to remove.
            subject: null,
            preview: previewLines,
            // Question dropped: "Do you want to run this <tool>
            // command?" is implicit from the context label + the
            // numbered options. The engine's `event.reason` (if
            // any) lives in the source-attribution preview line via
            // the matched-rule path; no separate question row.
            question: null,
            options,
            selectedIndex: options.length - 1,
            // Tab and Ctrl+E are hints only — handlers are deferred
            // to Slices 4-5 of the modal redesign. Pre-flowing the
            // footer here means the visual layout stays stable when
            // the handlers land.
            hints: ['Esc to cancel', 'Tab to amend', 'Ctrl+E to explain'],
            queueDepth: 0,
          },
        },
        permanent: [],
      };
    }

    case 'modal:answer': {
      // Only clear the modal when the answer matches the open prompt.
      // A late answer from a stale prompt (e.g. cancelled then a new
      // ask raised before the cancel propagated) shouldn't dismiss
      // the wrong modal.
      if (state.modal === null || state.modal.promptId !== event.promptId) {
        return { state, permanent: [] };
      }
      return { state: { ...state, modal: null }, permanent: [] };
    }

    case 'modal:select': {
      // In-modal navigation. Updates only `selectedIndex`; never
      // reconstructs contents. Stale events (mismatched promptId, or
      // arrived after the modal closed) are dropped silently. Out-of-
      // range index clamps to a valid bound so a buggy producer can't
      // poison the modal.
      if (state.modal === null || state.modal.promptId !== event.promptId) {
        return { state, permanent: [] };
      }
      const max = state.modal.options.length - 1;
      const clamped = Math.max(0, Math.min(max, event.selectedIndex));
      return {
        state: { ...state, modal: { ...state.modal, selectedIndex: clamped } },
        permanent: [],
      };
    }

    case 'modal:queue-depth': {
      // Live update of how many other ask*s are queued behind the
      // active modal. Modal-manager emits one when a modal opens
      // (from drain) and again whenever a new ask enqueues while
      // the modal is up. Dropped silently when promptId mismatches
      // or the modal already closed — a stale event that lost its
      // race with `modal:answer`. Negative depths clamp to 0 (a
      // buggy producer can't render a phantom "(-1 waiting)").
      if (state.modal === null || state.modal.promptId !== event.promptId) {
        return { state, permanent: [] };
      }
      const depth = Math.max(0, event.depth);
      return {
        state: { ...state, modal: { ...state.modal, queueDepth: depth } },
        permanent: [],
      };
    }

    case 'trust:ask': {
      const options: ConfirmOption[] = [
        { key: '1', label: 'Yes, I trust this folder', value: 'yes' },
        { key: '2', label: 'No, exit', value: 'no' },
      ];
      // Layout intentionally mirrors the IDE-style "accessing
      // workspace" prompt: title is the action, the cwd lives on
      // its own preview row (so a long path doesn't crowd the
      // title), and the prose explains the safety question + the
      // capabilities the operator is granting. Question slot stays
      // null because the prose already does that job; pushing both
      // would double-state the ask.
      const previewLines: string[] = [
        event.path,
        '',
        'Quick safety check: is this a project you created or one you trust?',
        '(Your own code, a well-known open source project, or work from your team.)',
        "If not, take a moment to review what's in this folder first.",
        '',
        'Forja will be able to read, edit, and execute files here.',
      ];
      if (event.agentsMd) {
        previewLines.push('');
        previewLines.push(
          'AGENTS.md present — the agent will read it via read_file when project conventions are relevant.',
        );
      }
      return {
        state: {
          ...state,
          modal: {
            promptId: event.promptId,
            flavor: 'trust',
            title: 'Accessing workspace:',
            subject: null,
            preview: previewLines,
            question: null,
            // D65 (UI.md §6.5): last option is the conservative
            // default. Operator hitting Enter without reading
            // chooses "No, exit" — the safer outcome here.
            options,
            selectedIndex: options.length - 1,
            hints: ['Enter to confirm', 'Esc to cancel'],
            queueDepth: 0,
          },
        },
        permanent: [],
      };
    }

    case 'history-clear:ask': {
      // Three options per HISTORY.md §2.3: clear-only, clear-and-
      // disable-permanently, no. `yes-disable` writes the
      // `.agent/no-history` marker (spec §3.3 level 2) on top of
      // the wipe so subsequent REPLs in this project never
      // re-enable persistence without explicit operator action.
      const options: ConfirmOption[] = [
        { key: '1', label: 'Yes, wipe', value: 'yes' },
        { key: '2', label: 'Yes, wipe and disable persistence', value: 'yes-disable' },
        { key: '3', label: 'No', value: 'no' },
      ];
      const blast =
        event.entryCount === 1
          ? '1 entry will be permanently removed.'
          : `${event.entryCount} entries will be permanently removed.`;
      // Layout follows the trust-modal pattern: the path goes into
      // `preview` as its own row (where the renderer's truncate-to-
      // width pass clips long paths cleanly) rather than into
      // `subject` (where a >80-char path would visually overflow
      // without recourse). Subject stays null because the title
      // already names the action.
      return {
        state: {
          ...state,
          modal: {
            promptId: event.promptId,
            flavor: 'history-clear',
            title: 'Clear input history',
            subject: null,
            preview: [event.projectRoot, '', blast],
            question: 'Are you sure you want to wipe the input history for this project?',
            options,
            // Default = last (No), per the same conservative-default
            // convention as trust / permission. An operator hitting
            // Enter without reading shouldn't lose history.
            selectedIndex: options.length - 1,
            hints: ['Enter to confirm', 'Esc to cancel'],
            queueDepth: 0,
          },
        },
        permanent: [],
      };
    }

    case 'memory:write:ask': {
      const options: ConfirmOption[] = [
        { key: '1', label: 'Yes, write memory', value: 'yes' },
        { key: '2', label: 'No, skip', value: 'no' },
      ];
      return {
        state: {
          ...state,
          modal: {
            promptId: event.promptId,
            flavor: 'memory-write',
            title: 'Write memory',
            subject: `${event.scope}/${event.name}`,
            preview: event.body.split('\n'),
            question: 'Save this memory entry?',
            options,
            selectedIndex: options.length - 1,
            hints: ['Esc to cancel'],
            queueDepth: 0,
          },
        },
        permanent: [],
      };
    }

    case 'memory:action:ask': {
      // Generic confirm flavor for /memory delete | promote | demote
      // (spec §5.4 / §5.5 / §6.3). Producer (slash command) supplies
      // the title / subject / preview / question — reducer just
      // mounts them. Conservative-default last-option (No) mirrors
      // every other modal flavor.
      const options: ConfirmOption[] = [
        { key: '1', label: 'Yes, proceed', value: 'yes' },
        { key: '2', label: 'No, cancel', value: 'no' },
      ];
      return {
        state: {
          ...state,
          modal: {
            promptId: event.promptId,
            flavor: 'memory-action',
            title: event.title,
            subject: event.subject,
            preview: event.preview,
            question: event.question,
            options,
            selectedIndex: options.length - 1,
            hints: ['Esc to cancel'],
            queueDepth: 0,
          },
        },
        permanent: [],
      };
    }

    case 'memory:user-scope:ask': {
      // Spec §7.2.5 second-confirm modal. Wording leans heavy on
      // the cross-session blast radius — the operator just said
      // "yes" to writing this memory; the only reason to ask
      // again is to make them think about "and EVERY future
      // session" before persisting. Same option shape as the
      // first prompt (yes/no, default no) so muscle memory carries
      // over, but title/subject/preview emphasize the scope risk.
      //
      // Preview lines are kept as natural sentences (not pre-
      // wrapped at fixed columns) — the renderer wraps via
      // wrap-ansi at terminal width, and pre-wrapping here would
      // either truncate in narrow terminals or produce a
      // fragmented look in wide ones. Trust modal and plan-review
      // follow the same convention.
      const options: ConfirmOption[] = [
        { key: '1', label: 'Yes, persist to user scope', value: 'yes' },
        { key: '2', label: 'No, cancel write', value: 'no' },
      ];
      return {
        state: {
          ...state,
          modal: {
            promptId: event.promptId,
            flavor: 'memory-user-scope',
            title: 'Confirm user-scope memory',
            subject: event.name,
            preview: [
              'This memory will load in EVERY session on this machine, regardless of project.',
              'Confirm only if the content is genuinely cross-project context.',
              '',
              ...event.body.split('\n'),
            ],
            question: 'Persist to user scope?',
            options,
            selectedIndex: options.length - 1,
            hints: ['Esc to cancel'],
            queueDepth: 0,
          },
        },
        permanent: [],
      };
    }

    case 'plan:review': {
      const options: ConfirmOption[] = [
        { key: '1', label: 'Approve', value: 'yes' },
        { key: '2', label: 'Edit', value: 'edit' },
        { key: '3', label: 'Reject', value: 'no' },
      ];
      const previewLines = [
        ...event.steps.map((s, i) => `${i + 1}. ${s}`),
        '',
        `estimated: ${event.estimatedCalls} tool calls · $${event.estimatedCostUsd.toFixed(2)}`,
      ];
      return {
        state: {
          ...state,
          modal: {
            promptId: event.promptId,
            flavor: 'plan-review',
            title: 'Plan review',
            subject: `${event.steps.length} steps`,
            preview: previewLines,
            question: 'Approve this plan?',
            options,
            selectedIndex: options.length - 1,
            hints: ['Esc to cancel'],
            queueDepth: 0,
          },
        },
        permanent: [],
      };
    }

    case 'critique:ask': {
      // Three-way decision per AGENTIC_CLI.md §5.4 line 551 and
      // ORCHESTRATION.md §6.2: ignore (proceed), redo (re-run with
      // hint), abort (stop the run). Default selection is `abort`
      // (last) — the most conservative answer for a step that just
      // got flagged. The D5/D65 convention places the safe default
      // last, but for critique "safe" means "don't proceed without
      // the operator looking", which `abort` captures more
      // strongly than `ignore` (proceeding blind) or `redo`
      // (re-running and possibly looping).
      //
      // We ALSO clear `state.critique` here. The chip's `startedAt`
      // is the critic LLM call's start — at the point the modal
      // opens, that call is already over and the remaining wait is
      // on the operator. Letting the chip live past this point
      // would have it tick across human decision time, reading
      // "Reviewing… (45s)" when the actual critic call took 2s
      // and the rest was the operator reading. The eventual
      // `critique:end` (mapped from `critique_finished`, fired
      // AFTER `confirmCritique` resolves) becomes a no-op for the
      // chip since we already nulled it; that's intentional —
      // both clear sites converge on the same end state.
      const options: ConfirmOption[] = [
        { key: '1', label: 'Ignore', value: 'ignore' },
        { key: '2', label: 'Redo with hint', value: 'redo' },
        { key: '3', label: 'Abort step', value: 'abort' },
      ];
      const previewLines = event.issues.map(
        (i) => `[${i.severity}] (${i.confidence.toFixed(2)}) ${i.message}`,
      );
      // Stronger headline when the proposal includes writes:true
      // tool calls. The `toolPlanWrites` flag is forwarded by the
      // producer (harness's confirmCritique bridge); absent ⇒
      // text-only end-of-step critique.
      const writes = event.toolPlanWrites === true;
      const title = writes ? 'Critique — about to mutate' : 'Critique';
      return {
        state: {
          ...state,
          critique: null,
          modal: {
            promptId: event.promptId,
            flavor: 'critique',
            title,
            subject: `${event.issues.length} issue(s)`,
            preview: previewLines,
            question: writes
              ? 'Proceed with the writes, redo with hint, or abort?'
              : 'Ignore, redo with hint, or abort?',
            options,
            selectedIndex: options.length - 1,
            hints: ['Esc to cancel'],
            queueDepth: 0,
          },
        },
        permanent: [],
      };
    }

    case 'todo:update':
      // Full-replace per spec §7.4. Producer (TodoStore.set wrapper)
      // already deep-clones via get(), but the reducer copies the
      // outer array anyway — without the spread, two LiveStates
      // produced from the same event (e.g. headless NDJSON replay,
      // tests applying the same event twice) would alias the same
      // array, and mutation in one would leak into the other. Inner
      // items remain shared by reference; the renderer treats them
      // read-only and we don't expose a mutation API.
      return { state: { ...state, todos: [...event.items] }, permanent: [] };

    case 'bg:start': {
      // Insert into the live map. Duplicate processId from a
      // misbehaving producer overwrites silently — Map.set is the
      // natural semantic and the renderer's count stays correct.
      const next = new Map(state.bgProcesses);
      next.set(event.processId, { processId: event.processId, command: event.command });
      return { state: { ...state, bgProcesses: next }, permanent: [] };
    }

    case 'bg:end': {
      // Remove from the live map. Unknown processId is a no-op —
      // out-of-order events (end without prior start) shouldn't
      // crash, and the count stays correct without the entry.
      if (!state.bgProcesses.has(event.processId)) return { state, permanent: [] };
      const next = new Map(state.bgProcesses);
      next.delete(event.processId);
      return { state: { ...state, bgProcesses: next }, permanent: [] };
    }

    case 'bg:update':
      // Free-form status string with no producer today. Reserved for
      // a future "process tray" panel that surfaces per-process
      // status changes without flapping the counter.
      return { state, permanent: [] };

    case 'subagent:start': {
      // Insert a fresh row keyed by subagentId. Duplicate starts
      // (defensive — producer is single-shot) overwrite the
      // existing entry rather than no-oping; the new producer is
      // the source of truth for any field the renderer reads.
      const next = new Map(state.subagents);
      next.set(event.subagentId, {
        subagentId: event.subagentId,
        name: event.name,
        goal: event.goal,
        progress: '',
        startedAt: event.ts,
        liveCostUsd: 0,
      });
      return { state: { ...state, subagents: next }, permanent: [] };
    }

    case 'subagent:update': {
      // Out-of-order updates (event arrives before the matching
      // start; or after the end already removed the entry) are
      // silently dropped. The renderer relies on the entry
      // existing; instead of synthesizing a half-formed row, we
      // wait for the producer's next start. This matches the
      // bg:* reducer's same-shape policy.
      const existing = state.subagents.get(event.subagentId);
      if (existing === undefined) return { state, permanent: [] };
      const next = new Map(state.subagents);
      // `cumulativeCostUsd` is optional on subagent:update — only
      // populated when the adapter routed a `cost_update` inner
      // event. Other progress events leave it undefined, which
      // means "no change" — preserves the existing value rather
      // than zeroing it. Monotonic at the source (handle-store
      // enforces) so we don't need a max() guard.
      const liveCostUsd = event.cumulativeCostUsd ?? existing.liveCostUsd;
      next.set(event.subagentId, { ...existing, progress: event.progress, liveCostUsd });
      return { state: { ...state, subagents: next }, permanent: [] };
    }

    case 'subagent:end': {
      // Drop the live row + emit a one-line scrollback summary so
      // the operator sees the run's terminal verdict even after
      // the live region recycles. Same shape as bg:end / tool
      // finalize: the live region collapses, the permanent line
      // captures the outcome.
      const existing = state.subagents.get(event.subagentId);
      const next = new Map(state.subagents);
      next.delete(event.subagentId);
      const permanent: PermanentItem[] =
        existing === undefined
          ? []
          : [
              {
                kind: 'subagent_summary',
                ts: event.ts,
                subagentId: event.subagentId,
                name: existing.name,
                status: event.status,
                ...(event.reason !== undefined ? { reason: event.reason } : {}),
                costUsd: event.costUsd,
                summary: event.summary,
                durationMs: event.durationMs,
              },
            ];
      return { state: { ...state, subagents: next }, permanent };
    }

    case 'parallel:status': {
      // Snapshot the latest figures for the footer's
      // `subagents R+Q/cap` and `tools R/cap` chips. The
      // event arrives every time the harness's running /
      // queued counts shift — we just overwrite the
      // previous snapshot. No permanent emission: the
      // footer is the only consumer.
      return {
        state: {
          ...state,
          parallelStatus: {
            subagentsRunning: event.subagentsRunning,
            subagentsQueued: event.subagentsQueued,
            subagentsCap: event.subagentsCap,
            toolsRunning: event.toolsRunning,
            toolsCap: event.toolsCap,
          },
        },
        permanent: [],
      };
    }

    default: {
      // Exhaustiveness guard: TypeScript marks `event` as `never` here
      // when every case is handled. If a new UIEvent kind is added and
      // not wired, this throws at runtime — failing fast beats silent
      // drops for new producer events.
      const _exhaustive: never = event;
      void _exhaustive;
      throw new Error(`applyEvent: unhandled event type ${(event as { type: string }).type}`);
    }
  }
};

// Public reducer. Wraps the inner switch with the
// `pendingToolEndBatch` flush lifecycle (slice 3):
//
//   - `tool:end` events: handled directly by the inner switch,
//     which extends the buffer or starts a new one. NEVER auto-
//     flushes here — that would defeat the coalescing.
//   - Any other event whose inner result emits permanent items:
//     flush the pending batch FIRST, then prepend the flushed
//     items to the inner's permanent. This preserves scrollback
//     order — the batch (e.g., 3 reads) chronologically completed
//     before whatever scrollback-emitting event fired next.
//   - Events that emit no permanent items (status updates,
//     deltas, heartbeats, parallel:status, cost_update wrapped
//     in subagent_progress that doesn't rise to permanent):
//     buffer holds across them. This is the load-bearing
//     invariant: a parallel batch of reads can interleave with
//     subagent:update heartbeats and still coalesce correctly.
//
// INVARIANT — DO NOT VIOLATE:
//   No reducer case other than `tool:end` may read or mutate
//   `state.pendingToolEndBatch`. The wrapper's "flush only when
//   inner produced permanent items" rule depends on the buffer
//   being unchanged across non-tool:end inner calls. A new case
//   that touches the buffer would either double-flush (if it
//   also flushed internally) or silently skip a flush (if it
//   extended the buffer but emitted no permanent items, the
//   wrapper would assume "nothing happened" and the next non-
//   tool:end emitter would flush stale entries with the wrong
//   chronology). Add buffer manipulation to `tool:end` only;
//   for everything else, treat the field as opaque.
export const applyEvent = (state: LiveState, event: UIEvent): ApplyResult => {
  const inner = applyEventInner(state, event);
  if (event.type === 'tool:end') return inner;
  if (inner.permanent.length === 0) return inner;
  const flushed = flushPendingToolEndBatch(inner.state);
  return {
    state: flushed.state,
    permanent: [...flushed.permanent, ...inner.permanent],
  };
};
