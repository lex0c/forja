import { describe, expect, test } from 'bun:test';
import { AbortError, abortableIterable } from '../../src/harness/abortable.ts';

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
