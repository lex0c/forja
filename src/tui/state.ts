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

import type { FileDiff } from '../diff/line-diff.ts';
import type { ForjaEffort } from '../harness/effort.ts';
import type { ApprovalPosture } from '../permissions/index.ts';
import { sanitizeOneLineForDisplay } from '../sanitize/ansi.ts';
import type { SessionBannerEnvEntry, TodoItemForUI, UIEvent } from './events.ts';
import {
  MEMORY_WRITE_DEFAULT_SELECTED_INDEX,
  PERMISSION_DEFAULT_SELECTED_INDEX,
  buildPermissionOptions,
} from './modal-manager.ts';

export interface InputState {
  // Current value of the input box (multi-line allowed via `\n`).
  value: string;
  // Cursor position, in JS code units within `value`. UTF-16 surrogate
  // pairs are treated as two positions; renderers that care about
  // grapheme clusters can re-derive from `value`.
  cursor: number;
}

// Threshold below which a pending tool-end batch flushes as
// individual chips (a lone tool-end has nothing to coalesce with).
// At/above the threshold, the batch flushes as a single
// `tool-end-batch` PermanentItem. Tuned to 2: two consecutive
// same-tool runs already pay for the summary — one head + two
// `├─`/`└─` subject rows (3 lines) replaces two gap-separated
// chips (blank + head + `└─` each = 6 lines), and the operator
// reads "Read 2 files" instead of two near-identical chips.
export const TOOL_BATCH_COALESCE_THRESHOLD = 2;

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
  outputTruncated?: boolean;
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
  // Whether the tool body has actually started running. False between
  // `tool:start` (card created before the permission engine) and
  // `tool:execution-started` (fires after approval + hooks). While
  // false the tool is parked at the permission modal — the renderer
  // shows an "awaiting approval" head with no elapsed timer instead of
  // the misleading "Executing… [Ns]" that counts human think-time as
  // runtime. Optional so pre-existing ActiveTool fixtures stay valid;
  // the renderer treats only an explicit `false` as the awaiting state
  // (undefined → behaves as executing, the legacy default).
  executing?: boolean;
  // Last few lines of streaming output. Capped so a tool that emits
  // a megabyte of stdout doesn't bloat the live region — the full
  // content goes through the scrollback as `tool:delta` permanent
  // lines.
  preview: string[];
}

