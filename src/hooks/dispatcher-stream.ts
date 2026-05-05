import { HOOK_STDOUT_MAX_BYTES } from './types.ts';

// Truncate a string to HOOK_STDOUT_MAX_BYTES; appends a marker
// when truncated so the audit row makes the cap visible.
export const truncate = (s: string): string => {
  // Convert to UTF-8 bytes for the cap check — operators may
  // emit multi-byte chars and a char-count cap would over- or
  // under-truncate.
  const encoder = new TextEncoder();
  const bytes = encoder.encode(s);
  if (bytes.length <= HOOK_STDOUT_MAX_BYTES) return s;
  const cut = bytes.slice(0, HOOK_STDOUT_MAX_BYTES - 24);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return `${decoder.decode(cut)}\n... (truncated)`;
};

// Read a stream to a string, capping at the byte limit. The cap
// is 4× HOOK_STDOUT_MAX_BYTES so `truncate()` (post-read) has
// slack for the trailing "(truncated)" marker without losing
// useful prefix bytes — keeping the audit-visible cap as the
// canonical truncate point. The READ-side cap is the OOM guard
// against pathological hooks emitting megabytes; truncate is
// the audit-presentation cap. Exported for direct unit-test of
// the slicing behavior without driving a full dispatchOne.
export const STREAM_READ_CAP_BYTES = 16 * 1024;

export const readStream = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Read to EOF, but cap how much we BUFFER. Two layered caps:
  //
  //   - Buffer cap (STREAM_READ_CAP_BYTES): per-chunk slice
  //     before push, so a single multi-MB chunk can't blow
  //     past the cap by being pushed-then-checked.
  //   - Drain semantics: AFTER the buffer cap is reached, we
  //     keep reading and DISCARDING. Breaking out early would
  //     leave bytes in the OS pipe buffer; once that fills,
  //     the subprocess blocks on its next `write()` and never
  //     exits — the dispatcher's per-hook timer fires and we
  //     report `timeout` even though the hook's logic
  //     completed. With failClosed=true on a blockable event,
  //     a chatty-but-correct hook would wrongly deny the
  //     gated tool. Drain-and-discard keeps the pipe flowing,
  //     subprocess writes succeed, child exits naturally,
  //     true exit code reaches classifyExitCode.
  //
  // Drain-and-discard (vs reader.cancel()) is deliberate:
  // canceling the stream propagates to the source, closing
  // the pipe's read end → child gets SIGPIPE / EPIPE on next
  // write. Some operators' hooks ignore SIGPIPE and complete;
  // others abort with a non-zero code that classifyExitCode
  // would call an "error". Drain semantics give a stable
  // contract: cap bounds memory, child sees a healthy pipe.
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    if (total >= STREAM_READ_CAP_BYTES) {
      // Cap already reached — discard and keep draining so
      // the subprocess's stdout pipe never fills.
      continue;
    }
    const remaining = STREAM_READ_CAP_BYTES - total;
    const slice = value.byteLength <= remaining ? value : value.subarray(0, remaining);
    chunks.push(slice);
    total += slice.byteLength;
  }
  if (chunks.length === 0) return '';
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(combined);
};

// Test-only alias for `readStream`, kept for backwards compat
// with existing test imports.
export const _readStreamForTests = (stream: ReadableStream<Uint8Array>): Promise<string> =>
  readStream(stream);
