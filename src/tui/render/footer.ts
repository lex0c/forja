// Footer line render. Spec: UI.md §4.10.6.

import type { LiveState } from '../state.ts';
import { type Capabilities, paint } from '../term.ts';
import { FRAME_MARGIN, FRAME_MARGIN_WIDTH } from './frame.ts';
import { isBashMode } from './mode.ts';
import { visualWidth } from './width.ts';

// `unit` lets the same magnitude formatting drive both the `N tokens`
// (non-cache compute) and `N cached` chips — they share the k/M
// rounding rules, only the trailing label differs.
const formatTokens = (n: number, unit = 'tokens'): string => {
  if (n < 1000) return `${n} ${unit}`;
  if (n < 10_000) {
    const k = n / 1000;
    const rounded = Math.round(k * 10) / 10;
    return rounded === Math.floor(rounded)
      ? `${rounded.toFixed(0)}k ${unit}`
      : `${rounded.toFixed(1)}k ${unit}`;
  }
  if (n < 1_000_000) return `${Math.round(n / 1000)}k ${unit}`;
  const m = n / 1_000_000;
  const rounded = Math.round(m * 10) / 10;
  return rounded === Math.floor(rounded)
    ? `${rounded.toFixed(0)}M ${unit}`
    : `${rounded.toFixed(1)}M ${unit}`;
};

// REPL-cumulative spend for the footer's `$X.XX` chip. Two decimals
// match the session-end `formatDollars` (permanent.ts) so the cents
// the operator sees agree with the final figure. Sub-cent totals floor
// to `$0.00` — acceptable "negligible" signal; the chip is suppressed
// entirely at exactly $0 (see renderFooter).
const formatCost = (usd: number): string => `$${(Math.round(usd * 100) / 100).toFixed(2)}`;

// "Can the operator interrupt right now?" — keyed off `state.busy`, the
// renderer's mirror of the REPL's `isBusy()` (a foreground turn OR a
// playbook OR an operator `!cmd` in flight). It must cover ALL of those:
// Ctrl+C / Esc are wired to interrupt each (the turn abort, the playbook
// abort, the `!cmd` process-group kill), so the cue has to show whenever
// any is running — including a `!sleep 5` with no turn-local activity,
// which a render-derived turn-activity check would miss and fall back to
// the idle `\+Enter newline` hint, making a hung command look
// non-interruptible. `busy` spans the whole turn (set at startTurn,
// before `awaitingProvider`), so the cue never flickers off mid-turn.
const isRunning = (state: LiveState): boolean => state.busy;

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
  if (status.model !== null && status.model !== '') {
    rightParts.push(dim(caps, status.model));
  }
  // Non-cache compute (input + output) and cache (read + creation) are
  // shown as two disjoint chips that sum back to the grand total. Cache
  // is provider-reported and billed, but far cheaper than input, so the
  // operator wants it distinguishable from real compute.
  const cacheTokens = status.sessionCacheTokens;
  const nonCacheTokens = status.sessionTotalTokens - cacheTokens;
  if (nonCacheTokens > 0) {
    rightParts.push(dim(caps, formatTokens(nonCacheTokens)));
  }
  if (cacheTokens > 0) {
    rightParts.push(dim(caps, formatTokens(cacheTokens, 'cached')));
  }
  // REPL-cumulative spend, right beside the (also cumulative) token
  // count. Suppressed at exactly $0 (pre-first-turn / cost not yet
  // reported) so the chip doesn't render a meaningless `$0.00` on an
  // idle session.
  if (status.sessionTotalCostUsd > 0) {
    rightParts.push(dim(caps, formatCost(status.sessionTotalCostUsd)));
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
