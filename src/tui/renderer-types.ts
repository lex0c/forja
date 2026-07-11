// Public types shared between renderer.ts and the per-element render
// functions in `src/tui/render/`. Lives in its own file to avoid a
// circular import between `renderer.ts` (consumer) and
// `render/compose.ts` (producer that the renderer depends on).

import type { LiveState } from './state.ts';
import type { Capabilities } from './term.ts';

// Compose the live region from current state. `now` is wall-clock ms,
// passed by the renderer so per-frame elements (spinners, thinking
// duration) have a single time source — easier to test than reading
// `Date.now()` inside each render function.
export type ComposeLive = (state: LiveState, caps: Capabilities, now: number) => string[];
