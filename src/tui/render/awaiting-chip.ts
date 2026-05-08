// "Awaiting model" live chip. Rendered between `step_start` (the
// harness handed the request to the provider) and the first
// provider event arriving on the renderer (text_delta /
// thinking_delta / tool_use_start). On extended-thinking turns
// or slow cold-starts the gap is 30-60s; without a visible
// indicator the operator sees nothing and assumes the agent
// hung — usually reaches for Ctrl-C before the step-stall
// watchdog (90s default) would have caught a real problem.
//
// Format mirrors the thinking and assistant chips so the
// operator's eye reads them as the same family of indicator:
//
//   ▸ Awaiting model… (12s)
//
// Mutual exclusion: when `thinking` or `pendingAssistant` is
// set, that chip takes the slot. The compose layer's chip-slot
// picks the more specific indicator; this one is the fallback
// when the model has been called but hasn't started streaming.

import type { LiveState } from '../state.ts';
import { type Capabilities, paint } from '../term.ts';
import { spinnerGlyph } from './tool-card.ts';

const formatElapsed = (ms: number): string => {
  // Same clamp as thinking-chip / assistant-chip: clock skew
  // (producer's startedAt > now) clamps to 0 in ms, not seconds,
  // so a single skew tick doesn't visually jump units.
  if (ms < 0) return '0ms';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

export const renderAwaitingChip = (
  awaiting: NonNullable<LiveState['awaitingProvider']>,
  caps: Capabilities,
  now: number,
): string[] => {
  const spinner = spinnerGlyph(caps, now);
  const elapsed = formatElapsed(now - awaiting.startedAt);
  // `secondary` palette (SGR 90 bright-black, visibly grey)
  // rather than `warn` (yellow) so a long wait doesn't read as
  // an alarm — it's normal for some prompts. The thinking chip
  // uses warn because extended thinking with a real cost
  // implication is more notable; awaiting is just "we asked
  // and we're waiting".
  return [paint(caps, 'secondary', `${spinner} Awaiting model… (${elapsed})`)];
};
