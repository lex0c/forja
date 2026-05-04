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
}

export interface Renderer {
  // Force an immediate redraw. Useful at boot or after a foreground
  // resume.
  redraw: () => void;
  // Read-only snapshot of the current LiveState. Tests inspect this;
  // production rarely needs it.
  state: () => LiveState;
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
    const raw = composeLive(state, liveCaps, now());
    const truncated = raw.map((l) => truncateToWidth(l, liveCaps.cols));
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
    const raw = composeLive(state, liveCaps, now());
    const truncated = raw.map((l) => truncateToWidth(l, liveCaps.cols));

    // Empty live region — just erase.
    if (truncated.length === 0) {
      const buf = buildErase();
      if (buf.length > 0) write(wrapSync(buf));
      prevLines = [];
      return;
    }

    // First frame OR height change → full erase + draw.
    if (liveHeight === 0 || prevLines.length !== truncated.length) {
      const buf = buildErase() + buildFullDraw(truncated);
      if (buf.length > 0) write(wrapSync(buf));
      prevLines = truncated;
      return;
    }

    // Differential — same height, only changed rows emit.
    const buf = buildDifferentialDraw(truncated);
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
  const heartbeat: Heartbeat | null =
    options.heartbeat === false
      ? null
      : createHeartbeat({
          ...(options.heartbeat ?? {}),
          isActive: () =>
            state.activeTools.size > 0 ||
            state.thinking !== null ||
            state.pendingAssistant !== null,
          onTick: () => scheduler.request(),
        });

  // Bus subscription: fold every event, emit permanent if any, then
  // request a frame. Permanent output requires erasing the live region
  // first (otherwise the new permanent text would land below it).
  const handleEvent = (event: UIEvent): void => {
    if (closed) return;
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
      const raw = composeLive(state, liveCaps, now());
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

  // Resize watcher: keep `liveCaps.cols`/`rows` in sync with the
  // terminal. We default to `process.stdout`; tests pass a fake;
  // callers can pass `false` to opt out (e.g., when the parent owns
  // the watcher). On every resize, force a redraw so truncation
  // applies the new width immediately.
  //
  // TODO(perf): a terminal "wiggle" during a resize drag can fire
  // SIGWINCH 5-10 times per second. We currently flush per event;
  // if this ever shows up as flicker, debounce to ~50ms here.
  const watcher =
    options.resizeStream === false ? null : createResizeWatcher(options.resizeStream ?? undefined);
  const unsubscribeResize = watcher
    ? watcher.onResize(({ cols, rows }) => {
        liveCaps.cols = cols;
        liveCaps.rows = rows;
        scheduler.flush();
      })
    : () => {};

  // Side-effects on construction: enable raw mode + bracketed paste
  // BEFORE subscribing to the bus, so the first event handler sees the
  // terminal already in the right mode. Defensive ordering — emits
  // through synchronous EventEmitters can't race ahead of subscription
  // anyway, but third-party bus impls might.
  // We do NOT initial-draw here — the first `bus.emit('session:start')`
  // (or any other event) triggers the first frame. Quietly waiting
  // means a renderer attached to an empty bus produces no output.
  if (stdin !== undefined) enableRawMode(stdin);
  if (bracketedPaste) enableBracketedPasteOn(write);

  const unsubscribe = bus.onAny(handleEvent);

  return {
    redraw: () => scheduler.flush(),
    state: () => state,
    close: () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      unsubscribeResize();
      watcher?.close();
      heartbeat?.close();
      scheduler.close();
      // Final clean live region so the prompt returns to a sane place.
      // Single write is fine here — no follow-up draw to coalesce with.
      const eraseBuf = buildErase();
      if (eraseBuf.length > 0) write(eraseBuf);
      prevLines = [];
      if (bracketedPaste) disableBracketedPasteOn(write);
      if (stdin !== undefined) disableRawMode(stdin);
    },
  };
};
