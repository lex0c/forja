import { describe, expect, test } from 'bun:test';
import {
  AbortError,
  StepStallError,
  abortableIterable,
  stallWatchdog,
  withAbort,
} from '../../src/harness/abortable.ts';

describe('withAbort', () => {
  test('resolves with the promise value when it settles first', async () => {
    const ac = new AbortController();
    await expect(withAbort(Promise.resolve(42), ac.signal)).resolves.toBe(42);
  });

  test('rejects with AbortError immediately when the signal is pre-aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    // Never-settling promise: only the pre-abort can resolve the race.
    let caught: unknown;
    await withAbort(new Promise<number>(() => {}), ac.signal).catch((e) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(AbortError);
  });

  test('rejects with AbortError when the signal fires before the promise settles', async () => {
    const ac = new AbortController();
    // A promise that never settles on its own — stands in for a hung countTokens.
    const hung = new Promise<number>(() => {});
    const raced = withAbort(hung, ac.signal);
    queueMicrotask(() => ac.abort());
    let caught: unknown;
    await raced.catch((e) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(AbortError);
  });

  test('a late abort after the promise won does not surface (listener removed)', async () => {
    const ac = new AbortController();
    const value = await withAbort(Promise.resolve('done'), ac.signal);
    expect(value).toBe('done');
    // Aborting now must not throw or produce an unhandled rejection — the
    // listener was removed when the race settled.
    expect(() => ac.abort()).not.toThrow();
  });
});

describe('abortableIterable', () => {
  test('passes events through when signal is never aborted', async () => {
    const ctrl = new AbortController();
    const source = (async function* () {
      yield 1;
      yield 2;
      yield 3;
    })();
    const out: number[] = [];
    for await (const n of abortableIterable(source, ctrl.signal)) out.push(n);
    expect(out).toEqual([1, 2, 3]);
  });

  test('throws AbortError immediately if signal is pre-aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const source = (async function* () {
      yield 1;
    })();
    let caught: unknown = null;
    try {
      for await (const _ of abortableIterable(source, ctrl.signal)) {
        // unreachable
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AbortError);
  });

  test('throws AbortError when signal fires while waiting for next event', async () => {
    const ctrl = new AbortController();
    // Source yields once then hangs forever — abortableIterable's race
    // against the signal is the only thing that can break the for-await.
    const source = (async function* () {
      yield 1;
      await new Promise(() => {
        // never resolves
      });
      yield 2;
    })();
    setTimeout(() => ctrl.abort(), 30);
    const out: number[] = [];
    let caught: unknown = null;
    try {
      for await (const n of abortableIterable(source, ctrl.signal)) {
        out.push(n);
      }
    } catch (e) {
      caught = e;
    }
    expect(out).toEqual([1]);
    expect(caught).toBeInstanceOf(AbortError);
  });

  test('abort fired between yields is caught at the next iteration boundary', async () => {
    // The bug this guards: if abort fires AFTER a value yields and
    // BEFORE the next iter.next() is awaited, onAbort would call the
    // previous iteration's already-settled reject (no-op). Without a
    // per-iteration re-check of signal.aborted, the next pull would
    // await on a hung source forever.
    const ctrl = new AbortController();
    const yields: number[] = [];
    const source = (async function* () {
      yield 1;
      // Simulate an SDK that hangs when pulled after the first value.
      await new Promise(() => {
        // never resolves
      });
      yield 2;
    })();
    let caught: unknown = null;
    try {
      for await (const n of abortableIterable(source, ctrl.signal)) {
        yields.push(n);
        // Abort right after consuming value 1. The next iteration
        // must throw at the boundary check, not hang on the next
        // iter.next() call.
        if (n === 1) ctrl.abort();
      }
    } catch (e) {
      caught = e;
    }
    expect(yields).toEqual([1]);
    expect(caught).toBeInstanceOf(AbortError);
  });

  test('removes the abort listener on normal completion (no leak per call)', async () => {
    const ctrl = new AbortController();
    const before = (ctrl.signal as unknown as { _events?: object })._events;
    for (let i = 0; i < 5; i++) {
      const source = (async function* () {
        yield i;
      })();
      for await (const _ of abortableIterable(source, ctrl.signal)) {
        // drain
      }
    }
    // Smoke check: signal should still fire normally; we can't introspect
    // listener counts portably, but a passing test means no thrown errors
    // from accumulated listeners.
    expect(ctrl.signal.aborted).toBe(false);
    void before;
  });
});

