import { describe, expect, test } from 'bun:test';
import { createHeartbeat } from '../../src/tui/heartbeat.ts';

// Deterministic timer harness — each scheduled fn is captured; tests
// drain by calling `flushAll`.
type Pending = { fn: () => void; ms: number };
const makeHarness = (): {
  setTimer: (fn: () => void, ms: number) => Pending;
  clearTimer: (h: unknown) => void;
  flushAll: () => void;
  pending: () => Pending[];
} => {
  let pending: Pending[] = [];
  return {
    setTimer: (fn, ms) => {
      const p = { fn, ms };
      pending.push(p);
      return p;
    },
    clearTimer: (h) => {
      pending = pending.filter((p) => p !== h);
    },
    flushAll: () => {
      const snap = pending;
      pending = [];
      snap.forEach((p) => p.fn());
    },
    pending: () => pending.slice(),
  };
};

describe('createHeartbeat', () => {
  test('idle: bump with isActive=false does NOT arm a timer', () => {
    const h = makeHarness();
    let ticks = 0;
    const hb = createHeartbeat({
      isActive: () => false,
      onTick: () => ticks++,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    hb.bump();
    expect(h.pending()).toHaveLength(0);
    expect(ticks).toBe(0);
    hb.close();
  });

  test('active: bump arms a timer; firing calls onTick and re-arms', () => {
    const h = makeHarness();
    let ticks = 0;
    const hb = createHeartbeat({
      isActive: () => true,
      onTick: () => ticks++,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    hb.bump();
    expect(h.pending()).toHaveLength(1);
    h.flushAll();
    expect(ticks).toBe(1);
    expect(h.pending()).toHaveLength(1); // re-armed
    h.flushAll();
    expect(ticks).toBe(2);
    hb.close();
  });

  test('becomes inactive: next firing skips both onTick and re-arm', () => {
    const h = makeHarness();
    let active = true;
    let ticks = 0;
    const hb = createHeartbeat({
      isActive: () => active,
      onTick: () => ticks++,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    hb.bump();
    h.flushAll();
    expect(ticks).toBe(1);
    expect(h.pending()).toHaveLength(1);
    // State went idle between fires. The pending timer fires, sees
    // isActive=false, and bails BEFORE incrementing ticks — saves
    // one wasted redraw on every active→idle transition.
    active = false;
    h.flushAll();
    expect(ticks).toBe(1);
    expect(h.pending()).toHaveLength(0); // not re-armed
    hb.close();
  });

  test('multiple bump() calls while active are coalesced (single timer)', () => {
    const h = makeHarness();
    const hb = createHeartbeat({
      isActive: () => true,
      onTick: () => {},
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    hb.bump();
    hb.bump();
    hb.bump();
    expect(h.pending()).toHaveLength(1);
    hb.close();
  });

  test('close cancels any pending timer and stops further firings', () => {
    const h = makeHarness();
    let ticks = 0;
    const hb = createHeartbeat({
      isActive: () => true,
      onTick: () => ticks++,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    hb.bump();
    hb.close();
    expect(h.pending()).toHaveLength(0);
    h.flushAll(); // nothing to flush, but verify no crash
    expect(ticks).toBe(0);
  });

  test('close is idempotent', () => {
    const h = makeHarness();
    const hb = createHeartbeat({
      isActive: () => true,
      onTick: () => {},
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    expect(() => {
      hb.close();
      hb.close();
    }).not.toThrow();
  });

  test('intervalMs option sets the timer delay', () => {
    const h = makeHarness();
    const hb = createHeartbeat({
      isActive: () => true,
      onTick: () => {},
      intervalMs: 250,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    hb.bump();
    expect(h.pending()[0]?.ms).toBe(250);
    hb.close();
  });

  test('tickCount reports cumulative firings', () => {
    const h = makeHarness();
    const hb = createHeartbeat({
      isActive: () => true,
      onTick: () => {},
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    hb.bump();
    h.flushAll();
    h.flushAll();
    h.flushAll();
    expect(hb.tickCount()).toBe(3);
    hb.close();
  });

  test('skipped tick (isActive false at fire time) does not increment tickCount', () => {
    const h = makeHarness();
    let active = true;
    const hb = createHeartbeat({
      isActive: () => active,
      onTick: () => {},
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    hb.bump();
    active = false;
    h.flushAll();
    expect(hb.tickCount()).toBe(0);
    hb.close();
  });
});
