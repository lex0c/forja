// Live-region renderer. Spec: UI.md §2, §10.
//
// Owns the redraw cycle for the inline TUI:
//   1. subscribe to the bus (UIEvent stream)
//   2. fold each event into LiveState via applyEvent
//   3. emit permanent items to stdout (they become scrollback) via
//      `formatPermanent` (lives in `./render/permanent.ts`)
//   4. update the live region. Two paths:
//        - layout change (height differs from prev frame, first frame,
//          or after a permanent transition wiped the region) → full
//          erase + redraw all lines.
//        - same height → differential: walk to row 0, only emit
//          content for lines that actually changed, skip the rest,
//          reposition cursor at the end. This is what makes typing
//          flicker-free under key repeat: the static lines (status,
//          rules, footer) aren't touched, so the terminal never
//          repaints them.
//
// Mechanics-only: every formatting decision (glyphs, color, line
// shape) lives in `./render/`. The renderer just calls whatever
// composer + formatter is wired in.
//
// Frame coalescing: multiple events arriving within one frame budget
// produce a single redraw. Permanent items bypass the scheduler — they
// must hit stdout before the new live state, since they shape the
// scrollback above the live region.
//
// Each redraw is a single `write()` (UI.md §2.2 step 4) wrapped in
// DECSET 2026 (synchronized output) so terminals that support it
// present the frame atomically. The single-write + synchronized-output
// + differential triple is what keeps the live region stable under
// 30fps key repeat across both modern (kitty/wezterm/alacritty) and
// older (xterm vanilla) terminal emulators.

import type { Bus } from './bus.ts';
import type { UIEvent } from './events.ts';
import { type Heartbeat, type HeartbeatOptions, createHeartbeat } from './heartbeat.ts';
import { composeCursor, composeLive as defaultComposeLiveFn } from './render/compose.ts';
import { formatPermanent } from './render/permanent.ts';
import { truncateToWidth } from './render/width.ts';
import type { ComposeLive } from './renderer-types.ts';
import {
  type ApplyResult,
  type LiveState,
  type PermanentItem,
  applyEvent,
  createInitialState,
  flushPendingToolEndBatch,
} from './state.ts';
import {
  type Capabilities,
  type FrameSchedulerOptions,
  type RawModeStdin,
  type ResizeStream,
  beginSyncOutput,
  clearDown,
  clearLine,
  createFrameScheduler,
  createResizeWatcher,
  cursorDown,
  cursorForward,
  cursorHide,
  cursorShow,
  cursorUp,
  disableBracketedPasteOn,
  disableRawMode,
  enableBracketedPasteOn,
  enableRawMode,
  endSyncOutput,
} from './term.ts';

// Re-export the canonical compose function, its type, and the
// permanent formatter so callers importing from `src/tui/renderer.ts`
// get the full public surface without reaching into `./render/`.
export type { ComposeLive };
export { defaultComposeLiveFn as defaultComposeLive, formatPermanent };

// Events that bypass the tool min-display hold queue
// (RendererOptions.toolMinDisplayMs). All of these touch only
// live-region / overlay slices of LiveState, emit NO permanent
// (scrollback) item, and commute with the held tool lifecycle — so
// processing them immediately is scrollback-safe. They fall into three
// groups, each of which would BREAK if delayed behind a held tool:end:
//
//   - Keystroke / overlay: typing must stay responsive while a fast
//     tool's card is held.
//   - Modal open + lifecycle: `modal-manager.ts` installs the modal's
//     focus handler synchronously on emit, so the keyboard is already
//     routed to the (unseen) modal. If the `*:ask` event were queued,
//     the prompt wouldn't render yet but Enter / a hotkey would already
//     resolve it — an operator could approve a permission prompt
//     (default Yes) without ever seeing it. The modal MUST render in
//     lockstep with focus activation.
//   - Interrupt: `triggerInterrupt()` reads/writes `softInterrupted`
//     through this event to drive the soft→hard ladder. Queued, the
//     state never flips, so a second Esc/Ctrl+C within the hold window
//     re-takes the soft branch instead of issuing the promised hard
//     abort.
//
// Anything NOT listed here goes through the FIFO queue so scrollback
// ordering stays correct.
const HOLD_BYPASS: ReadonlySet<UIEvent['type']> = new Set([
  // Keystroke / overlay.
  'input:update',
  'slash:update',
  'reverse-search:update',
  'reverse-search:close',
  // Modal open (focus installed synchronously by modal-manager).
  'permission:ask',
  'trust:ask',
  'shared-trust:ask',
  'history-clear:ask',
  'memory:write:ask',
  'memory:action:ask',
  'memory:user-scope:ask',
  // Modal lifecycle (keep the rendered modal in sync with the focus
  // stack / selection).
  'modal:answer',
  'modal:select',
  'modal:queue-depth',
  // Interrupt ladder (soft/hard decision reads the flipped state).
  'interrupt',
  'interrupt:exit-arm',
  'interrupt:exit-cancel',
]);

