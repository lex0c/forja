// Footer line render. Spec: UI.md §4.10.6.

import type { LiveState } from '../state.ts';
import { type Capabilities, paint } from '../term.ts';
import { FRAME_MARGIN, FRAME_MARGIN_WIDTH } from './frame.ts';
import { isBashMode, isTurnRunning } from './mode.ts';
import { visualWidth } from './width.ts';

const formatTokens = (n: number): string => {
  if (n < 1000) return `${n} tokens`;
  if (n < 10_000) {
    const k = n / 1000;
    const rounded = Math.round(k * 10) / 10;
    return rounded === Math.floor(rounded)
      ? `${rounded.toFixed(0)}k tokens`
      : `${rounded.toFixed(1)}k tokens`;
  }
  if (n < 1_000_000) return `${Math.round(n / 1000)}k tokens`;
  const m = n / 1_000_000;
  const rounded = Math.round(m * 10) / 10;
  return rounded === Math.floor(rounded)
    ? `${rounded.toFixed(0)}M tokens`
    : `${rounded.toFixed(1)}M tokens`;
};

const CONTEXT_WARN_THRESHOLD = 0.8;

// "Can the operator interrupt right now?" — true across the WHOLE turn,
// not just the instants a tool or stream is live. It must include
// `awaitingProvider` (the model deliberating before the first token —
// often the LONGEST phase of a turn); without it the
// predicate flickers off during that wait and the footer falls back
// to the idle `\+Enter newline` hint mid-turn, hiding the load-bearing
// interrupt cue (the two segments are mutually exclusive on this).
// Shared with the bash-mode predicate — see render/mode.ts.
const isRunning = isTurnRunning;

// `secondary` (SGR 90) rather than `dim` (SGR 2): xterm with default
// config renders SGR 2 identical to the default foreground, so
// faint-painted cues become invisible.
const dim = (caps: Capabilities, s: string): string => paint(caps, 'secondary', s);

export const renderFooter = (state: LiveState, caps: Capabilities): string | null => {
  if (state.modal !== null) return null;

  // Bash mode (idle `!cmd`, not reverse-search-dimmed): the operator is
  // composing a shell command, so the normal footer cues (operation
  // mode / newline hint / model) are noise. Replace the whole line with
  // a single yellow shell-mode indicator. `isBashMode` is idle-gated
  // (render/mode.ts), so this never fires mid-turn — the interrupt cue
  // below stays visible while a turn runs even if the buffer starts
  // with `!`. Same predicate the input box + its rules use.
  if (isBashMode(state)) {
    return `${FRAME_MARGIN}${paint(caps, 'warn', '! for shell mode')}`;
  }

  const sep = dim(caps, ' · ');
  let left: string;
  if (state.exitArmed !== null) {
    left = paint(caps, 'warn', 'Press Ctrl-C again to exit');
  } else if (state.slash !== null) {
    // Slash popover already shows actionable rows; the help hints
    // would compete with them for attention. Interrupt cue stays
    // because esc is still load-bearing if a run is in flight.
    const leftParts: string[] = [];
    if (isRunning(state)) {
      leftParts.push(dim(caps, state.softInterrupted ? 'esc again to force' : 'esc to interrupt'));
    }
    left = leftParts.join(sep);
  } else {
    // Operation mode replaces the old `? for help` cue (UI.md §4.10.6):
    // `supervised mode on` in accent (blue), `autonomous mode on` in
    // warn (yellow), each with a secondary "(shift+tab to change)"
    // affordance. `?` still opens help (the editor maps it on an empty
    // buffer); it just loses its dedicated footer hint.
    const autonomous = state.status.operationMode === 'autonomous';
    const modeLabel = paint(
      caps,
      autonomous ? 'warn' : 'accent',
      autonomous ? 'autonomous mode on' : 'supervised mode on',
    );
    const leftParts = [`${modeLabel}${dim(caps, ' (shift+tab to change)')}`];
    if (isRunning(state)) {
      // During a turn the operator isn't composing input, so the
      // newline affordance is noise — and it's the segment that pushes
      // the load-bearing interrupt cue past the right edge on narrow
      // (80-col) terminals. Surface the interrupt cue instead.
      leftParts.push(dim(caps, state.softInterrupted ? 'esc again to force' : 'esc to interrupt'));
    } else {
      // Idle: the operator can type, so surface the multiline
      // continuation affordance for terminals/WMs that eat Shift+Enter
      // — the input editor accepts `\` + Enter (UI.md §5.4).
      leftParts.push(dim(caps, '\\+Enter newline'));
    }
    left = leftParts.join(sep);
  }

  const status = state.status;
  const rightParts: string[] = [];
  // Selected effort level (leftmost of the right cluster). Seeded at
  // boot from config/DEFAULT_EFFORT, updated live on `/effort`.
  if (status.effort !== null) {
    rightParts.push(dim(caps, `effort: ${status.effort}`));
  }
  if (status.model !== null && status.model !== '') {
    rightParts.push(dim(caps, status.model));
  }
  if (status.sessionTotalTokens > 0) {
    rightParts.push(dim(caps, formatTokens(status.sessionTotalTokens)));
  }
  // Both fields required: rendering `0% context used` against an
  // unknown window would mislead the operator.
  if (status.contextWindow > 0 && status.lastTurnContextTokens > 0) {
    const ratio = status.lastTurnContextTokens / status.contextWindow;
    const pct = Math.min(100, Math.max(0, Math.round(ratio * 100)));
    const text = `${pct}% context used`;
    rightParts.push(ratio >= CONTEXT_WARN_THRESHOLD ? paint(caps, 'warn', text) : dim(caps, text));
  }
  const right = rightParts.join(sep);

  const leftW = visualWidth(left);
  const rightW = visualWidth(right);
  // Symmetric margins (UI.md §6.3): 2sp on the left already, mirror
  // it on the right so the trailing chip (model name in particular)
  // doesn't kiss the terminal edge.
  const padding = ' '.repeat(Math.max(0, caps.cols - 2 * FRAME_MARGIN_WIDTH - leftW - rightW));
  return `${FRAME_MARGIN}${left}${padding}${right}${FRAME_MARGIN}`;
};
