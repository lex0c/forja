// Shared chrome primitives for the inline modals — the confirm flavors
// (modal.ts) and the clarify form (clarify-modal.ts). Extracted so a
// tweak to the rule glyph / min-width or the "(+N waiting)" affordance
// lands in ONE place instead of drifting between the two renderers.
//
// Deliberately tiny: only the byte-identical helpers. Each modal keeps
// its own structure (preview/subject vs questions/why) and its own
// option-row layout — those genuinely differ and are not forced into a
// shared shape here.

import type { Capabilities } from '../term.ts';

// Full-width horizontal rule — the single structural divider at the top
// of a modal. Edge-to-edge at caps.cols (min 8) so it matches the input
// block's full-width rule convention (UI.md §6.3); ASCII falls back to
// '-'. truncateToWidth in the renderer clips if cols changes mid-render;
// a normal redraw handles resize.
export const rule = (caps: Capabilities): string =>
  (caps.unicode ? '─' : '-').repeat(Math.max(8, caps.cols));

// Title suffix surfacing how many OTHER asks are queued behind the
// active modal. Empty when none, so the operator only sees the count
// when a modal pop is actually pending behind this one — without it,
// answering a modal that auto-pops the next reads as a regression/loop.
// The modal-manager keeps queueDepth live via `modal:queue-depth`.
export const queueSuffix = (queueDepth: number): string =>
  queueDepth > 0 ? ` (+${queueDepth} waiting)` : '';
