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
export const IPC_PROTOCOL_VERSION = 1;

// Exit code the child uses when refusing on protocol version
// mismatch (spec §4.2 mandates pre-message refusal). The parent's
// wait loop maps this exit code from a `crashed` outcome (no
// payload published) to the dedicated `ipc_version_mismatch`
// reason — without it, mixed-version deployments surface as a
// generic `subprocess_crashed`, defeating the handshake's
// diagnostic value exactly when it matters most. 64 is
// `EX_USAGE` per sysexits.h: the parent invoked the child with
// a flag (`--ipc=<n>`) the child can't satisfy; that's a usage
// problem, not a software fault.
export const IPC_VERSION_MISMATCH_EXIT_CODE = 64;

interface CommonFields {
  // UUID v4 from the emitter. Uniqueness lets request/response
  // pairs correlate across a single
  // session. Debug correlation in audit too — pair an audit row
  // with the IPC line that produced it.
  id: string;
  // Wall-clock from the emitter (epoch ms). Receiver uses its
  // own clock for ordering authority — `ts` is forensic.
  ts: number;
}

// Verdict the operator's modal returns for a `permission:ask`.
// Wire-friendly subset of the engine's full `Decision` type — the
// modal only produces yes/no, so the answer is a binary verdict
// instead of round-tripping the engine's richer shape. The bridge
// at the child side maps `'allow' | 'deny'` back to the boolean
// `confirmPermission` callback contract; future scope (`'session'`)
// would extend this union, not break it.
export type PermissionDecision = 'allow' | 'deny';

// Pai → filho. Idempotent within a session: a second
// `interrupt:soft` after the first is a no-op (spec §3.1).
// `permission:answer` carries the operator's verdict for an
// outstanding `permission:ask`; correlation is by `promptId`,
// NOT the IPC envelope `id` (which the emitter stamps fresh
// per message).
export type IpcCommand =
  | (CommonFields & { type: 'interrupt:soft' })
  | (CommonFields & { type: 'interrupt:hard' })
  | (CommonFields & { type: 'shutdown' })
  | (CommonFields & {
      type: 'permission:answer';
      promptId: string;
      decision: PermissionDecision;
    });

// Filho → pai. `event` carries an arbitrary HarnessEvent payload
// (the consumer layer narrows it to the HarnessEvent union).
// `session_start` and `session_finished` bracket every run; the
// in-between events flow through `event`. `permission:ask` is the
// only request/response variant on the wire — child blocks until
// the matching `permission:answer` returns. The deviation from
// IPC.md §3.2's illustrative `{ promptId, toolName, command, cwd }`
// is intentional: the engine's confirm flow already passes
// `{ toolName, args, cwd, prompt }` through `confirmPermission`,
// and forcing a bash-shaped `command` field would require lossy
// translation for non-bash tools (write_file, web_fetch, …).
// `args` is opaque at the wire layer; the parent's modal renderer
// is responsible for safe display.
export type IpcEvent =
  | (CommonFields & {
      type: 'session_start';
      sessionId: string;
      protocolVersion: number;
    })
  | (CommonFields & { type: 'session_finished' })
  | (CommonFields & { type: 'event'; event: unknown })
  | (CommonFields & {
      type: 'permission:ask';
      promptId: string;
      toolName: string;
      args: unknown;
      cwd: string;
      prompt: string;
    });

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
  'permission:ask',
  'permission:answer',
]);

