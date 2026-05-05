// Parent ↔ child IPC channel for subagents — spec docs/spec/IPC.md.
// Stream-shaped NDJSON over stdin/stdout. Three layers:
//
//   1. Wire (this file's top): typed `IpcMessage` union +
//      `encodeMessage` / `parseLine`. JSON.stringify is single-line
//      by construction (control chars escaped), so the framing
//      separator is a bare LF.
//   2. Transport: line-oriented duplex. Concrete implementations:
//      `fakeTransportPair` (in-memory, for tests),
//      `subprocessTransport` (parent side, wraps Bun.spawn streams),
//      `processTransport` (child side, wraps process.stdin/stdout).
//   3. Channel (`IpcChannel`): sits on top of any transport, parses
//      incoming lines into typed messages, exposes typed send +
//      listeners. Errors (malformed lines) surface via `onError`
//      and DO NOT close the channel — spec §4.5: "log warning,
//      descarta a linha".
//
// S1 lands the wire + transports + channel. The taxonomy already
// reserves the message types S2 (HarnessEvent observability),
// S3 (interrupt soft/hard), and S4 (tool warning) will populate.
// Until those slices wire semantics, the only messages the child
// emits are `session_start` (at boot, carries protocol version)
// and `session_finished` (right before exit) — enough to prove
// the wire is alive end-to-end without committing to event shapes.

export const IPC_PROTOCOL_VERSION = 1;

interface CommonFields {
  // UUID v4 from the emitter. Uniqueness lets request/response
  // pairs (S4 permission proxy) correlate across a single
  // session. Debug correlation in audit too — pair an audit row
  // with the IPC line that produced it.
  id: string;
  // Wall-clock from the emitter (epoch ms). Receiver uses its
  // own clock for ordering authority — `ts` is forensic.
  ts: number;
}

// Pai → filho. Idempotent within a session: a second
// `interrupt:soft` after the first is a no-op (spec §3.1).
export type IpcCommand =
  | (CommonFields & { type: 'interrupt:soft' })
  | (CommonFields & { type: 'interrupt:hard' })
  | (CommonFields & { type: 'shutdown' });

// Filho → pai. `event` carries an arbitrary HarnessEvent payload
// — S2 narrows it to the full HarnessEvent union once that union
// is in scope. `session_start` and `session_finished` bracket
// every run; S1 emits both and S2-S4 add the in-between events.
export type IpcEvent =
  | (CommonFields & {
      type: 'session_start';
      sessionId: string;
      protocolVersion: number;
    })
  | (CommonFields & { type: 'session_finished' })
  | (CommonFields & { type: 'event'; event: unknown });

export type IpcMessage = IpcCommand | IpcEvent;

// Source of truth for the type discriminator. The parser refuses
// any `type` not in this set — drift between emitter and parser
// surfaces as `unknown_type` instead of corrupting downstream
// reducers with an unhandled variant.
const KNOWN_TYPES: ReadonlySet<IpcMessage['type']> = new Set([
  'interrupt:soft',
  'interrupt:hard',
  'shutdown',
  'session_start',
  'session_finished',
  'event',
]);

// Encode a typed message into a single NDJSON line (terminated
// LF). JSON.stringify escapes embedded LF inside string values
// (as the two-char sequence backslash-n) so the line boundary is
// unambiguous — no extra scanning needed by the framer.
export const encodeMessage = (msg: IpcMessage): string => `${JSON.stringify(msg)}\n`;

export type ParseResult = { ok: true; msg: IpcMessage } | { ok: false; reason: string };

