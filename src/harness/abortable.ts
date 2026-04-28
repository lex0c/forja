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
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
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