export interface RendererOptions {
  bus: Bus;
  caps: Capabilities;
  // Where to write live + permanent output. Defaults to
  // `process.stdout.write`. Tests pass a string-collecting fake.
  write?: (s: string) => void;
  // Compose the live region from current state. Optional; falls back
  // to `defaultComposeLive`.
  composeLive?: ComposeLive;
  // Stdin handle for raw-mode toggle. Optional — when omitted, the
  // renderer doesn't touch stdin (useful for tests / headless).
  stdin?: RawModeStdin;
  // Stream the resize watcher subscribes to. Defaults to
  // `process.stdout`. Tests inject a fake stream so resize events
  // are deterministic. Pass `false` (NOT undefined) to disable
  // resize handling entirely; useful when the renderer is wrapped
  // in something that owns the watcher itself.
  resizeStream?: ResizeStream | false;
  // Frame scheduler tuning. Tests inject deterministic timers.
  schedulerOptions?: FrameSchedulerOptions;
  // When true (default), enable bracketed paste at start and disable
  // at close. Disable in tests where the writes pollute assertions.
  bracketedPaste?: boolean;
  // Time source for spinners + thinking duration. Defaults to
  // `Date.now`. Tests inject a constant or counter for determinism.
  now?: () => number;
  // Heartbeat tuning. The renderer wires its own `isActive` and
  // `onTick`; only `intervalMs` and the timer hooks are exposed.
  // Pass `false` to disable the heartbeat entirely (useful in tests
  // that don't want spinner animation noise).
  heartbeat?: Pick<HeartbeatOptions, 'intervalMs' | 'setTimer' | 'clearTimer'> | false;
  // When `'eager'` (default), the renderer flips stdin to raw mode
  // and emits the bracketed-paste enable on construction. When
  // `'manual'`, the caller is expected to call `enableInput()`
  // before relying on any stdin events. The manual mode exists for
  // callers that have a window between renderer creation and
  // input-handler readiness — the REPL's pre-bootstrap stack is
  // the motivating case: enabling raw mode immediately would
  // suppress Ctrl+C → SIGINT during bootstrap (raw mode disables
  // ISIG), making a slow / hanging bootstrap uninterruptible. With
  // `manual`, raw mode arms only at the moment a focus handler is
  // ready to receive keystrokes.
  inputMode?: 'eager' | 'manual';
  // Minimum wall-clock time (ms) a live tool card stays on screen
  // before its `tool:end` is allowed to remove it. Fast tools
  // (read / write / quick bash) otherwise complete within a single
  // frame budget (~33ms at 30fps) — by the time the coalesced frame
  // draws, the reducer has already removed the tool from
  // `activeTools`, so the card never paints. It "flashes and
  // disappears". When this is > 0, the renderer HOLDS each `tool:end`
  // (and the harness events queued behind it) until the card has been
  // visible at least this long, keeping it on screen (and animating
  // via the heartbeat). Keystroke / overlay events bypass the hold so
  // typing stays responsive. 0 (default) disables the hold entirely —
  // events process in arrival order with zero added latency, which is
  // what the renderer test-suite assumes. Production wires a small
  // positive value. Timer + clock injection reuse `schedulerOptions`
  // (`setTimer` / `clearTimer`) and `now` so the hold is deterministic
  // under test.
  toolMinDisplayMs?: number;
}

