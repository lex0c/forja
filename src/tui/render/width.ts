// Visual-width helpers. Wraps `string-width` so call sites don't have
// to import directly and so we can swap the impl if the dep ever
// breaks (or if we add ANSI-aware adjustments beyond width).
//
// Why a wrapper exists: `.length` measures JS code units (UTF-16). For
// CJK and emoji that occupy 2 columns visually, code-unit length
// undercounts. The renderer's clear+redraw cycle uses these to figure
// out how many lines we actually wrote — getting the math wrong means
// stale ghost lines.

import stringWidth from 'string-width';

// Visual width of `s` in terminal columns. Counts CJK as 2, emoji
// presentation as 2, control chars as 0, and ANSI escapes as 0.
export const visualWidth = (s: string): number => stringWidth(s);

// Truncate `s` so that its visual width fits within `maxCols`. Returns
// the original string when it already fits. Operates on grapheme-ish
// boundaries: we walk codepoints and stop when adding the next one
// would exceed the budget. ANSI escape sequences are detected and
// emitted whole (zero-width), so colorized input stays intact.
//
// Note: this does NOT add a trailing ellipsis. The renderer drops the
// overflow silently because the spec (UI.md §10) prefers "less data"
// over "interrupted data" in the live region. Callers that want
// ellipsis can compose: `truncateToWidth(s, max - 1) + '…'`.
//
// ANSI handling: a per-codepoint walk would count `[`, `3`, `1`, `m`
// inside `\x1b[31m` as 1 col each (string-width DOES count them when
// passed in isolation — only the full escape sequence reads as 0).
// We need to spot the start of a CSI sequence and skip to its final
// byte without spending any budget. We don't try to "balance"
// emitted escapes — the caller is responsible for emitting reset
// codes if they care about post-truncation state, just as before.
//
// Recognized ANSI shapes (only what we actually emit):
//   - CSI:  ESC `[` <params> <final byte 0x40..0x7e>  — used by paint()
// Other escapes (SS3, OSC, etc.) we don't emit and don't try to skip;
// `string-width` already strips most of them in its visual-width
// computation. If they ever leak into truncate input, they'd be
// counted as visible chars — accept the small inconsistency rather
// than try to mirror every quirk of strip-ansi.
const ESC = '\x1b';
const CSI_FINAL_MIN = 0x40;
const CSI_FINAL_MAX = 0x7e;

export const truncateToWidth = (s: string, maxCols: number): string => {
  if (maxCols <= 0) return '';
  if (visualWidth(s) <= maxCols) return s;
  let acc = '';
  let width = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === undefined) break;
    if (ch === ESC && s[i + 1] === '[') {
      // CSI: scan for final byte and admit the whole sequence as
      // zero-width. paint() is the only emitter today.
      let end = i + 2;
      while (end < s.length) {
        const c = s.charCodeAt(end);
        end++;
        if (c >= CSI_FINAL_MIN && c <= CSI_FINAL_MAX) break;
      }
      acc += s.slice(i, end);
      i = end;
      continue;
    }
    // Codepoint walk for non-ANSI content. `for...of` over the
    // remaining slice would re-iterate from 0 each time; manual
    // codePointAt + length-aware step is faster.
    const cp = s.codePointAt(i);
    if (cp === undefined) {
      i++;
      continue;
    }
    const cpLen = cp > 0xffff ? 2 : 1;
    const cpStr = s.slice(i, i + cpLen);
    const w = visualWidth(cpStr);
    if (width + w > maxCols) break;
    acc += cpStr;
    width += w;
    i += cpLen;
  }
  // Trailing-escape balance: scan the remainder for any CSI
  // sequences that follow the visible truncation point and append
  // them. This keeps SGR resets intact — without it, `\x1b[31mhello\x1b[0m`
  // truncated to 3 cols would emit `\x1b[31mhel` and leave the
  // terminal in red state for whatever renders next.
  let j = i;
  while (j < s.length) {
    if (s[j] === ESC && s[j + 1] === '[') {
      let end = j + 2;
      while (end < s.length) {
        const c = s.charCodeAt(end);
        end++;
        if (c >= CSI_FINAL_MIN && c <= CSI_FINAL_MAX) break;
      }
      acc += s.slice(j, end);
      j = end;
    } else {
      j++;
    }
  }
  return acc;
};
