// Shimmer — a highlight that slides left-to-right across a live
// chip's verb (awaiting / assistant / thinking / critique). The
// centre char is `accent`, its two neighbours `default`, the rest
// the chip's own base token (`secondary` / `warn` / `error`) — the
// closest the 8-color palette gets to a gradient (no truecolor,
// UI.md §6.1). Position derives from `now`, so the frame scheduler
// (already redrawing for the spinner) animates it.
//
// EXPERIMENTAL — this collides with UI.md §13 ("Animações. Só
// spinner. Nada de fade, slide, transition."). Under operator
// evaluation; the spec is NOT amended. If the shimmer stays, §13
// needs a deliberate revision first.

import { type Capabilities, type SgrToken, paint } from '../term.ts';

// The highlight centre advances one position every SPEED ms; the
// GAP idle slots past the text give a pause between passes.
const SHIMMER_SPEED_MS = 90;
const SHIMMER_GAP = 6;

// Render `text` with the shimmer highlight at the `now`-derived
// position. `base` is the chip's resting color: the centre char
// flips to `accent`, its two neighbours to `default`, the rest
// stay `base`. Under NO_COLOR the text is returned untouched.
export const renderShimmer = (
  text: string,
  caps: Capabilities,
  now: number,
  base: SgrToken,
): string => {
  if (caps.color === 'none') return text;
  const chars = [...text];
  const cycle = chars.length + SHIMMER_GAP;
  const centre = Math.floor(now / SHIMMER_SPEED_MS) % cycle;
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] ?? '';
    const d = Math.abs(i - centre);
    if (d === 0) out += paint(caps, 'accent', ch);
    else if (d === 1) out += ch;
    else out += paint(caps, base, ch);
  }
  return out;
};
