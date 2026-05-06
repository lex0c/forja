// Footer line render. Spec: UI.md §4.10.6.
//
// One line at the bottom of the live region (below the input + a rule).
// Two columns: left = "what can I do right now?" (help hint + contextual
// interrupt cue); right = "what's in effect?" (model + plan + budget +
// cost). Modal up suppresses the footer entirely — modal owns the
// bottom slot and carries its own hint line.
//
// Returns null when caller wants to omit the footer — kept consistent
// with status.ts's "null = skip the line" convention.

import type { LiveState } from '../state.ts';
import { type Capabilities, paint } from '../term.ts';
import { FRAME_MARGIN, FRAME_MARGIN_WIDTH } from './frame.ts';
import { visualWidth } from './width.ts';

const formatCost = (usd: number): string => {
  if (usd >= 100) return `$${usd.toFixed(2)}`;
  if (usd >= 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
};

// True iff something is animating in the live region (a tool is
// running, the model is generating text, or thinking is active).
// Drives the contextual "esc to interrupt" hint.
const isRunning = (state: LiveState): boolean =>
  state.activeTools.size > 0 || state.thinking !== null || state.pendingAssistant !== null;

// Per-segment paint helper. Each token gets its own `secondary`
// wrap (UI.md §6.1, SGR 90 / bright-black ≈ grey) so a future
// shading layer (budget warn at 80%, error at 90% per §4.4) can
// replace individual tokens without fighting an outer wrap.
//
// Token used to be `dim` (SGR 2, faint), but xterm with default
// config renders SGR 2 identical to the default foreground —
// operators couldn't tell the footer cue from primary content,
// and the `? for help` hint visually disappeared. `secondary`
// renders as visible grey on every terminal. Local helper name
// stayed `dim` for prose-readability — every line below `dim(...)`
// is the footer's "secondary" token applied to one token.
const dim = (caps: Capabilities, s: string): string => paint(caps, 'secondary', s);

export const renderFooter = (state: LiveState, caps: Capabilities): string | null => {
  // Modal owns the bottom slot — composeLive already suppresses the
  // input box; suppress the footer too so the modal isn't sandwiched
  // by an unrelated status line.
  if (state.modal !== null) return null;

  // Left column: hint + interrupt cue. While running, the cue starts
  // as "esc to interrupt"; once the operator hits Esc once
  // (softInterrupted flips true via the reducer), it swaps to
  // "esc again to force" per spec §4.10.6 — telling the operator
  // the loop has acknowledged the request and is winding down.
  // softInterrupted clears on session boundaries, so a fresh turn
  // starts back on "esc to interrupt".
  //
  // Idle exit-armed (UI.md §5.4 + §4.10.6 row "Idle, exit armed")
  // takes over the entire left column with a `warn`-painted cue.
  // Higher precedence than the help hint because the operator's
  // next action is now load-bearing — they're 1 keystroke from a
  // 130 exit, and we owe them the loudest signal we have.
  const sep = dim(caps, ' · ');
  let left: string;
  if (state.exitArmed !== null) {
    left = paint(caps, 'warn', 'Press Ctrl-C again to exit');
  } else {
    const leftParts = [
      dim(caps, '? for help'),
      // `\+Enter` newline hint pairs with the input editor's
      // backslash-continuation feature (UI.md §5.4): operators on
      // terminals/WMs that eat Shift+Enter need a discoverable way
      // to insert a newline mid-buffer, so the cue lives in the
      // footer next to `? for help` (the other "things you can
      // press" entry).
      dim(caps, '\\+Enter newline'),
    ];
    if (isRunning(state)) {
      leftParts.push(dim(caps, state.softInterrupted ? 'esc again to force' : 'esc to interrupt'));
    }
    left = leftParts.join(sep);
  }

  // Right column: shown only when a session is running (single
  // sessionId gate so all segments appear or none — avoids the
  // "model present but steps/cost missing" half-state). When absent,
  // the line is just the help hint on the left.
  // Order tracks spec UI.md §4.4 line 245 (the only concrete example
  // with bg present): `model · [plan] · steps/max · cost · [bg N]`.
  // Spec §4.10.6 line 480 lists bg's removal priority as "less sticky
  // than cost" (drops before cost when terminal is narrow), reinforcing
  // the trailing position.
  const status = state.status;
  const rightParts: string[] = [];
  if (status.sessionId !== null) {
    rightParts.push(dim(caps, `• ${status.model ?? ''}`));
    if (status.planMode) rightParts.push(dim(caps, 'plan'));
    if (status.maxSteps > 0) rightParts.push(dim(caps, `${status.steps}/${status.maxSteps}`));
    rightParts.push(dim(caps, formatCost(status.costUsd)));
    if (state.bgProcesses.size > 0) {
      rightParts.push(dim(caps, `bg ${state.bgProcesses.size}`));
    }
    // Active subagent counter. Sits next to `bg` because both
    // are operator-facing in-flight indicators that drop early
    // when the line is narrow (UI.md §4.10.6). Shown only when
    // the count is > 0; same suppression rule as bg.
    //
    // `state.subagents` is populated by the harness adapter from
    // `subagent_start` / `subagent_finished` events — those fire
    // for BOTH sync `task` runs AND async `task_async` runs. The
    // counter is therefore "live subagent runs" regardless of
    // surface. The `/subagents` slash command, by contrast, only
    // lists async handles (those persisted in `subagent_handles`).
    // The two surfaces are complementary, not redundant: the
    // footer answers "is anything in flight right now"; the
    // slash answers "what async handles can I task_await".
    // Subagents chip. Two variants:
    //   - `parallelStatus` populated (D234): show
    //     `subagents R+Q/cap` so the operator sees the queue
    //     depth alongside the running count. Suppressed when
    //     R+Q === 0.
    //   - `parallelStatus === null` (no event yet — pre-task
    //     surface activity): fall back to `subagents N` from
    //     the live-row map. Same suppression at zero.
    // The fallback covers the brief window between
    // `subagent:start` and the first `parallel:status` event,
    // and any future surface that bypasses the harness's
    // emission. Both branches feed the same operator-visible
    // chip — the layout slot is identical.
    if (state.parallelStatus !== null) {
      const ps = state.parallelStatus;
      const total = ps.subagentsRunning + ps.subagentsQueued;
      if (total > 0) {
        const queueChip = ps.subagentsQueued > 0 ? `+${ps.subagentsQueued}` : '';
        rightParts.push(
          dim(caps, `subagents ${ps.subagentsRunning}${queueChip}/${ps.subagentsCap}`),
        );
      }
      // Tools chip — only when more than one tool is in flight
      // through the parallel-tool dispatcher. A single tool is
      // visible via the per-tool card; the chip exists to
      // surface "running multiple in parallel" specifically.
      if (ps.toolsRunning > 1 && ps.toolsCap > 0) {
        rightParts.push(dim(caps, `tools ${ps.toolsRunning}/${ps.toolsCap}`));
      }
    } else if (state.subagents.size > 0) {
      rightParts.push(dim(caps, `subagents ${state.subagents.size}`));
    }
    // Memory count. Sits AFTER bg per spec
    // §4.10.6 "less sticky" priority — bg already drops first when
    // the line is narrow; memory drops second. The token uses `mem`
    // not `memory` to keep it under 6 chars (the right column gets
    // crowded fast on 80-col terminals). Suppressed when count is
    // zero so an operator without any memories doesn't see a dead
    // segment.
    if (status.memoryCount > 0) {
      rightParts.push(dim(caps, `mem ${status.memoryCount}`));
    }
  }
  const right = rightParts.join(sep);

  // Pad middle so right anchors to col `caps.cols - 1`. The frame
  // margin (UI.md §6.3, 2sp left) is prepended outside this math:
  // total line width stays caps.cols, with FRAME_MARGIN + left + middle
  // padding + right. When content overflows the available width
  // (cols - margin), the pad clamps to 0 (left and right collapse
  // together) and the renderer's truncateToWidth clips the right end.
  // Acceptable degradation; future polish can drop low-priority
  // tokens (cost label, then steps, then plan) before truncation.
  const leftW = visualWidth(left);
  const rightW = visualWidth(right);
  const padding = ' '.repeat(Math.max(0, caps.cols - FRAME_MARGIN_WIDTH - leftW - rightW));
  return `${FRAME_MARGIN}${left}${padding}${right}`;
};
