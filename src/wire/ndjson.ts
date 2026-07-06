// Shared NDJSON wire primitives: byte-stream framing + line encoding.
//
// Extracted from the subagent IPC channel (src/subagents/ipc.ts) so a second
// NDJSON consumer — the mesh transport (src/mesh/transport.ts) — reuses the
// exact same framer instead of a divergent copy. Only the transport-agnostic
// byte→line framing lives here; each protocol keeps its own typed
// encode/parse, validating against its own message union.

// Encode a value into a single NDJSON line (LF-terminated). JSON.stringify
// escapes any embedded LF inside string values, so the trailing LF is an
// unambiguous line boundary — the framer needs no extra scanning.
export const encodeJsonLine = (value: unknown): string => `${JSON.stringify(value)}\n`;

// Per-line cap (UTF-16 code units held in the partial-line buffer). 1Mi chars
// covers a ~1 MiB message with ASCII-heavy JSON while staying bounded in RAM.
// Without it, a peer that streams bytes with no `\n` (a buggy loop, or a
// crafted payload) would grow the buffer until the heap dies — the OOM
// seatbelt. Overridable via `lineCap` for tests that exercise the resync path
// without allocating a megabyte.
export const DEFAULT_LINE_CAP = 1 << 20; // 1 MiB (UTF-16 code units)

export interface LineFramer {
  // Push a raw byte chunk; whole lines are delivered via the onLine callback.
  push(chunk: Uint8Array): void;
  // Emit any held partial line (stream end). Delivers every byte written.
  flush(): void;
  // Drop the partial-line buffer without emitting.
  reset(): void;
}

// Frame raw byte chunks into complete UTF-8 lines. Stateful — the caller
// pushes chunks (which may split line boundaries arbitrarily) and whole lines
// come back via `onLine`; the trailing partial line is held until the next
// push or `flush()`.
//
// UTF-8 safety: TextDecoder `{ stream: true }` reassembles multi-byte
// sequences split across chunks (without it, a 4-byte emoji split across two
// chunks corrupts into U+FFFD replacement chars).
//
// Overflow safety: when the partial line exceeds `lineCap`, the framer drops
// the buffer, fires `onOverflow(droppedChars)`, and resyncs — discarding
// bytes until the next `\n`, then resuming. A too-long line degrades the
// stream, it does not kill it.
export const createLineFramer = (
  onLine: (line: string) => void,
  options: { onOverflow?: (droppedChars: number) => void; lineCap?: number } = {},
): LineFramer => {
  const decoder = new TextDecoder('utf-8');
  const lineCap = options.lineCap ?? DEFAULT_LINE_CAP;
  let buf = '';
  // True after an overflow, until we observe the next `\n` and resume framing.
  // While resyncing, every chunk is scanned for the boundary and discarded
  // otherwise.
  let resyncing = false;
  return {
    push(chunk: Uint8Array): void {
      const decoded = decoder.decode(chunk, { stream: true });
      let pending: string;
      if (resyncing) {
        const boundary = decoded.indexOf('\n');
        if (boundary === -1) {
          // Still hunting for the end of the over-cap line; keep discarding.
          return;
        }
        // Found end of bad line; resume framing after it, dropping the rest.
        resyncing = false;
        pending = decoded.slice(boundary + 1);
      } else {
        pending = decoded;
      }
      buf += pending;
      // Walk the buffer for LFs; the remainder after the last LF is the
      // partial line, kept for the next push.
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        // Enforce the cap on COMPLETE lines too — not just the trailing partial
        // below. `nl` IS the line length (line = buf.slice(0, nl)), so an over-cap
        // line is detected WITHOUT materializing the (potentially multi-MB) slice,
        // and dropped before onLine. Without this, a record that arrives WITH its
        // trailing `\n` in one chunk would be sliced + emitted before the partial
        // check runs, so the cap only bounded unterminated floods — a peer could
        // hand a giant line straight to the parser (the OOM/DoS guard, defeated).
        // No resync needed: we already have the boundary, so the next line frames
        // normally; only the unterminated case (below) has to hunt for it.
        if (nl > lineCap) {
          options.onOverflow?.(nl);
        } else if (nl > 0) {
          onLine(buf.slice(0, nl));
        }
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
      // Trailing partial line past the cap: dropped + resynced (an unterminated
      // flood — we don't have the boundary yet, so discard until the next `\n`).
      // The dropped count goes through the diagnostic channel; the wire stays open.
      if (buf.length > lineCap) {
        const dropped = buf.length;
        buf = '';
        resyncing = true;
        options.onOverflow?.(dropped);
      }
    },
    flush(): void {
      // Stream end may omit a trailing LF; emit any held partial line so the
      // framer delivers every byte the peer wrote. Mid-resync at flush = empty
      // buffer, nothing to emit.
      const tail = buf + decoder.decode();
      if (tail.length > 0) onLine(tail);
      buf = '';
    },
    reset(): void {
      buf = '';
    },
  };
};
