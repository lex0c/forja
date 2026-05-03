// Live region composition. Combines the per-element render functions
// (status line, input box, tool cards) into the array of lines the
// renderer writes. Spec: UI.md §2, §4, §4.10.
//
// Layout (top → bottom of live region):
//   1. TodoList (1 + N lines — only when state.todos is non-empty).
//   2. Live assistant chip ("Generating…") — only while
//      pendingAssistant is set.
//   3. Active tool cards (running form, with preview).
//   4. Status line (1 line — only when session has started).
//   5. Bottom anchor block:
//      - rule above input
//      - input box (1+ lines)
//      - rule below input
//      - footer (1 line)
//      OR modal (when up), which owns the bottom slot entirely
//      and carries its own structure.
//
// Order matches the spec: history above (scrollback), then todos,
// then the live assistant chip, then live tool activity, then status,
// then the bottom anchor (rule/input/rule/footer).

import type { ComposeLive } from '../renderer-types.ts';
import type { LiveState } from '../state.ts';
import { type Capabilities, paint } from '../term.ts';
import { renderAssistantChip } from './assistant-chip.ts';
import { renderFooter } from './footer.ts';
import { padFrame } from './frame.ts';
import { renderInput } from './input.ts';
import { renderModal } from './modal.ts';
import { renderSlashPopover } from './slash-popover.ts';
import { renderTodoList } from './todo-list.ts';
import { renderToolCardLive } from './tool-card.ts';

// Horizontal rules around the input go edge-to-edge (UI.md §6.3
// "bloco do input" exception). Together with the input line they
// form a 3-row unit that visually breaks away from the indented
// content above and the indented footer below — operator's eye reads
// the block as "this is where you type" without the rules pretending
// to belong to the padded frame.
const horizontalRule = (caps: Capabilities): string =>
  paint(caps, 'dim', (caps.unicode ? '─' : '-').repeat(caps.cols));

// Number of lines between the input's last row and the bottom of the
// live region (the rule below input + the footer line). composeCursor
// subtracts this so the cursor lands inside the input, not on the
// footer. Only matters in the no-modal path — when a modal is up,
// composeCursor returns null and the constant goes unused. Grow
// alongside any future expansion of the bottom block (multi-line
// footer, secondary tray under it, etc.).
//
// Exported so a regression test can guard against drift between the
// constant and what composeLive actually emits below the input.
export const FOOTER_BLOCK_LINES = 2;

// Position the cursor wants to land inside the live region, so the
// renderer can issue cursor-back escapes after writing. Coordinates
// are 0-based from the top-left of the live region. Returns null when
// no input is rendered (modal is up — modal owns the bottom slot).
//
// `lineCount` is the size of `composeLive`'s output for the same
// state. We pass it instead of recomputing because the renderer
// already has it.
//
// Layout assumption: when no modal, the bottom anchor is
// `[..., rule, input, rule, footer]` — input ends `FOOTER_BLOCK_LINES`
// rows above the last live line. composeLive and composeCursor must
// stay in lockstep on this constant.
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
  // Last input row is FOOTER_BLOCK_LINES above the bottom of the
  // live region; subtract input's own height to get the first row.
  const inputStartRow = lineCount - FOOTER_BLOCK_LINES - inputLineCount;
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

  // Frame margin (UI.md §6.3): every line in the live region gets 2sp
  // left padding EXCEPT the input row. The composer applies `padFrame`
  // to each renderer's output here; the renderers themselves emit
  // unpadded content, which keeps them composable with anything else
  // (tests, headless replay) that wants the raw content. The two
  // width-aware paths — `horizontalRule` (computed locally) and
  // `renderFooter` (anchor math) — already produce padded output.

  // Live region "session" blocks (UI.md §6.3): each top-level element
  // (TodoList, assistant chip, each tool card) gets a blank line above
  // it for scannability. Sub-content within an element (todo rows
  // under "Tasks", `└─` connector under a tool chip) stays tight —
  // it's the parent block's "subsession". Helper ALWAYS prepends a
  // blank: combined with the forced blank above the input rule,
  // every top-level block ends up bounded by blanks on both sides
  // — so the operator's eye scans live content as discrete units
  // (e.g., "Generating..." chip with breathing space top + bottom)
  // without the bottom edge fusing with the rule above the input.
  const appendBlock = (block: string[]): void => {
    if (block.length === 0) return;
    lines.push(padFrame(''));
    lines.push(...block.map(padFrame));
  };

  // 1. Live TodoList (above the operation chips per spec §4.10.6:
  // "Todo list (§4.3) acima dos chips, se houver"). renderTodoList
  // returns [] when state.todos is empty — section drops entirely.
  appendBlock(renderTodoList(state.todos, caps));

  // 2. Live "Generating…" chip. Spec §4.10.5: the assistant turn is
  // an operation chip just like a tool call. Renders above the tool
  // cards because the assistant is the parent operation — tool calls
  // it spawns sit beneath it visually.
  if (state.pendingAssistant !== null) {
    appendBlock(renderAssistantChip(state.pendingAssistant, caps, now));
  }

  // 3. Active tool cards (running). Map insertion order is preserved,
  // so the visual order matches the order tools were started.
  for (const tool of state.activeTools.values()) {
    appendBlock(renderToolCardLive(tool, caps, now));
  }

  // 4. (was status line) — removed (UI.md §4.4 absorbed into §4.10.6
  // footer). Same info `model · [plan] · steps/max · cost · [bg N]`
  // appears in the footer's right column, so a separate line above
  // the input would just duplicate it. Position kept as a numbered
  // step so future additions slot in without renumbering downstream.

  // 5. Modal OR bottom anchor — never both. Bottom anchor is rule +
  // input + rule + footer (4-block stack); modal substitutes the
  // whole anchor and carries its own structure. Status line + tool
  // cards stay visible above so the user keeps context.
  if (state.modal !== null) {
    lines.push(...renderModal(state.modal, caps).map(padFrame));
    return lines;
  }
  // Slash autocomplete popover sits above the rule, between status
  // line / tool cards and the bottom anchor. Its line count adds to
  // the upper region — composeCursor's math (FOOTER_BLOCK_LINES +
  // inputLines from the bottom) stays correct regardless.
  if (state.slash !== null) {
    appendBlock(renderSlashPopover(state.slash, caps));
  }
  // Always 1 blank line above the input block (rule + input + rule),
  // regardless of whether the upper live region has content. This
  // line ALSO separates the top of the input rule from whatever
  // permanent content sits in scrollback right above the live
  // region: the bottom of the assistant text (or any other
  // permanent line) ends up adjacent to the rule otherwise, and
  // the typing zone visually fuses with the conversation.
  lines.push(padFrame(''));
  lines.push(horizontalRule(caps));
  // Input is the single OUTDENTED element (UI.md §6.3 frame margin
  // exception). No padFrame here — the prompt `> ` lives at col 0
  // and the cursor lands at col 2, naturally anchored to the rest
  // of the indented content's left edge.
  lines.push(...renderInput(state.input, caps));
  lines.push(horizontalRule(caps));
  // renderFooter only returns null on modal (handled above); the
  // non-null assert keeps the contract explicit — if a future
  // renderFooter loosens it, composeCursor's FOOTER_BLOCK_LINES math
  // would silently drift. Fail loudly here instead.
  const footer = renderFooter(state, caps);
  if (footer === null) throw new Error('composeLive: renderFooter returned null in non-modal path');
  lines.push(footer);

  return lines;
};
