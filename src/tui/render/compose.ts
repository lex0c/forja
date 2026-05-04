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
import { renderReverseSearch } from './reverse-search.ts';
import { renderSlashPopover } from './slash-popover.ts';
import { renderTodoList } from './todo-list.ts';
import { renderToolCardLive } from './tool-card.ts';
import { wrapInputLine } from './wrap.ts';

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
  // Both '> ' (first line) and '  ' (continuation) are 2 chars wide;
  // soft-wrap chunks each `\n`-separated buffer line into chunks of
  // up to `caps.cols - prefixWidth` code units, with surrogate-pair
  // boundaries kept intact (see render/wrap.ts). composeCursor must
  // walk the SAME chunk list renderInput produced — uniform-width
  // arithmetic (`offsetInLine % innerWidth`) breaks when chunks are
  // shrunk by one to avoid splitting a non-BMP codepoint.
  const prefixWidth = 2;
  const innerWidth = Math.max(1, caps.cols - prefixWidth);

  // Per-buffer-line chunk list. Empty buffer lines wrap to a single
  // empty sub-row (the prefix-only `> ` / `  ` line that renderInput
  // emits) — the chunk list is `[]` in that case and the
  // sub-row/col math below special-cases it.
  const lines = value === '' ? [''] : value.split('\n');
  const lineChunks = lines.map((l) => wrapInputLine(l, innerWidth));
  const rowsForChunks = (n: number): number => (n === 0 ? 1 : n);
  const inputLineCount = lineChunks.reduce((acc, cs) => acc + rowsForChunks(cs.length), 0);

  // Find which buffer line + offset within it contains the cursor.
  const cursorAbs = state.input.cursor;
  let charsBefore = 0;
  let bufferLineIdx = 0;
  let offsetInLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = (lines[i] ?? '').length;
    if (cursorAbs <= charsBefore + lineLen) {
      bufferLineIdx = i;
      offsetInLine = cursorAbs - charsBefore;
      break;
    }
    charsBefore += lineLen + 1; // +1 for the '\n' separator
  }

  // Visual rows occupied by buffer lines BEFORE the cursor's line.
  let visualRowsBefore = 0;
  for (let i = 0; i < bufferLineIdx; i++) {
    visualRowsBefore += rowsForChunks((lineChunks[i] ?? []).length);
  }
  const cursorChunks = lineChunks[bufferLineIdx] ?? [];
  const numSubRows = rowsForChunks(cursorChunks.length);
  // Locate the chunk whose code-unit range covers `offsetInLine`.
  // Linear walk is fine: typical input has < 30 chunks per line.
  // Cursor at the exact end of a chunk lands on that chunk's last
  // column (the next chunk's start === this chunk's end), which the
  // boundary clamp below resolves; same shape as the old
  // exact-wrap-boundary case where cursor was at offset = N*innerWidth.
  let subRowInLine = 0;
  let col = prefixWidth + offsetInLine;
  for (let c = 0; c < cursorChunks.length; c++) {
    const chunk = cursorChunks[c];
    if (chunk === undefined) continue;
    if (offsetInLine < chunk.end) {
      subRowInLine = c;
      col = prefixWidth + (offsetInLine - chunk.start);
      break;
    }
    // Past the last chunk's end — fall through; the clamp below
    // pins to the right edge of the last sub-row.
    if (c === cursorChunks.length - 1) {
      subRowInLine = c;
      col = prefixWidth + (offsetInLine - chunk.start);
    }
  }

  // Exact-wrap-boundary clamp: cursor at offset = chunk.end of a
  // non-final chunk wants to land on the next sub-row, but
  // renderInput only emits `chunks.length` sub-rows so a cursor
  // past the last would visually overlap the rule below the input.
  // Clamp to the right edge of the last existing sub-row instead —
  // typical editor behavior. As soon as the operator types one
  // more char, a new chunk allocates and the cursor moves naturally
  // to col 2 of the new row.
  if (subRowInLine >= numSubRows) {
    subRowInLine = numSubRows - 1;
    col = caps.cols - 1;
  }

  // Last input row is FOOTER_BLOCK_LINES above the bottom of the
  // live region; subtract input's own (wrapped) height to get the
  // first row.
  const inputStartRow = lineCount - FOOTER_BLOCK_LINES - inputLineCount;
  return {
    row: inputStartRow + visualRowsBefore + subRowInLine,
    col: Math.min(col, Math.max(0, caps.cols - 1)),
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
  //
  // Modal lines are NOT run through padFrame: renderModal already
  // bakes the §6.3 frame margin into content rows (each block
  // emits `'  ' + text`) AND its rule rows are intentionally
  // edge-to-edge at caps.cols (matching the input block's full-
  // width rule convention §6.3). Adding another 2sp prefix would
  // double-indent content AND push rules past caps.cols, which
  // truncateToWidth then clips on the right edge — visible as the
  // box losing its last 2 columns on every row of every modal.
  if (state.modal !== null) {
    lines.push(...renderModal(state.modal, caps));
    return lines;
  }
  // Slash autocomplete popover sits above the rule, between status
  // line / tool cards and the bottom anchor. Its line count adds to
  // the upper region — composeCursor's math (FOOTER_BLOCK_LINES +
  // inputLines from the bottom) stays correct regardless.
  if (state.slash !== null) {
    appendBlock(renderSlashPopover(state.slash, caps));
  }
  // Reverse-search overlay (HISTORY.md §2.2). Same slot as slash —
  // they're mutually exclusive at the producer level (REPL refuses
  // to open Ctrl+R while slash is active), so this branch and the
  // one above never fire on the same frame. The input box below
  // stays visible: operator's draft is preserved untouched while
  // the overlay is up.
  if (state.reverseSearch !== null) {
    appendBlock(renderReverseSearch(state.reverseSearch, caps));
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
  // of the indented content's left edge. When the reverse-search
  // overlay is up, the input rows render dim (HISTORY.md §2.2) so
  // the operator's draft is visibly preserved-but-secondary.
  lines.push(...renderInput(state.input, caps, { dimmed: state.reverseSearch !== null }));
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
