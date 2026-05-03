// Soft-wrap chunker for the input box. Spec: UI.md §4.5.
//
// Splits a buffer line into chunks of at most `innerWidth` UTF-16
// code units, with one constraint: a chunk MUST NOT end in the
// middle of a surrogate pair. JS strings are UTF-16, so a non-BMP
// codepoint (most emoji, many symbols) occupies two code units;
// `slice(pos, pos + N)` falling exactly between them produces a
// malformed half that the terminal renders as the replacement
// glyph (U+FFFD), and every column downstream drifts by one.
//
// The fix: when the byte that would be at the chunk's last
// position is a high surrogate, shrink the chunk by one code unit
// so the pair stays together in the next chunk. This makes some
// chunks slightly shorter than `innerWidth`, which is why both
// `renderInput` (slicing to render) and `composeCursor` (locating
// the cursor's sub-row + col) must consult the SAME chunk list —
// their previous shared model of "chunk size = innerWidth" no
// longer holds when surrogates span boundaries.
//
// What this DOES NOT fix: visual width. Emoji and CJK glyphs
// typically render at 2 cols, so even with surrogate-safe
// chunking a chunk of `innerWidth` codepoints can still overflow
// the terminal's column budget. The existing comment in
// `renderInput` acknowledges that — it's a separate problem
// solved by a wcwidth-aware chunker (deferred).

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
  const width = Math.max(1, innerWidth);
  const chunks: WrapChunk[] = [];
  let pos = 0;
  while (pos < line.length) {
    let end = Math.min(pos + width, line.length);
    // If the last code unit of the would-be chunk is a high
    // surrogate, the matching low surrogate is at `end` (just
    // past). Pull back so the pair lands wholly in the NEXT
    // chunk. Skipping at most 1 unit per chunk; degenerate cases
    // (innerWidth === 1, every char is non-BMP) still terminate
    // because we always advance by `width` of the FOLLOWING
    // chunk start which is `end` post-clamp; the clamp below
    // protects against the pathological pos === end case.
    if (end < line.length && isHighSurrogate(line.charCodeAt(end - 1))) {
      end -= 1;
    }
    // Forward progress guarantee: if width === 1 and pos sits
    // exactly on a high surrogate, end - 1 === pos and we'd loop
    // forever. Force at least the surrogate pair into this
    // chunk in that case (over-budget by 1 code unit, but a
    // surrogate pair is 1 grapheme — the terminal renders it
    // with whatever width the font assigns, same as if it were
    // at the start of any other chunk).
    if (end <= pos) end = Math.min(pos + 2, line.length);
    chunks.push({ start: pos, end });
    pos = end;
  }
  return chunks;
};
