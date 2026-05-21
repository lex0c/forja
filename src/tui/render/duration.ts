// Canonical duration formatter for operation chips. Spec: UI.md §4.10.5.
//
// One source of truth for the `[…]` metric every operation chip
// carries — the live tool card, the assistant / thinking / critique /
// awaiting chips, the finalized tool-end card, and the subagent
// summary all format elapsed time through this. Before, each chip
// kept its own near-identical `formatElapsed`, and they had drifted
// (`0s` vs `0ms` clamp; decimal vs integer seconds).
//
// Scale:
//   < 1s    → `850ms`
//   < 1min  → `8.2s`    one decimal — the sub-second precision an
//                       operator wants while a chip ticks live
//   ≥ 1min  → `1m23s`   (`2m` when the seconds are zero)
//
// Negative input (clock skew — a producer's `startedAt` ahead of
// `now`) clamps to `0ms`, not `0s`: the unit stays consistent with
// the sub-second branch so a single skew tick doesn't visually jump
// the chip between units.
//
// NOT used by the turn-end footer (`Cogitated for X`) or the live
// subagent row — those carry their own editorial / tabular duration
// shapes by design (see permanent.ts §session-footer, subagent-row.ts).
export const formatChipDuration = (ms: number): string => {
  if (ms < 0) return '0ms';
  if (ms < 1000) return `${ms}ms`;
  // Round to tenths of a second once, then branch on the rounded
  // value — comparing raw ms would let 59 999ms render as `60.0s`
  // one tick before it flips to `1m`.
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  // Minute branch rounds `ms` directly. Reusing `tenths` would
  // double-round (60 450ms → 605 tenths → 61s → `1m1s` instead of
  // `1m`); the `tenths < 600` gate already settled the boundary.
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
};

// Coarse duration for non-chip surfaces — the turn-end footer
// (`Cogitated for 8s`) and the live subagent row (`· 2s`). Whole
// seconds, no sub-second decimal: those lines read as prose / a
// table cell where `8.2s` would be noise. Same `< 1s → ms` and
// `≥ 1min → 1m23s` shape as `formatChipDuration`; only the
// 1s-to-1min band differs — integer here, one decimal there.
// Callers pass a non-negative `ms` (the footer's event duration,
// the subagent row's `Math.max(0, …)` elapsed), so there is no
// skew clamp.
export const formatCoarseDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
};