// Defensive — never throws. Spec §4.5 mandates the channel
// survives a malformed line; the channel layer routes failures
// to `onError` and keeps the wire open.
export const parseLine = (line: string): ParseResult => {
  // Strip a trailing CR if a CRLF snuck in (some platforms /
  // pipes inject them). The wire is strictly LF; we accept CRLF
  // as a courtesy — rejecting would just create operator
  // confusion in cross-platform debug pipes.
  const stripped = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (stripped.length === 0) return { ok: false, reason: 'empty_line' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return { ok: false, reason: 'json_parse_failed' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'not_object' };
  }
  const obj = parsed as Record<string, unknown>;

  const t = obj.type;
  if (typeof t !== 'string') return { ok: false, reason: 'missing_type' };
  if (!KNOWN_TYPES.has(t as IpcMessage['type'])) {
    return { ok: false, reason: `unknown_type:${t}` };
  }
  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    return { ok: false, reason: 'missing_id' };
  }
  if (typeof obj.ts !== 'number' || !Number.isFinite(obj.ts)) {
    return { ok: false, reason: 'missing_ts' };
  }

  // Type-specific shape validation. Variants without extra
  // payload (interrupt:soft, interrupt:hard, shutdown,
  // session_finished) need nothing beyond the common fields
  // above.
  switch (t) {
    case 'session_start': {
      if (typeof obj.sessionId !== 'string' || obj.sessionId.length === 0) {
        return { ok: false, reason: 'session_start.missing_sessionId' };
      }
      if (typeof obj.protocolVersion !== 'number' || !Number.isFinite(obj.protocolVersion)) {
        return { ok: false, reason: 'session_start.missing_protocolVersion' };
      }
      break;
    }
    case 'event': {
      // The `event` payload is opaque at this layer — S2 narrows
      // it to HarnessEvent. We only verify the field exists so
      // a sender bug ("forgot to include event") surfaces here
      // instead of as a confusing reducer crash downstream.
      if (!('event' in obj)) {
        return { ok: false, reason: 'event.missing_event' };
      }
      break;
    }
    default:
      break;
  }

  return { ok: true, msg: obj as unknown as IpcMessage };
};

// Convenience: emit a fresh id+ts pair so callers don't have to
// remember the fields. crypto.randomUUID is in the lib lib.dom.d.ts
// definition; Bun and Node ≥ 19 expose it on the global scope.
const stamp = (): { id: string; ts: number } => ({
  id: crypto.randomUUID(),
  ts: Date.now(),
});

export const makeSessionStart = (sessionId: string): IpcEvent => ({
  type: 'session_start',
  sessionId,
  protocolVersion: IPC_PROTOCOL_VERSION,
  ...stamp(),
});

export const makeSessionFinished = (): IpcEvent => ({
  type: 'session_finished',
  ...stamp(),
});

export const makeEvent = (event: unknown): IpcEvent => ({
  type: 'event',
  event,
  ...stamp(),
});

export const makeInterruptSoft = (): IpcCommand => ({
  type: 'interrupt:soft',
  ...stamp(),
});

export const makeInterruptHard = (): IpcCommand => ({
  type: 'interrupt:hard',
  ...stamp(),
});

export const makeShutdown = (): IpcCommand => ({
  type: 'shutdown',
  ...stamp(),
});

// Tiny pub/sub helper used by transport implementations and the
// channel layer. Subscribers receive every emit until they
// unsubscribe; the iterator-snapshot pattern lets a subscriber
// remove itself mid-iteration without skipping siblings.
const createEmitter = <T>() => {
  const subs = new Set<(v: T) => void>();
  return {
    subscribe(cb: (v: T) => void): () => void {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    emit(v: T): void {
      // Snapshot before iterating: a subscriber that unsubscribes
      // (or even subscribes another) inside its callback must not
      // affect the current emit's delivery to its peers.
      for (const cb of [...subs]) {
        try {
          cb(v);
        } catch {
          // Listener bugs must not break the channel. Spec §0
          // principle 4: falha do canal não é falha do filho —
          // and vice versa.
        }
      }
    },
    size(): number {
      return subs.size;
    },
  };
};

// Line-oriented duplex. Implementations own platform glue (Bun
// streams, Node process I/O, in-memory queues) and expose a
// uniform "lines in, lines out" interface. The Channel layer
// above doesn't know whether it's talking to a real subprocess
// or a fake pair.
export interface IpcTransport {
  // Emit a fully-framed line (caller's responsibility — should
  // already include the trailing LF when going onto a real
  // stream). The fake transport tolerates payloads with multiple
  // lines (split on LF) so callers can pass the output of
  // `encodeMessage` directly.
  write(line: string): void;
  onLine(cb: (line: string) => void): () => void;
  onClose(cb: () => void): () => void;
  close(): void;
}

// Frame raw byte chunks into complete UTF-8 lines. Stateful — the
// caller pushes chunks (which may span line boundaries arbitrarily)
// and the framer emits whole lines via the callback. Trailing
// partial line is held in the buffer until the next push or a
// `flush()` call.
//
// UTF-8 safety: TextDecoder with `{ stream: true }` handles
// multi-byte sequences split across chunks. Without `stream: true`
// a single 4-byte emoji split across two chunks would corrupt
// into U+FFFD replacement chars.
const createLineFramer = (onLine: (line: string) => void) => {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  return {
    push(chunk: Uint8Array): void {
      buf += decoder.decode(chunk, { stream: true });
      // Walk buffer for LFs. The remainder after the last LF is
      // the partial line; keep it for the next push. A buffer
      // with no LF this round just accumulates.
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length > 0) onLine(line);
        nl = buf.indexOf('\n');
      }
    },
    flush(): void {
      // Stream end may or may not include a trailing LF. If a
      // partial line is held, emit it now — the framer's
      // contract is to deliver every byte the peer wrote.
      // (Spec §2.2: "Mensagens com caracteres binários" are
      // base64-encoded — partial UTF-8 sequences at flush time
      // are decoder errors, not silent drops.)
      const tail = buf + decoder.decode();
      if (tail.length > 0) onLine(tail);
      buf = '';
    },
    reset(): void {
      buf = '';
    },
  };
};

