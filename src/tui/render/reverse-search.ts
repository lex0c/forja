// Reverse-search overlay. Spec: HISTORY.md §2.2.
//
// Renders a single line above the input box while the operator holds
// Ctrl+R open. Layout matches the bash convention every shell user
// recognizes:
//
//   (reverse-i-search)`que`: como rodar bun em watch?
//
// Empty matches surface as `<empty>` in dim:
//
//   (reverse-i-search)`xyz`: <empty>
//
// The operator's draft buffer stays visible in the input box below
// (HISTORY.md §2.2 "operator vê seu draft preservado abaixo, dim").
// We don't re-style the input box from here — the producer keeps the
// buffer untouched while the overlay is up; on Esc the buffer is
// already as it was, on Enter/Tab the producer emits an `input:update`
// with the chosen match BEFORE the close event.
//
// Design note on truncation: history may store multi-line prompts
// (HISTORY.md §4.1). The match line collapses any embedded `\n` to a
// single space so a recall preview never grows the live region. The
// full content lands in the input buffer on accept, untouched.

import type { ReverseSearchState } from '../state.ts';
import { type Capabilities, paint } from '../term.ts';
import { truncateToWidth } from './width.ts';

const PREFIX = '(reverse-i-search)';

export const renderReverseSearch = (rs: ReverseSearchState, caps: Capabilities): string[] => {
  const selected =
    rs.selectedIdx >= 0 && rs.selectedIdx < rs.results.length
      ? rs.results[rs.selectedIdx]
      : undefined;

  // Match block: the actual prompt that's currently selected, or
  // `<empty>` (dim) when there are no matches. Multi-line prompts
  // collapse via `\n → space` so the overlay never spills into more
  // than one row regardless of payload.
  const matchBlock =
    selected !== undefined ? selected.replace(/\r?\n/g, ' ') : paint(caps, 'dim', '<empty>');

  // Build the visible line. Truncate to terminal width so a wide
  // recalled prompt doesn't wrap and break the live region's row
  // accounting. truncateToWidth tracks SGR sequences so the dim
  // `<empty>` block stays balanced even when clipped.
  const raw = `  ${PREFIX}\`${rs.query}\`: ${matchBlock}`;
  return [truncateToWidth(raw, caps.cols)];
};
