// "Awaiting model" live chip. Rendered between `step_start` (the
// harness handed the request to the provider) and the first
// provider event arriving on the renderer (text_delta /
// thinking_delta / tool_use_start). On extended-thinking turns
// or slow cold-starts the gap is 30-60s; without a visible
// indicator the operator sees nothing and assumes the agent
// hung — usually reaches for Ctrl-C before the step-stall
// watchdog (90s default) would have caught a real problem.
//
//   ⠙ Awaiting model…  [12s]
//
// The label carries the shimmer (`render/shimmer.ts`, EXPERIMENTAL
// — see the note there); base token `secondary`, like the rest of
// this chip's resting color.
//
// Mutual exclusion: when `thinking` or `pendingAssistant` is
// set, that chip takes the slot. The compose layer's chip-slot
// picks the more specific indicator; this one is the fallback
// when the model has been called but hasn't started streaming.

import type { LiveState } from '../state.ts';
import { type Capabilities, paint } from '../term.ts';
import { formatChipDuration } from './duration.ts';
import { renderShimmer } from './shimmer.ts';
import { spinnerGlyph } from './tool-card.ts';

export const renderAwaitingChip = (
  awaiting: NonNullable<LiveState['awaitingProvider']>,
  caps: Capabilities,
  now: number,
): string[] => {
  const spinner = paint(caps, 'secondary', `${spinnerGlyph(caps, now)} `);
  const label = renderShimmer('Awaiting model…', caps, now, 'secondary');
  const elapsed = paint(caps, 'secondary', `  [${formatChipDuration(now - awaiting.startedAt)}]`);
  return [`${spinner}${label}${elapsed}`];
};
