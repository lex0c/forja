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

// Per-segment paint helper. Each token gets its own dim wrap so a
// future shading layer (e.g., budget warn at 80%, error at 90% per
// spec §4.4) can replace individual tokens without fighting an outer
// dim wrap that paints over everything.
const dim = (caps: Capabilities, s: string): string => paint(caps, 'dim', s);

export const renderFooter = (state: LiveState, caps: Capabilities): string | null => {
  // Modal owns the bottom slot — composeLive already suppresses the
  // input box; suppress the footer too so the modal isn't sandwiched
  // by an unrelated status line.
  if (state.modal !== null) return null;

  // Left column: hint + interrupt cue (interrupt only when running).
  const leftParts = [dim(caps, '? for help')];
  if (isRunning(state)) leftParts.push(dim(caps, 'esc to interrupt'));
  const sep = dim(caps, ' · ');
  const left = leftParts.join(sep);

  // Right column: shown only when a session is running (single
  // sessionId gate so all segments appear or none — avoids the
  // "model present but steps/cost missing" half-state). When absent,
  // the line is just the help hint on the left.
  const status = state.status;
  const rightParts: string[] = [];
  if (status.sessionId !== null) {
    rightParts.push(dim(caps, `• ${status.model ?? ''}`));
    if (status.planMode) rightParts.push(dim(caps, 'plan'));
    if (status.maxSteps > 0) rightParts.push(dim(caps, `${status.steps}/${status.maxSteps}`));
    rightParts.push(dim(caps, formatCost(status.costUsd)));
  }
  const right = rightParts.join(sep);

  // Pad middle so right anchors to caps.cols. When content overflows
  // (long model name + budget pushing past the terminal width), the
  // pad clamps to 0 (left and right collapse together) and the
  // renderer's truncateToWidth clips the right end. Acceptable
  // degradation; future polish can drop low-priority tokens (cost
  // label, then steps, then plan) before truncation kicks in.
  const leftW = visualWidth(left);
  const rightW = visualWidth(right);
  const padding = ' '.repeat(Math.max(0, caps.cols - leftW - rightW));
  return `${left}${padding}${right}`;
};
