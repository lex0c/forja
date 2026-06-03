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
import { type Capabilities, paint } from '../term.ts';
import { wrapInputLine } from './wrap.ts';

const PROMPT_PREFIX = '> ';
const CONT_PREFIX = '  ';

export interface RenderInputOptions {
  // Render every row painted dim. Used when the reverse-search
  // overlay is open (HISTORY.md §2.2 — the operator's draft is
  // preserved below the overlay but visually faded so attention
  // stays on the search line). Default false leaves the input in
  // its normal palette.
  dimmed?: boolean;
  // Ghost hint shown after the prompt ONLY when the buffer is empty
  // (INBOX §6.1 — "Press up to edit queued messages" while the queue
  // is non-empty). Rendered dim so it reads as an affordance, not as
  // typed content; it vanishes the moment the operator types. The
  // cursor still lands at column 2 (composeCursor keys off the empty
  // value), sitting at the head of the ghost text.
  placeholder?: string;
  // Bash mode (operator `!cmd` shell escape). The caller (composeLive)
  // decides this — it needs the full LiveState for the idle gate (a `!`
  // typed mid-turn is refused, so it must NOT flip to bash mode then;
  // see render/mode.ts `isBashMode`). When true, the leading `!` is
  // consumed as the prompt glyph (`> ` → `! `) and the whole row is
  // painted yellow. renderInput stays a pure function of the buffer +
  // these flags rather than re-deriving the predicate itself.
  bash?: boolean;
}

export const renderInput = (
  input: InputState,
  caps: Capabilities,
  options: RenderInputOptions = {},
): string[] => {
  const innerWidth = Math.max(1, caps.cols - PROMPT_PREFIX.length);
  // Bash mode (operator `!cmd` — decided by the caller via `options.bash`,
  // which is idle-gated; see render/mode.ts). The leading `!` is consumed
  // as the MODE GLYPH, not shown as content: the prompt flips `> ` → `! `
  // and the rest of the buffer is the command, with the WHOLE row painted
  // `warn` (yellow). composeCursor strips the same `!` and shifts the
  // cursor by one so the caret stays aligned (shared contract — both read
  // `isBashMode`). Defensive `startsWith('!')` guard: never strip a
  // non-`!` buffer even if a caller passes `bash` by mistake. Dimming
  // (reverse-search) wins — but `isBashMode` is already false then, so
  // `options.bash` won't be set under dimming in practice.
  const bang = options.bash === true && options.dimmed !== true && input.value.startsWith('!');
  const promptPrefix = bang ? '! ' : PROMPT_PREFIX;
  // The text actually drawn after the prompt — the command (bang mode)
  // or the raw buffer.
  const shown = bang ? input.value.slice(1) : input.value;
  const lines = shown === '' ? [''] : shown.split('\n');
  const out: string[] = [];
  // Per-row paint: dimmed (reverse-search) dims the whole row; bash mode
  // paints it yellow; otherwise identity. Wraps the prompt prefix too so
  // the glyph shares the row's tone. paint() no-ops under color='none'.
  const finish = (line: string): string =>
    options.dimmed === true ? paint(caps, 'dim', line) : bang ? paint(caps, 'warn', line) : line;
  // Slash-command highlight: when the buffer is a single-line `/command`
  // the leading command token (slash + word, up to the first
  // whitespace) is painted `accent` (blue) so the operator sees they're
  // in command mode, not composing a message. Args after the token keep
  // the normal tone. Skipped when dimmed (reverse-search owns the
  // palette then) and when the buffer spans lines (slash commands are
  // single-line). `paint` no-ops under color='none', and the SGR is
  // zero-width so composeCursor / truncateToWidth are unaffected.
  const slashTokenEnd =
    options.dimmed !== true && input.value.startsWith('/') && !input.value.includes('\n')
      ? (() => {
          const ws = input.value.search(/\s/);
          return ws === -1 ? input.value.length : ws;
        })()
      : -1;
  // Empty buffer + a placeholder → show the dim ghost hint instead of a
  // bare prompt. Only the hint is dimmed (the prompt keeps its normal
  // tone unless reverse-search dims the whole input via `finish`).
  if (input.value === '' && options.placeholder !== undefined && options.placeholder !== '') {
    return [finish(PROMPT_PREFIX + paint(caps, 'dim', options.placeholder))];
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const linePrefix = i === 0 ? promptPrefix : CONT_PREFIX;
    if (line.length === 0) {
      out.push(finish(linePrefix));
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
      // Paint the command token blue on the first row of a slash line.
      // `slashTokenEnd` is a code-unit index into the (single) line; the
      // token always lives in chunk 0, possibly split if the command is
      // long enough to wrap (rare). Color only the part of the token
      // inside this chunk; the remainder of the chunk stays default.
      if (slashTokenEnd > chunk.start && i === 0) {
        const cut = Math.min(slashTokenEnd, chunk.end);
        const head = paint(caps, 'accent', line.slice(chunk.start, cut));
        const tail = line.slice(cut, chunk.end);
        out.push(prefix + head + tail);
        continue;
      }
      out.push(finish(prefix + line.slice(chunk.start, chunk.end)));
    }
  }
  return out;
};
