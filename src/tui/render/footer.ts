// Footer line render. Spec: UI.md §4.10.6.

import type { LiveState } from '../state.ts';
import { type Capabilities, paint } from '../term.ts';
import { FRAME_MARGIN, FRAME_MARGIN_WIDTH } from './frame.ts';
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

const isRunning = (state: LiveState): boolean =>
  state.activeTools.size > 0 || state.thinking !== null || state.pendingAssistant !== null;

// `secondary` (SGR 90) rather than `dim` (SGR 2): xterm with default
// config renders SGR 2 identical to the default foreground, so
// faint-painted cues become invisible.
const dim = (caps: Capabilities, s: string): string => paint(caps, 'secondary', s);

export const renderFooter = (state: LiveState, caps: Capabilities): string | null => {
  if (state.modal !== null) return null;

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
    // Supervised in accent (blue), Autonomous in warn (yellow), each
    // with a secondary "(shift+tab to change)" affordance. `?` still
    // opens help (the editor maps it on an empty buffer); it just loses
    // its dedicated footer hint.
    const autonomous = state.status.operationMode === 'autonomous';
    const modeLabel = paint(
      caps,
      autonomous ? 'warn' : 'accent',
      autonomous ? 'Autonomous' : 'Supervised',
    );
    const leftParts = [
      `${modeLabel}${dim(caps, ' (shift+tab to change)')}`,
      // Discoverability cue for operators on terminals/WMs that
      // eat Shift+Enter — the input editor accepts `\` + Enter
      // as a multiline continuation (UI.md §5.4).
      dim(caps, '\\+Enter newline'),
    ];
    if (isRunning(state)) {
      leftParts.push(dim(caps, state.softInterrupted ? 'esc again to force' : 'esc to interrupt'));
    }
    left = leftParts.join(sep);
  }

  const status = state.status;
  const rightParts: string[] = [];
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
  // Cache hit-rate across the REPL session. Denominator is "input
  // billed" (input + cacheRead + cacheCreation); numerator is what
  // arrived cached. Suppressed until any usage event has landed so
  // we don't show `0% cached` against zero traffic.
  const inputBilled =
    status.sessionUncachedInput + status.sessionCacheRead + status.sessionCacheCreation;
  if (inputBilled > 0) {
    const pct = Math.round((status.sessionCacheRead / inputBilled) * 100);
    rightParts.push(dim(caps, `${pct}% cached`));
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
