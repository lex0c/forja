// Shared display glyphs used across multiple renderers. Single source
// of truth for box-drawing / connector chars so the spec change for
// "use ▸ instead of ·" lands in one file. ASCII fallbacks live next
// to the Unicode glyph so reviewers see both in context.

import type { Capabilities } from '../term.ts';

// Sub-content connector under operation chips. UI.md §4.10.7.
// Used by both `tool-card` (live chip) and `permanent` (final chip).
export const subContentConnector = (caps: Capabilities): string => (caps.unicode ? '└─ ' : '\\- ');
