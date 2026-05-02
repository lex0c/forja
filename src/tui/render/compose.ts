// Live region composition. Combines the per-element render functions
// (status line, input box, tool cards) into the array of lines the
// renderer writes. Spec: UI.md §2, §4, §4.10.
//
// Layout (top → bottom of live region):
//   1. Active tool cards (running form, with preview).
//   2. Status line (1 line — only when session has started).
//   3. Rule above input (full-width, dim) + input box (1+ lines)
//      — OR modal (when up), which owns the bottom slot entirely
//      and carries its own structure (no rule above it).
//
// Order matches the spec: history above (scrollback), then live tool
// activity, then status, then either the rule+input pair or the
// modal. Todos arrive in subsequent slices.

import type { ComposeLive } from '../renderer-types.ts';
import type { LiveState } from '../state.ts';
import { type Capabilities, paint } from '../term.ts';
import { renderInput } from './input.ts';
import { renderModal } from './modal.ts';
import { renderStatusLine } from './status.ts';
import { renderToolCardLive } from './tool-card.ts';

const ruleAboveInput = (caps: Capabilities): string =>
  paint(caps, 'dim', (caps.unicode ? '─' : '-').repeat(caps.cols));

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

  // 3. Modal OR (rule + input) — never both. The modal owns the
  // bottom of the live region while it's up (no rule above it; the
  // modal carries its own structure). Status line + tool cards stay
  // visible above so the user keeps context.
  if (state.modal !== null) {
    lines.push(...renderModal(state.modal, caps));
  } else {
    lines.push(ruleAboveInput(caps));
    lines.push(...renderInput(state.input, caps));
  }

  return lines;
};
