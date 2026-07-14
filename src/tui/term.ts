// Terminal primitives for the inline TUI. No framework — just raw ANSI
// escape codes and stdin/stdout coordination. Spec: UI.md §1, §2, §8.
//
// Three concerns live here: capability detection (isTTY/cols/color/unicode),
// stateful mode toggles (raw, bracketed paste), and ANSI helpers (cursor,
// clear, color). Frame scheduling lives at the bottom.

import { EventEmitter } from 'node:events';

// One-shot capabilities probed at boot. cols/rows are mutable via SIGWINCH
// (use createResizeWatcher for live updates); the rest is fixed for the
// life of the session — re-detection mid-run buys nothing and risks
// flicker.
export interface Capabilities {
  isTTY: boolean;
  cols: number;
  rows: number;
  // 'none' = no escapes. 'basic' = 16-color (\x1b[3xm) only — we don't
  // track 256/truecolor because the palette is grayscale + 1 accent.
  color: 'none' | 'basic';
  unicode: boolean;
}

export interface DetectOptions {
  // Streams + env are injectable so tests can probe deterministically
  // without monkey-patching globals. Defaults match production.
  stdout?: { isTTY?: boolean; columns?: number; rows?: number };
  env?: Record<string, string | undefined>;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export const detectCapabilities = (opts: DetectOptions = {}): Capabilities => {
  const stdout = opts.stdout ?? process.stdout;
  const env = opts.env ?? process.env;
  const isTTY = stdout.isTTY === true;
  const cols = stdout.columns ?? DEFAULT_COLS;
  const rows = stdout.rows ?? DEFAULT_ROWS;
  // NO_COLOR per https://no-color.org/ — any value disables color, env
  // presence alone is enough. CLICOLOR_FORCE wins over !isTTY (used in
  // CI log capture). Otherwise: TTY gates color.
  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== '';
  const force = env.CLICOLOR_FORCE === '1';
  const color: Capabilities['color'] = noColor ? 'none' : force || isTTY ? 'basic' : 'none';
  // Unicode detection is conservative: only enable when locale advertises
  // UTF-8. Anything else falls back to ASCII glyphs (UI.md §6.2). We
  // explicitly do NOT probe by writing a multibyte char and reading width
  // back — that would block startup and is unreliable on slow terminals.
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? '';
  const unicode = /UTF-?8/i.test(locale);
  return { isTTY, cols, rows, color, unicode };
};

// ─── ANSI helpers ─────────────────────────────────────────────────────────
//
// Lowercase escape names mirror common references (curses, blessed).
// Strings, not functions, where possible — call sites concatenate.

export const ESC = '\x1b';
export const CSI = `${ESC}[`;

// Cursor movement. Bounded by terminal; off-screen moves are clamped by
// the terminal itself (no defensive math here).
export const cursorUp = (n: number): string => (n <= 0 ? '' : `${CSI}${n}A`);
export const cursorDown = (n: number): string => (n <= 0 ? '' : `${CSI}${n}B`);
export const cursorBack = (n: number): string => (n <= 0 ? '' : `${CSI}${n}D`);
export const cursorForward = (n: number): string => (n <= 0 ? '' : `${CSI}${n}C`);
// 1-indexed (terminal convention). row=1,col=1 = top-left.
export const cursorTo = (row: number, col: number): string => `${CSI}${row};${col}H`;
export const cursorHide = `${CSI}?25l`;
export const cursorShow = `${CSI}?25h`;

// Erase. clearLine erases just the current line; clearDown erases from
// cursor to bottom (used by the live-region redraw — UI.md §2.2).
export const clearLine = `${CSI}2K`;
export const clearDown = `${CSI}J`;

// Bracketed paste (DECSET 2004). When enabled, terminals wrap pasted text
// in \x1b[200~ … \x1b[201~ so the parser can batch it instead of treating
// each char as a keystroke (UI.md §5.1).
export const enableBracketedPaste = `${CSI}?2004h`;
export const disableBracketedPaste = `${CSI}?2004l`;

// Synchronized output (DECSET 2026). Wraps a write so the terminal
// buffers the bytes between BSU/ESU and presents the resulting frame
// atomically — no incremental rasterization of "cursor-up + clear →
// content" pinned to the redraw cycle, which the operator perceives
// as flicker on the static lines (status, footer, rules) surrounding
// the input box. Terminals without support silently ignore (it's a
// private mode; safe to emit unconditionally per the spec).
//
// Spec: https://gist.github.com/christianparpart/d8a62cc1ab659194337d73e399004036
// Supported by: kitty, iTerm2, alacritty, wezterm, recent gnome-terminal,
// recent konsole. Unsupported (no-op): xterm without patches, screen,
// most older emulators.
export const beginSyncOutput = `${CSI}?2026h`;
export const endSyncOutput = `${CSI}?2026l`;

// Paste marker constants for the key parser. Kept here so paste handling
// stays adjacent to its escape-code definition.
export const BRACKETED_PASTE_START = `${CSI}200~`;
export const BRACKETED_PASTE_END = `${CSI}201~`;

// Color SGR codes. Names match UI.md §6.1 tokens (reset, dim, bold,
// error, warn, success). The original UI spec restricted the palette
// to greyscale + the three state colors (success/warn/error) and
// excluded blue/cyan/magenta — see UI.md §6.4 line 951. The `accent`
// token below is an operator-authorized deviation (used for the
// modal's top rule so the structural anchor reads visually distinct
// from surrounding dim text); a future spec amendment can codify it.
export const SGR = {
  reset: `${CSI}0m`,
  dim: `${CSI}2m`,
  // `secondary` is the visible-grey variant of dim, used for meta
  // that must stand out from the primary content (turn-end marker
  // `Worked for X`). SGR 2 (faint) is invisible on many xterm
  // configs; SGR 90 (bright-black ≈ grey) is universal. Distinct
  // token from `dim` so we don't recolor every dim element on the
  // screen — rules, footer hints, sub-content connectors stay in
  // SGR 2 (rendered same as default on terminals that don't
  // distinguish faint, but that's deliberate).
  secondary: `${CSI}90m`,
  // `accent` (SGR 94 = bright blue) for structural anchors that
  // need to stand out from greyscale meta. Reserved for layout
  // chrome (modal top rule today; future: section dividers, status
  // anchors) — NOT for content. Adding more colors at this token
  // requires a spec amendment to UI.md §6.4; keep this scope tight
  // until then.
  accent: `${CSI}94m`,
  // `accentDark` (SGR 34 = blue, non-bright) — a quieter blue than
  // `accent`, for footer cues (`? for help`) that should read as
  // interactive without a structural anchor's brightness.
  // Operator-authorized like `accent`; same UI.md §6.4 amendment owed.
  accentDark: `${CSI}34m`,
  bold: `${CSI}1m`,
  // Text attributes (not colors) for inline Markdown — `emphasis`
  // and `~~delete~~`. Landed with the markdown-render slice; they
  // degrade gracefully on terminals that ignore them. UI.md §6
  // codifies the palette/typography evolution afterwards.
  italic: `${CSI}3m`,
  strikethrough: `${CSI}9m`,
  error: `${CSI}31m`,
  warn: `${CSI}33m`,
  success: `${CSI}32m`,
} as const;
export type SgrToken = keyof typeof SGR;

// Apply SGR token, skipping when color is disabled. Single helper instead
// of per-color wrappers because every renderer flows through one path.
export const paint = (caps: Pick<Capabilities, 'color'>, token: SgrToken, text: string): string =>
  caps.color === 'none' ? text : `${SGR[token]}${text}${SGR.reset}`;

// Apply multiple SGR tokens with a single trailing reset. Use when
// stacking attributes (e.g. accent + bold for the modal title) —
// nested `paint(paint(...))` works but emits a redundant inner
// `\x1b[0m` that some terminals re-process as a flash. Empty tokens
// list returns the bare text. Order is preserved (outer-first), but
// SGR cascading is order-independent for the supported tokens
// (color and weight stack regardless).
export const paintMulti = (
  caps: Pick<Capabilities, 'color'>,
  tokens: readonly SgrToken[],
  text: string,
): string => {
  if (caps.color === 'none' || tokens.length === 0) return text;
  return `${tokens.map((t) => SGR[t]).join('')}${text}${SGR.reset}`;
};

// Reverse video (SGR 7). Spec UI.md §4.10.8: reverse is an attribute,
// not a color — it works under NO_COLOR (a black-on-white bar still
// renders, just without color). Always emits the escape regardless of
// `caps.color` because the use case (user-submit echo as scrollback
// divider) depends on the visual contrast even in plain terminals.
export const reverse = (text: string): string => `${CSI}7m${text}${SGR.reset}`;

// ─── Mode toggles ─────────────────────────────────────────────────────────
//
// Raw mode is process-wide state. The spec (UI.md §12) requires restoring
// stdin mode on every exit path — do NOT scatter setRawMode calls; route
// them through enable/disableRawMode so the saved state lives in one
// place and uncaughtException can call disableRawMode safely.

// Shape of the bit of stdin we touch. Defined locally instead of
// extending NodeJS.ReadStream so strict optional-property semantics
// don't trip on the upstream `setRawMode` return type.
export interface RawModeStdin {
  setRawMode?: (mode: boolean) => unknown;
}

let rawModeActive = false;
let bracketedPasteActive = false;

export const enableRawMode = (stdin: RawModeStdin = process.stdin as RawModeStdin): boolean => {
  if (typeof stdin.setRawMode !== 'function') return false;
  if (!rawModeActive) {
    stdin.setRawMode(true);
    rawModeActive = true;
  }
  return true;
};

export const disableRawMode = (stdin: RawModeStdin = process.stdin as RawModeStdin): void => {
  if (typeof stdin.setRawMode !== 'function') return;
  if (rawModeActive) {
    stdin.setRawMode(false);
    rawModeActive = false;
  }
};

export const isRawModeActive = (): boolean => rawModeActive;

// Bracketed paste write helpers. Separate from raw mode because tests
// inject a fake stdout sink, and because bracketed paste is meaningful
// even outside raw mode (e.g. headless replay tools).
export const enableBracketedPasteOn = (write: (s: string) => void): void => {
  if (!bracketedPasteActive) {
    write(enableBracketedPaste);
    bracketedPasteActive = true;
  }
};

export const disableBracketedPasteOn = (write: (s: string) => void): void => {
  if (bracketedPasteActive) {
    write(disableBracketedPaste);
    bracketedPasteActive = false;
  }
};

export const isBracketedPasteActive = (): boolean => bracketedPasteActive;

// ─── Resize watcher ───────────────────────────────────────────────────────
//
// Wraps SIGWINCH + the stdout 'resize' event into a single subscription.
// We listen on 'resize' because it fires more reliably than SIGWINCH on
// some terminals (e.g. iTerm with split panes); SIGWINCH is the fallback
// for environments where the stream event is missing.

export interface ResizeEvent {
  cols: number;
  rows: number;
}

export interface ResizeStream {
  columns?: number;
  rows?: number;
  on: (event: 'resize', listener: () => void) => unknown;
  off: (event: 'resize', listener: () => void) => unknown;
}

export const createResizeWatcher = (
  stdout: ResizeStream = process.stdout as unknown as ResizeStream,
): { onResize: (handler: (e: ResizeEvent) => void) => () => void; close: () => void } => {
  const emitter = new EventEmitter();
  const pump = (): void => {
    emitter.emit('resize', {
      cols: stdout.columns ?? DEFAULT_COLS,
      rows: stdout.rows ?? DEFAULT_ROWS,
    });
  };
  stdout.on('resize', pump);
  // SIGWINCH is the POSIX signal; node forwards stream resize from it.
  // Belt-and-suspenders: we register both. On Bun the signal handler is
  // a no-op when the stream event is what fires, but it covers older
  // terminals that don't emit the stream event.
  const sigwinch = (): void => pump();
  if (typeof process.on === 'function') process.on('SIGWINCH', sigwinch);
  return {
    onResize: (handler) => {
      emitter.on('resize', handler);
      return () => emitter.off('resize', handler);
    },
    close: () => {
      stdout.off('resize', pump);
      if (typeof process.off === 'function') process.off('SIGWINCH', sigwinch);
      emitter.removeAllListeners();
    },
  };
};

// ─── Frame scheduler ──────────────────────────────────────────────────────
//
// Coalesces redraw requests into at most one render per frame. Spec:
// UI.md §10 — 30fps soft, 60fps in bursts. We aim for the soft target
// (33ms) by default; callers can pass higher fps for tests or animation
// bursts. The scheduler is intentionally simple: a single dirty flag +
// setTimeout. No requestAnimationFrame, no priorities — the live region
// is small enough that "draw soon, draw once" is the only invariant.
//
// `flush()` forces an immediate render, used at the end of an event
// burst (e.g. `assistant:end`) when latency matters more than batching.

export interface FrameSchedulerOptions {
  fps?: number;
  // Inject for tests so the scheduler is deterministic. Production uses
  // setTimeout/clearTimeout from the runtime.
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface FrameScheduler {
  request: () => void;
  flush: () => void;
  close: () => void;
}

export const createFrameScheduler = (
  render: () => void,
  options: FrameSchedulerOptions = {},
): FrameScheduler => {
  const fps = options.fps ?? 30;
  const intervalMs = Math.max(1, Math.floor(1000 / fps));
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let closed = false;

  const fire = (): void => {
    timer = null;
    if (closed) return;
    render();
  };

  return {
    request: () => {
      if (closed || timer !== null) return;
      timer = setTimer(fire, intervalMs);
    },
    flush: () => {
      if (closed) return;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      render();
    },
    close: () => {
      closed = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
};
