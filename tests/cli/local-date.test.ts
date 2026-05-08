import { describe, expect, test } from 'bun:test';
import { localIsoDate } from '../../src/cli/local-date.ts';

describe('localIsoDate', () => {
  test('returns YYYY-MM-DD shape', () => {
    expect(localIsoDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('formats local-time fields, not UTC', () => {
    // Pin the load-bearing semantic: the helper reads the LOCAL
    // year/month/day fields off the Date object. A regression
    // that swapped back to `toISOString()` would compute UTC
    // — visible here when we hand-craft a Date whose UTC and
    // local fields disagree.
    //
    // Strategy: use a Date whose construction-time numeric
    // fields are unambiguous. `new Date(2026, 4, 7)` constructs
    // May 7 2026 at midnight LOCAL — `getMonth()` returns 4
    // (May; 0-indexed), `getDate()` returns 7, `getFullYear()`
    // returns 2026. Independent of CI timezone.
    const d = new Date(2026, 4, 7);
    expect(localIsoDate(d)).toBe('2026-05-07');
  });

  test('zero-pads month and day', () => {
    // January 1 — single-digit month and day MUST emit `01`,
    // not `1`. A regression that dropped padStart(2, '0') would
    // surface as `2026-1-1`, which the model would either
    // mis-parse or render as a non-ISO oddity.
    const d = new Date(2026, 0, 1);
    expect(localIsoDate(d)).toBe('2026-01-01');
  });

  test('handles December (largest valid month) without overflow', () => {
    const d = new Date(2026, 11, 31);
    expect(localIsoDate(d)).toBe('2026-12-31');
  });

  test('does NOT match toISOString() when local and UTC disagree', () => {
    // The whole point of this helper. A Date whose LOCAL date
    // and UTC date are different MUST emit the local one.
    //
    // We can't reliably force a TZ disagreement without
    // mocking the system clock, but we CAN assert that the
    // helper reads from local-time getters: construct a Date
    // at midnight UTC and compare with the helper's output
    // for the local interpretation of that instant.
    //
    // The instant `2026-05-07T00:00:00Z` is May 6 (or May 7,
    // depending on TZ) in local time. We verify the helper's
    // result MATCHES the local-time year/month/day fields of
    // that Date — not the UTC string.
    const utcMidnight = new Date('2026-05-07T00:00:00Z');
    const expectedY = utcMidnight.getFullYear();
    const expectedM = String(utcMidnight.getMonth() + 1).padStart(2, '0');
    const expectedD = String(utcMidnight.getDate()).padStart(2, '0');
    expect(localIsoDate(utcMidnight)).toBe(`${expectedY}-${expectedM}-${expectedD}`);
  });
});
