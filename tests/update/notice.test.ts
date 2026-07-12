import { describe, expect, test } from 'bun:test';
import type { UpdateCheckState } from '../../src/storage/repos/update-check.ts';
import { DEFAULT_INTERVAL_MS, decideNotice, shouldRefresh } from '../../src/update/notice.ts';

const state = (o: Partial<UpdateCheckState>): UpdateCheckState => ({
  lastCheckedAt: null,
  latestSeen: null,
  notifiedVersion: null,
  ...o,
});

describe('decideNotice', () => {
  test('no cached latest → silent', () => {
    expect(decideNotice(state({}), '0.1.3').show).toBe(false);
  });
  test('newer + not yet notified → show', () => {
    expect(decideNotice(state({ latestSeen: '0.2.0' }), '0.1.3')).toEqual({
      show: true,
      latest: '0.2.0',
    });
  });
  test('already notified this version → silent (once per release)', () => {
    expect(
      decideNotice(state({ latestSeen: '0.2.0', notifiedVersion: '0.2.0' }), '0.1.3').show,
    ).toBe(false);
  });
  test('same version → silent', () => {
    expect(decideNotice(state({ latestSeen: '0.1.3' }), '0.1.3').show).toBe(false);
  });
  test('downgrade (dev ahead of release) → silent', () => {
    expect(decideNotice(state({ latestSeen: '0.1.0' }), '0.2.0-dev').show).toBe(false);
  });
  test('running prerelease, stable out → show', () => {
    expect(decideNotice(state({ latestSeen: '0.2.0' }), '0.2.0-rc.1')).toEqual({
      show: true,
      latest: '0.2.0',
    });
  });
});

describe('shouldRefresh', () => {
  test('never checked → refresh', () => {
    expect(shouldRefresh(state({ lastCheckedAt: null }), 1_000_000)).toBe(true);
  });
  test('within interval → skip', () => {
    const now = 1_000_000_000;
    expect(shouldRefresh(state({ lastCheckedAt: now - 1000 }), now)).toBe(false);
  });
  test('interval elapsed → refresh', () => {
    const now = 1_000_000_000;
    expect(shouldRefresh(state({ lastCheckedAt: now - DEFAULT_INTERVAL_MS - 1 }), now)).toBe(true);
  });
  test('custom interval honored', () => {
    const now = 1_000_000;
    expect(shouldRefresh(state({ lastCheckedAt: now - 5000 }), now, 10_000)).toBe(false);
    expect(shouldRefresh(state({ lastCheckedAt: now - 15_000 }), now, 10_000)).toBe(true);
  });
});
