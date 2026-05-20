// Slash autocomplete popover. Spec: UI.md §5.3.
//
// Renders directly below the input block (between the rule-below-input
// and the footer) when the user is typing a `/command`. Up to 8 visible
// suggestions; the highlighted one (state.slash.selectedIdx) is painted
// in `accent` (terminal blue) while the rest stay in `secondary` (grey).
// "(no matches)" surfaces when the user typed something with no
// completions — better than silently hiding the popover.
//
// Each row: `/<name>  <description>` (col 0). Two-column layout with
// names padded to the longest visible name so descriptions align.
// Rows start at column 0 (no frame margin), matching the input block's
// edge-to-edge convention.
//
// Selection cue.
// - Colored terminals (caps.color !== 'none'): the selected row paints
//   in `accent` (SGR 94 = bright blue), unselected in `secondary`
//   (SGR 90 = grey). No glyph — selection reads cleanly from color
//   alone, which is what the operator-aligned UX iteration landed on.
// - Monochrome terminals (caps.color === 'none', e.g. NO_COLOR=1, CI
//   logs, scripts piping stdout): paint() returns plain text and the
//   color cue disappears. Without a fallback, selected and unselected
//   rows look identical — and since Enter now executes the
//   highlighted suggestion (including destructive ones like /quit),
//   that ambiguity is operator-visible harm. So we prepend a `>`
//   glyph to the selected row and a `  ` to others, padded to the
//   same width so the `/name` column stays aligned. The glyph fallback
//   only activates in no-color mode — colored terminals keep the
//   tighter col-0 layout.

import type { SlashAutocomplete } from '../state.ts';
import { type Capabilities, type SgrToken, paint } from '../term.ts';

// Spec §5.3 caps the popover at 8 visible items.
const MAX_VISIBLE = 8;

// Number of visible lines the popover will emit for the given state.
// Exported so compose.ts can compute the offset between the input row
// and the footer without re-running the full render. Keep in lockstep
// with renderSlashPopover's return shape.
export const slashPopoverLineCount = (slash: SlashAutocomplete): number => {
  if (slash.suggestions.length === 0) return 1;
  const visibleCount = Math.min(MAX_VISIBLE, slash.suggestions.length);
  return visibleCount + (slash.suggestions.length > visibleCount ? 1 : 0);
};

export const renderSlashPopover = (slash: SlashAutocomplete, caps: Capabilities): string[] => {
  if (slash.suggestions.length === 0) {
    return [paint(caps, 'secondary', '(no matches — try /help)')];
  }
  // Window the suggestions so the highlighted one is always visible.
  // Simple algorithm: if selectedIdx is past the first MAX_VISIBLE,
  // shift the window so it sits at the bottom of the visible slice.
  const total = slash.suggestions.length;
  const visibleCount = Math.min(MAX_VISIBLE, total);
  let windowStart = 0;
  if (slash.selectedIdx >= MAX_VISIBLE) {
    windowStart = slash.selectedIdx - MAX_VISIBLE + 1;
  }
  const visible = slash.suggestions.slice(windowStart, windowStart + visibleCount);
  const longest = visible.reduce((max, s) => Math.max(max, s.name.length), 0);
  // Glyph fallback fires only in no-color terminals — see header
  // comment. In colored mode the prefix is empty so the popover keeps
  // the tight col-0 layout the iteration converged on.
  const useGlyph = caps.color === 'none';
  const lines = visible.map((s, i) => {
    const absoluteIdx = windowStart + i;
    const isSelected = absoluteIdx === slash.selectedIdx;
    const padded = s.name.padEnd(longest);
    const prefix = useGlyph ? (isSelected ? '> ' : '  ') : '';
    const token: SgrToken = isSelected ? 'accent' : 'secondary';
    return paint(caps, token, `${prefix}/${padded}  ${s.description}`);
  });
  // Footer hint when the visible slice is a window of a larger list.
  // No glyph here — the hint isn't a selectable row, so it carries no
  // "is this selected?" ambiguity even in no-color mode.
  if (total > visibleCount) {
    lines.push(paint(caps, 'secondary', `(${total - visibleCount} more — scroll with ↑/↓)`));
  }
  return lines;
};
