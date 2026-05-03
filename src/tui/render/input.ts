// Input box render. Spec: UI.md §4.5.
//
// Renders the user's pending input as one or more visual rows. Each
// `\n`-separated buffer line becomes one or more rows: the first row
// of the first line carries the `> ` prompt; every continuation row
// (whether from an explicit `\n` or from soft-wrap of a long line)
// uses a 2-space indent that aligns under the prompt's first column.
//
// Soft-wrap: a buffer line wider than `caps.cols - 2` chars is split
// into chunks of `caps.cols - 2` so each visual row fits within the
// terminal. Without wrap, the renderer's truncateToWidth would clip
// the tail of the line — operator sees only the first ~80 chars of
// what they typed/pasted, with no way to read or edit the rest. Wrap
// keeps every char visible at the cost of growing the live region's
// row count. composeCursor's math accounts for the wrap so the
// cursor always lands on the right visual row.
//
// Wrap is intentionally column-based, not word-aware. For prose the
// terminal would prefer word boundaries, but the input box is for
// commands / code / paste content where mid-word boundaries are
// fine and predictable; word-aware wrap would also fight CJK / emoji
// width inconsistencies.

import type { InputState } from '../state.ts';
import type { Capabilities } from '../term.ts';

const PROMPT_PREFIX = '> ';
const CONT_PREFIX = '  ';

export const renderInput = (input: InputState, caps: Capabilities): string[] => {
  const innerWidth = Math.max(1, caps.cols - PROMPT_PREFIX.length);
  const lines = input.value === '' ? [''] : input.value.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const linePrefix = i === 0 ? PROMPT_PREFIX : CONT_PREFIX;
    if (line.length === 0) {
      out.push(linePrefix);
      continue;
    }
    // Chunk by code-unit length. CJK / emoji that occupy 2 columns
    // would over-flow the visual budget by 1 col per double-width
    // glyph; accept the small inconsistency until visualWidth-aware
    // chunking lands (most input today is ASCII commands / code).
    let pos = 0;
    let firstSub = true;
    while (pos < line.length) {
      const chunk = line.slice(pos, pos + innerWidth);
      out.push((firstSub ? linePrefix : CONT_PREFIX) + chunk);
      pos += innerWidth;
      firstSub = false;
    }
  }
  return out;
};
