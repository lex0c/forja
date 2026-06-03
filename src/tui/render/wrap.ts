// Soft-wrap chunker for the input box. Spec: UI.md §4.5.
//
// Splits a buffer line into chunks that each fit within `innerWidth`
// TERMINAL COLUMNS (visual width), not code units. The distinction
// matters for CJK and emoji, which occupy 2 columns: counting code
// units would let a chunk of `innerWidth` codepoints render ~2×
// wider than the terminal, the terminal would soft-wrap it onto a
// second visual row, and the renderer — which counts one chunk as one
// row — would undercount `liveHeight` / `cursorRow` and leak stale
// rows into scrollback on the next erase.
//
// Iteration is per-CODEPOINT (codePointAt + a 1-or-2 code-unit step),
// so a non-BMP codepoint (most emoji, many symbols — two UTF-16 code
// units) is never split across a chunk boundary: a `slice` landing
// mid-pair would emit the replacement glyph (U+FFFD) and drift every
// column after it. Each chunk is still a code-unit range `[start, end)`
// so `renderInput` (slicing to render) and `composeCursor` (locating
// the cursor's sub-row + column) consume the SAME list — both must, or
// the cursor desyncs from the drawn rows.
//
// A single codepoint whose visual width alone exceeds `innerWidth`
// (e.g. a 2-col glyph at `innerWidth === 1`) gets its own over-budget
// chunk — a glyph can't be split, so the terminal renders it with
// whatever width the font assigns. Forward progress is guaranteed:
// the walk always advances by the codepoint's code-unit length.

import { visualWidth } from './width.ts';

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

// Each chunk is a code-unit range `[start, end)` over the input
// line. Empty input lines produce an empty chunk list — callers
// (renderInput emits the bare prefix; composeCursor treats it as
// a single sub-row of length 0) must handle that case explicitly.
export interface WrapChunk {
  start: number;
  end: number;
}

export const wrapInputLine = (line: string, innerWidth: number): readonly WrapChunk[] => {
  if (line.length === 0) return [];
  const budget = Math.max(1, innerWidth);
  const chunks: WrapChunk[] = [];
  let start = 0;
  let col = 0;
  let i = 0;
  while (i < line.length) {
    // Step by whole codepoints so surrogate pairs stay intact. A high
    // surrogate at `i` is the lead of a 2-code-unit pair.
    const cpLen = isHighSurrogate(line.charCodeAt(i)) && i + 1 < line.length ? 2 : 1;
    const w = visualWidth(line.slice(i, i + cpLen));
    // This codepoint overflows the current chunk's column budget:
    // close the chunk here and start a fresh one. Skip when the chunk
    // is still empty (`i === start`) — a lone glyph wider than the
    // budget can't be split, so it takes an over-budget chunk of one.
    if (col + w > budget && i > start) {
      chunks.push({ start, end: i });
      start = i;
      col = 0;
    }
    col += w;
    i += cpLen;
  }
  chunks.push({ start, end: line.length });
  return chunks;
};
