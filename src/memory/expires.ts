// Canonical `expires` parsing for memory frontmatter.
//
// The spec admits `expires: YYYY-MM-DD` strings — a date with no
// time component. Operators read "expires today" as "valid through
// today" (intuition mirrors most calendar apps), so we treat the
// cutoff as start-of-next-day UTC. A memory with `expires:
// 2026-05-15` is expired starting `2026-05-16 00:00 UTC`.
//
// Two-step parse:
//   1. Validate the date itself (`Date.UTC(y, m-1, day)` + round-trip
//      check on year / month / day). This catches inputs like
//      `2026-02-31` which JS would silently roll to `2026-03-03`.
//   2. Compute cutoff = startOfDay + 24h via ms addition. Epoch ms
//      is independent of calendar structure, so month / year
//      rollovers (`2026-01-31` → `2026-02-01`, `2026-12-31` →
//      `2027-01-01`) work without re-engaging Date.UTC.
//
// History: an earlier shape combined the two steps into
// `Date.UTC(y, m-1, day + 1)` + month round-trip check. Every
// legitimate last-day-of-month input ("expires: 2026-01-31") was
// rejected by the month check because the +1 spilled into the
// next month. `isExpired` returned `false` for those memories
// and `list({ includeExpired: false })` quietly kept them visible
// past their expiry. The two-step form documented here is the
// correct shape (commits `68bf36e` / `6636b59`).

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Parse the spec-shaped `YYYY-MM-DD` and return the cutoff (epoch ms,
// inclusive: `nowMs >= cutoff` ⇒ expired). Returns `null` on any
// malformed input — caller treats null as "no expiry information"
// (frontmatter validator refuses bad shapes on write; on read we're
// defensive against hand-edited files).
export const parseExpiresEndOfDayMs = (expires: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expires);
  if (m === null) return null;
  const year = Number.parseInt(m[1] ?? '', 10);
  const month = Number.parseInt(m[2] ?? '', 10);
  const day = Number.parseInt(m[3] ?? '', 10);
  const startOfDayMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  if (Number.isNaN(startOfDayMs)) return null;
  const round = new Date(startOfDayMs);
  if (
    round.getUTCFullYear() !== year ||
    round.getUTCMonth() !== month - 1 ||
    round.getUTCDate() !== day
  ) {
    return null;
  }
  return startOfDayMs + MS_PER_DAY;
};

// Predicate: is the frontmatter's `expires` value past `nowMs`?
// Undefined `expires` (no expiry set) is never expired. Malformed
// `expires` is treated as non-expiring (defensive — caller decides
// whether to surface a separate warning; default behavior is to
// keep the memory visible so the operator can fix the hand-edit
// via `/memory list` / `/memory audit`).
export const isExpired = (expires: string | undefined, nowMs: number): boolean => {
  if (expires === undefined) return false;
  const cutoffMs = parseExpiresEndOfDayMs(expires);
  if (cutoffMs === null) return false;
  return nowMs >= cutoffMs;
};
