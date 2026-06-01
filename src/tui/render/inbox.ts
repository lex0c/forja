// Queued inbox messages (docs/spec/INBOX.md §6 — in-memory by design).
//
// Renders the operator's pending input — committed while a turn or
// playbook was in flight — as inverse bars in the live region, just
// above the typing zone. Deliberately reuses the `user-submit` bar
// format from `permanent.ts` (§4.10.8) so a queued message looks
// exactly like a sent one: the operator reads the stack above the
// prompt as "these go next, in this order".
//
// Returns the BARE reversed content (no frame margin). composeLive's
// `appendBlock` adds the 2sp margin via `padFrame`, exactly as it does
// for every other live block — so the result is byte-identical to a
// user-submit bar. Empty queue → [] (the section collapses entirely).

import type { QueuedInput } from '../state.ts';
import { type Capabilities, reverse } from '../term.ts';
import { frameWidth } from './frame.ts';
import { visualWidth } from './width.ts';

export const renderQueued = (queued: readonly QueuedInput[], caps: Capabilities): string[] => {
  if (queued.length === 0) return [];
  const innerWidth = frameWidth(caps);
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
