// Shared display glyphs used across multiple renderers. Single source
// of truth for box-drawing, connector and glyph chars so a spec change
// (e.g. "use ▸ instead of ·") lands in one file. ASCII fallbacks live
// next to the Unicode glyph so reviewers see both in context.

import type { Capabilities } from '../term.ts';

// Sub-content connector under operation chips. UI.md §4.10.7.
// Used by both `tool-card` (live chip) and `permanent` (final chip);
// also the LAST line of a grouped card's subject tree.
export const subContentConnector = (caps: Capabilities): string => (caps.unicode ? '└─ ' : '\\- ');

// Mid-branch connector for the non-last lines of a grouped card's
// subject list (`tool-end-batch`). `├─` keeps the tree open;
// `subContentConnector`'s `└─` closes it on the final row. ASCII
// fallback `+- ` stays distinct from the `\- ` last-branch.
export const treeBranchConnector = (caps: Capabilities): string => (caps.unicode ? '├─ ' : '+- ');

// Ellipsis glyph (UI.md §6.2). Truncation / overflow tails — the
// `… +N more` fold under a capped `tool-end-batch`. Centralized so
// the ASCII fallback (`...`) stays consistent across renderers.
export const ellipsisGlyph = (caps: Capabilities): string => (caps.unicode ? '…' : '...');
