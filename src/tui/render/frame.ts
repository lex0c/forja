// Frame margin primitives. Spec: UI.md §6.3.
//
// Every visible element gets 2 spaces of left padding — banner,
// scrollback, status line, tool cards, todo list, slash popover,
// footer, modal, horizontal rules, the user-submit inverse bar.
// The single exception is the input box (rendered by `renderInput`):
// it stays edge-to-edge at column 0 so the operator's typing surface
// is the visual focal point, with the cursor naturally landing at
// column 2 (matching the indented content above).
//
// `padFrame` is for renderers that emit short content lines — the 2sp
// prefix is pure spaces (no SGR), so any reverse / dim / colored
// attributes inside the content keep their boundaries clean.
//
// `frameWidth` is for width-aware renderers (rules, footer anchor,
// user-submit bar) that need to know how many columns of content fit
// after subtracting the margin.

import type { Capabilities } from '../term.ts';

export const FRAME_MARGIN = '  ';
export const FRAME_MARGIN_WIDTH = FRAME_MARGIN.length;

export const frameWidth = (caps: Capabilities): number =>
  Math.max(0, caps.cols - FRAME_MARGIN_WIDTH);

export const padFrame = (line: string): string => `${FRAME_MARGIN}${line}`;