export interface StatusState {
  sessionId: string | null;
  project: string | null;
  model: string | null;
  // Active isolation profile (`--profile`/FORJA_PROFILE), or null on the
  // default namespace. Seeded by session:banner; drives the footer chip.
  profile: string | null;
  steps: number;
  maxSteps: number;
  // Current-turn spend (this harness session only). Reset to 0 at each
  // session:end after it folds into `sessionTotalCostUsd`. Driven by
  // step:budget — internal accumulator now; the footer renders the
  // REPL-cumulative field below.
  costUsd: number;
  // REPL-cumulative spend across every turn. Mirrors
  // `sessionTotalTokens`: REPL-scoped (does NOT reset on session:start),
  // accumulated at the turn boundary (session:end). The footer's `$X.XX`
  // chip reads THIS so cost and the token count both summarize the whole
  // REPL run rather than disagreeing (tokens cumulative, cost per-turn).
  sessionTotalCostUsd: number;
  // null = no cap configured. Renderer shows steps/cost without budget
  // shading when cap absent.
  maxCostUsd: number | null;
  // Approval posture (Supervised / Autonomous) shown in the footer in
  // place of the help cue. Default 'supervised' on createInitialState;
  // seeded by `session:start.operationMode`, flipped at runtime by
  // `mode:change`. The permission engine is the source of truth — this
  // is the rendered mirror.
  operationMode: ApprovalPosture;
  // Whether relay mode is on (serving mesh peers). Mirrors
  // meshManager.isServing(), flipped by `relay:change`; drives the footer badge.
  relayMode: boolean;
  // Alias shown in the relay badge when serving (null when off). Mirrors the
  // manager's alias via `relay:change`.
  relayAlias: string | null;
  // Effort level shown in the footer's right cluster. Seeded by
  // `session:banner.effort` (config/DEFAULT_EFFORT at boot), updated by
  // `effort:change` when the operator runs `/effort`. null = not yet
  // known (pre-banner) → no chip rendered.
  effort: ForjaEffort | null;
  // Distinct-name memory count for the footer's `mem N` segment.
  // Snapshot at session:start; mid-session
  // memory_write success could bump the count, but we keep the
  // value boot-fresh for now (operators don't expect the footer to
  // animate per-memory-write — too much noise for too little
  // signal). 0 == no segment rendered.
  memoryCount: number;
  // Source: session:banner. Persists across session:start boundaries
  // (each REPL submit is its own harness session, but the operator
  // sees the REPL as one).
  contextWindow: number;
  // REPL-scoped (does NOT reset on session:start) so the chip
  // accumulates across the operator's whole REPL run. GRAND total —
  // input + output + cache_read + cache_creation. The footer renders
  // the non-cache part (`sessionTotalTokens - sessionCacheTokens`)
  // beside a dedicated cache chip, so the two displayed numbers are
  // disjoint and sum back to this.
  sessionTotalTokens: number;
  // REPL-scoped cumulative cache tokens (cache_read + cache_creation).
  // Split out from sessionTotalTokens for its own `N cached` footer
  // chip: cache is provider-reported and billed, but at a fraction of
  // the input rate, so the operator wants it distinguishable from real
  // compute (input + output).
  sessionCacheTokens: number;
  // inputTokens + cacheRead + cacheCreation of the latest turn —
  // what occupied the context window when the model generated.
  lastTurnContextTokens: number;
  // True between a compaction (compacting:start) and the next assistant:end.
  // The compaction shrank the live context but lastTurnContextTokens still
  // reflects the pre-compaction turn, so the footer suppresses the % until a
  // real turn re-measures it from provider usage — we never show a stale or
  // estimated number.
  contextStale: boolean;
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
// string union per flavor; permission uses 'yes' | 'no'. Cancel
// (Esc) is NOT a regular option — it returns 'cancel' distinct from
// 'no' so audit can tell explicit rejection from "user closed the
// modal without deciding".
//
// `shortcut` is an optional secondary key (named chord like
// 'shift+tab'). Renderer shows it in parens after the label.
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
// A plain string renders dim; `{ text, tone }` renders the whole line in
// one tone; `{ verb, text }` renders a BOLD verb followed by a dim subject
// on one line (e.g. the permission modal's `fetch <url>` action — only the
// verb is emphasized, the url stays dim).
export type PreviewLine =
  | string
  | { text: string; tone: 'secondary' | 'bold' }
  | { verb: string; text: string };

export interface ConfirmState {
  // ID assigned by the producer; threaded through `permission:ask` and
  // matched by `modal:answer` to resolve the right promise.
  promptId: string;
  // Flavor lets the renderer pick layout details and the reducer
  // route to the right answer shape. All confirm-shaped modals
  // (permission, trust, memory write) share
  // this single state field — only one modal visible at a time.
  flavor:
    | 'permission'
    | 'trust'
    | 'shared-trust'
    | 'mcp-trust'
    | 'memory-write'
    | 'memory-user-scope'
    | 'memory-action'
    | 'history-clear'
    | 'resume-mode'
    | 'clarify'
    | 'relay-start';
  // Title block: bold first line + dim subject. `subject` is
  // optional — null when the modal has no single target.
  title: string;
  subject: string | null;
  // Paint tone for the subject line. Defaults to `dim`; the
  // permission flavor sets `secondary` so its framing sentence lifts
  // out of the dim baseline (the action + cwd rows below stay dim).
  subjectTone?: 'dim' | 'secondary';
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
export type PermissionAnswer = 'yes' | 'no' | 'cancel';

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
  // Inline arg-hint ghost for an exactly-typed command (e.g.
  // ` [low|medium|high]` after `/effort`). Undefined when there's no
  // exact command match or it takes no args. The input renderer draws
  // it dim after the typed text, gated on the cursor being at line end.
  ghost?: string;
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
  // INBOX (docs/spec/INBOX.md §6 — in-memory by design). Messages the
  // operator committed while a turn/playbook was in flight, in FIFO
  // order, awaiting the next boundary to drain as one user turn.
  // Rendered as inverse bars above the typing zone (render/inbox.ts).
  // Appended by the `inbox:queued` reducer, cleared by `inbox:drained`.
  queued: QueuedInput[];
  // INBOX edit (§4.2): id of the queued message currently being edited
  // in the input (lifted via ↑), or null. The message STAYS in `queued`
  // — `editingId` only tells the renderer to hide its bar while it's in
  // the input, so an edit can never lose the message.
  editingId: string | null;
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
  // True iff the LAST item emitted to scrollback was a subagent block, so
  // a following `subagent:end` coalesces under the SAME `Subagent` title
  // (no repeat). Owned by the `applyEvent` wrapper: set on a subagent
  // block, cleared by any other scrollback emission (incl. a tool batch
  // flushing between two subagent completions). Renderer never reads it.
  subagentTitleShown: boolean;
  pendingAssistant: PendingAssistant | null;
  // `messageId` carried alongside `startedAt` so the thinking
  // chip can hash a stable per-turn seed when picking its
  // spinner verb (`render/spinner-verbs.ts`). The reducer copies
  // it from the `thinking:start` event; without it the chip
  // would have no per-turn identity to hash and would either
  // collapse to a single static verb or drift to a non-stable
  // seed (timestamp-based picks can change mid-turn under clock
  // skew or replay).
  // `text` accumulates the `thinking:delta` reasoning so `thinking:end` can
  // flush it to scrollback (the chip reads only startedAt/messageId; ignores it).
  thinking: { startedAt: number; messageId: string; text: string } | null;
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
  // "Compacting context…" indicator. Set by `compacting:start` (from /compact, or
  // the adapter on the loop's auto compaction), cleared by `compacting:end`.
  // Rendered by compose.ts's chip-slot at LOWEST priority — a compaction
  // runs only between steps / with no turn, so the turn chips are null when
  // it shows, and a stray one never masks live work. Like awaitingProvider
  // it carries only `startedAt`, for the elapsed timer.
  compacting: { startedAt: number } | null;
  // Id of the assistant message driving the current turn, or null
  // between turns. Set by whichever of `thinking:start` /
  // `assistant:start` opens the turn and held through the tool
  // phase that follows (`pendingAssistant` and `thinking` both
  // clear before tools run, so they can't seed a chip there). The
  // tool-phase chip (`render/tool-phase-chip.ts`) hashes this into
  // its orchestration verb so the top-slot verb stays stable while
  // tool cards run beneath it — same per-turn-stable / per-pool-
  // independent contract the thinking and output chips use. Cleared
  // at session boundaries so a stale id from a crashed run can't
  // seed the next session's first tool phase.
  currentTurnId: string | null;
  // Mirror of the REPL's `isBusy()` (foreground turn OR playbook OR an
  // operator `!cmd` in flight), pushed via `busy:change`. The render
  // layer can't call `isBusy()` (it lives in the REPL), and two of its
  // inputs have no other LiveState reflection — so this is the single
  // signal the bash-mode gate (`render/mode.ts`) keys off to match the
  // submit gate. NOT touched by session boundaries (it tracks the REPL,
  // not a turn).
  busy: boolean;
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
      // The child's IN-FLIGHT tool as a compact `read engine.ts`
      // label — rendered on the live row's line 2. Empty before the
      // first tool and after each tool finishes (cleared on toolDone).
      currentTool: string;
      // Per-tool-type invocation counts, accumulated as the child
      // works (the child's tools no longer stream to scrollback live —
      // they collapse into the grouped, aggregated trail on end).
      // Insertion order preserved so the trail is stable across ticks.
      toolCounts: Map<string, number>;
      // Total tool invocations (the `N tools` figure in the summary).
      toolTotal: number;
    }
  >;
  // Pending reminders scheduled this session (ORCHESTRATION.md §3B.9).
  // A plain count, not a Map: the footer chip only needs the size, and
  // the ReminderScheduler is the source of truth — every set/cancel/fire/
  // cleanup pushes the new count via `reminders:update`. Like
  // `bgProcesses` it survives the turn boundary (reminders are
  // session-scoped); a fresh PROCESS starts from 0.
  reminderCount: number;
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

// A single queued inbox message (INBOX §6). `id` is a per-session
// monotonic tag minted by the REPL — used to target a message for
// in-place editing (↑ lifts it back into the input).
export interface QueuedInput {
  id: string;
  text: string;
}

// True when something in the live region is animating and the frame
// scheduler must keep redrawing: a running tool's spinner, the thinking /
// awaiting-provider / compacting duration counters, a streaming assistant
// chip — or a task marked in_progress, whose `Tasks` header carries the
// live-verb shimmer (render/todo-list.ts). Goes false (scheduler idles,
// zero wakeups) once none of those hold. The renderer's heartbeat polls
// this each tick. MISS one and that chip renders once then freezes — no
// spinner motion, no ticking [elapsed] — until the next unrelated redraw.
export const liveRegionActive = (state: LiveState): boolean =>
  state.activeTools.size > 0 ||
  state.thinking !== null ||
  state.pendingAssistant !== null ||
  state.awaitingProvider !== null ||
  state.compacting !== null ||
  // Gated on `!state.ended`: todos persist across the turn boundary (neither
  // session:start nor session:end clears them — they mirror the last
  // todo:update), so a turn that stops with a task still in_progress (notably
  // an abnormal cut like maxCostUsd) would otherwise keep this true forever,
  // pinning the heartbeat awake and animating the `Tasks` shimmer against a
  // dead turn. Once ended, the frozen in_progress status no longer drives the
  // live region. renderTodoList applies the same `!ended` gate to the header
  // so the two never disagree (heartbeat idle + header wanting to shimmer =
  // a frozen highlighted char).
  (!state.ended && state.todos.some((t) => t.status === 'in_progress')) ||
  // A running subagent keeps the heartbeat awake so its row's spinner
  // animates and the [elapsed]/cost tick. Gated on `!ended` like todos:
  // an abnormal cut that leaves a row un-collapsed must not pin the
  // heartbeat forever (subagent:end normally removes the row first).
  (!state.ended && state.subagents.size > 0);

export const createInitialState = (): LiveState => ({
  input: { value: '', cursor: 0 },
  queued: [],
  editingId: null,
  status: {
    sessionId: null,
    project: null,
    model: null,
    profile: null,
    steps: 0,
    maxSteps: 0,
    costUsd: 0,
    sessionTotalCostUsd: 0,
    maxCostUsd: null,
    operationMode: 'supervised',
    relayMode: false,
    relayAlias: null,
    effort: null,
    memoryCount: 0,
    contextWindow: 0,
    sessionTotalTokens: 0,
    sessionCacheTokens: 0,
    lastTurnContextTokens: 0,
    contextStale: false,
  },
  activeTools: new Map(),
  pendingToolEndBatch: null,
  subagentTitleShown: false,
  pendingAssistant: null,
  thinking: null,
  awaitingProvider: null,
  compacting: null,
  currentTurnId: null,
  busy: false,
  modal: null,
  slash: null,
  reverseSearch: null,
  todos: [],
  bgProcesses: new Map(),
  subagents: new Map(),
  reminderCount: 0,
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
// Cap a reasoning block before it lands in scrollback. Extended-thinking turns
// emit thousands of tokens; persisting all of it would bury the conversation in
// grey. Keep a useful head and mark the rest. Char-based (not line-based) so a
// single long paragraph is bounded too. Tunable.
const REASONING_MAX_CHARS = 1500;
export const capReasoning = (text: string): string => {
  if (text.length <= REASONING_MAX_CHARS) return text;
  let head = text.slice(0, REASONING_MAX_CHARS);
  // Don't cut through a surrogate pair: a lone high surrogate at the boundary
  // would render as U+FFFD (replacement char). Drop it so the head ends on a
  // whole code point.
  const lastUnit = head.charCodeAt(head.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) head = head.slice(0, -1);
  return `${head.trimEnd()}\n… (reasoning truncated)`;
};

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
      // Active isolation profile, or null/absent on the default namespace.
      // Renders a boot-banner line so a dev/test run is obvious at a glance.
      profile?: string | null;
      // Initial effort level (config/DEFAULT_EFFORT at boot). Rendered on the
      // banner's identity line beside the model; optional so non-CLI emitters
      // that omit it still produce a valid banner.
      effort?: ForjaEffort;
      contextWindow: number;
      maxOutputTokens: number;
      cwd: string;
      // Operator home dir for the banner's `$HOME → ~` cwd collapse (display
      // only; `cwd` stays raw). Optional — absent skips the collapse.
      home?: string;
      // Mirror of SessionBannerEvent.env (UI.md §4.10.9). Renderer
      // discriminates on `kind` to pick the right palette per entry.
      env: SessionBannerEnvEntry[];
      // Set when broker resolved to spawn mode + sandbox tool
      // present. Renderer appends a secondary line inside the banner
      // block ("✓ sandbox enforcement active (bwrap)"). The
      // non-active states ride warn/error events outside the banner.
      sandboxActive?: 'bwrap' | 'sandbox-exec';
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
      // True when the tool capped its own output — renderer adds a
      // `… output truncated` line under the card.
      outputTruncated?: boolean;
      // Display diff (write/edit) — renderer shows +N/−M on the head and
      // a bounded colored snippet under the card. Display-only.
      diff?: FileDiff;
      // Non-zero exit code of a command tool (bash). Renderer shows
      // `exit N` on the head so a failed command reads as a failure.
      exitCode?: number;
    }
  | {
      // Coalesced batch of N consecutive same-name + same-parentId
      // tool-end items, emitted by the reducer when the pending
      // batch flushes with `count >= TOOL_BATCH_COALESCE_THRESHOLD`.
      // Reads as a single card "Read 3 files  [0.6s]" with the N
      // subjects as a `├─`/`└─` tree underneath.
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
      // True when ANY child in the batch capped its output — the
      // renderer adds one `… output truncated` line for the group.
      outputTruncated?: boolean;
    }
  | { kind: 'error'; message: string }
  | { kind: 'warn'; message: string }
  | { kind: 'info'; message: string; tone?: 'plain' | 'secondary'; header?: string }
  | {
      kind: 'operator-bash';
      command: string;
      output: string;
      exitCode: number;
      durationMs: number;
    }
  | { kind: 'recap-terse'; message: string }
  // Extended-thinking / reasoning block flushed at `thinking:end`. Rendered as
  // a bold `reasoning:` label over a secondary-toned body (the model's scratch
  // work, not the answer). `text` is already capped at flush.
  | { kind: 'reasoning'; text: string }
  | {
      // `Subagent` group title — emitted by the `applyEvent` wrapper
      // before the FIRST subagent block of a consecutive run, so a burst
      // of finishing subagents reads as one titled group in scrollback
      // (mirrors how coalesced tools share a head). Renders as a single
      // col-0 plain line.
      kind: 'subagent_group_header';
      ts: number;
    }
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
      // Per-tool-type invocation counts (insertion order), rendered as
      // the grouped, aggregated trail under the summary header
      // (`├ read 38 files`). Empty array → header-only block.
      toolCounts: ReadonlyArray<readonly [string, number]>;
      // Total tool invocations across the run (the `N tools` figure).
      toolTotal: number;
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
    case 'git_apply_patch':
      return `Applied ${count} patches`;
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
      ...(it.outputTruncated === true ? { outputTruncated: true } : {}),
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
    ...(batch.items.some((it) => it.outputTruncated === true) ? { outputTruncated: true } : {}),
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
    case 'mode:change':
      // Mirror the engine's new approval posture into status so the
      // footer repaints. No scrollback line — the footer cue is the
      // whole signal (UI.md §4.10.6).
      return {
        state: { ...state, status: { ...state.status, operationMode: event.posture } },
        permanent: [],
      };

    case 'relay:change':
      // Mirror relay on/off (+ alias) into status so the footer badge repaints.
      return {
        state: {
          ...state,
          status: { ...state.status, relayMode: event.active, relayAlias: event.alias },
        },
        permanent: [],
      };
    case 'effort:change':
      // Mirror the operator's new effort selection into status so the
      // footer chip repaints at once. No scrollback line — the slash
      // command already emits its own confirmation notes.
      return {
        state: { ...state, status: { ...state.status, effort: event.effort } },
        permanent: [],
      };
    case 'stats:refresh':
      // DB-derived usage totals (cost/tokens/cache) for the footer. The
      // REPL recomputes these over its session tree per model response
      // (each usage_persisted), at turn boundaries, and on boot/resume,
      // then emits this so we SET (not accumulate) —
      // single source of truth is the persisted DB, so the chips are
      // tree-wide (incl. subagents) and resume-correct. SET overrides any
      // stale value; no scrollback.
      return {
        state: {
          ...state,
          status: {
            ...state.status,
            sessionTotalCostUsd: event.costUsd,
            sessionTotalTokens: event.totalTokens,
            sessionCacheTokens: event.cacheTokens,
          },
        },
        permanent: [],
      };
    case 'session:start': {
      const status: StatusState = {
        ...state.status,
        sessionId: event.sessionId,
        project: event.project,
        model: event.model,
        memoryCount: event.memoryCount ?? 0,
        // operationMode is intentionally NOT touched here: it's seeded
        // at boot by session:banner and flipped by mode:change. A bare
        // session:start (each REPL submit) must preserve it via the
        // `...state.status` spread, never reset it.
      };
      // Boundary cleanup: soft-interrupt state is per-session and
      // resets. bg processes are NOT reset here — bash_background now
      // keeps them alive across turn boundaries (ORCHESTRATION §3B.1),
      // so zeroing the renderer map every new turn would drop the
      // `bash bg` chip for processes still running (the exact regression
      // this comment used to predict under "--keep-bg" — it landed). The
      // map carries across turns; `bg:end` removes each process on
      // settle; a fresh PROCESS (resume) starts from createInitialState's
      // empty map. Subagents DO reset — they're within-turn (drained at
      // turn end), so a fresh turn legitimately starts with none.
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
          // bgProcesses intentionally NOT reset (see boundary comment
          // above) — bash_background processes survive the turn.
          subagents: new Map(),
          // Reset the scrollback title-run flag at the turn boundary: a new
          // turn's first subagent burst must re-show the `● Subagents`
          // title even if the prior turn ended on a subagent block (the
          // boundary itself emits no permanent, so the wrapper can't clear
          // it for us). Mirrors the pendingToolEndBatch drop below.
          subagentTitleShown: false,
          parallelStatus: null,
          // Per-session: a stale "Awaiting model" indicator from a
          // crashed prior run (e.g., resume after parent crash mid-
          // step) shouldn't carry into a fresh turn.
          awaitingProvider: null,
          compacting: null,
          // Same per-session rationale: a stale turn id from a
          // crashed prior run must not seed the new session's first
          // tool-phase verb.
          currentTurnId: null,
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
      // bg processes are NOT zeroed here anymore: the old "zombie tray"
      // rationale (cleanup() killing every process at turn end, so the
      // counter had to be cleared before the late bg:end events landed)
      // no longer holds — bash_background processes survive the turn
      // (ORCHESTRATION §3B.1) and cleanup() runs only at session exit.
      // Zeroing here would hide processes that are still alive.
      //
      // The footer's cumulative cost/token/cache totals are NOT folded
      // here anymore — they are DB-derived and pushed via `stats:refresh`
      // (the REPL recomputes over its session tree at the turn boundary,
      // which is tree-wide incl. subagents and resume-correct). This
      // boundary only does the soft-interrupt / bg / subagent cleanup.
      return {
        state: {
          ...flushed.state,
          softInterrupted: false,
          // Same boundary reset rationale as session:start (above).
          exitArmed: null,
          // bgProcesses intentionally NOT reset — processes survive the
          // turn (see the boundary comment above).
          subagents: new Map(),
          parallelStatus: null,
          // Same rationale as session:start: a session ending mid-
          // step (abort, error) shouldn't leave the indicator armed
          // — the footer would then show "Awaiting model" against a
          // run that's already terminated.
          awaitingProvider: null,
          compacting: null,
          // Boundary cleanup: see session:start.
          currentTurnId: null,
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
      // Banner is the earliest carrier of provider capabilities; mirror
      // model + contextWindow onto status so the footer renders during
      // the idle window between boot and first user submit.
      return {
        state: {
          ...state,
          status: {
            ...state.status,
            model: event.model,
            profile: event.profile ?? state.status.profile,
            contextWindow: event.contextWindow,
            operationMode: event.operationMode ?? state.status.operationMode,
            effort: event.effort ?? state.status.effort,
          },
        },
        permanent: [
          {
            kind: 'session-banner',
            app: event.app,
            version: event.version,
            model: event.model,
            ...(event.profile !== undefined ? { profile: event.profile } : {}),
            ...(event.effort !== undefined ? { effort: event.effort } : {}),
            contextWindow: event.contextWindow,
            maxOutputTokens: event.maxOutputTokens,
            cwd: event.cwd,
            ...(event.home !== undefined ? { home: event.home } : {}),
            env: event.env,
            ...(event.sandboxActive !== undefined ? { sandboxActive: event.sandboxActive } : {}),
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

    case 'inbox:queued':
      // Append to the FIFO queue AND clear the input (the operator hit
      // Enter — their draft became the queued item, so the buffer
      // should reset for the next message, exactly like user:submit).
      // No scrollback yet — the bar lives in the live region until drain.
      return {
        state: {
          ...state,
          queued: [...state.queued, { id: event.id, text: event.text }],
          input: { value: '', cursor: 0 },
        },
        permanent: [],
      };

    case 'inbox:drained':
      // Boundary reached: freeze each drained message into its own
      // user-submit scrollback bar (visual continuity with the pending
      // stack). The message being edited (if any) is NOT drained — it
      // stays queued (`q.id === editingId`) for the next boundary, so the
      // operator isn't cut off mid-edit. Input is left UNTOUCHED — a
      // draft typed after the last enqueue must survive the drain.
      return {
        state: { ...state, queued: state.queued.filter((q) => q.id === state.editingId) },
        permanent: event.texts.map((text) => ({ kind: 'user-submit', text })),
      };

    case 'inbox:edit-start':
      // Mark the message as being edited; it STAYS in the queue (never
      // lost) — the renderer hides its bar via `editingId` while it sits
      // in the input. Input is set separately by the REPL.
      return {
        state: { ...state, editingId: event.id },
        permanent: [],
      };

    case 'inbox:edit-commit':
      // Write the edited text in place, keeping the message's FIFO
      // position, and end the edit (its bar reappears with the new text).
      return {
        state: {
          ...state,
          queued: state.queued.map((q) => (q.id === event.id ? { ...q, text: event.text } : q)),
          editingId: null,
        },
        permanent: [],
      };

    case 'inbox:remove':
      // Drop the queued message entirely (INBOX §4.3). Terminal: unlike
      // edit-cancel (which restores the message unchanged), the message
      // leaves the queue for good — it never drains. editingId clears
      // with it (the message had to be lifted for editing to be removed).
      return {
        state: {
          ...state,
          queued: state.queued.filter((q) => q.id !== event.id),
          editingId: null,
        },
        permanent: [],
      };

    case 'inbox:edit-cancel':
      // End the edit with the message unchanged (its bar reappears).
      return {
        state: { ...state, editingId: null },
        permanent: [],
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
          // Anchor the turn seed. `assistant:start` may fire after
          // `thinking:start` in the same turn (same messageId), so
          // this is a harmless re-set; on a no-thinking turn it's
          // the first anchor. Held through the tool phase for the
          // tool-phase chip's verb.
          currentTurnId: event.messageId,
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
      // Read the buffer's final usage snapshot (Anthropic streams
      // cumulative counts). The REPL-cumulative token/cache totals are
      // NOT folded here anymore — they're DB-derived via `stats:refresh`.
      // We still derive `lastTurnContextTokens` (input + cache) for the
      // context-occupancy field, which is a per-turn snapshot, not a
      // running total.
      const input = buf?.inputTokens ?? 0;
      const cacheRead = buf?.cacheRead ?? 0;
      const cacheCreation = buf?.cacheCreation ?? 0;
      const turnContext = input + cacheRead + cacheCreation;
      const status: StatusState = {
        ...state.status,
        // Fallback to the prior value when the turn yielded no usage
        // event (provider edge case) so the chip doesn't flicker to 0%.
        lastTurnContextTokens: turnContext > 0 ? turnContext : state.status.lastTurnContextTokens,
        // A turn WITH usage re-measured the context from provider truth → clear
        // post-compaction staleness so the footer % shows again. A turn without
        // usage gave no fresh measurement, so keep it suppressed if it was stale.
        contextStale: turnContext > 0 ? false : state.status.contextStale,
      };
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
      return { state: { ...state, status, pendingAssistant: null }, permanent };
    }

    case 'thinking:start':
      // Clear `awaitingProvider` — extended thinking started
      // streaming, the more specific indicator takes the slot.
      return {
        state: {
          ...state,
          awaitingProvider: null,
          // Anchor the turn seed at the earliest signal of the turn
          // (thinking precedes any text). `assistant:start` re-sets
          // it to the same messageId later — see that case.
          currentTurnId: event.messageId,
          thinking: { startedAt: event.ts, messageId: event.messageId, text: '' },
        },
        permanent: [],
      };

    case 'thinking:delta':
      // Accumulate the reasoning text so `thinking:end` can flush it to
      // scrollback. Duration is still computed at render time from `startedAt`.
      return {
        state: state.thinking
          ? {
              ...state,
              // `event.text` is optional on the event contract (omitted for
              // headless replay deltas). `?? ''` so a textless delta doesn't
              // concatenate the literal string "undefined" into the buffer.
              thinking: { ...state.thinking, text: state.thinking.text + (event.text ?? '') },
            }
          : state,
        permanent: [],
      };

    case 'thinking:end': {
      // Flush the accumulated reasoning as a scrollback `reasoning` block (bold
      // label + secondary body), then clear the live indicator. Capped so an
      // extended-thinking turn doesn't bury the conversation in grey text.
      // Trim BEFORE capping: the guard already keys off `.trim()`, and capping
      // the untrimmed text would persist leading/trailing blank lines that
      // render as empty grey rows in the `reasoning:` block.
      const reasoning = (state.thinking?.text ?? '').trim();
      const permanent: PermanentItem[] =
        reasoning.length > 0 ? [{ kind: 'reasoning', text: capReasoning(reasoning) }] : [];
      return { state: { ...state, thinking: null }, permanent };
    }

    case 'tool:start': {
      const tool: ActiveTool = {
        toolId: event.toolId,
        name: event.name,
        activeVerb: event.activeVerb,
        finalVerb: event.finalVerb,
        subject: event.subject,
        ...(event.parentId !== undefined ? { parentId: event.parentId } : {}),
        startedAt: event.ts,
        // Not running yet — the card is created here, BEFORE the
        // permission engine. It sits at "awaiting approval" until
        // `tool:execution-started` flips this true after the modal +
        // hooks. On the auto-allow path that follow-up event arrives
        // within the same tick, so the awaiting head never visibly
        // renders for non-gated calls.
        executing: false,
        preview: [],
      };
      const next = cloneTools(state.activeTools);
      next.set(event.toolId, tool);
      return { state: { ...state, activeTools: next }, permanent: [] };
    }

    case 'tool:execution-started': {
      // Rebase the tool's clock to when its body actually started —
      // execution begins after the permission engine, the modal, and
      // PreToolUse hooks. Without this the live card's `[Xs]` would
      // count the human wait at the permission modal. Flipping
      // `executing` true also swaps the card head from "Awaiting
      // approval" (no timer) to the active verb + elapsed counter.
      const tool = state.activeTools.get(event.toolId);
      if (tool === undefined) return { state, permanent: [] };
      const next = cloneTools(state.activeTools);
      next.set(event.toolId, { ...tool, startedAt: event.ts, executing: true });
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
      // A non-zero exit code joins the non-`done` bypass: the command
      // ran fine as a tool call but failed on its own terms, so it
      // must not vanish into a coalesced "Executed N commands" batch.
      // A tool carrying a display diff (write/edit) bypasses batching
      // too: its per-file diff is rich detail a coalesced "Edited N
      // files" chip can't show, so it gets its own card. A done chip
      // carrying a `summary` (a tool's one-line `result_detail`, e.g.
      // clarify's question→answer) bypasses for the same reason — the
      // coalesced "Called N" head has nowhere to show it.
      if (
        event.status !== 'done' ||
        event.exitCode !== undefined ||
        event.diff !== undefined ||
        event.summary !== undefined
      ) {
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
          ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
          ...(event.outputTruncated === true ? { outputTruncated: true } : {}),
          ...(event.diff !== undefined ? { diff: event.diff } : {}),
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
        ...(event.outputTruncated === true ? { outputTruncated: true } : {}),
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

    case 'compacting:start': {
      // Open the "Compacting context…" chip. Idempotent: a re-emit just refreshes
      // startedAt. /compact and the auto path both bracket with :end, so this
      // never lingers past the compaction. The context is NOT marked stale here —
      // we don't yet know whether the compaction will change anything (a 'skipped'
      // no-op must not suppress the footer); compacting:end decides.
      return { state: { ...state, compacting: { startedAt: event.ts } }, permanent: [] };
    }

    case 'compacting:end': {
      // Stray / duplicate end (nothing open): no-op. Guards against an orphan
      // event — e.g. a session boundary cleared `compacting` between start and
      // end — arming contextStale via contextChanged when no compaction ran.
      if (state.compacting === null) return { state, permanent: [] };
      // Close the chip. Mark the context stale ONLY when the compaction actually
      // changed it (contextChanged) — a no-op 'skipped' / "nothing to compact"
      // leaves lastTurnContextTokens accurate, so the footer % keeps showing.
      // When stale, it's cleared later by the next assistant:end that re-measures
      // from provider usage (never here, never by a later skipped compaction).
      const status = event.contextChanged ? { ...state.status, contextStale: true } : state.status;
      return { state: { ...state, status, compacting: null }, permanent: [] };
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
          slash: empty
            ? null
            : {
                suggestions: event.suggestions,
                selectedIdx: event.selectedIdx,
                ...(event.ghost !== undefined ? { ghost: event.ghost } : {}),
              },
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
      return {
        state,
        permanent: [
          {
            kind: 'info',
            message: event.message,
            ...(event.tone !== undefined ? { tone: event.tone } : {}),
            ...(event.header !== undefined ? { header: event.header } : {}),
          },
        ],
      };

    case 'operator-bash:done':
      // Operator `!cmd` result → scrollback card. No state change; the
      // applyEvent wrapper flushes any pending tool-end batch first
      // (ordering stays correct).
      return {
        state,
        permanent: [
          {
            kind: 'operator-bash',
            command: event.command,
            output: event.output,
            exitCode: event.exitCode,
            durationMs: event.durationMs,
          },
        ],
      };

    case 'busy:change':
      return { state: { ...state, busy: event.busy }, permanent: [] };

    case 'recap:terse':
      return { state, permanent: [{ kind: 'recap-terse', message: event.message }] };

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
      //   3. Options + footer: Yes / No via buildPermissionOptions
      //      — same source the manager uses for selection clamping,
      //      so labels and count can't drift. Footer reserves
      //      "Tab to amend" and "Ctrl+E to explain" hints — handlers
      //      land in later slices; the hint reservation pre-flows
      //      the footer.
      const options = buildPermissionOptions();

      // Fixed generic title; the specific action lives in the
      // preview block below. Anti-spoof: only the agent's declared
      // `name` (from the agents/*.md frontmatter) reaches the suffix
      // — never a string the child generated.
      const titleStr =
        event.peer !== undefined
          ? `Permission required (peer: ${event.peer.alias})`
          : event.subagent !== undefined
            ? `Permission required (subagent: ${event.subagent.name})`
            : 'Permission required';

      const previewLines: PreviewLine[] = [];
      // Action block: a blank line, then the command verbatim (no
      // shell prefix). The 4-space lead (this stored line) + the
      // renderer's 2-space indent = 6 visible spaces. Rendered as a
      // plain `dim` line — the modal title stays the only bold one.
      previewLines.push('');
      if (event.toolName === 'fetch_url') {
        // For a network fetch the action (`event.command`) is the bare
        // URL — a `fetch` verb in bold makes the ask read as the action
        // it is ("fetch https://…"), not an opaque address. The verb is
        // the one emphasized token; the URL stays dim like other actions.
        previewLines.push({ verb: 'fetch', text: event.command });
      } else if (
        (event.toolName === 'mesh_send' || event.toolName === 'mesh_reply') &&
        event.reason !== undefined &&
        event.reason.length > 0
      ) {
        // For a mesh send/reply the vocab `command` is only the peer/target;
        // the PAYLOAD that crosses the trust boundary lives in `event.reason`
        // — the engine (mesh.egress/mesh.reply) builds a bounded, one-line,
        // control-stripped "to WHOM + WHAT leaves" excerpt there precisely
        // because the modal has no dedicated payload field. Render THAT as the
        // action so the operator reviews what is leaving, not just to whom (the
        // two-audiences review, MESH.md §7). Without it the send is blind.
        previewLines.push(`    ${event.reason}`);
      } else {
        previewLines.push(`    ${event.command}`);
      }

      // Source attribution — a `secondary` line sitting directly
      // under the action, at the same 4-space indent. Tells the
      // operator which policy rule (or none) gated this ask.
      if (event.rule !== undefined) {
        const layerLabel =
          event.layer === undefined
            ? ''
            : event.layer === 'default'
              ? ' (built-in default)'
              : ` (${event.layer} policy)`;
        previewLines.push({
          text: `    matched rule: ${event.rule}${layerLabel}`,
          tone: 'secondary',
        });
      } else if (event.layer !== undefined && event.layer !== 'default') {
        previewLines.push({
          text: `    no rule matched in ${event.layer} policy`,
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
            // Subject sits directly under the context-label title: a
            // single plain-language framing line for the ask.
            // (Reinstated after the redesign had dropped it — the
            // explicit framing reads better above the action block.)
            subject:
              event.peer !== undefined
                ? `A peer ('${event.peer.alias}') request led here — approve the action below only if you would run it yourself.`
                : 'The agent is requesting permission for the action below.',
            // Secondary tone lifts the framing line out of the dim
            // baseline (the action + cwd rows below stay dim).
            subjectTone: 'secondary',
            preview: previewLines,
            // Question sits directly above the option list as the
            // explicit decision prompt; the numbered Yes/No options
            // answer it. `event.reason` (the engine's payload framing)
            // is rendered as the action line for mesh tools above; for
            // other tools the action (`event.command`) already carries
            // the intent, so reason would only duplicate it.
            question: 'Approve this action?',
            options,
            // Per-flavor cursor default. Sourced from the same
            // constant the manager's drain() reads so cursor (this
            // reducer state) and Enter resolution (manager) stay
            // in sync — a flip in one without the other would
            // silently desync the modal.
            selectedIndex: PERMISSION_DEFAULT_SELECTED_INDEX,
            // Only `Esc to cancel` is wired up. The earlier slices
            // listed `Tab to amend` and `Ctrl+E to explain` here
            // hoping the handlers would land soon — but they
            // didn't, and on a permission modal those keys do
            // surprising things: Tab moves selection (default
            // modal behavior) and Ctrl+E has no branch. Promising
            // an action and silently changing the operator's
            // selected answer is a UX hazard on a security
            // surface. Restore the hint(s) when the handler lands.
            hints: ['Esc to cancel'],
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

    case 'clarify:ask': {
      // Clarify is a confirm flavor: one question + options. Title is
      // fixed ('Clarify'); why_it_matters rides the subject line; the
      // question sits above the options. Each option's `key` is the
      // generated safe hotkey from the event (the manager builds it, NOT
      // the model id — a named-key id like 'down'/'escape' would hijack
      // nav); enqueueConfirm holds the prefixed `value` used to resolve,
      // so the `value` here is display-only. selectedIndex starts at 0
      // (the skip default the tool also assumes); the manager's open-time
      // modal:select re-asserts the cursor so render + resolution agree.
      return {
        state: {
          ...state,
          modal: {
            promptId: event.promptId,
            flavor: 'clarify',
            title: 'Clarify',
            subject: event.why,
            subjectTone: 'secondary',
            preview: [],
            question: event.question,
            options: event.options.map((o) => ({ key: o.key, label: o.label, value: o.id })),
            selectedIndex: 0,
            hints: ['↑/↓ choose', 'Enter confirm', 'Esc skip'],
            queueDepth: 0,
          },
        },
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
          'A project instructions file (e.g. AGENTS.md) is present — its contents will be loaded into the agent’s context if you trust this folder. Review it first.',
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

    case 'relay-start:ask': {
      const options: ConfirmOption[] = [
        { key: '1', label: 'Yes, start serving', value: 'yes' },
        { key: '2', label: 'No, cancel', value: 'no' },
      ];
      return {
        state: {
          ...state,
          modal: {
            promptId: event.promptId,
            flavor: 'relay-start',
            title: 'Start relay mode?',
            subject: null,
            preview: [
              `This Forja will serve mesh peers as '${event.alias}'.`,
              '',
              'It opens a local Unix socket other Forja instances you run (same',
              'user) can send textual prompts to. Each arrives as an untrusted',
              'system turn under YOUR approval — a peer never edits or runs',
              'anything here directly (MESH.md §0).',
              '',
              'The session is NOT dedicated: you keep working normally; peer',
              'requests interleave as their own isolated turns.',
            ],
            question: null,
            // Last option is the conservative default (D65): Enter without
            // reading errs toward "No, cancel".
            options,
            selectedIndex: options.length - 1,
            hints: ['Enter to confirm', 'Esc to cancel'],
            queueDepth: 0,
          },
        },
        permanent: [],
      };
    }

    case 'shared-trust:ask': {
      // Trust modal for the `trust_revoked` detector (MEMORY.md
      // §6.5.2, §7.2 rule 8). Two modes share this flavor — see the
      // event type doc — and the prose adapts:
      //
      //   - 'first-visit': non-empty corpus, no prior trust row.
      //     The cwd-trust modal attested the directory; the shared
      //     bodies are still unattested. Confirm before they enter
      //     eager-load.
      //   - 'drift': stored hash diverged from current (usually
      //     after a `git pull` touched `.forja/memory/shared/`).
      //
      // Both modes share answer space: yes → re-stamp (after TOCTOU
      // recheck), no → bulk-invalidate, cancel → defer.
      const options: ConfirmOption[] = [
        {
          key: '1',
          label:
            event.mode === 'first-visit'
              ? 'Yes, I trust this shared corpus'
              : 'Yes, I trust the updated corpus',
          value: 'yes',
        },
        {
          key: '2',
          label: event.mode === 'first-visit' ? 'No, do not load' : 'No, revoke trust',
          value: 'no',
        },
      ];

      // SECURITY (P0/F1 hardening). Filenames flow from
      // disk-attacker-controlled readdirSync (an attacker with
      // commit access to `.forja/memory/shared/` can name a file
      // `\x1b[2J\x1b[Hfake.md` and repaint the entire modal). The
      // sanitizer strips ANSI escapes, collapses \r/\n/\t to single
      // spaces, and caps length. `event.path` is operator-derived
      // today (projectScopeRoots(repoRoot).shared), but sanitizing
      // it costs nothing and protects against a future call site
      // that threads attacker-influenced data into the path field.
      const safePath = sanitizeOneLineForDisplay(event.path);

      // Layout mirrors `trust:ask`: subject null, path on its own
      // preview row, prose explains the situation + consequences,
      // then a bounded inventory cap so a malicious corpus can't
      // explode the modal height. The cap is deliberately small —
      // operators with a large corpus should review the files
      // outside the modal (e.g., `ls .forja/memory/shared/`); the
      // modal's job is to flag THAT something changed and let the
      // operator make a deliberate yes/no, not to be the audit UI.
      const MAX_LIST = 8;
      const visible = event.corpusFiles.slice(0, MAX_LIST);
      const overflow = event.corpusFiles.length - visible.length;

      const previewLines: PreviewLine[] = [safePath, ''];
      if (event.mode === 'first-visit') {
        previewLines.push(
          'This project ships a shared memory corpus that you have not yet confirmed.',
          'These files load into model context on every session in this directory.',
          'Review the current contents below before confirming trust:',
        );
      } else {
        previewLines.push(
          'The shared memory corpus changed since you last confirmed trust.',
          'This commonly happens after a `git pull` that modifies, adds, or removes',
          'files under `.forja/memory/shared/`. Review the current contents below:',
        );
      }
      previewLines.push('');

      if (visible.length === 0) {
        // The corpus exists from a hash-mismatch standpoint but the
        // current listing is empty — every previously-trusted file
        // was removed. Surface the absence explicitly; otherwise the
        // operator sees blank space below "Review the current
        // contents below" and may misread it as "no diff".
        previewLines.push('(the corpus is currently empty)');
      } else {
        for (const f of visible) {
          // P0/F1: sanitize EACH filename. The byte count is from
          // lstatSync — a number, no injection surface.
          previewLines.push(`  ${sanitizeOneLineForDisplay(f.name)} — ${f.bytes} bytes`);
        }
        if (overflow > 0) {
          previewLines.push(`  …and ${overflow} more file${overflow === 1 ? '' : 's'} not shown`);
        }
      }
      previewLines.push('');
      if (event.mode === 'first-visit') {
        previewLines.push('If you trust: the corpus hash is recorded as your baseline.');
        previewLines.push('If you decline: every memory above is invalidated and stays off.');
        previewLines.push('  Recovery is NOT one-click: invalidated memories cannot');
        previewLines.push('  /memory restore (state machine forbids invalidated→active).');
        previewLines.push('  Manual fix: edit `.md` frontmatter (remove `state: invalidated`)');
        previewLines.push('  + re-add to MEMORY.md, then `/memory trust accept`.');
      } else {
        previewLines.push('If you trust this update: the new corpus hash will be stamped.');
        previewLines.push('If you revoke: every active shared memory is invalidated AND');
        previewLines.push('the corpus stays off until you re-curate.');
        previewLines.push('  Recovery is NOT one-click: invalidated memories cannot');
        previewLines.push('  /memory restore (state machine forbids invalidated→active).');
        previewLines.push('  Manual fix: edit `.md` frontmatter (remove `state: invalidated`)');
        previewLines.push('  + re-add to MEMORY.md, then `/memory trust accept`.');
      }
      return {
        state: {
          ...state,
          modal: {
            promptId: event.promptId,
            flavor: 'shared-trust',
            title:
              event.mode === 'first-visit'
                ? 'Shared memory trust (first visit):'
                : 'Shared memory trust:',
            subject: null,
            preview: previewLines,
            question: null,
            options,
            // D65: last option is the conservative default. Operator
            // hitting Enter without reading chooses "No, revoke" —
            // safer outcome for a corpus that just changed under
            // their feet (or that they haven't reviewed).
            selectedIndex: options.length - 1,
            hints: ['Enter to confirm', 'Esc to cancel'],
            queueDepth: 0,
          },
        },
        permanent: [],
      };
    }

    case 'mcp-trust:ask': {
      // MCP server manifest-trust modal (MCP.md §1.5). Trust authorizes TWO
      // things: spawning the server's `command` (arbitrary local code — the
      // real risk) and exposing its declared tools to the model. 'first-visit'
      // = never-seen manifest hash; 'drift' = a previously-trusted server whose
      // hash (tools or command) changed.
      const options: ConfirmOption[] = [
        {
          key: '1',
          label:
            event.mode === 'first-visit'
              ? 'Yes, I trust this server'
              : 'Yes, I trust the updated server',
          value: 'yes',
        },
        { key: '2', label: 'No, do not run it', value: 'no' },
      ];

      // SECURITY (mirrors the shared-trust P0/F1 hardening): server name,
      // command, and every tool name/description come from an UNTRUSTED server
      // manifest (or a config a hostile commit could edit). Sanitize each
      // before display so a `\x1b[2J\x1b[H…` payload can't repaint/forge the
      // modal.
      const safeServer = sanitizeOneLineForDisplay(event.server);
      const safeCommand = sanitizeOneLineForDisplay(event.command);

      // Sandbox posture (MCP.md §2.3) — the containment the operator authorizes.
      // The two unsandboxed states lead with a warning glyph (full host access).
      const sandboxLine =
        event.sandbox === 'sandboxed'
          ? 'sandbox: ON (cwd-rw, no network)'
          : event.sandbox === 'sandboxed-net'
            ? '⚠ sandbox: ON + network egress (allowlist advisory — NOT host-filtered)'
            : event.sandbox === 'opt-out'
              ? '⚠ sandbox: OFF (operator opt-out) — full host access'
              : event.sandbox === 'remote'
                ? '⚠ remote endpoint — network egress, no sandbox (every call is confirmed)'
                : '⚠ sandbox: OFF (no sandbox tool available) — full host access';

      const previewLines: PreviewLine[] = [`server:  ${safeServer}`, `command: ${safeCommand}`];
      // The explicit cwd (writable root / relative-binary base) and the env
      // bindings each get their OWN line — the `command` above is length-capped, so
      // folding these in would let a hostile config pad the argv to push an injected
      // `LD_PRELOAD` / `NODE_OPTIONS` past the cutoff and hide it. Each is sanitized
      // independently; env shows the UNRESOLVED `$VAR` binding, never the resolved
      // value, and leads with ⚠ (it injects code into the spawned process).
      if (event.cwd !== undefined) {
        previewLines.push(`cwd:     ${sanitizeOneLineForDisplay(event.cwd)}`);
      }
      if (event.env !== undefined && event.env.length > 0) {
        previewLines.push('⚠ env (injected into the server process):');
        for (const b of event.env) {
          previewLines.push(`    ${sanitizeOneLineForDisplay(`${b.name}=${b.value}`)}`);
        }
      }
      previewLines.push(sandboxLine, '');
      if (event.preConnect) {
        // PRE-CONNECT identity gate (MCP.md §1.5): the tools aren't fetched yet —
        // fetching them IS the spawn/connect we're gating, so a hostile config
        // can't run code or leak a bearer token before this approval. Authorize
        // the IDENTITY (command/URL) here; the tool list is reviewed in the
        // manifest-trust prompt that follows the (now-authorized) connect.
        previewLines.push(
          event.mode === 'first-visit'
            ? 'A configured MCP server has NOT been reached yet. Authorizing lets'
            : 'A configured MCP server changed. Re-authorizing lets',
          'Forja RUN this command / connect to this URL (with any configured auth)',
          'and load its tools — which you then REVIEW before they become callable.',
        );
        previewLines.push('');
        previewLines.push(
          'If you authorize: Forja connects; the tool list is shown for review next.',
        );
        previewLines.push(
          'If you decline: the server is never run or connected (nothing is sent).',
        );
      } else {
        const MAX_LIST = 8;
        const visible = event.tools.slice(0, MAX_LIST);
        const overflow = event.tools.length - visible.length;
        if (event.mode === 'first-visit') {
          previewLines.push(
            'An MCP server wants to run the command above and expose these tools',
            'to the model. Trusting it AUTHORIZES RUNNING THAT BINARY. Review the',
            'tools it declares before confirming:',
          );
        } else {
          previewLines.push(
            'A previously-trusted MCP server changed (its command or tool set).',
            'Trusting again RE-AUTHORIZES running the command above. Review the',
            'current tools before confirming:',
          );
        }
        previewLines.push('');

        if (visible.length === 0) {
          previewLines.push('(the server declares no tools)');
        } else {
          for (const t of visible) {
            // Mark side-effecting tools so the operator sees which ones write —
            // and, by omission, which the server claims are read-only (the
            // `writes:false` it is asking them to trust).
            const marker = t.writes ? ' [writes]' : '';
            previewLines.push(
              `  ${sanitizeOneLineForDisplay(t.name)}${marker} — ${sanitizeOneLineForDisplay(t.description)}`,
            );
          }
          if (overflow > 0) {
            previewLines.push(`  …and ${overflow} more tool${overflow === 1 ? '' : 's'} not shown`);
          }
        }
        previewLines.push('');
        previewLines.push(`manifest hash: ${sanitizeOneLineForDisplay(event.manifestHash)}`);
        previewLines.push('');
        previewLines.push('If you trust: the server runs on next use; its tools become callable.');
        previewLines.push('If you decline: the server is not run and its tools stay hidden.');
      }

      return {
        state: {
          ...state,
          modal: {
            promptId: event.promptId,
            flavor: 'mcp-trust',
            title:
              event.mode === 'first-visit'
                ? 'MCP server trust (first visit):'
                : 'MCP server trust (changed):',
            subject: null,
            preview: previewLines,
            question: null,
            options,
            // Conservative default (last) = "No, do not run it".
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
      // `.forja/no-history` marker (spec §3.3 level 2) on top of
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

    case 'resumemode:ask': {
      // Two options: compact older turns first (recommended), or load the full
      // (uncapped) session. From-summary is FIRST and the default cursor — it's
      // the recommended resume (keeps context lean); full is the deliberate
      // opt-out. Neither is destructive (Esc → capped default in the caller).
      // The selectedIndex + option ORDER here MUST match the manager
      // (modal-manager RESUME_MODE_OPTIONS + cursor 0) so the painted cursor
      // and what Enter resolves can't drift.
      const options: ConfirmOption[] = [
        { key: '1', label: 'From summary (recommended)', value: 'summary' },
        { key: '2', label: 'Full session', value: 'full' },
      ];
      const blast =
        event.totalCount === 1
          ? '1 message in this session.'
          : `${event.totalCount} messages in this session.`;
      return {
        state: {
          ...state,
          modal: {
            promptId: event.promptId,
            flavor: 'resume-mode',
            title: 'Resume session',
            subject: null,
            preview: [blast, '', 'From summary: compact older turns first. Full: load everything.'],
            question: 'How do you want to load this session?',
            options,
            selectedIndex: 0,
            hints: ['Enter to confirm', 'Esc for recent-only'],
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
            // Secondary tone lifts the scope/name out of the dim
            // baseline (matches the permission flavor's framing line).
            subjectTone: 'secondary',
            preview: event.body.split('\n'),
            question: 'Save this memory entry?',
            options,
            // Default cursor on the first option (Yes) — writing memory
            // is the expected outcome of this prompt, so Enter accepts
            // (same convention as the permission modal; a deliberate
            // break from the last-option-safe default for this flavor).
            // Shared constant with the manager (which decides what Enter
            // resolves) so the cursor and the resolution can't drift.
            selectedIndex: MEMORY_WRITE_DEFAULT_SELECTED_INDEX,
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
      // fragmented look in wide ones. The trust modal follows the
      // same convention.
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

    case 'reminders:update':
      // Absolute pending count from the ReminderScheduler (§3B.9). Stored
      // directly — the scheduler is the source of truth, so the reducer
      // never derives it. No permanent scrollback line: the fire itself
      // surfaces via the bg_done-style `● [reminder]` wake echo.
      return { state: { ...state, reminderCount: event.count }, permanent: [] };

    case 'subagent:start': {
      // Insert a fresh row keyed by subagentId. Duplicate starts
      // (defensive — producer is single-shot) overwrite the
      // existing entry rather than no-oping; the new producer is
      // the source of truth for any field the renderer reads.
      const next = new Map(state.subagents);
      // `name` and `goal` are model/child-authored — `goal` is the raw
      // seed prompt verbatim — and the renderer paints them into the LIVE
      // region every heartbeat tick (`name` and the `goal` slice share the
      // row head, line 1). Now that `liveRegionActive`
      // stays true for the whole subagent run, a raw ESC/BEL/CR would ring
      // the bell, forge SGR, or move the cursor on every redraw. Sanitize at
      // this STATE boundary — same chokepoint the sibling `currentTool`
      // (harness-adapter) and the `read_file` path already use — so every
      // downstream read (live row, end-block summary) sees clean text.
      next.set(event.subagentId, {
        subagentId: event.subagentId,
        name: sanitizeOneLineForDisplay(event.name),
        goal: sanitizeOneLineForDisplay(event.goal),
        progress: '',
        startedAt: event.ts,
        liveCostUsd: 0,
        currentTool: '',
        toolCounts: new Map(),
        toolTotal: 0,
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
      // `currentTool` (line 2) is set on tool-start and PERSISTS until the
      // next tool starts — it is NOT cleared on `toolDone`. Clearing it
      // would blank line 2 during the gap between tools (every model
      // round-trip), flapping back to the bare `starting…` cue on
      // each tool finish. Keeping the last tool shown (with the spinner
      // still conveying "active") reads as the subagent's most recent
      // action instead. `toolDone` only feeds the per-type aggregate.
      const currentTool = event.currentTool ?? existing.currentTool;
      let toolCounts = existing.toolCounts;
      let toolTotal = existing.toolTotal;
      if (event.toolDone !== undefined) {
        toolCounts = new Map(existing.toolCounts);
        toolCounts.set(event.toolDone, (toolCounts.get(event.toolDone) ?? 0) + 1);
        toolTotal = existing.toolTotal + 1;
      }
      next.set(event.subagentId, {
        ...existing,
        progress: event.progress,
        liveCostUsd,
        currentTool,
        toolCounts,
        toolTotal,
      });
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
                // Freeze the accumulated per-type counts for the grouped
                // scrollback trail (sorted desc by count, then name for a
                // stable tie-break).
                toolCounts: [...existing.toolCounts.entries()].sort(
                  (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
                ),
                toolTotal: existing.toolTotal,
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
  if (event.type === 'tool:end') {
    // tool:end NEVER flushes here (it coalesces into pendingToolEndBatch).
    // But a BYPASSED tool-end — one that emits its chip immediately rather
    // than buffering (failed/denied status, an exit code, a diff, a
    // summary) — lands a non-subagent block in scrollback, so it ends a
    // subagent title-run. A BUFFERED tool-end emits no permanent yet, so it
    // leaves the flag: the buffer re-titles via `flushed.permanent` when it
    // flushes on the next event.
    if (inner.permanent.length > 0 && state.subagentTitleShown) {
      return { state: { ...inner.state, subagentTitleShown: false }, permanent: inner.permanent };
    }
    return inner;
  }
  if (inner.permanent.length === 0) return inner;
  const flushed = flushPendingToolEndBatch(inner.state);
  // Subagent group title: a `subagent:end` emits a `subagent_summary`
  // block. Prepend a single `Subagent` header ONLY when the preceding
  // scrollback wasn't already a subagent block (a fresh run) — including
  // when a tool batch just flushed between two completions (flushed
  // items break the run). Any OTHER scrollback-emitting event clears the
  // flag, so the next burst re-titles. This coalesces a parallel batch of
  // finishing subagents under one title (like tools share a head).
  if (event.type === 'subagent:end') {
    const startRun = !state.subagentTitleShown || flushed.permanent.length > 0;
    const title: PermanentItem[] = startRun
      ? [{ kind: 'subagent_group_header', ts: event.ts }]
      : [];
    return {
      state: { ...flushed.state, subagentTitleShown: true },
      permanent: [...flushed.permanent, ...title, ...inner.permanent],
    };
  }
  return {
    state: { ...flushed.state, subagentTitleShown: false },
    permanent: [...flushed.permanent, ...inner.permanent],
  };
};
