// Live-region renderer. Spec: UI.md §2, §10.
//
// Owns the redraw cycle for the inline TUI:
//   1. subscribe to the bus (UIEvent stream)
//   2. fold each event into LiveState via applyEvent
//   3. emit `permanent` lines to stdout (they become scrollback)
//   4. clear the previous live region and write the new one
//
// Mechanics-only: no render functions for tool cards or modals live
// here. The caller injects a `composeLive(state) -> string[]` so the
// renderer stays agnostic to layout. A minimal default is provided
// (input + status placeholder) so the foundation is testable end-to-end
// before render functions land in the next slice.
//
// Frame coalescing: multiple events arriving within one frame budget
// produce a single redraw. Permanent lines bypass the scheduler — they
// must hit stdout before the new live state, since they shape the
// scrollback above the live region.

import type { Bus } from './bus.ts';
import type { UIEvent } from './events.ts';
import { type ApplyResult, type LiveState, applyEvent, createInitialState } from './state.ts';
import {
  type Capabilities,
  type FrameSchedulerOptions,
  type RawModeStdin,
  clearDown,
  createFrameScheduler,
  cursorUp,
  disableBracketedPasteOn,
  disableRawMode,
  enableBracketedPasteOn,
  enableRawMode,
} from './term.ts';

export type ComposeLive = (state: LiveState, caps: Capabilities) => string[];

// Default compose: a single status placeholder + the input prompt. Just
// enough to be visible end-to-end. Replaced by the proper render
// functions (`renderStatusLine`, `renderInput`, `renderToolCard`...) in
// the next slice. Keeping it minimal here avoids tying renderer
// mechanics to layout decisions that may yet shift.
export const defaultComposeLive: ComposeLive = (state) => {
  const lines: string[] = [];
  // Active-tool stub: one line per running tool, glyph + name + args.
  // Final, formatted card output happens in `applyEvent` (permanent).
  for (const tool of state.activeTools.values()) {
    lines.push(`> ${tool.name} ${tool.args}`);
  }
  // Status line stub. Real render comes with the status-line function;
  // here we just surface enough state to verify wiring.
  const s = state.status;
  if (s.sessionId !== null) {
    const steps = s.maxSteps > 0 ? `${s.steps}/${s.maxSteps}` : `${s.steps}`;
    const cost = `$${s.costUsd.toFixed(4)}`;
    lines.push(
      `[${s.profile ?? '-'}] ${s.project ?? '-'} · ${s.model ?? '-'} · ${steps} · ${cost}`,
    );
  }
  // Input box.
  lines.push(`> ${state.input.value}`);
  return lines;
};

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
  // Frame scheduler tuning. Tests inject deterministic timers.
  schedulerOptions?: FrameSchedulerOptions;
  // When true (default), enable bracketed paste at start and disable
  // at close. Disable in tests where the writes pollute assertions.
  bracketedPaste?: boolean;
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

const truncate = (line: string, maxCols: number): string => {
  // We do NOT use `string-width` here yet — the dep arrives with the
  // proper render functions (UI.md §1). Until then, JS code-unit
  // length approximates display width within ASCII; multibyte CJK
  // and emoji may render wider than expected, but that's a layout
  // bug, not a correctness bug — the cursor math still tracks
  // because we always know how many newlines we wrote.
  if (maxCols <= 0) return '';
  if (line.length <= maxCols) return line;
  return line.slice(0, maxCols);
};

export const createRenderer = (options: RendererOptions): Renderer => {
  const {
    bus,
    caps,
    write = (s) => {
      process.stdout.write(s);
    },
    composeLive = defaultComposeLive,
    stdin,
    schedulerOptions,
    bracketedPaste = true,
  } = options;

  let state = createInitialState();
  // Number of lines written by the last `drawLive`. Used to compute
  // how many lines to clear on the next redraw.
  // TODO(1.c): wire createResizeWatcher so `caps.cols`/`rows` track
  // SIGWINCH. Today they're frozen at construction — a resize mid-run
  // truncates against the wrong width and may produce wrap-induced
  // ghost lines.
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
    const raw = composeLive(state, caps);
    if (raw.length === 0) {
      liveHeight = 0;
      return;
    }
    const truncated = raw.map((l) => truncate(l, caps.cols));
    write(truncated.join('\n'));
    liveHeight = truncated.length;
  };

  const writePermanent = (lines: string[]): void => {
    if (lines.length === 0) return;
    // Permanent lines must NOT be truncated — they're scrollback and
    // the user can scroll horizontally / wrap-view in their terminal.
    // (Live region is the only place width matters, because we have
    // to cursor-up to erase.)
    const text = `${lines.join('\n')}\n`;
    write(text);
  };

  // Public redraw — used by external triggers (resize, foreground
  // resume) and by the scheduler.
  const redraw = (): void => {
    if (closed) return;
    eraseLive();
    drawLive();
  };

  const scheduler = createFrameScheduler(redraw, schedulerOptions);

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
      writePermanent([`warn: renderer reducer error: ${msg}`]);
      drawLive();
      return;
    }
    state = result.state;
    if (result.permanent.length > 0) {
      eraseLive();
      writePermanent(result.permanent);
      drawLive();
      return;
    }
    scheduler.request();
  };

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
      scheduler.close();
      // Final clean live region so the prompt returns to a sane place.
      eraseLive();
      if (bracketedPaste) disableBracketedPasteOn(write);
      if (stdin !== undefined) disableRawMode(stdin);
    },
  };
};
