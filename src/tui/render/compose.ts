// Live region composition. Combines the per-element render functions
// (status line, input box, tool cards) into the array of lines the
// renderer writes. Spec: UI.md §2, §4.
//
// Layout (top → bottom of live region):
//   1. Active tool cards (running form, with preview).
//   2. Status line (1 line — only when session has started).
//   3. Input box (1+ lines).
//
// Order matches the spec: history above (scrollback), then live tool
// activity, then status, then input at the bottom where the cursor
// lives. Modals and todos arrive in subsequent slices.

import type { ComposeLive } from '../renderer-types.ts';
import type { LiveState } from '../state.ts';
import type { Capabilities } from '../term.ts';
import { renderInput } from './input.ts';
import { renderStatusLine } from './status.ts';
import { renderToolCardLive } from './tool-card.ts';

export const composeLive: ComposeLive = (
  state: LiveState,
  caps: Capabilities,
  now: number,
): string[] => {
  const lines: string[] = [];

  // 1. Active tool cards (running). Map insertion order is preserved,
  // so the visual order matches the order tools were started.
  for (const tool of state.activeTools.values()) {
    lines.push(...renderToolCardLive(tool, caps, now));
  }

  // 2. Status line — only when session has started.
  const status = renderStatusLine(state, caps, { now });
  if (status !== null) lines.push(status);

  // 3. Input box — always present.
  lines.push(...renderInput(state.input, caps));

  return lines;
};
