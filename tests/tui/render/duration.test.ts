import { describe, expect, test } from 'bun:test';
import { formatChipDuration, formatCoarseDuration } from '../../../src/tui/render/duration.ts';

describe('formatChipDuration', () => {
  test('sub-second durations render in ms', () => {
    expect(formatChipDuration(0)).toBe('0ms');
    expect(formatChipDuration(1)).toBe('1ms');
    expect(formatChipDuration(850)).toBe('850ms');
    expect(formatChipDuration(999)).toBe('999ms');
  });

  test('1s to <1min renders as one-decimal seconds', () => {
    expect(formatChipDuration(1000)).toBe('1.0s');
    expect(formatChipDuration(1234)).toBe('1.2s');
    expect(formatChipDuration(8200)).toBe('8.2s');
    expect(formatChipDuration(45000)).toBe('45.0s');
    expect(formatChipDuration(59400)).toBe('59.4s');
  });

  test('>=1min renders as minutes and seconds (`Xm` when seconds are zero)', () => {
    expect(formatChipDuration(60000)).toBe('1m');
    expect(formatChipDuration(90000)).toBe('1m30s');
    expect(formatChipDuration(125000)).toBe('2m5s');
    expect(formatChipDuration(120000)).toBe('2m');
  });

  test('the minute boundary never flashes 60.0s (rounds to tenths before branching)', () => {
    // 59 999ms: a raw `(59.999).toFixed(1)` would print "60.0s" one
    // tick before the chip flips to "1m". Rounding to tenths first
    // sends the whole [59 950, 60 000) window straight to `1m`.
    expect(formatChipDuration(59999)).toBe('1m');
    expect(formatChipDuration(59950)).toBe('1m');
    expect(formatChipDuration(59949)).toBe('59.9s');
  });

  test('negative input (clock skew) clamps to 0ms, not 0s', () => {
    // Unit stays consistent with the sub-second branch so a single
    // skew tick doesn't visually jump the chip between units.
    expect(formatChipDuration(-1)).toBe('0ms');
    expect(formatChipDuration(-5000)).toBe('0ms');
  });

  test('minute branch rounds raw ms, not the tenths (no double-round)', () => {
    // 60 450ms = 60.45s → honestly `1m`. Rounding through `tenths`
    // (605 → 60.5 → 61) would wrongly yield `1m1s`.
    expect(formatChipDuration(60450)).toBe('1m');
    expect(formatChipDuration(60500)).toBe('1m1s');
  });
});

describe('formatCoarseDuration', () => {
  test('sub-second renders in ms', () => {
    expect(formatCoarseDuration(0)).toBe('0ms');
    expect(formatCoarseDuration(850)).toBe('850ms');
  });

  test('1s to <1min renders as whole seconds (no decimal)', () => {
    // The chip formatter would say `8.2s`; the coarse one rounds to
    // a whole second — prose / table cells don't want the decimal.
    expect(formatCoarseDuration(1000)).toBe('1s');
    expect(formatCoarseDuration(8200)).toBe('8s');
    expect(formatCoarseDuration(8700)).toBe('9s');
    expect(formatCoarseDuration(59000)).toBe('59s');
  });

  test('>=1min renders as minutes and seconds', () => {
    expect(formatCoarseDuration(60000)).toBe('1m');
    expect(formatCoarseDuration(90000)).toBe('1m30s');
    expect(formatCoarseDuration(125000)).toBe('2m5s');
  });
});
