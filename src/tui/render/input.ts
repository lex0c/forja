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
import { wrapInputLine } from './wrap.ts';

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
    // Chunking via wrapInputLine — keeps surrogate pairs intact
    // (a `slice` mid-pair would render U+FFFD and drift the
    // visible column for the rest of the line). composeCursor
    // uses the SAME chunker so cursor row/col stays consistent
    // with what's drawn here. Visual width of CJK / emoji (2
    // cols per glyph) still over-flows the column budget; that's
    // a separate wcwidth-aware-chunking concern.
    const chunks = wrapInputLine(line, innerWidth);
    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c];
      if (chunk === undefined) continue;
      const prefix = c === 0 ? linePrefix : CONT_PREFIX;
      out.push(prefix + line.slice(chunk.start, chunk.end));
    }
  }
  return out;
};
