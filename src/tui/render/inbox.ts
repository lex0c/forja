// Queued inbox messages (docs/spec/INBOX.md §6 — in-memory by design).
//
// Renders the operator's pending input — committed while a turn or
// playbook was in flight — as inverse bars in the live region, just
// above the typing zone, so the operator reads the stack as "these go
// next, in this order".
//
// Inset on BOTH sides to read as "not sent yet". A SENT message
// (`user-submit`, permanent.ts §4.10.8) is a full-bleed reverse band
// from col 0 to the right edge; a queued one is the same `> ` bar but
// with a 2-col margin on the left AND the right, so the operator can
// tell pending-in-the-inbox from already-committed at a glance.
//
// Returns the BARE reversed content (no frame margin). composeLive's
// `appendBlock` prepends the LEFT margin via `padFrame` (like every
// live block); the RIGHT margin comes from padding the reverse content
// to `cols - 4` instead of `cols - 2`. Empty queue → [] (the section
// collapses entirely).

import type { QueuedInput } from '../state.ts';
import { type Capabilities, reverse } from '../term.ts';
import { FRAME_MARGIN_WIDTH, frameWidth } from './frame.ts';
import { visualWidth } from './width.ts';

export const renderQueued = (queued: readonly QueuedInput[], caps: Capabilities): string[] => {
  if (queued.length === 0) return [];
  // `cols - 4`: the left 2 cols are appendBlock's `padFrame` (normal bg,
  // outside the reverse), the right 2 are this shorter band leaving the tail
  // of the row undrawn — together the inset that distinguishes a pending bar
  // from a sent (edge-to-edge) one.
  const innerWidth = Math.max(0, frameWidth(caps) - FRAME_MARGIN_WIDTH);
  const bars: string[] = [];
  for (const item of queued) {
    // Same prefixing as the user-submit bar: `> ` on the first line,
    // 2sp continuation indent on wrapped lines.
    const prefixed = item.text.split('\n').map((l, i) => (i === 0 ? `> ${l}` : `  ${l}`));
    for (const line of prefixed) {
      // padEnd on code units; matches visual columns for plain ASCII.
      // Mirrors the user-submit bar's known CJK/emoji over-pad caveat.
      const padded = line + ' '.repeat(Math.max(0, innerWidth - visualWidth(line)));
      bars.push(reverse(padded));
    }
  }
  return bars;
};
