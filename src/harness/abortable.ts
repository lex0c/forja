// AbortError is what we throw out of `abortableIterable` when the signal
// fires. Distinct from any SDK's AbortError so the retry layer's
// `isRetryableError` sees it as non-retryable (no `.status`, no
// network-style `.code`) and the loop's catch can route to `aborted`.
export class AbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

// StepStallError fires when the stall watchdog observed no events
// for `ms` milliseconds. Distinct from AbortError so the loop's
// catch can route to `stepStalled` instead of `aborted` — the
// operator distinction matters: aborted is "I cancelled this",
// stepStalled is "the provider stream went silent".
export class StepStallError extends Error {
  constructor(public readonly stallMs: number) {
    super(`step stalled (no provider events for ${stallMs}ms)`);
    this.name = 'StepStallError';
  }
}

// Per-step stall watchdog. Wraps an AsyncIterable so that the
// for-await throws `StepStallError` when the source is silent
// for `stallMs` consecutive milliseconds. Reset on each pull —
// a slow but progressing stream (extended thinking with high
// budget, large structured outputs) doesn't trip the gate.
//
// Distinct from the existing wall-clock cap (maxWallClockMs)
// because that's session-wide; stallMs is per-step. A long
// session with many short turns can stay under wall-clock while
// still wanting per-step stall protection. Distinct from
// abortableIterable because that one fires the signal on
// EXTERNAL events (user Ctrl+C, wall-clock); this one fires on
// INTERNAL silence (provider hang, network drop mid-stream).
//
// `stallMs` of 0 disables the watchdog entirely — yields the
// source verbatim with no timer. Negative values are treated
// the same as 0 (defensive).
//
// Lifecycle: timer is armed ONLY while `iter.next()` is in
// flight. Disarmed the moment a value (or `done`) lands, so the
// consumer's own processing time during `yield` does NOT count
// against the budget. Re-armed at the top of the next iteration
// before the next pull. This dual property is load-bearing:
//
//   - Arming before yield (the prior implementation) lets the
//     timer fire DURING the yield while `stallReject` still
//     points to the previous (already-settled) iteration's
//     promise. Calling reject on a settled promise is a no-op,
//     so the timeout is effectively dropped — the next pull
//     then runs with NO timer armed at all and a true provider
//     hang has no watchdog. The slow-consumer case (renderer
//     doing heavy work between events with a low maxStepStallMs)
//     would silently defeat the gate.
//   - Arming after yield (the simpler alternative) would count
//     consumer time against the budget — a slow renderer could
//     trip the gate even though the provider is responsive.
//
// The arm-before-pull / disarm-on-result shape gets both: timer
// covers exactly the iter.next() window, never the yield, and
// stallReject is always live when the timer fires.
export async function* stallWatchdog<T>(
  source: AsyncIterable<T>,
  stallMs: number,
): AsyncIterable<T> {
  if (stallMs <= 0) {
    yield* source;
    return;
  }
  const iter = source[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stallReject: ((e: Error) => void) | null = null;
  const arm = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      stallReject?.(new StepStallError(stallMs));
    }, stallMs);
  };
  const disarm = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  try {
    while (true) {
      // Arm BEFORE setting stallReject + scheduling the pull so
      // the timer covers the entire await; disarm on result so
      // the consumer's `yield` window stays untimed.
      arm();
      const result = await new Promise<IteratorResult<T>>((resolve, reject) => {
        stallReject = reject;
        iter.next().then(resolve, reject);
      });
      // Got a result (or stall threw and we'd be in catch).
      // Drop the timer + the closure ref so:
      //   1. A late timer fire (between iter.next() resolving
      //      and disarm running, in the same microtask) doesn't
      //      reject a fresh promise from the next iteration.
      //   2. The consumer's processing time during yield does
      //      not count against the next pull's budget.
      disarm();
      stallReject = null;
      if (result.done) return;
      yield result.value;
    }
  } finally {
    disarm();
    stallReject = null;
    if (typeof iter.return === 'function') {
      Promise.resolve(iter.return(undefined)).catch(() => undefined);
    }
  }
}

// Wraps an `AsyncIterable<T>` so that an aborted signal interrupts the
// for-await loop, even if the underlying source (e.g., an SDK stream)
// never yields again. The Provider interface doesn't expose a way to
// pass `AbortSignal` to the SDK, so without this wrapper a hung HTTP
// request blocks `collectStep` forever — neither user Ctrl+C nor the
// `maxWallClockMs` cap can interrupt it because both signal sources are
// only checked between loop iterations.
//
// Mechanics: each pull from the underlying iterator races against an
// abort promise. When the signal fires, the race rejects with an
// `AbortError`. We attempt `it.return()` for graceful cleanup; the
// underlying request keeps running (we can't kill it from here) but
// the harness can move on.
//
// Two safeguards against the "abort fires between iterations" race:
//   1. A per-iteration `signal.aborted` re-check before awaiting next().
//      An abort that lands while the consumer is processing a yielded
//      value calls onAbort against the previous iteration's already-
//      settled reject (no-op). Without this re-check, the next call
//      to iter.next() would await on a hung source with no live
//      cancellation path.
//   2. The listener is registered for the lifetime of the call (no
//      `once: true`) and removed in the finally block. AbortSignal
//      only fires `abort` once anyway, but keeping the registration
//      symmetric with the cleanup avoids surprises.
// Race a plain promise against an abort signal: resolves with the promise's value
// if it settles first, rejects with `AbortError` if the signal fires first. Use
// for SDK calls that take NO AbortSignal of their own (e.g. `provider.countTokens`,
// whose interface — providers/types.ts — has no signal param) so a hung native
// endpoint can't outlive a Ctrl+C or `maxWallClockMs` abort. The underlying call
// is NOT cancelled (the SDK gives us no handle) — we stop AWAITING it, so the run
// proceeds/aborts on time while the orphaned request settles in the background and
// is GC'd. The abort listener is removed when the race settles (either way), so a
// promise that wins the race leaks no listener.
export const withAbort = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) return Promise.reject(new AbortError());
  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = (): void => reject(new AbortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, abortPromise]).finally(() => {
    if (onAbort !== null) signal.removeEventListener('abort', onAbort);
  });
};

export async function* abortableIterable<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncIterable<T> {
  if (signal.aborted) throw new AbortError();

  const iter = source[Symbol.asyncIterator]();
  let abortReject: ((e: Error) => void) | null = null;
  const onAbort = (): void => {
    abortReject?.(new AbortError());
  };
  signal.addEventListener('abort', onAbort);

  try {
    while (true) {
      if (signal.aborted) throw new AbortError();
      const result = await new Promise<IteratorResult<T>>((resolve, reject) => {
        abortReject = reject;
        iter.next().then(resolve, reject);
      });
      if (result.done) return;
      yield result.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    abortReject = null;
    // Best-effort cleanup. A misbehaving iterator shouldn't keep us
    // hanging in the finally, so we don't await — just swallow any
    // rejection so it doesn't surface as unhandled.
    if (typeof iter.return === 'function') {
      Promise.resolve(iter.return(undefined)).catch(() => undefined);
    }
  }
}
