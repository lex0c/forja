import { describe, expect, test } from 'bun:test';
import {
  DEFER_BELOW_TOKENS_SMALL,
  GUIDE_WINDOW_FRACTION,
  MEMORY_MIN_ENTRIES,
  guideMaxBytes,
  isDeferred,
  isSmallWindow,
  memoryMaxEntries,
} from '../../src/tools/context-budget.ts';

const ABSOLUTE = 16 * 1024; // PROJECT_GUIDE_MAX_BYTES

describe('guideMaxBytes', () => {
  test('a frontier window is dominated by the absolute ceiling (no change)', () => {
    // 200K × 0.10 × 4 = 80000 bytes >> 16384 → ceiling wins.
    expect(guideMaxBytes(200_000, ABSOLUTE)).toBe(ABSOLUTE);
    expect(guideMaxBytes(1_000_000, ABSOLUTE)).toBe(ABSOLUTE);
  });

  test('a small window clips below the ceiling to the window fraction', () => {
    // 32K × 0.10 × 4 = 12800 bytes < 16384 → window budget wins.
    expect(guideMaxBytes(32_000, ABSOLUTE)).toBe(12_800);
    expect(guideMaxBytes(32_000, ABSOLUTE)).toBeLessThan(ABSOLUTE);
  });

  test('the cap equals ~GUIDE_WINDOW_FRACTION of the window in tokens', () => {
    const window = 32_000;
    const capTokens = guideMaxBytes(window, ABSOLUTE) / 4;
    expect(capTokens).toBeCloseTo(window * GUIDE_WINDOW_FRACTION, 0);
  });

  test('an unknown (non-positive) window falls back to the absolute cap', () => {
    expect(guideMaxBytes(0, ABSOLUTE)).toBe(ABSOLUTE);
    expect(guideMaxBytes(-1, ABSOLUTE)).toBe(ABSOLUTE);
  });

  test('never exceeds the caller-supplied ceiling', () => {
    for (const w of [1_000, 8_000, 32_000, 128_000, 200_000, 1_000_000]) {
      expect(guideMaxBytes(w, ABSOLUTE)).toBeLessThanOrEqual(ABSOLUTE);
    }
  });
});

describe('isDeferred', () => {
  const SMALL = 30_000;
  const LARGE = 200_000;

  test('a plain base tool is never deferred', () => {
    expect(isDeferred({}, SMALL)).toBe(false);
    expect(isDeferred({}, LARGE)).toBe(false);
  });

  test('the static deferred flag wins at any window', () => {
    expect(isDeferred({ deferred: true }, LARGE)).toBe(true);
    expect(isDeferred({ deferred: true }, SMALL)).toBe(true);
    expect(isDeferred({ deferred: true }, 0)).toBe(true);
  });

  test('a window-tagged tool defers only below its threshold', () => {
    const meta = { deferBelowTokens: DEFER_BELOW_TOKENS_SMALL };
    expect(isDeferred(meta, LARGE)).toBe(false); // 200K ≥ 64K → base
    expect(isDeferred(meta, SMALL)).toBe(true); // 30K < 64K → deferred
  });

  test('the threshold boundary is exclusive (>= stays base)', () => {
    const meta = { deferBelowTokens: 64_000 };
    expect(isDeferred(meta, 64_000)).toBe(false);
    expect(isDeferred(meta, 63_999)).toBe(true);
  });

  test('an unknown window disables the window-relative arm', () => {
    // Preserves static behavior when the window is unknown — the tool stays
    // visible rather than vanishing on a 0/negative capability.
    expect(isDeferred({ deferBelowTokens: DEFER_BELOW_TOKENS_SMALL }, 0)).toBe(false);
    expect(isDeferred({ deferBelowTokens: DEFER_BELOW_TOKENS_SMALL }, -1)).toBe(false);
  });
});

describe('memoryMaxEntries', () => {
  test('no cap at or above the small tier (64K)', () => {
    expect(memoryMaxEntries(DEFER_BELOW_TOKENS_SMALL)).toBeUndefined();
    expect(memoryMaxEntries(200_000)).toBeUndefined();
  });

  test('an unknown window means no cap', () => {
    expect(memoryMaxEntries(0)).toBeUndefined();
    expect(memoryMaxEntries(-1)).toBeUndefined();
  });

  test('a small window caps to the window fraction', () => {
    // 32K × 0.04 / 20 = 64.
    expect(memoryMaxEntries(32_000)).toBe(64);
  });

  test('never caps below the floor', () => {
    // A tiny window computes < MEMORY_MIN_ENTRIES; the floor wins.
    expect(memoryMaxEntries(1_000)).toBe(MEMORY_MIN_ENTRIES);
  });
});

describe('isSmallWindow', () => {
  test('true below the 64K tier, false at/above', () => {
    expect(isSmallWindow(32_000)).toBe(true);
    expect(isSmallWindow(63_999)).toBe(true);
    expect(isSmallWindow(DEFER_BELOW_TOKENS_SMALL)).toBe(false);
    expect(isSmallWindow(200_000)).toBe(false);
  });

  test('an unknown (non-positive) window is not small (full prefix)', () => {
    expect(isSmallWindow(0)).toBe(false);
    expect(isSmallWindow(-1)).toBe(false);
  });
});
