// Slash autocomplete popover. Spec: UI.md §5.3.
//
// Renders above the input box (between status line and input rule)
// when the user is typing a `/command`. Up to 8 visible suggestions;
// the highlighted one (state.slash.selectedIdx) gets a `>` cursor.
// "(no matches)" surfaces when the user typed something with no
// completions — better than silently hiding the popover.
//
// Each row: `  > /<name>  <description>`. Two-column layout with
// names padded to the longest visible name so descriptions align.
// Cursor on the highlighted line, plain space on the rest. The
// `>` is intentionally the same glyph the modal uses for option
// selection — consistent affordance across the TUI.

import type { SlashAutocomplete } from '../state.ts';
import { type Capabilities, paint } from '../term.ts';

// Spec §5.3 caps the popover at 8 visible items.
const MAX_VISIBLE = 8;

export const renderSlashPopover = (slash: SlashAutocomplete, caps: Capabilities): string[] => {
  if (slash.suggestions.length === 0) {
    return [paint(caps, 'dim', '  (no matches — try /help)')];
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
  const lines = visible.map((s, i) => {
    const absoluteIdx = windowStart + i;
    const cursor = absoluteIdx === slash.selectedIdx ? '>' : ' ';
    const padded = s.name.padEnd(longest);
    return paint(caps, 'dim', `  ${cursor} /${padded}  ${s.description}`);
  });
  // Footer hint when the visible slice is a window of a larger list.
  if (total > visibleCount) {
    lines.push(paint(caps, 'dim', `  (${total - visibleCount} more — scroll with ↑/↓)`));
  }
  return lines;
};
