// Live-region renderer. Spec: UI.md §2, §10.
//
// Owns the redraw cycle for the inline TUI:
//   1. subscribe to the bus (UIEvent stream)
//   2. fold each event into LiveState via applyEvent
//   3. emit permanent items to stdout (they become scrollback) via
//      `formatPermanent` (lives in `./render/permanent.ts`)
//   4. clear the previous live region and write the new one (layout
//      via `composeLive` in `./render/compose.ts`)
//
// Mechanics-only: every formatting decision (glyphs, color, line
// shape) lives in `./render/`. The renderer just calls whatever
// composer + formatter is wired in.
//
// Frame coalescing: multiple events arriving within one frame budget
// produce a single redraw. Permanent items bypass the scheduler — they
// must hit stdout before the new live state, since they shape the
// scrollback above the live region.

import type { Bus } from './bus.ts';
import type { UIEvent } from './events.ts';
import { type Heartbeat, type HeartbeatOptions, createHeartbeat } from './heartbeat.ts';
import { composeLive as defaultComposeLiveFn } from './render/compose.ts';
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
  clearDown,
  createFrameScheduler,
  createResizeWatcher,
  cursorUp,
  disableBracketedPasteOn,
  disableRawMode,
  enableBracketedPasteOn,
  enableRawMode,
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
  // Number of lines written by the last `drawLive`. Used to compute
  // how many lines to clear on the next redraw.
  let liveHeight = 0;
  let closed = false;

  const eraseLive = (): void => {
    if (liveHeight === 0) return;
    // After the last drawLive, the cursor sits at the END of the last
    // live line (no trailing newline). To erase we need to:
    //   1. Carriage return — move to column 1 of the current line.
    //   2. Move up (liveHeight - 1) lines.
    //   3. Clear from cursor down to the bottom of the screen.
    write(`\r${cursorUp(liveHeight - 1)}${clearDown}`);
    liveHeight = 0;
  };

  const drawLive = (): void => {
    if (closed || state.ended) return;
    const raw = composeLive(state, liveCaps, now());
    if (raw.length === 0) {
      liveHeight = 0;
      return;
    }
    const truncated = raw.map((l) => truncateToWidth(l, liveCaps.cols));
    write(truncated.join('\n'));
    liveHeight = truncated.length;
  };

  const writePermanent = (items: PermanentItem[]): void => {
    if (items.length === 0) return;
    // Format each item to lines via caps-aware `formatPermanent`,
    // flatten, and emit. Permanent lines are NOT truncated — they're
    // scrollback and the user can scroll horizontally / wrap-view in
    // their terminal. (Live region is the only place width matters,
    // because we have to cursor-up to erase.)
    const lines = items.flatMap((item) => formatPermanent(item, liveCaps));
    if (lines.length === 0) return;
    write(`${lines.join('\n')}\n`);
  };

  // Public redraw — used by external triggers (resize, foreground
  // resume) and by the scheduler.
  const redraw = (): void => {
    if (closed) return;
    eraseLive();
    drawLive();
  };

  const scheduler = createFrameScheduler(redraw, schedulerOptions);

  // Heartbeat: while anything in the live region animates (spinner
  // for a running tool, thinking duration counter), tick periodically
  // so the frame scheduler keeps redrawing. Goes idle when no
  // animated element is on screen — zero wakeups while waiting on
  // user input.
  const heartbeat: Heartbeat | null =
    options.heartbeat === false
      ? null
      : createHeartbeat({
          ...(options.heartbeat ?? {}),
          isActive: () => state.activeTools.size > 0 || state.thinking !== null,
          onTick: () => scheduler.request(),
        });

  // Bus subscription: fold every event, emit permanent if any, then
  // request a frame. Permanent output requires erasing the live region
  // first (otherwise the new permanent text would land below it).
  const handleEvent = (event: UIEvent): void => {
    if (closed) return;
    let result: ApplyResult;
    try {
      result = applyEvent(state, event);
    } catch (err) {
      // Reducer threw — likely an unhandled new event kind. Surface
      // as a warn line in scrollback so the user sees something
      // actionable, and keep the renderer alive.
      const msg = err instanceof Error ? err.message : String(err);
      eraseLive();
      writePermanent([{ kind: 'warn', message: `renderer reducer error: ${msg}` }]);
      drawLive();
      heartbeat?.bump();
      return;
    }
    state = result.state;
    if (result.permanent.length > 0) {
      eraseLive();
      writePermanent(result.permanent);
      drawLive();
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
      eraseLive();
      if (bracketedPaste) disableBracketedPasteOn(write);
      if (stdin !== undefined) disableRawMode(stdin);
    },
  };
};
