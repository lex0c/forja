// A live "<label>… [elapsed]" chip: spinner glyph + shimmering label +
// a monotonic elapsed timer. The label is the only thing that varies
// between the surfaces that use it — awaiting a provider call, compacting
// context — so the render lives here once and each chip is a thin label
// wrapper (or a direct call from the compose chip-slot).
//
//   ⠙ Compacting context…  [3s]
//
// The label carries the shimmer (`render/shimmer.ts`, EXPERIMENTAL — see
// the note there); base token `secondary`, the chip's resting color.

import { type Capabilities, paint } from '../term.ts';
import { formatChipDuration } from './duration.ts';
import { renderShimmer } from './shimmer.ts';
import { spinnerGlyph } from './tool-card.ts';

export const renderTimedChip = (
  label: string,
  startedAt: number,
  caps: Capabilities,
  now: number,
): string[] => {
  const spinner = paint(caps, 'secondary', `${spinnerGlyph(caps, now)} `);
  const shimmer = renderShimmer(label, caps, now, 'secondary');
  const elapsed = paint(caps, 'secondary', `  [${formatChipDuration(now - startedAt)}]`);
  return [`${spinner}${shimmer}${elapsed}`];
};
