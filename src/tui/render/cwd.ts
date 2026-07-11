// Banner cwd display (UI.md §6.1). The working directory is shown on the
// startup banner, but a deep tree — notably a removable-drive mount like
// `/run/media/<uuid>/<user>/Workspaces/forja` — buries the two parts that
// carry signal (WHERE it's mounted, and the repo itself) under a middle of
// pure noise (the mount uuid, the user). This shortens the DISPLAY string:
// collapse `$HOME` → `~`, then, when the result still exceeds a comfortable
// budget, elide the middle, keeping the leading context + the last two
// components joined by an ellipsis. The RAW cwd stays on the PermanentItem
// (NDJSON / audit consumers read it untouched) — only this human line shrinks.

import type { Capabilities } from '../term.ts';
import { ellipsisGlyph } from './glyphs.ts';

// Comfortable width before eliding. Deliberately NOT the terminal width: a
// `/run/media/<uuid>/...` path fits an 80-col line yet is still unreadable,
// so the budget targets readability, not layout. The renderer's
// truncateToWidth still hard-clips if the terminal is narrower than even the
// shortened form, so this never has to reason about `caps.cols`.
const CWD_BUDGET = 48;
// `/run/media`, `/usr/local` — two leading components is enough to say where
// an absolute path lives without dragging the noisy middle along.
const HEAD_KEEP_ABS = 2;
// `Workspaces/forja` — the repo and its immediate parent, the part the
// operator actually reads.
const TAIL_KEEP = 2;

// Collapse a `$HOME`-rooted path to `~`. Boundary-anchored so a sibling like
// `/home/lexicon` under home `/home/lex` is NOT mangled into `~icon`.
const collapseHome = (path: string, home: string): string => {
  if (home.length === 0) return path;
  if (path === home) return '~';
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
};

export const shortenCwd = (cwd: string, home: string, caps: Capabilities): string => {
  const collapsed = collapseHome(cwd, home);
  if (collapsed.length <= CWD_BUDGET) return collapsed;

  const isHome = collapsed === '~' || collapsed.startsWith('~/');
  const isAbs = collapsed.startsWith('/');
  // Strip the anchor so `comps` holds only the meaningful path segments:
  // `~/` and the leading `/` are re-applied when rebuilding.
  const rest = isHome ? collapsed.slice(2) : isAbs ? collapsed.slice(1) : collapsed;
  const comps = rest.split('/').filter((c) => c.length > 0);

  // Home already contributes its anchor (`~`), so it keeps no leading
  // components; an absolute/relative path keeps the first two for context.
  const headKeep = isHome ? 0 : HEAD_KEEP_ABS;
  if (comps.length <= headKeep + TAIL_KEEP) return collapsed; // nothing to drop

  const ell = ellipsisGlyph(caps);
  const middle = [...comps.slice(0, headKeep), ell, ...comps.slice(comps.length - TAIL_KEEP)].join(
    '/',
  );
  if (isHome) return `~/${middle}`;
  if (isAbs) return `/${middle}`;
  return middle;
};