// In-memory transport pair for tests. Each side's `write` enqueues
// lines onto the OTHER side's onLine listeners; `close` propagates
// to both onClose handlers (so a test can simulate either peer
// going away). Identical contract to the subprocess transport
// from a behavioral standpoint.
export const fakeTransportPair = (): { a: IpcTransport; b: IpcTransport } => {
  const aIn = createEmitter<string>();
  const bIn = createEmitter<string>();
  const aClose = createEmitter<void>();
  const bClose = createEmitter<void>();
  let closed = false;

  // The callers send `JSON\n` (the output of `encodeMessage`).
  // Strip the trailing LF and emit the bare line. Multi-line
  // payloads are split on LF (defensive: a caller could batch
  // two messages by concatenating two encoded lines).
  const splitFramedPayload = (raw: string): string[] => {
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < raw.length; i += 1) {
      if (raw[i] === '\n') {
        const piece = raw.slice(start, i);
        if (piece.length > 0) out.push(piece);
        start = i + 1;
      }
    }
    const tail = raw.slice(start);
    if (tail.length > 0) out.push(tail);
    return out;
  };

  const closeAll = () => {
    if (closed) return;
    closed = true;
    aClose.emit();
    bClose.emit();
  };

  const a: IpcTransport = {
    write(line) {
      if (closed) return;
      for (const piece of splitFramedPayload(line)) bIn.emit(piece);
    },
    onLine: (cb) => aIn.subscribe(cb),
    onClose: (cb) => aClose.subscribe(cb),
    close: closeAll,
  };
  const b: IpcTransport = {
    write(line) {
      if (closed) return;
      for (const piece of splitFramedPayload(line)) aIn.emit(piece);
    },
    onLine: (cb) => bIn.subscribe(cb),
    onClose: (cb) => bClose.subscribe(cb),
    close: closeAll,
  };
  return { a, b };
};

// Web-stream-based transport for the parent side. Reads from the
// child subprocess's stdout (a `ReadableStream<Uint8Array>` from
// Bun.spawn) and writes to the child's stdin (a
// `WritableStream<Uint8Array>`). The pump loop reads chunks, frames
// them into lines, and dispatches via onLine. EOF on stdout fires
// onClose. Local close() cancels the reader and aborts the
// writer — both propagate as EOF on the peer's side.
export interface SubprocessStreams {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
}

