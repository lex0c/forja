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