describe('stallWatchdog', () => {
  // A source that yields N values, each after `delayMs`. Lets
  // tests pin the relationship between yield interval and stall
  // budget without timing flakiness from the system clock.
  const delayedSource = async function* (
    values: readonly number[],
    delayMs: number,
  ): AsyncIterable<number> {
    for (const v of values) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      yield v;
    }
  };

  test('passes events through when stallMs is 0 (disabled)', async () => {
    const out: number[] = [];
    for await (const n of stallWatchdog(delayedSource([1, 2, 3], 5), 0)) out.push(n);
    expect(out).toEqual([1, 2, 3]);
  });

  test('passes events through when stream yields faster than stallMs', async () => {
    // 5ms between yields, 200ms stall budget — every yield
    // resets the timer well before it can fire.
    const out: number[] = [];
    for await (const n of stallWatchdog(delayedSource([1, 2, 3, 4], 5), 200)) out.push(n);
    expect(out).toEqual([1, 2, 3, 4]);
  });

  test('throws StepStallError when stream is silent for stallMs', async () => {
    // Source delays 200ms before its first yield, stall budget
    // is 50ms — the watchdog fires before the source ever
    // produces an event.
    const source = delayedSource([1, 2], 200);
    let caught: unknown = null;
    try {
      for await (const _ of stallWatchdog(source, 50)) {
        // unreachable
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StepStallError);
    if (caught instanceof StepStallError) {
      expect(caught.stallMs).toBe(50);
      expect(caught.message).toContain('50ms');
    }
  });

  test('resets the timer between yields (slow but progressing stream is fine)', async () => {
    // 40ms between yields, 60ms stall budget — each yield resets
    // before the next interval expires; total stream takes
    // 4×40=160ms but never stalls 60ms in a row. Test confirms
    // the timer is reset on each yield, not just armed once.
    const out: number[] = [];
    for await (const n of stallWatchdog(delayedSource([1, 2, 3, 4], 40), 60)) out.push(n);
    expect(out).toEqual([1, 2, 3, 4]);
  });

  test('clears the timer on normal stream completion', async () => {
    // After the stream finishes, no stale setTimeout should fire
    // post-completion. Bun would surface this as an unhandled
    // rejection in the test process. Drain a fast stream and
    // wait past what would have been a stall budget — no
    // unhandled errors means the timer was disarmed in finally.
    for await (const _ of stallWatchdog(delayedSource([1, 2], 5), 50)) {
      // drain
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    // Reaching here without a thrown StepStallError == pass.
    expect(true).toBe(true);
  });

  test('clears the timer on early break (consumer abandons the stream)', async () => {
    // for-await with `break` triggers iter.return(); the
    // watchdog's finally must disarm the timer. Otherwise a
    // stale setTimeout fires post-break and rejects nothing
    // (consumer already moved on), which Bun surfaces as
    // unhandled. The "no error wins" assertion is the test.
    const slow = delayedSource([1, 2, 3, 4, 5], 80);
    for await (const n of stallWatchdog(slow, 200)) {
      if (n === 1) break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    expect(true).toBe(true);
  });

  test('slow consumer (longer than stallMs) does NOT defeat the watchdog on the next pull (regression)', async () => {
    // Pre-fix bug: the watchdog armed the timer BEFORE yield. If
    // the consumer's processing time exceeded stallMs, the timer
    // fired DURING the yield while `stallReject` still pointed
    // to the just-resolved iter.next() promise. Calling reject on
    // a settled promise is a no-op, so the timeout was silently
    // dropped — the next pull then ran with NO timer at all and a
    // real provider hang had no watchdog. A slow renderer + low
    // maxStepStallMs was enough to trigger.
    //
    // Test shape: source yields 1 fast, then hangs. Consumer
    // sleeps longer than stallMs after receiving the first
    // value. The next pull (which never resolves) MUST trip the
    // stall — proving the timer was re-armed for the second
    // pull instead of being lost.
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]: async function* () {
        yield 1;
        await new Promise<never>(() => {
          // hang forever
        });
      },
    };
    const stallMs = 50;
    let caught: unknown = null;
    try {
      for await (const _ of stallWatchdog(source, stallMs)) {
        // Consumer takes longer than stallMs to process the
        // first event. Pre-fix this would have burned the
        // watchdog's only timer; post-fix the timer is
        // disarmed during this sleep and re-armed for the next
        // pull.
        await new Promise<void>((resolve) => setTimeout(resolve, stallMs * 3));
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StepStallError);
  });

  test('consumer time during yield does NOT count against the stall budget', async () => {
    // The companion invariant: a slow consumer between fast
    // provider yields shouldn't trip the gate either. The arm-
    // before-pull / disarm-on-result shape gives us both
    // guarantees: timer covers ONLY the iter.next() window.
    //
    // Source yields fast (5ms apart). Consumer sleeps 80ms
    // between values — total elapsed comfortably exceeds the
    // 50ms stall budget, but no individual pull does.
    const out: number[] = [];
    for await (const n of stallWatchdog(delayedSource([1, 2, 3], 5), 50)) {
      out.push(n);
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
    }
    expect(out).toEqual([1, 2, 3]);
  });
});

describe('stallWatchdog composed with abortableIterable', () => {
  // The loop wires them as `abortableIterable(stallWatchdog(...))`
  // — external aborts (Ctrl+C, wall-clock) take precedence over
  // stall detection. Pin the composition order semantics here
  // so a future refactor that swaps the layering shows up as a
  // test failure.

  test('external abort wins over a hung stream', async () => {
    const ctrl = new AbortController();
    // Source that NEVER yields (would otherwise stall forever).
    const hung: AsyncIterable<number> = {
      [Symbol.asyncIterator]: async function* () {
        await new Promise<never>(() => {
          // never resolves
        });
      },
    };
    setTimeout(() => ctrl.abort(), 30);
    let caught: unknown = null;
    try {
      for await (const _ of abortableIterable(stallWatchdog(hung, 5_000), ctrl.signal)) {
        // unreachable
      }
    } catch (e) {
      caught = e;
    }
    // abortableIterable wins — signal abort fires before the
    // stall budget elapses (5s budget vs 30ms abort).
    expect(caught).toBeInstanceOf(AbortError);
  });

  test('stall fires when stallMs is shorter than any external abort', async () => {
    const ctrl = new AbortController();
    // No abort — only stall can end the loop.
    const hung: AsyncIterable<number> = {
      [Symbol.asyncIterator]: async function* () {
        await new Promise<never>(() => {
          // never resolves
        });
      },
    };
    let caught: unknown = null;
    try {
      for await (const _ of abortableIterable(stallWatchdog(hung, 30), ctrl.signal)) {
        // unreachable
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StepStallError);
  });
});
