// Input box render. Spec: UI.md §4.5.
//
// Renders the user's pending input as one or more lines. First line
// gets a `> ` prompt prefix; continuation lines get a 2-space indent
// so they line up under the prompt's first character.
//
// Cursor handling: the renderer leaves the terminal cursor at the end
// of the last live line (where this function's output sits). For
// proper inline editing (cursor inside the value, not at the end),
// the caller will issue cursor-back escapes after writing — that's
// next-slice work. For now, the cursor sits at end-of-input, which is
// where most users type anyway.

import type { InputState } from '../state.ts';
import type { Capabilities } from '../term.ts';

export const renderInput = (input: InputState, _caps: Capabilities): string[] => {
  const lines = input.value === '' ? [''] : input.value.split('\n');
  return lines.map((l, i) => (i === 0 ? `> ${l}` : `  ${l}`));
};
