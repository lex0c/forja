import { describe, expect, test } from 'bun:test';
import {
  createReminderScheduler,
  DEFAULT_HORIZON_CAP_MS,
  type Reminder,
} from '../../src/reminders/index.ts';

// A controllable fake clock + timer so reminders fire synchronously on
// demand — no wall-clock waits, fully deterministic.
const makeClock = () => {
  let nowMs = 1_000_000;
  let nextHandle = 1;
  const timers = new Map<number, { fireAt: number; cb: () => void }>();
  return {
    now: () => nowMs,
    setTimer: (cb: () => void, ms: number) => {
      const h = nextHandle++;
      timers.set(h, { fireAt: nowMs + ms, cb });
      return h as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (h: ReturnType<typeof setTimeout>) => {
      timers.delete(h as unknown as number);
    },
    // Advance virtual time; fire every timer now due, soonest first.
    advance: (ms: number) => {
      nowMs += ms;
      const due = [...timers.entries()]
        .filter(([, t]) => t.fireAt <= nowMs)
        .sort((a, b) => a[1].fireAt - b[1].fireAt);
      for (const [h, t] of due) {
        timers.delete(h);
        t.cb();
      }
    },
    pendingTimers: () => timers.size,
  };
};

describe('reminder scheduler', () => {
  test('fires after the delay with the scheduled note', () => {
    const clock = makeClock();
    const fired: Reminder[] = [];
    const s = createReminderScheduler({
      onFire: (r) => fired.push(r),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const { id, fireAt } = s.set({ delayMs: 10 * 60_000, note: 'check the deploy' });
    expect(fireAt).toBe(clock.now() + 10 * 60_000);
    clock.advance(9 * 60_000);
    expect(fired).toHaveLength(0); // not due yet
    clock.advance(2 * 60_000);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.id).toBe(id);
    expect(fired[0]?.note).toBe('check the deploy');
  });

  test('list shows pending reminders soonest-first and drops fired ones', () => {
    const clock = makeClock();
    const s = createReminderScheduler({
      onFire: () => {},
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    s.set({ delayMs: 30 * 60_000, note: 'later' });
    const soon = s.set({ delayMs: 5 * 60_000, note: 'soon' });
    const listed = s.list();
    expect(listed.map((r) => r.note)).toEqual(['soon', 'later']); // soonest first
    clock.advance(6 * 60_000); // fire 'soon'
    expect(s.list().map((r) => r.note)).toEqual(['later']);
    expect(s.list().some((r) => r.id === soon.id)).toBe(false);
  });

  test('cancel before fire prevents the callback and is reported', () => {
    const clock = makeClock();
    const fired: Reminder[] = [];
    const s = createReminderScheduler({
      onFire: (r) => fired.push(r),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const { id } = s.set({ delayMs: 60_000, note: 'cancel me' });
    expect(s.cancel(id)).toBe(true);
    expect(s.cancel(id)).toBe(false); // already gone
    clock.advance(120_000);
    expect(fired).toHaveLength(0);
    expect(clock.pendingTimers()).toBe(0);
  });

  test('cancel of an unknown id returns false', () => {
    const s = createReminderScheduler({ onFire: () => {} });
    expect(s.cancel('no-such-id')).toBe(false);
  });

  test('cleanup clears every pending timer (no leak at session exit)', () => {
    const clock = makeClock();
    const fired: Reminder[] = [];
    const s = createReminderScheduler({
      onFire: (r) => fired.push(r),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    s.set({ delayMs: 60_000, note: 'a' });
    s.set({ delayMs: 120_000, note: 'b' });
    expect(clock.pendingTimers()).toBe(2);
    s.cleanup();
    expect(clock.pendingTimers()).toBe(0);
    expect(s.list()).toHaveLength(0);
    clock.advance(300_000);
    expect(fired).toHaveLength(0); // nothing fires after cleanup
  });

  test('onChange reports the pending count on set / cancel / fire / cleanup', () => {
    const clock = makeClock();
    const counts: number[] = [];
    const s = createReminderScheduler({
      onFire: () => {},
      onChange: (n) => counts.push(n),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const a = s.set({ delayMs: 10_000, note: 'a' }); // → 1
    s.set({ delayMs: 20_000, note: 'b' }); // → 2
    s.cancel(a.id); // → 1
    clock.advance(25_000); // fires 'b' → 0
    s.cleanup(); // → 0 (idempotent, still reports)
    expect(counts).toEqual([1, 2, 1, 0, 0]);
  });

  test('rejects a non-positive or non-finite delay', () => {
    const s = createReminderScheduler({ onFire: () => {} });
    expect(() => s.set({ delayMs: 0, note: 'x' })).toThrow();
    expect(() => s.set({ delayMs: -5, note: 'x' })).toThrow();
    expect(() => s.set({ delayMs: Number.POSITIVE_INFINITY, note: 'x' })).toThrow();
  });

  test('rejects a delay beyond the horizon cap (setTimeout overflow guard)', () => {
    const s = createReminderScheduler({ onFire: () => {} });
    expect(() => s.set({ delayMs: DEFAULT_HORIZON_CAP_MS + 1, note: 'x' })).toThrow(/horizon cap/);
    // At the cap exactly is allowed.
    expect(() => s.set({ delayMs: DEFAULT_HORIZON_CAP_MS, note: 'x' })).not.toThrow();
  });
});
