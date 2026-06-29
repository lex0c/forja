// Format a `Date` as `YYYY-MM-DD` in the OPERATOR'S LOCAL
// timezone, not UTC. Used by `bootstrap.ts` to populate the
// environment prompt's `today:` field — a value the model uses
// to interpret relative requests like "today's commits" or
// "yesterday's logs".
//
// Why local: `Date.prototype.toISOString()` always emits UTC.
// In US timezones (UTC-5..UTC-10) any session that starts in
// the operator's evening lands in the NEXT UTC day; the model
// would then interpret "yesterday" as the operator's TODAY,
// pulling the wrong git window for date-sensitive actions
// (e.g. `git log --since=yesterday` on the wrong range,
// `--since=today` returning empty when it shouldn't).
//
// `getFullYear()` / `getMonth()` / `getDate()` are
// guaranteed-local-time getters on the Date prototype — same
// pattern already used by `slash/commands/memory.ts` and
// `slash/commands/sessions.ts`. We do not depend on
// `toLocaleDateString('en-CA')` because Bun's `Intl` surface
// can be locale-data-stripped in stripped builds; the manual
// pad keeps the format deterministic across runtimes.
//
// Exported so the bug surface (timezone math) has a focused
// unit test that pins the local-time semantics — a regression
// that flipped back to `toISOString()` would break the test
// even when the failing date crosses no DST boundary in the
// CI runner's timezone.
export const localIsoDate = (d: Date = new Date()): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// Format an epoch-ms timestamp as `YYYY-MM-DD HH:MM` in the operator's LOCAL
// timezone (same local-getter rationale as localIsoDate above — operator
// surfaces like /mcp, /memory audit, /sessions all read local, so cross-
// referencing them doesn't skew by the UTC offset). Returns '—' for a
// null/non-positive/invalid ms, so a missing or tampered timestamp renders
// cleanly. Uses the local getters (not toISOString), so an out-of-range ms
// yields '—' rather than throwing a RangeError.
export const localTimestamp = (ms: number | null): string => {
  if (ms === null || ms <= 0) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
