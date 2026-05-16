// Calendar-correct expires parsing — single source of truth shared
// between `registry.list({ includeExpired })` and the slash-side
// `/memory list` flag rendering. The two-step parse (validate date
// first, then add 24h) was the load-bearing fix that closed both the
// month-end regression (commit 68bf36e — `2026-01-31` was rejected
// pre-fix) and the duplicated-implementation drift risk (this
// module's reason for existing).

import { describe, expect, test } from 'bun:test';
import { isExpired, parseExpiresEndOfDayMs } from '../../src/memory/expires.ts';

describe('parseExpiresEndOfDayMs', () => {
  test('valid YYYY-MM-DD returns start-of-NEXT-day UTC', () => {
    // 2026-05-15 expires at 2026-05-16 00:00 UTC.
    const cutoff = parseExpiresEndOfDayMs('2026-05-15');
    expect(cutoff).toBe(Date.UTC(2026, 4, 16, 0, 0, 0));
  });

  test('month-end dates round-trip (regression for `day + 1` bug)', () => {
    // Last day of a 31-day month. Pre-fix this returned null because
    // `Date.UTC(y, m-1, day + 1)` rolled into the next month, and
    // the round-trip month check rejected it as malformed.
    expect(parseExpiresEndOfDayMs('2026-01-31')).toBe(Date.UTC(2026, 1, 1, 0, 0, 0));
    expect(parseExpiresEndOfDayMs('2026-04-30')).toBe(Date.UTC(2026, 4, 1, 0, 0, 0));
    expect(parseExpiresEndOfDayMs('2026-12-31')).toBe(Date.UTC(2027, 0, 1, 0, 0, 0));
  });

  test('leap day (2024-02-29) round-trips; non-leap year rejects 2025-02-29', () => {
    expect(parseExpiresEndOfDayMs('2024-02-29')).toBe(Date.UTC(2024, 2, 1, 0, 0, 0));
    expect(parseExpiresEndOfDayMs('2025-02-29')).toBeNull();
  });

  test('overflow inputs rejected (Feb 31, Apr 31, month 13, day 0)', () => {
    expect(parseExpiresEndOfDayMs('2026-02-31')).toBeNull();
    expect(parseExpiresEndOfDayMs('2026-04-31')).toBeNull();
    expect(parseExpiresEndOfDayMs('2026-13-01')).toBeNull();
    expect(parseExpiresEndOfDayMs('2026-01-00')).toBeNull();
  });

  test('format mismatches rejected', () => {
    expect(parseExpiresEndOfDayMs('not-a-date')).toBeNull();
    expect(parseExpiresEndOfDayMs('2026/05/15')).toBeNull();
    expect(parseExpiresEndOfDayMs('26-05-15')).toBeNull();
    expect(parseExpiresEndOfDayMs('2026-5-15')).toBeNull();
    expect(parseExpiresEndOfDayMs('')).toBeNull();
  });
});

describe('isExpired', () => {
  test('undefined expires is never expired', () => {
    expect(isExpired(undefined, Date.UTC(2099, 0, 1))).toBe(false);
  });

  test('end-of-day boundary: valid at 23:59 on expiry date; expired at 00:00 the next day', () => {
    // 2026-05-15 valid until 2026-05-15 23:59:59.999 UTC; expired
    // starting 2026-05-16 00:00:00 UTC.
    const expiry = '2026-05-15';
    expect(isExpired(expiry, Date.UTC(2026, 4, 15, 23, 59, 59, 999))).toBe(false);
    expect(isExpired(expiry, Date.UTC(2026, 4, 16, 0, 0, 0))).toBe(true);
    // Mid-day on expiry is valid.
    expect(isExpired(expiry, Date.UTC(2026, 4, 15, 12, 0, 0))).toBe(false);
  });

  test('past expiry → expired; future expiry → not expired', () => {
    const now = Date.UTC(2026, 0, 15);
    expect(isExpired('2024-01-01', now)).toBe(true);
    expect(isExpired('2099-12-31', now)).toBe(false);
  });

  test('malformed expires treated as non-expiring (defensive)', () => {
    // The frontmatter validator refuses bad shapes on write, but on
    // read we're defensive against hand-edited files: rather than
    // surprise-evict, surface the malformed entry as visible so
    // operator can fix.
    expect(isExpired('2026-02-31', Date.UTC(2099, 0, 1))).toBe(false);
    expect(isExpired('not-a-date', Date.UTC(2099, 0, 1))).toBe(false);
  });

  test('year-rollover boundary (2026-12-31 → 2027-01-01 expired)', () => {
    expect(isExpired('2026-12-31', Date.UTC(2026, 11, 31, 23, 59))).toBe(false);
    expect(isExpired('2026-12-31', Date.UTC(2027, 0, 1, 0, 0))).toBe(true);
  });
});
