// Heartbeat ticker for animated live-region elements. Spec: UI.md §5.2.
//
// Without periodic ticks, the spinner stays frozen between events: the
// renderer only redraws when something changes the state. The heartbeat
// fixes this by calling `onTick` (typically `scheduler.request()`) at a
// fixed interval while `isActive()` returns true.
//
// We start/stop dynamically:
//   - inactive (no running tools, no thinking): timer is off — zero
//     wakeups while idle
//   - becomes active: `bump()` schedules the next tick
//   - becomes inactive again: the next firing checks `isActive`, sees
//     false, and skips both the tick and the re-arm
//
// The check happens lazily inside the timer callback. There's no
// "external start" event the heartbeat can observe; instead, the
// renderer calls `bump()` whenever it processes an event so the
// heartbeat re-evaluates `isActive` and re-arms if needed.

export interface HeartbeatOptions {
  // Tick cadence. The spinner uses 80ms (Unicode) / 100ms (ASCII)
  // per UI.md §5.2; we go with the lower bound (80ms) so both paths
  // animate smoothly. Caller can tune.
  intervalMs?: number;
  // Predicate evaluated on each tick: when false, the heartbeat
  // stops scheduling further ticks. The renderer wires this to
  // "any active tool OR thinking indicator visible".
  isActive: () => boolean;
  // Side effect to fire on each tick. Typically `scheduler.request()`.
  onTick: () => void;
  // Injectable timer for tests (deterministic, no real setTimeout).
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export interface Heartbeat {
  // Re-evaluate `isActive` and arm a timer if active and none is
  // pending. Cheap to call repeatedly; idempotent.
  bump: () => void;
  // Stop any pending timer. Idempotent.
  close: () => void;
  // Test hook: number of ticks fired so far.
  tickCount: () => number;
}

const DEFAULT_INTERVAL_MS = 80;

export const createHeartbeat = (options: HeartbeatOptions): Heartbeat => {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let timer: unknown = null;
  let closed = false;
  let ticks = 0;

  const fire = (): void => {
    timer = null;
    if (closed) return;
    // Skip tick + re-arm when nothing animates anymore. Without this
    // check the heartbeat fires one wasted onTick after an idle
    // transition (the timer was armed before activity ceased).
    if (!options.isActive()) return;
    ticks++;
    options.onTick();
    // Re-evaluate after the tick: still active → re-arm.
    if (options.isActive()) {
      timer = setTimer(fire, intervalMs);
    }
  };

  return {
    bump: () => {
      if (closed || timer !== null) return;
      if (!options.isActive()) return;
      timer = setTimer(fire, intervalMs);
    },
    close: () => {
      closed = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
    tickCount: () => ticks,
  };
};