export const subprocessTransport = (streams: SubprocessStreams): IpcTransport => {
  const lines = createEmitter<string>();
  const closed = createEmitter<void>();
  let isClosed = false;
  const closeOnce = () => {
    if (isClosed) return;
    isClosed = true;
    closed.emit();
  };

  const framer = createLineFramer((line) => lines.emit(line));
  const reader = streams.stdout.getReader();
  const encoder = new TextEncoder();
  const writer = streams.stdin.getWriter();

  // Pump loop: chained reads with no awaiting on the caller's
  // side. The promise is fire-and-forget — we don't surface it
  // because the caller's signal is `onClose`, not a returned
  // future. Errors during read (stream broken mid-read) collapse
  // to onClose: a broken pipe IS the channel ending.
  void (async () => {
    try {
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        if (r.value !== undefined) framer.push(r.value);
      }
    } catch {
      // Read error → treat as EOF. Spec §4.5: pipe broken =
      // child died unexpectedly; surface via onClose so the
      // parent can synthesize a `subprocess_crashed` outcome.
    } finally {
      framer.flush();
      closeOnce();
    }
  })();

  return {
    write(line) {
      if (isClosed) return;
      // writer.write returns a promise; we fire-and-forget for
      // the same reason the read loop is detached. Backpressure
      // here is OS-buffered (typical 64KB pipe buffer); the
      // command volume is trivial (a handful of interrupt
      // messages per session) so we don't await the drain.
      writer.write(encoder.encode(line)).catch(() => {
        // Write to a dead pipe → channel is gone. Mirror the
        // read path: collapse to onClose.
        closeOnce();
      });
    },
    onLine: (cb) => lines.subscribe(cb),
    onClose: (cb) => closed.subscribe(cb),
    close() {
      if (isClosed) return;
      // Cancel the reader to release the lock and signal EOF
      // upstream. Closing the writer flushes pending data and
      // sends EOF to the child's stdin (its read loop sees
      // done=true). Both are best-effort — if the child is
      // already gone, both throw and we ignore.
      reader.cancel().catch(() => undefined);
      writer.close().catch(() => undefined);
      closeOnce();
    },
  };
};

// Node-streams transport for the child side. Wraps `process.stdin`
// (a Readable) and `process.stdout` (a Writable). Used by the
// child binary when invoked with `--ipc=1`.
//
// The Readable's `data` events arrive as Buffers (or strings if
// encoding is set). We don't set the encoding — keeping bytes raw
// lets the framer's TextDecoder handle UTF-8 boundaries
// correctly, identical to the subprocess path.
// Minimal Readable/Writable shapes the transport actually consumes.
// The Node typings for `process.stdin` collapse to a union of
// TTY/Socket/Pipe whose overloaded `on` resolutions conflict at the
// call site; declaring the narrow surface we need lets us bypass
// the overload soup without losing type safety on the listener
// signatures we register.
type EventListener = (...args: unknown[]) => void;
interface ReadableStdin {
  on(event: 'data', cb: (chunk: Buffer | string) => void): unknown;
  on(event: 'end' | 'error' | 'close', cb: EventListener): unknown;
  removeListener(event: string, cb: EventListener): unknown;
}
interface WritableStdout {
  write(chunk: string): unknown;
}

export interface ProcessStreams {
  stdin: ReadableStdin;
  stdout: WritableStdout;
}

export const processTransport = (streams?: ProcessStreams): IpcTransport => {
  const stdin: ReadableStdin = streams?.stdin ?? (process.stdin as unknown as ReadableStdin);
  const stdout: WritableStdout = streams?.stdout ?? (process.stdout as unknown as WritableStdout);

  const lines = createEmitter<string>();
  const closed = createEmitter<void>();
  let isClosed = false;
  const closeOnce = () => {
    if (isClosed) return;
    isClosed = true;
    closed.emit();
  };

  const framer = createLineFramer((line) => lines.emit(line));

  const onData = (chunk: Buffer | string) => {
    // Bun's process.stdin emits Buffer when no encoding is set;
    // tests may inject a string-emitting stream for convenience.
    // Convert string → Uint8Array via TextEncoder so the framer
    // sees a consistent byte shape.
    const bytes =
      typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    framer.push(bytes);
  };
  const onEnd = () => {
    framer.flush();
    closeOnce();
  };
  const onError = () => {
    // Same collapse as the subprocess path — a stdin error is
    // indistinguishable from EOF for our purposes.
    framer.flush();
    closeOnce();
  };

  stdin.on('data', onData);
  stdin.on('end', onEnd);
  stdin.on('error', onError);
  stdin.on('close', onEnd);

  return {
    write(line) {
      if (isClosed) return;
      try {
        stdout.write(line);
      } catch {
        closeOnce();
      }
    },
    onLine: (cb) => lines.subscribe(cb),
    onClose: (cb) => closed.subscribe(cb),
    close() {
      if (isClosed) return;
      // Detach our listeners — without this, a stdin still
      // emitting after close would deliver to a dead framer and
      // our onClose subscribers would have already fired.
      stdin.removeListener('data', onData as EventListener);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
      stdin.removeListener('close', onEnd);
      closeOnce();
    },
  };
};

