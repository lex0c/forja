// Bounded stream reader — keeps memory at ~`cap` bytes while still
// fully draining the underlying pipe. Originally local to
// `src/tools/builtin/bash.ts`; lifted here so the bash worker
// handler (slice 81) shares one implementation. Slice 82 will
// delete the bash.ts copy once its spawn site migrates through
// the broker.
//
// Why "drain and discard past-cap chunks" vs. abandoning the
// stream: the kernel pipe buffer is fixed (typically 64KB on
// Linux). If we stop reading, the child's next write blocks —
// effectively a deadlock when paired with awaiting `proc.exited`.
// Past-cap chunks are read off the wire + dropped on the floor;
// memory stays bounded at ~cap because they're never appended to
// the chunk list.
//
// UTF-8 boundary safety: a multi-byte sequence may straddle a
// chunk boundary. `decoder.decode(chunk, { stream: true })` holds
// the trailing incomplete bytes between calls; the final
// `decoder.decode()` (no `stream` flag) flushes them. Naive
// per-chunk decoding without the stream flag would produce
// replacement chars for split sequences.
//
// The `stopSignal` parameter cancels the reader's pending `read()`
// without consuming the rest of the stream. Used by callers to
// break out when the producer (a spawned process) has exited but
// orphaned children keep the pipe fd open — without this, a
// `bash -c 'sleep 60 &'` invocation would block reads for the
// full sleep duration even after the bash shell itself exits.

export interface ReadCappedResult {
  text: string;
  truncated: boolean;
}

export const readCapped = async (
  stream: ReadableStream<Uint8Array>,
  cap: number,
  stopSignal?: AbortSignal,
): Promise<ReadCappedResult> => {
  const reader = stream.getReader();
  const onStop = (): void => {
    reader.cancel().catch(() => {
      // already cancelled
    });
  };
  // Slice 116 (R7 P1): symmetric attach/remove. Pre-slice the
  // pre-aborted branch called `onStop()` but did NOT attach a
  // listener — the finally below would then call
  // `removeEventListener('abort', onStop)` against an unattached
  // listener (a no-op in normal cases, but produces a warning in
  // some stricter EventTarget implementations + reads confusing
  // to maintainers tracing the listener lifecycle). Now: ALWAYS
  // attach the listener (even pre-aborted — the listener is then
  // a no-op since cancel was already called by the synchronous
  // onStop() below); the finally's remove is always symmetric.
  let listenerAttached = false;
  if (stopSignal !== undefined) {
    stopSignal.addEventListener('abort', onStop, { once: true });
    listenerAttached = true;
    // Pre-aborted: fire the cancel synchronously so we don't
    // wait for the event loop to deliver the abort event.
    if (stopSignal.aborted) onStop();
  }
  const decoder = new TextDecoder('utf-8');
  const chunks: string[] = [];
  let acceptedBytes = 0;
  let omittedBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (truncated) {
        omittedBytes += value.byteLength;
        continue;
      }
      const remaining = cap - acceptedBytes;
      if (value.byteLength <= remaining) {
        chunks.push(decoder.decode(value, { stream: true }));
        acceptedBytes += value.byteLength;
      } else {
        if (remaining > 0) {
          chunks.push(decoder.decode(value.subarray(0, remaining), { stream: true }));
          acceptedBytes += remaining;
        }
        chunks.push(decoder.decode());
        omittedBytes += value.byteLength - remaining;
        truncated = true;
      }
    }
    if (!truncated) chunks.push(decoder.decode());
  } finally {
    // Symmetric remove (slice 116, R7 P1): only remove when we
    // actually attached. With { once: true } the listener auto-
    // removes after firing, but explicit remove in the no-fire
    // path keeps the AbortSignal's listener set clean — important
    // for long-running operator sessions where the same stopSignal
    // might be reused across many calls (though our actual
    // construction pattern creates a fresh signal per call).
    if (stopSignal !== undefined && listenerAttached) {
      stopSignal.removeEventListener('abort', onStop);
    }
    reader.releaseLock();
  }
  let text = chunks.join('');
  if (truncated) {
    text = `${text}\n[... truncated; ${omittedBytes} bytes omitted]`;
  }
  return { text, truncated };
};
