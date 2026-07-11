// "Awaiting model" live chip — the fallback indicator between `step_start`
// (request handed to the provider) and the first provider event. On
// extended-thinking turns or slow cold-starts the gap is 30-60s; without
// it the operator sees nothing and assumes the agent hung — usually
// reaching for Ctrl-C before the step-stall watchdog (90s) catches a real
// problem. The render (spinner + shimmer + elapsed) is shared, in
// `renderTimedChip`; this only supplies the label. The compose chip-slot
// ranks `thinking` / `pendingAssistant` above it — the more specific
// indicators once streaming starts.

import type { LiveState } from '../state.ts';
import type { Capabilities } from '../term.ts';
import { renderTimedChip } from './timed-chip.ts';

export const renderAwaitingChip = (
  awaiting: NonNullable<LiveState['awaitingProvider']>,
  caps: Capabilities,
  now: number,
): string[] => renderTimedChip('Awaiting model…', awaiting.startedAt, caps, now);