// Channel layer. Wraps a transport with typed send + parsed
// onMessage delivery. Malformed lines do NOT propagate as
// messages — they surface on `onError` and the wire stays open.
export interface IpcChannel {
  send(msg: IpcMessage): void;
  onMessage(cb: (msg: IpcMessage) => void): () => void;
  // `line` is the raw payload (without trailing LF) so debug
  // tools can show the operator exactly what arrived. `reason`
  // is one of the parser's stable codes (`json_parse_failed`,
  // `unknown_type:<t>`, etc.) — operators can grep audit logs
  // without parsing free-form text.
  onError(cb: (err: { line: string; reason: string }) => void): () => void;
  onClose(cb: () => void): () => void;
  close(): void;
}

// Bounded replay buffer for messages that arrive before the first
// `onMessage` subscriber attaches. Without this the subprocess
// transport's pump loop (which starts the moment the spawn factory
// constructs it) would lose any line the peer wrote before the
// runtime threaded its observer in. Spec §10.2 endorses (b)
// "buffer with a small cap" as the right answer for the
// pre-renderer phase. Cap chosen low: a child sending more than
// this many messages before any consumer attaches indicates a
// runaway producer, not a wiring race; better to drop with a
// stderr note than to grow the heap.
const REPLAY_BUFFER_CAP = 64;

export const createChannel = (transport: IpcTransport): IpcChannel => {
  const messages = createEmitter<IpcMessage>();
  const errors = createEmitter<{ line: string; reason: string }>();

  // Pre-subscriber buffers. Drained synchronously the moment the
  // first listener attaches (in `onMessage` / `onError`), then
  // discarded. No emitter snapshot games — the buffer is
  // single-pass: drain on first subscribe, then `null` so further
  // subscribers see real-time only (matching the existing emitter
  // contract).
  let pendingMessages: IpcMessage[] | null = [];
  let pendingErrors: { line: string; reason: string }[] | null = [];
  let droppedFromOverflow = 0;

  // Subscribe to the transport once at construction. The channel
  // owns the subscription's lifetime — a downstream listener
  // unsubscribing only removes itself from `messages`, not from
  // the transport.
  transport.onLine((line) => {
    const r = parseLine(line);
    if (r.ok) {
      if (messages.size() === 0 && pendingMessages !== null) {
        if (pendingMessages.length < REPLAY_BUFFER_CAP) {
          pendingMessages.push(r.msg);
        } else {
          droppedFromOverflow += 1;
        }
        return;
      }
      messages.emit(r.msg);
    } else {
      const err = { line, reason: r.reason };
      if (errors.size() === 0 && pendingErrors !== null) {
        if (pendingErrors.length < REPLAY_BUFFER_CAP) {
          pendingErrors.push(err);
        } else {
          droppedFromOverflow += 1;
        }
        return;
      }
      errors.emit(err);
    }
  });

  return {
    send(msg) {
      transport.write(encodeMessage(msg));
    },
    onMessage(cb) {
      const unsub = messages.subscribe(cb);
      // Drain anything that arrived before the first subscriber.
      // After this point real-time delivery resumes; new
      // subscribers don't see history (they're attaching after
      // the wire is observable).
      if (pendingMessages !== null) {
        const buf = pendingMessages;
        pendingMessages = null;
        for (const m of buf) cb(m);
        if (droppedFromOverflow > 0) {
          // Diagnostic: a child that out-ran the buffer is a
          // signal worth surfacing on stderr (NDJSON contract:
          // stdout pure, stderr admin). One line, total —
          // duplicate cap-hits don't repeat.
          process.stderr.write(
            `forja: ipc replay buffer overflow — ${droppedFromOverflow} message(s) dropped before subscriber attached\n`,
          );
          droppedFromOverflow = 0;
        }
      }
      return unsub;
    },
    onError(cb) {
      const unsub = errors.subscribe(cb);
      if (pendingErrors !== null) {
        const buf = pendingErrors;
        pendingErrors = null;
        for (const e of buf) cb(e);
      }
      return unsub;
    },
    onClose: (cb) => transport.onClose(cb),
    close: () => transport.close(),
  };
};