export interface Renderer {
  // Force an immediate redraw. Useful at boot or after a foreground
  // resume.
  redraw: () => void;
  // Read-only snapshot of the current LiveState. Tests inspect this;
  // production rarely needs it.
  state: () => LiveState;
  // Activates raw mode (stdin) + bracketed paste (stdout). No-op
  // when already enabled or when constructed with `inputMode:
  // 'eager'`. Pair with the existing `close` for teardown — close
  // restores stdin / bracketed paste regardless of when (or
  // whether) `enableInput` was called.
  enableInput: () => void;
  // Tear down everything: unsubscribe, drop listeners, restore stdin
  // mode, disable bracketed paste, stop scheduler. Idempotent.
  close: () => void;
}

export const createRenderer = (options: RendererOptions): Renderer => {
  const {
    bus,
    write = (s) => {
      process.stdout.write(s);
    },
    composeLive = defaultComposeLiveFn,
    stdin,
    schedulerOptions,
    bracketedPaste = true,
    now = () => Date.now(),
  } = options;

  // Tool min-display hold (see RendererOptions.toolMinDisplayMs).
  // Reuse the scheduler's injectable timer hooks so the hold is
  // deterministic under the same test seam that drives frames.
  const toolMinDisplayMs = Math.max(0, options.toolMinDisplayMs ?? 0);
  const holdSetTimer = schedulerOptions?.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const holdClearTimer =
    schedulerOptions?.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  // Wall-clock time each live tool card first appeared, keyed by
  // toolId — the anchor for the min-display hold. Set on `tool:start`,
  // cleared when its `tool:end` finally processes.
  const toolShownAt = new Map<string, number>();
  // FIFO buffer for events held behind a not-yet-elapsed tool card.
  // Only non-bypass events land here (see HOLD_BYPASS).
  const eventQueue: UIEvent[] = [];
  // Active hold timer, or null when the queue is draining freely.
  let holdTimer: unknown = null;

  // Mutable internal copy of caps. SIGWINCH/resize updates `cols`/`rows`
  // here so `drawLive` and `composeLive` see fresh dimensions on every
  // frame without the caller threading a new value through. The caller's
  // original `caps` reference is never mutated.
  const liveCaps: Capabilities = { ...options.caps };

  let state = createInitialState();
  // Number of lines written by the last full draw. Used to compute
  // how many lines to clear on the next full redraw.
  let liveHeight = 0;
  // Row (0-based from top of live region) where the cursor currently
  // sits. After a full draw without inline cursor positioning this
  // equals `liveHeight - 1` (cursor at end of last line). When cursor
  // inline positioning fires, this matches the cursor row so erase
  // walks the right number of lines back to row 0.
  let cursorRow = 0;
  // Last frame's truncated lines, kept so the next redraw can diff
  // line-by-line and only emit what changed (UI.md §2.2). Without
  // this every keystroke under key repeat would repaint the static
  // lines (status / footer / rules) 30x/s — even with a single
  // syscall + DECSET 2026 wrap, terminals like xterm vanilla render
  // ANSI incrementally and the operator perceives flicker on those
  // lines. Differential rendering skips them entirely when their
  // content didn't change.
  //
  // Reset on: layout change (height differs), permanent emit (live
  // region was erased to make room), screen:clear, session end,
  // close. The reset forces the next frame through the full-draw
  // path so the renderer's layout state stays in lockstep with what
  // the terminal actually shows.
  let prevLines: string[] = [];
  let closed = false;
  // Cursor visibility tracker. The terminal cursor is normally
  // visible (where the operator types into the input box); during
  // a modal there is no input, so the cursor lands on the modal's
  // bottom row (the hint footer row by the redraw's "no cursor
  // target → land at bottom" branch). The blinking cursor block
  // sits ON TOP of the hint text, looking like flicker. Hide on
  // modal-up, show on modal-down. Idempotent transition emit so
  // the redraw fast path doesn't spam the escape every frame.
  let cursorVisible = true;
  const cursorVisibilityEscape = (modalUp: boolean): string => {
    if (modalUp && cursorVisible) {
      cursorVisible = false;
      return cursorHide;
    }
    if (!modalUp && !cursorVisible) {
      cursorVisible = true;
      return cursorShow;
    }
    return '';
  };

  // ─── Build helpers ────────────────────────────────────────────────
  //
  // Each helper produces ANSI/text output as a string and updates
  // internal layout state (`liveHeight`, `cursorRow`) in place. The
  // orchestrators (`redraw`, the permanent-emit path) concatenate the
  // pieces and emit them in **one** `write()` per redraw cycle.
  //
  // Spec contract (UI.md §2.2 step 4): a frame is a single
  // `process.stdout.write(...)`. Splitting erase + draw across two
  // writes flushes the terminal between them — for ~1ms the live
  // region is gone, which the operator perceives as flicker. Keeping
  // the whole sequence in one syscall makes the update atomic from
  // the terminal's POV.

  const buildErase = (): string => {
    if (liveHeight === 0) return '';
    // \r → col 0; cursorUp(cursorRow) → row 0 of live region;
    // clearDown wipes everything below. cursorRow may be < liveHeight-1
    // when inline cursor positioning moved the cursor into the input
    // buffer mid-frame.
    const s = `\r${cursorUp(cursorRow)}${clearDown}`;
    liveHeight = 0;
    return s;
  };

  // Full draw: write every line from scratch. Used after an erase
  // (first frame, layout change, permanent transition). Updates
  // `liveHeight` / `cursorRow` to reflect the new layout.
  const buildFullDraw = (truncated: string[]): string => {
    if (truncated.length === 0) {
      liveHeight = 0;
      return '';
    }
    liveHeight = truncated.length;
    cursorRow = truncated.length - 1;
    let s = truncated.join('\n');
    // Inline cursor positioning. After the join the terminal cursor
    // would sit at end of the last line; back it up to where the
    // input box wants it (cursorUp + carriage return + cursorForward).
    // The helpers no-op on n <= 0, so single concat handles "already
    // on the right row" / "col 0" without branching.
    const cursor = composeCursor(state, liveCaps, truncated.length);
    if (cursor !== null) {
      const linesUp = truncated.length - 1 - cursor.row;
      s += `${cursorUp(linesUp)}\r${cursorForward(cursor.col)}`;
      cursorRow = cursor.row;
    }
    return s;
  };

  // Differential draw: assumes the live region is currently rendered
  // at the same height as `truncated`. Walks to row 0, then for each
  // changed line walks down + clearLine + writes the new content.
  // Unchanged lines are NEVER touched — that's the whole point: under
  // key repeat the only line that changes is the input row, so the
  // surrounding static lines stay pixel-stable instead of getting
  // wiped+repainted 30x/s.
  const buildDifferentialDraw = (truncated: string[]): string => {
    if (truncated.length === 0) return '';
    // Start at row 0 of the live region.
    let buf = `\r${cursorUp(cursorRow)}`;
    let curRow = 0;
    for (let i = 0; i < truncated.length; i++) {
      if (truncated[i] !== prevLines[i]) {
        if (curRow !== i) {
          buf += cursorDown(i - curRow);
          curRow = i;
        }
        // \r + clearLine + content. clearLine wipes the whole row
        // (CSI 2K), so leftover columns from the previous frame's
        // longer content disappear correctly.
        buf += `\r${clearLine}${truncated[i]}`;
      }
    }
    // Reposition cursor to the input target.
    const cursor = composeCursor(state, liveCaps, truncated.length);
    if (cursor !== null) {
      if (curRow !== cursor.row) {
        buf +=
          cursor.row > curRow ? cursorDown(cursor.row - curRow) : cursorUp(curRow - cursor.row);
      }
      buf += `\r${cursorForward(cursor.col)}`;
      cursorRow = cursor.row;
    } else {
      // No cursor target (modal up) → land at the bottom row of the
      // live region. We don't bother positioning to end-of-line like
      // the full-draw path does (where the join's natural drift puts
      // the cursor at the last line's end column) — the next frame's
      // erase only consumes `cursorRow`, and its leading `\r` resets
      // col 0 before the cursor-up walk. So col 0 vs end-of-line is
      // observationally identical.
      const target = truncated.length - 1;
      if (curRow !== target) {
        buf += cursorDown(target - curRow);
      }
      cursorRow = target;
    }
    return buf;
  };

  const buildPermanent = (items: PermanentItem[]): string => {
    if (items.length === 0) return '';
    // Format each item to lines via caps-aware `formatPermanent`,
    // flatten, and emit. Permanent lines are NOT truncated — they're
    // scrollback and the user can scroll horizontally / wrap-view in
    // their terminal. (Live region is the only place width matters,
    // because we have to cursor-up to erase.)
    const lines = items.flatMap((item) => formatPermanent(item, liveCaps));
    if (lines.length === 0) return '';
    return `${lines.join('\n')}\n`;
  };

  // Wrap a non-empty payload with synchronized output (DECSET 2026)
  // so terminals that support it present the frame atomically. Empty
  // payloads bypass the wrap to avoid emitting BSU+ESU around nothing
  // (would still be no-op on the terminal, but pollutes test fixtures
  // and wastes a couple of bytes per spurious tick).
  const wrapSync = (buf: string): string =>
    buf.length === 0 ? '' : `${beginSyncOutput}${buf}${endSyncOutput}`;

  // Compose the live region as an array of SINGLE terminal rows.
  // `composeLive` is contracted to return one string per row, but a
  // render function that interpolates an unsanitized field (a tool
  // subject with a literal `\n`, a multi-line error summary) can emit
  // one element that spans several rows. That breaks the core invariant
  // every count here relies on — `liveHeight`, `cursorRow`, the erase
  // walk-back, and the differential diff all assume one element == one
  // row — and the symptom is stale rows leaking into scrollback (an
  // "Awaiting approval" card that never gets erased). Splitting embedded
  // newlines here is the single chokepoint that restores the invariant
  // for ALL sources; subjects are also flattened upstream
  // (harness-adapter) for a cleaner one-line look, so this is the
  // belt-and-suspenders guard for everything else.
  const composeRows = (): string[] =>
    composeLive(state, liveCaps, now()).flatMap((l) => l.split('\n'));

  // Compose a full erase + permanent + draw transition into one buffer
  // and emit it. Used by every path that prints permanent items
  // (regular event with `result.permanent`, reducer-error fallback,
  // screen:clear-while-modal warning) so the operator never sees an
  // intermediate "erased, no permanent yet" state. After this path
  // the live region is fully redrawn from scratch — `prevLines` is
  // updated so the next differential redraw has a correct baseline.
  const writeTransition = (permanent: PermanentItem[]): void => {
    if (closed) return;
    let buf = buildErase();
    buf += buildPermanent(permanent);
    // Always redraw the live region after a permanent emit. Earlier
    // this branch short-circuited on `state.ended` so session:end
    // wouldn't redraw input/footer, but that left the input box
    // invisible for the gap between session:end and the next
    // user:submit (operator typing in the dark). Now the live region
    // stays present; the next user prompt naturally lands on a
    // visible input box. The renderer's `closed` flag handles
    // teardown for one-shot mode (close() erases the live region).
    const raw = composeRows();
    const truncated = raw.map((l) => truncateToWidth(l, liveCaps.cols));
    buf += cursorVisibilityEscape(state.modal !== null);
    buf += buildFullDraw(truncated);
    prevLines = truncated;
    if (buf.length > 0) write(wrapSync(buf));
  };

  // Public redraw — used by external triggers (resize, foreground
  // resume) and by the scheduler.
  //
  // Two paths:
  //   - First frame OR layout change (height differs from prev) →
  //     erase + full draw. Resets `prevLines` to the new content.
  //   - Same height → differential: only changed lines emit content.
  //
  // Differential is the anti-flicker path. Under key repeat, only
  // the input line changes per frame; the surrounding static lines
  // stay untouched and the terminal never repaints them.
  const redraw = (): void => {
    if (closed) return;
    const raw = composeRows();
    const truncated = raw.map((l) => truncateToWidth(l, liveCaps.cols));
    // Cursor visibility transition: emit hide-on-modal /
    // show-on-no-modal at the SAME frame as the modal state
    // change. Idempotent — the helper returns '' when no change is
    // needed, so the differential fast path doesn't spam the
    // escape on every frame.
    const cursorVis = cursorVisibilityEscape(state.modal !== null);

    // Empty live region — just erase.
    if (truncated.length === 0) {
      const buf = cursorVis + buildErase();
      if (buf.length > 0) write(wrapSync(buf));
      prevLines = [];
      return;
    }

    // First frame OR height change → full erase + draw.
    if (liveHeight === 0 || prevLines.length !== truncated.length) {
      const buf = cursorVis + buildErase() + buildFullDraw(truncated);
      if (buf.length > 0) write(wrapSync(buf));
      prevLines = truncated;
      return;
    }

    // Differential — same height, only changed rows emit.
    const buf = cursorVis + buildDifferentialDraw(truncated);
    if (buf.length > 0) write(wrapSync(buf));
    prevLines = truncated;
  };

  const scheduler = createFrameScheduler(redraw, schedulerOptions);

  // Heartbeat: while anything in the live region animates (spinner
  // for a running tool, thinking duration counter, the assistant
  // chip's "Generating… (Xs · ↑ N tokens)" elapsed counter), tick
  // periodically so the frame scheduler keeps redrawing. Goes idle
  // when no animated element is on screen — zero wakeups while
  // waiting on user input.
  //
  // pendingAssistant matters even when no thinking/tool is in flight:
  // a long quiet gap between provider deltas (model reasoning, slow
  // network) would otherwise freeze the spinner and the elapsed
  // timer until the next delta lands. From the operator's POV the
  // run looks hung. Including pendingAssistant here keeps the chip
  // animating during pure text-generation turns.
  //
  // awaitingProvider: same rationale — between `step_start` and the
  // first provider event of the step, NO HarnessEvent fires (the
  // model is thinking on its end). Without including it here, the
  // "Awaiting model… (Xs)" chip would be drawn ONCE at step_start
  // with the elapsed counter frozen at 0ms, and the operator
  // would still perceive a hang. With it, the chip ticks at the
  // heartbeat cadence and the counter advances honestly while
  // the wait happens.
  const heartbeat: Heartbeat | null =
    options.heartbeat === false
      ? null
      : createHeartbeat({
          ...(options.heartbeat ?? {}),
          isActive: () =>
            state.activeTools.size > 0 ||
            state.thinking !== null ||
            state.pendingAssistant !== null ||
            state.awaitingProvider !== null,
          onTick: () => scheduler.request(),
        });

  // Process one event: fold it into state, emit permanent if any, then
  // request a frame. Permanent output requires erasing the live region
  // first (otherwise the new permanent text would land below it). This
  // is the unconditional apply path — `handleEvent` (below) gates which
  // events reach it immediately vs. wait out a tool's min-display hold.
  const processEvent = (event: UIEvent): void => {
    if (closed) return;
    // Anchor / release the min-display clock for tool cards. `tool:start`
    // stamps when the card first appeared; `tool:end` (reaching here only
    // after any hold elapsed) releases it. `session:start` drops any
    // orphaned anchors (a tool whose `tool:end` never arrived because the
    // turn was aborted mid-call) so the map can't accumulate across a
    // long REPL session — no tool spans a turn boundary.
    if (event.type === 'tool:start') toolShownAt.set(event.toolId, now());
    else if (event.type === 'tool:end') toolShownAt.delete(event.toolId);
    else if (event.type === 'session:start') toolShownAt.clear();
    // `screen:clear` is a renderer-side concern (writes ANSI escape,
    // forces redraw); the reducer is a no-op for it. Handle here so
    // the clear escape lands at the right moment in the I/O stream
    // (before drawLive's subsequent redraw so the live region is the
    // only thing on screen post-clear).
    //
    // Modal-up guard: refuse the wipe while a modal is active. The
    // clear-escape would erase the modal frame mid-decision and the
    // subsequent redraw would put it back, but the cursor-row
    // tracking and any focus-stack state could end up out of sync.
    // Operator can answer the modal first, then /clear.
    if (event.type === 'screen:clear') {
      if (state.modal !== null) {
        // Surface as a warn so the operator sees the refusal
        // explicitly instead of silently doing nothing.
        writeTransition([
          { kind: 'warn', message: 'screen:clear refused: a modal is open (answer it first)' },
        ]);
        heartbeat?.bump();
        return;
      }
      // \x1b[2J  — clear visible area
      // \x1b[H   — move cursor to home (top-left)
      // The terminal preserves the scrollback buffer above; the
      // live region's `liveHeight` is now stale (cursor is at row 0,
      // not at the end of last live line) — reset to 0 so the next
      // erase doesn't try to walk back over content we just wiped.
      // Wipe + draw are coalesced into one write AND wrapped in
      // synchronized output so the operator sees the post-clear
      // frame appear instantly, without a perceived empty flash.
      // `prevLines` reset because the screen was wiped — the next
      // redraw must go through the full-draw path.
      liveHeight = 0;
      cursorRow = 0;
      prevLines = [];
      const raw = composeRows();
      const truncated = raw.map((l) => truncateToWidth(l, liveCaps.cols));
      let buf = '\x1b[2J\x1b[H';
      if (truncated.length > 0) {
        buf += buildFullDraw(truncated);
        prevLines = truncated;
      }
      write(wrapSync(buf));
      heartbeat?.bump();
      return;
    }
    let result: ApplyResult;
    try {
      result = applyEvent(state, event);
    } catch (err) {
      // Reducer threw — likely an unhandled new event kind. Surface
      // as a warn line in scrollback so the user sees something
      // actionable, and keep the renderer alive.
      const msg = err instanceof Error ? err.message : String(err);
      writeTransition([{ kind: 'warn', message: `renderer reducer error: ${msg}` }]);
      heartbeat?.bump();
      return;
    }
    state = result.state;
    if (result.permanent.length > 0) {
      writeTransition(result.permanent);
    } else {
      scheduler.request();
    }
    // Re-evaluate heartbeat after every event: a `tool:start` arms
    // it; `tool:end` (the last running tool) leaves the predicate
    // false, so the heartbeat stops on the next firing.
    heartbeat?.bump();
  };

  // Drain queued events in arrival order, pausing when the head is a
  // `tool:end` whose card hasn't been on screen for `toolMinDisplayMs`
  // yet. While paused, the tool is still in `activeTools` (its
  // `tool:end` hasn't been applied), so the live region keeps showing
  // and animating the card via the heartbeat. A one-shot timer resumes
  // the drain once the remaining time elapses. With `toolMinDisplayMs`
  // at 0 (default) this never pauses and the queue empties synchronously
  // on every call — identical ordering to processing events inline.
  const drainQueue = (): void => {
    if (closed) return;
    if (holdTimer !== null) return; // already waiting; the timer will resume us
    while (eventQueue.length > 0) {
      const head = eventQueue[0] as UIEvent;
      if (toolMinDisplayMs > 0 && head.type === 'tool:end') {
        const shownAt = toolShownAt.get(head.toolId);
        if (shownAt !== undefined) {
          const remaining = toolMinDisplayMs - (now() - shownAt);
          if (remaining > 0) {
            holdTimer = holdSetTimer(() => {
              holdTimer = null;
              drainQueue();
            }, remaining);
            return; // leave `head` queued — card stays live until we resume
          }
        }
      }
      eventQueue.shift();
      processEvent(head);
    }
  };

  // Bus subscription entry point. Keystroke / overlay events bypass the
  // hold queue (HOLD_BYPASS) so typing stays responsive while a fast
  // tool's card is held on screen; everything else goes through the
  // FIFO queue so scrollback ordering is preserved. Bypass events touch
  // only the input / overlay state and emit no permanent items, so
  // applying them out of band relative to a held tool:end is safe.
  const handleEvent = (event: UIEvent): void => {
    if (closed) return;
    if (HOLD_BYPASS.has(event.type)) {
      processEvent(event);
      return;
    }
    eventQueue.push(event);
    drainQueue();
  };

  // Resize watcher: keep `liveCaps.cols`/`rows` in sync with the
  // terminal. We default to `process.stdout`; tests pass a fake;
  // callers can pass `false` to opt out (e.g., when the parent owns
  // the watcher). On every resize, force a redraw so truncation
  // applies the new width immediately.
  //
  // SIGWINCH can burst (5-10/s during a resize drag). We flush
  // per event today; if flicker shows up, debounce to ~50ms.
  const watcher =
    options.resizeStream === false ? null : createResizeWatcher(options.resizeStream ?? undefined);
  const unsubscribeResize = watcher
    ? watcher.onResize(({ cols, rows }) => {
        liveCaps.cols = cols;
        liveCaps.rows = rows;
        scheduler.flush();
      })
    : () => {};

  // Input activation: raw mode (stdin) + bracketed paste (stdout).
  // Idempotent — `enableRawMode` / `enableBracketedPasteOn` already
  // guard via module-level flags. Eager callers fire it during
  // construction (preserves pre-existing behavior); manual callers
  // delay until they have a focus handler ready and want to take
  // ownership of stdin.
  let inputEnabled = false;
  const enableInput = (): void => {
    if (inputEnabled) return;
    inputEnabled = true;
    if (stdin !== undefined) enableRawMode(stdin);
    if (bracketedPaste) enableBracketedPasteOn(write);
  };

  // We do NOT initial-draw here — the first `bus.emit('session:start')`
  // (or any other event) triggers the first frame. Quietly waiting
  // means a renderer attached to an empty bus produces no output.
  if ((options.inputMode ?? 'eager') === 'eager') {
    enableInput();
  }

  const unsubscribe = bus.onAny(handleEvent);

  return {
    redraw: () => scheduler.flush(),
    state: () => state,
    enableInput,
    close: () => {
      if (closed) return;
      // Flush anything held behind a min-display timer BEFORE marking
      // closed — we're tearing down, so landing each event's scrollback
      // beats dropping it. Cancel the pending hold and process the queue
      // in order, ignoring the min-display gate (processEvent still runs
      // because `closed` is not yet set). Bypass events never queue, so
      // this is exactly the held tool lifecycle tail.
      if (holdTimer !== null) {
        holdClearTimer(holdTimer);
        holdTimer = null;
      }
      const pending = eventQueue.splice(0);
      for (const ev of pending) processEvent(ev);
      // A drained `tool:end` for a successful tool only buffers into
      // the coalescing batch; without a follow-up flush trigger its
      // scrollback line would never land. Flush the batch explicitly so
      // teardown preserves the final-verb chip (the reducer does the
      // same at `session:end`).
      const flushed = flushPendingToolEndBatch(state);
      if (flushed.permanent.length > 0) {
        state = flushed.state;
        writeTransition(flushed.permanent);
      }
      closed = true;
      unsubscribe();
      unsubscribeResize();
      watcher?.close();
      heartbeat?.close();
      scheduler.close();
      // Final clean live region so the prompt returns to a sane place.
      // Single write is fine here — no follow-up draw to coalesce with.
      // Restore cursor visibility before exit so the operator's shell
      // prompt doesn't inherit a hidden cursor (would happen when
      // close() runs while a modal was the last visible thing).
      let eraseBuf = '';
      if (!cursorVisible) {
        eraseBuf += cursorShow;
        cursorVisible = true;
      }
      eraseBuf += buildErase();
      if (eraseBuf.length > 0) write(eraseBuf);
      prevLines = [];
      // Disable regardless of whether enableInput was called — close
      // is the canonical "restore terminal" call, and the underlying
      // helpers already no-op if the mode wasn't active.
      if (bracketedPaste) disableBracketedPasteOn(write);
      if (stdin !== undefined) disableRawMode(stdin);
    },
  };
};
