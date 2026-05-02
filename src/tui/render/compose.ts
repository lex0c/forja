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

// Position the cursor wants to land inside the live region, so the
// renderer can issue cursor-back escapes after writing. Coordinates
// are 0-based from the top-left of the live region. Returns null when
// no input is rendered (modal is up — modal owns the bottom slot).
//
// `lineCount` is the size of `composeLive`'s output for the same
// state. We pass it instead of recomputing because the renderer
// already has it.
//
// LAYOUT COUPLING — composeCursor assumes the input box is the LAST
// block emitted by composeLive (so `lineCount - inputLineCount` =
// input start row). True today; breaks the moment 1.e.4 lands a
// footer below the input. When that slice arrives, either subtract
// the footer's line count here too, or refactor composeLive to
// return `{lines, inputStartRow}` so this function reads the value
// directly. TODO(1.e.4): revisit.
//
// Visual columns assume single-width text (ASCII). CJK/emoji would
// under-count by 1 col per double-width glyph; producers don't emit
// multi-col text in the input today.
export interface CursorPos {
  row: number;
  col: number;
}
export const composeCursor = (
  state: LiveState,
  caps: Capabilities,
  lineCount: number,
): CursorPos | null => {
  if (state.modal !== null) return null;
  const value = state.input.value;
  const inputLineCount = value === '' ? 1 : value.split('\n').length;
  const inputStartRow = lineCount - inputLineCount;
  const before = value.slice(0, state.input.cursor);
  const linesBefore = before.split('\n');
  const cursorLineIdx = linesBefore.length - 1;
  const cursorColInLine = (linesBefore[cursorLineIdx] ?? '').length;
  // Both '> ' (first line) and '  ' (continuation) are 2 chars wide.
  const prefixWidth = 2;
  // Clamp to caps.cols - 1 so cursor stays on-screen for buffers
  // wider than the terminal. Without this, cursorForward overshoots
  // and either the terminal clamps (cursor "lost" at edge) or
  // auto-wraps to the next row (eraseLive math then walks the wrong
  // number of rows back). Buffer scrolling within the input box
  // is future polish; clamp is the safety floor.
  return {
    row: inputStartRow + cursorLineIdx,
    col: Math.min(prefixWidth + cursorColInLine, Math.max(0, caps.cols - 1)),
  };
};

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
