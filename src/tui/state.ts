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

export interface InputState {
  // Current value of the input box (multi-line allowed via `\n`).
  value: string;
  // Cursor position, in JS code units within `value`. UTF-16 surrogate
  // pairs are treated as two positions; renderers that care about
  // grapheme clusters can re-derive from `value`.
  cursor: number;
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
  startedAt: number;
  // Last few lines of streaming output. Capped so a tool that emits
  // a megabyte of stdout doesn't bloat the live region — the full
  // content has already gone through the scrollback as `tool:delta`
  // permanent lines (or, in this slice, will once delta lines are
  // wired to print permanently).
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
  // etc.). Producer formats them; renderer just emits between rules.
  // Empty array → preview block omitted entirely.
  preview: string[];
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
  pendingAssistant: PendingAssistant | null;
  thinking: { startedAt: number } | null;
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
  pendingAssistant: null,
  thinking: null,
  modal: null,
  slash: null,
  reverseSearch: null,
  todos: [],
  bgProcesses: new Map(),
  subagents: new Map(),
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
      status: 'done' | 'error';
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

export const applyEvent = (state: LiveState, event: UIEvent): ApplyResult => {
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
      // TODO (D150): when daemon mode / `--keep-bg` lands and bg
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
          ended: false,
        },
        permanent: [],
      };
    }

    case 'session:end':
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
          ...state,
          softInterrupted: false,
          // Same boundary reset rationale as session:start (above).
          exitArmed: null,
          bgProcesses: new Map(),
          subagents: new Map(),
          ended: true,
        },
        permanent: [
          {
            kind: 'session-footer',
            reason: event.reason,
            ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
            ...(event.abortCause !== undefined ? { abortCause: event.abortCause } : {}),
          },
        ],
      };

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
      return {
        state: {
          ...state,
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
      return { state: { ...state, thinking: { startedAt: event.ts } }, permanent: [] };

    case 'thinking:end':
    case 'thinking:delta':
      // Delta events don't change state — duration is computed at render
      // time from `startedAt`. End clears the indicator.
      return {
        state: event.type === 'thinking:end' ? { ...state, thinking: null } : state,
        permanent: [],
      };

    case 'tool:start': {
      const tool: ActiveTool = {
        toolId: event.toolId,
        name: event.name,
        activeVerb: event.activeVerb,
        finalVerb: event.finalVerb,
        subject: event.subject,
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
      const next = cloneTools(state.activeTools);
      next.delete(event.toolId);
      if (tool === undefined) return { state: { ...state, activeTools: next }, permanent: [] };
      const item: PermanentItem = {
        kind: 'tool-end',
        name: tool.name,
        verb: tool.finalVerb,
        subject: tool.subject,
        status: event.status,
        durationMs: event.durationMs,
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
      };
      return { state: { ...state, activeTools: next }, permanent: [item] };
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
      // 3 options per UI.md §4.10.13: yes, session-allow, no.
      // Default selectedIndex points to the last option (No) per
      // D5/D65 — Enter without navigating triggers the safe choice.
      // Esc returns 'cancel' (handled by manager, not in options
      // list).
      const options: ConfirmOption[] = [
        { key: '1', label: 'Yes', value: 'yes' },
        {
          key: '2',
          label: `Yes, allow all ${event.toolName} during this session`,
          value: 'session-allow',
          shortcut: 'shift+tab',
        },
        { key: '3', label: 'No', value: 'no' },
      ];
      const previewLines: string[] = [];
      previewLines.push(`$ ${event.command}`);
      previewLines.push(`cwd: ${event.cwd}`);
      if (event.rule !== undefined) previewLines.push(`matched rule: ${event.rule}`);
      return {
        state: {
          ...state,
          modal: {
            promptId: event.promptId,
            flavor: 'permission',
            title: 'Run command',
            subject: event.command,
            preview: previewLines,
            question:
              event.reason !== undefined
                ? event.reason
                : `Do you want to run this ${event.toolName} command?`,
            options,
            selectedIndex: options.length - 1,
            hints: ['Esc to cancel'],
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
        previewLines.push('AGENTS.md present — its instructions will be loaded on first use.');
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
          },
        },
        permanent: [],
      };
    }

    case 'critique:ask': {
      const options: ConfirmOption[] = [
        { key: '1', label: 'Acknowledge', value: 'yes' },
        { key: '2', label: 'Reject', value: 'no' },
      ];
      const previewLines = event.issues.map(
        (i) => `[${i.severity}] (${i.confidence.toFixed(2)}) ${i.message}`,
      );
      return {
        state: {
          ...state,
          modal: {
            promptId: event.promptId,
            flavor: 'critique',
            title: 'Critique',
            subject: `${event.issues.length} issue(s)`,
            preview: previewLines,
            question: null,
            options,
            selectedIndex: options.length - 1,
            hints: ['Esc to cancel'],
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
      next.set(event.subagentId, { ...existing, progress: event.progress });
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
                summary: event.summary,
                durationMs: event.durationMs,
              },
            ];
      return { state: { ...state, subagents: next }, permanent };
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