const PERMISSION_DECISIONS: ReadonlySet<PermissionDecision> = new Set(['allow', 'deny']);

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
      // The `event` payload is opaque at this layer (the consumer
      // narrows it to HarnessEvent). We only verify the field exists so
      // a sender bug ("forgot to include event") surfaces here
      // instead of as a confusing reducer crash downstream.
      if (!('event' in obj)) {
        return { ok: false, reason: 'event.missing_event' };
      }
      break;
    }
    case 'permission:ask': {
      if (typeof obj.promptId !== 'string' || obj.promptId.length === 0) {
        return { ok: false, reason: 'permission_ask.missing_promptId' };
      }
      if (typeof obj.toolName !== 'string' || obj.toolName.length === 0) {
        return { ok: false, reason: 'permission_ask.missing_toolName' };
      }
      // `args` is opaque (Record / array / scalar) — only verify
      // the key is present so the parent's modal doesn't have to
      // reach into an undefined slot. A sender bug ("forgot to
      // include args") surfaces here, not as a render crash later.
      if (!('args' in obj)) {
        return { ok: false, reason: 'permission_ask.missing_args' };
      }
      if (typeof obj.cwd !== 'string' || obj.cwd.length === 0) {
        return { ok: false, reason: 'permission_ask.missing_cwd' };
      }
      if (typeof obj.prompt !== 'string' || obj.prompt.length === 0) {
        return { ok: false, reason: 'permission_ask.missing_prompt' };
      }
      break;
    }
    case 'permission:answer': {
      if (typeof obj.promptId !== 'string' || obj.promptId.length === 0) {
        return { ok: false, reason: 'permission_answer.missing_promptId' };
      }
      // Wire decision is a closed enum. Anything outside the set
      // is a protocol violation (parent crafted a value the child
      // doesn't know how to honor). Refuse here so the child
      // bridge never has to pick a default for an unknown verdict
      // — picking `deny` would silently change the operator's
      // meaning, picking `allow` would defeat the entire proxy.
      if (typeof obj.decision !== 'string') {
        return { ok: false, reason: 'permission_answer.missing_decision' };
      }
      if (!PERMISSION_DECISIONS.has(obj.decision as PermissionDecision)) {
        return { ok: false, reason: `permission_answer.unknown_decision:${obj.decision}` };
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

// Child → parent. Caller (the child permission bridge) supplies a
// `promptId` so the matching answer can be correlated; we do NOT
// reuse the IPC envelope `id` for correlation because that field
// is stamped per message and would collide if the child ever
// re-emitted a retry. `args` opaque on the wire — see
// `permission:ask` type comment for the rationale.
export const makePermissionAsk = (input: {
  promptId: string;
  toolName: string;
  args: unknown;
  cwd: string;
  prompt: string;
}): IpcEvent => ({
  type: 'permission:ask',
  promptId: input.promptId,
  toolName: input.toolName,
  args: input.args,
  cwd: input.cwd,
  prompt: input.prompt,
  ...stamp(),
});

// Parent → child. `promptId` MUST match a prior `permission:ask`
// the child emitted; an unknown promptId is dropped silently by
// the child bridge (see `permission-bridge.ts`).
export const makePermissionAnswer = (input: {
  promptId: string;
  decision: PermissionDecision;
}): IpcCommand => ({
  type: 'permission:answer',
  promptId: input.promptId,
  decision: input.decision,
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
// Transport-level diagnostic shape. Today's only producer is the
// line framer's overflow path (peer sent > 1 MiB without a `\n`
// — OOM seatbelt fired, line dropped, framer resyncing). Future
// transports may add their own (decoder errors, signal-induced
// pipe breaks, etc.) without changing the channel API.
export interface IpcTransportError {
  reason: string;
  detail?: string;
}

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
  // Diagnostic stream for transport-level errors that don't have
  // a parseable line to surface through `onLine`. The channel
  // layer routes these through the same `onError` surface as
  // parser failures so operators see one diagnostic stream
  // regardless of which layer caught the issue.
  onTransportError(cb: (err: IpcTransportError) => void): () => void;
  onClose(cb: () => void): () => void;
  close(): void;
}

// Per-line cap (UTF-16 code units in the partial-line buffer).
// Spec §2.2: "Limite por mensagem: 1 MB. Acima disso, fragmentar
// em chunks ou referenciar via SQLite." 1Mi chars holds the spec
// cap with ASCII-heavy JSON (≈ 1 byte/char) and ~2-4 MiB UTF-16
// in RAM in the worst case — bounded.
//
// Without this cap, a peer that sends bytes without a `\n` (buggy
// child in a loop, or compromised binary crafting an OOM
// payload) would grow the framer's buffer indefinitely until the
// JS heap dies. The cap is the OOM seatbelt.
//
// Tunable via `lineCap` argument for tests that want to exercise
// the resync path quickly without allocating a megabyte.
const DEFAULT_LINE_CAP = 1 << 20; // 1 MiB (UTF-16 code units)

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
//
// Overflow safety: the partial-line buffer is capped (default
// 1 MiB UTF-16 code units). When a line exceeds the cap the
// framer drops the buffer, fires `onOverflow(droppedChars)`, and
// enters a resync state — discarding bytes until the next `\n`,
// then resuming normal framing. Spec §4.5 mandates the channel
// survives a malformed line; "line too long" is the same shape
// of survivable diagnostic.
const createLineFramer = (
  onLine: (line: string) => void,
  options: { onOverflow?: (droppedChars: number) => void; lineCap?: number } = {},
) => {
  const decoder = new TextDecoder('utf-8');
  const lineCap = options.lineCap ?? DEFAULT_LINE_CAP;
  let buf = '';
  // True after an overflow, until we observe the next `\n` and
  // resume framing. While resyncing, every chunk is scanned for
  // the boundary and discarded otherwise.
  let resyncing = false;
  return {
    push(chunk: Uint8Array): void {
      const decoded = decoder.decode(chunk, { stream: true });
      let pending: string;
      if (resyncing) {
        const boundary = decoded.indexOf('\n');
        if (boundary === -1) {
          // Still hunting for the end of the over-cap line.
          // Don't grow the buffer — we know we're discarding.
          return;
        }
        // Found end of bad line; resume normal framing from
        // after it. Anything before is dropped.
        resyncing = false;
        pending = decoded.slice(boundary + 1);
      } else {
        pending = decoded;
      }
      buf += pending;
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
      // Cap check: if the trailing partial line outgrew the cap
      // without finding `\n`, drop it and resync. The dropped
      // count goes through the diagnostic channel so operators
      // can investigate; the wire stays open.
      if (buf.length > lineCap) {
        const dropped = buf.length;
        buf = '';
        resyncing = true;
        options.onOverflow?.(dropped);
      }
    },
    flush(): void {
      // Stream end may or may not include a trailing LF. If a
      // partial line is held, emit it now — the framer's
      // contract is to deliver every byte the peer wrote.
      // (Spec §2.2: "Mensagens com caracteres binários" are
      // base64-encoded — partial UTF-8 sequences at flush time
      // are decoder errors, not silent drops.)
      // If we ended mid-resync (peer broke the pipe before the
      // next `\n` boundary), the remaining buffer is empty —
      // nothing to flush, no diagnostic to repeat.
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

  // Fake pair has no framer — caller writes already-framed lines
  // and we split on `\n`. There's no overflow surface to model;
  // transport-error subscribers just get no events.
  const aErrors = createEmitter<IpcTransportError>();
  const bErrors = createEmitter<IpcTransportError>();

  const a: IpcTransport = {
    write(line) {
      if (closed) return;
      for (const piece of splitFramedPayload(line)) bIn.emit(piece);
    },
    onLine: (cb) => aIn.subscribe(cb),
    onTransportError: (cb) => aErrors.subscribe(cb),
    onClose: (cb) => aClose.subscribe(cb),
    close: closeAll,
  };
  const b: IpcTransport = {
    write(line) {
      if (closed) return;
      for (const piece of splitFramedPayload(line)) aIn.emit(piece);
    },
    onLine: (cb) => bIn.subscribe(cb),
    onTransportError: (cb) => bErrors.subscribe(cb),
    onClose: (cb) => bClose.subscribe(cb),
    close: closeAll,
  };
  return { a, b };
};

// Subprocess transport (parent side). Reads from the child's stdout
// (a `ReadableStream<Uint8Array>` from `Bun.spawn`) and writes to
// the child's stdin. The stdin shape depends on the runtime:
//   - Bun.spawn with `stdin: 'pipe'` returns a `FileSink` (a Bun
//     primitive with `.write()`/`.end()`, NOT a WHATWG stream).
//   - Other runtimes (or future Bun changes) might surface
//     `WritableStream<Uint8Array>` instead.
// We accept either; the write path branches on whether
// `getWriter` is callable. Production verified: real `Bun.spawn`
// returns FileSink — a regression here would manifest as
// `streams.stdin.getWriter is not a function` at spawn time
// (caught in the smoke). Comment kept narrow because Bun's
// stdin shape is the kind of thing that's easy to forget.
//
// EOF on stdout fires onClose. Local close() cancels the reader
// and ends the writer — both propagate as EOF on the peer's side.
interface FileSinkLike {
  write(chunk: Uint8Array | string): void;
  end?: () => void;
}
interface WritableStreamLike {
  getWriter(): {
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
  };
}
export interface SubprocessStreams {
  stdin: FileSinkLike | WritableStreamLike;
  stdout: ReadableStream<Uint8Array>;
}

const isWhatwgStream = (s: FileSinkLike | WritableStreamLike): s is WritableStreamLike =>
  typeof (s as WritableStreamLike).getWriter === 'function';

export const subprocessTransport = (streams: SubprocessStreams): IpcTransport => {
  const lines = createEmitter<string>();
  const transportErrors = createEmitter<IpcTransportError>();
  const closed = createEmitter<void>();
  let isClosed = false;
  const closeOnce = () => {
    if (isClosed) return;
    isClosed = true;
    closed.emit();
  };

  const framer = createLineFramer((line) => lines.emit(line), {
    onOverflow: (droppedChars) => {
      transportErrors.emit({
        reason: 'line_too_long',
        detail: `dropped ${droppedChars} chars; resyncing on next LF`,
      });
    },
  });
  const reader = streams.stdout.getReader();
  const encoder = new TextEncoder();
  // Branch on stdin shape ONCE at construction so the write +
  // close paths stay cheap and unbranched per call. For the
  // WHATWG case, acquire the writer once and reuse it for both
  // operations — `getWriter()` is exclusive (calling it twice
  // throws), so we MUST hold a single reference if close() is
  // going to flush+EOF the pipe instead of relying on the
  // kernel to clean up at process exit.
  let writeBytes: (bytes: Uint8Array) => void;
  let closeWriter: () => void;
  if (isWhatwgStream(streams.stdin)) {
    const w = streams.stdin.getWriter();
    writeBytes = (bytes) => {
      w.write(bytes).catch(() => {
        // Write to a dead pipe → channel is gone.
        closeOnce();
      });
    };
    closeWriter = () => {
      // Flush pending writes and send EOF on the child's stdin
      // (its read loop sees done=true). Without this, a child
      // blocked in `read()` waiting for input would never
      // notice the parent's `close()` — graceful shutdowns
      // turn into hangs that only the wall-clock kill recovers
      // from. Best-effort: a writer already in error state
      // throws; the child will detect EOF either way once the
      // parent process exits.
      w.close().catch(() => undefined);
    };
  } else {
    const sink = streams.stdin;
    writeBytes = (bytes) => {
      try {
        sink.write(bytes);
      } catch {
        closeOnce();
      }
    };
    closeWriter = () => {
      try {
        sink.end?.();
      } catch {
        // ignore
      }
    };
  }

  // Pump loop: chained reads, fire-and-forget. The caller's
  // signal is `onClose`, not a returned future. Errors during
  // read (broken pipe) collapse to onClose — spec §4.5.
  void (async () => {
    try {
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        if (r.value !== undefined) framer.push(r.value);
      }
    } catch {
      // Read error → treat as EOF.
    } finally {
      framer.flush();
      closeOnce();
    }
  })();

  return {
    write(line) {
      if (isClosed) return;
      writeBytes(encoder.encode(line));
    },
    onLine: (cb) => lines.subscribe(cb),
    onTransportError: (cb) => transportErrors.subscribe(cb),
    onClose: (cb) => closed.subscribe(cb),
    close() {
      if (isClosed) return;
      reader.cancel().catch(() => undefined);
      closeWriter();
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
  const transportErrors = createEmitter<IpcTransportError>();
  const closed = createEmitter<void>();
  let isClosed = false;
  const closeOnce = () => {
    if (isClosed) return;
    isClosed = true;
    closed.emit();
  };

  const framer = createLineFramer((line) => lines.emit(line), {
    onOverflow: (droppedChars) => {
      transportErrors.emit({
        reason: 'line_too_long',
        detail: `dropped ${droppedChars} chars; resyncing on next LF`,
      });
    },
  });

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
    onTransportError: (cb) => transportErrors.subscribe(cb),
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

// Bounded replay buffer for messages that arrive before subscribers
// attach. Without this the subprocess transport's pump loop (which
// starts the moment the spawn factory constructs it) would lose any
// line the peer wrote before the runtime threaded its observers in.
// Spec §10.2 endorses (b) "buffer with a small cap" as the right
// answer for the pre-renderer phase.
//
// Drain semantics: the buffer stays alive until the FIRST real-time
// message arrives (i.e. one delivered after at least one subscriber
// is attached). New subscribers attaching while the buffer is alive
// receive the full replay — production wires multiple subscribers in
// the same synchronous frame (protocol-version check, typed event
// observer, raw onIpcMessage), and a "drain once into the first
// subscriber" semantic would leak every event-stream message into
// only the version checker. Once a message is emitted live, the
// buffer commits (pendingMessages → null) and late subscribers see
// only real-time, matching the standard emitter contract.
const REPLAY_BUFFER_CAP = 64;

export const createChannel = (transport: IpcTransport): IpcChannel => {
  const messages = createEmitter<IpcMessage>();
  const errors = createEmitter<{ line: string; reason: string }>();

  let pendingMessages: IpcMessage[] | null = [];
  let pendingErrors: { line: string; reason: string }[] | null = [];
  let droppedFromOverflow = 0;

  const flushOverflowDiagnostic = () => {
    if (droppedFromOverflow === 0) return;
    process.stderr.write(
      `forja: ipc replay buffer overflow — ${droppedFromOverflow} message(s) dropped before subscriber attached\n`,
    );
    droppedFromOverflow = 0;
  };

  // Subscribe to the transport once at construction. The channel
  // owns the subscription's lifetime — a downstream listener
  // unsubscribing only removes itself from `messages`, not from
  // the transport.
  transport.onLine((line) => {
    const r = parseLine(line);
    if (r.ok) {
      if (messages.size() === 0 && pendingMessages !== null) {
        // No subscribers yet — buffer with cap.
        if (pendingMessages.length < REPLAY_BUFFER_CAP) {
          pendingMessages.push(r.msg);
        } else {
          droppedFromOverflow += 1;
        }
        return;
      }
      // First real-time emit commits the buffer: future subscribers
      // are "late" and only see real-time delivery from here on.
      // The current subscribers already received their replay when
      // they attached; this real-time message reaches them via the
      // emitter the normal way.
      if (pendingMessages !== null) {
        pendingMessages = null;
        flushOverflowDiagnostic();
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
      if (pendingErrors !== null) {
        pendingErrors = null;
      }
      errors.emit(err);
    }
  });

  // Transport-level errors (line_too_long from the framer's
  // overflow path; future variants land here too) route through
  // the same `errors` emitter as parser failures so operators
  // see one diagnostic stream. The `line` field stays empty
  // because there's no parseable payload — operators can grep
  // on the reason code alone.
  transport.onTransportError((err) => {
    const wrapped = {
      line: '',
      reason: err.detail !== undefined ? `${err.reason}:${err.detail}` : err.reason,
    };
    if (errors.size() === 0 && pendingErrors !== null) {
      if (pendingErrors.length < REPLAY_BUFFER_CAP) {
        pendingErrors.push(wrapped);
      } else {
        droppedFromOverflow += 1;
      }
      return;
    }
    if (pendingErrors !== null) {
      pendingErrors = null;
    }
    errors.emit(wrapped);
  });

  return {
    send(msg) {
      transport.write(encodeMessage(msg));
    },
    onMessage(cb) {
      const unsub = messages.subscribe(cb);
      // Replay anything buffered so far. The buffer stays alive
      // until the first real-time emit, so multiple subscribers
      // attaching in the same sync frame all receive the same
      // history — critical for the production case where the
      // runtime wires three handlers back-to-back (version check,
      // typed observer, raw onIpcMessage).
      if (pendingMessages !== null) {
        for (const m of pendingMessages) cb(m);
      }
      // Surface any overflow drops that happened pre-subscribe.
      // Operator gets one stderr line at the moment a listener
      // can actually act on the signal; the diagnostic is gated
      // by the counter (non-zero, then reset) so duplicate
      // subscribes don't repeat.
      flushOverflowDiagnostic();
      return unsub;
    },
    onError(cb) {
      const unsub = errors.subscribe(cb);
      if (pendingErrors !== null) {
        for (const e of pendingErrors) cb(e);
      }
      return unsub;
    },
    onClose: (cb) => transport.onClose(cb),
    close: () => transport.close(),
  };
};
