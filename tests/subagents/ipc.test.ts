import { describe, expect, test } from 'bun:test';
import {
  IPC_PROTOCOL_VERSION,
  type IpcMessage,
  type IpcTransport,
  type ProcessStreams,
  createChannel,
  encodeMessage,
  fakeTransportPair,
  makeEvent,
  makeInterruptHard,
  makeInterruptSoft,
  makeSessionFinished,
  makeSessionStart,
  makeShutdown,
  parseLine,
  processTransport,
  subprocessTransport,
} from '../../src/subagents/ipc.ts';

// Wire layer: encodeMessage + parseLine are pure and the simplest
// surface to verify. Every variant of the IpcMessage union should
// round-trip; malformed inputs should surface stable reason codes
// without throwing.
describe('IPC wire — encode/parse', () => {
  test('round-trips every IpcMessage variant', () => {
    const cases: IpcMessage[] = [
      makeSessionStart('sess-1'),
      makeSessionFinished(),
      makeEvent({ kind: 'tool_invoking', name: 'echo' }),
      makeInterruptSoft(),
      makeInterruptHard(),
      makeShutdown(),
    ];
    for (const msg of cases) {
      const line = encodeMessage(msg);
      // Single line by construction (no embedded LF except the
      // terminator we appended).
      expect(line.endsWith('\n')).toBe(true);
      expect(line.slice(0, -1).includes('\n')).toBe(false);

      const parsed = parseLine(line.slice(0, -1));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.msg).toEqual(msg);
      }
    }
  });

  test('makeSessionStart stamps the protocol version', () => {
    const m = makeSessionStart('sess-x');
    expect(m.type).toBe('session_start');
    if (m.type === 'session_start') {
      expect(m.protocolVersion).toBe(IPC_PROTOCOL_VERSION);
      expect(m.sessionId).toBe('sess-x');
    }
  });

  test('JSON.stringify escapes embedded LF — single line invariant', () => {
    // Hostile payload: an event whose body contains a literal
    // newline. The encoder must produce exactly one LF (the
    // terminator); the embedded LF is escaped as \n.
    const m = makeEvent({ text: 'line1\nline2' });
    const line = encodeMessage(m);
    const lfCount = [...line].filter((c) => c === '\n').length;
    expect(lfCount).toBe(1);
    const r = parseLine(line.trim());
    expect(r.ok).toBe(true);
    if (r.ok && r.msg.type === 'event') {
      expect(r.msg.event).toEqual({ text: 'line1\nline2' });
    }
  });

  test('parseLine accepts CRLF-terminated input', () => {
    // Some debug pipes (typing into a terminal, Windows-flavored
    // tools) inject CR before LF. We only see the line content
    // here (LF is consumed by the framer), but a stray CR at the
    // end should not break parsing.
    const m = makeShutdown();
    const line = `${JSON.stringify(m)}\r`;
    const r = parseLine(line);
    expect(r.ok).toBe(true);
  });

  test.each([
    ['', 'empty_line'],
    ['not json', 'json_parse_failed'],
    ['null', 'not_object'],
    ['[1,2,3]', 'not_object'],
    ['{}', 'missing_type'],
    ['{"type":42}', 'missing_type'],
    ['{"type":"made_up","id":"x","ts":1}', 'unknown_type:made_up'],
    ['{"type":"shutdown"}', 'missing_id'],
    ['{"type":"shutdown","id":"x"}', 'missing_ts'],
    ['{"type":"shutdown","id":"","ts":1}', 'missing_id'],
    ['{"type":"shutdown","id":"x","ts":"now"}', 'missing_ts'],
    ['{"type":"session_start","id":"x","ts":1}', 'session_start.missing_sessionId'],
    [
      '{"type":"session_start","id":"x","ts":1,"sessionId":"s"}',
      'session_start.missing_protocolVersion',
    ],
    ['{"type":"event","id":"x","ts":1}', 'event.missing_event'],
  ])('parseLine refuses %j with reason %s', (input, expected) => {
    const r = parseLine(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(expected);
  });
});

// Transport contract: same shape across fake/subprocess/process.
// The fake pair gives us a self-contained way to verify the
// duplex, framing, and close semantics without spawning anything.
describe('IPC transport — fake pair', () => {
  test('writes on one side surface as lines on the other', () => {
    const { a, b } = fakeTransportPair();
    const got: string[] = [];
    b.onLine((line) => got.push(line));
    a.write('hello\n');
    a.write('world\n');
    expect(got).toEqual(['hello', 'world']);
  });

  test('drops empty lines (no message between two consecutive LFs)', () => {
    const { a, b } = fakeTransportPair();
    const got: string[] = [];
    b.onLine((line) => got.push(line));
    a.write('one\n\n\ntwo\n');
    expect(got).toEqual(['one', 'two']);
  });

  test('multiple lines in a single write are all delivered', () => {
    const { a, b } = fakeTransportPair();
    const got: string[] = [];
    b.onLine((line) => got.push(line));
    a.write('aaa\nbbb\nccc\n');
    expect(got).toEqual(['aaa', 'bbb', 'ccc']);
  });

  test('close fires onClose on both sides exactly once', () => {
    const { a, b } = fakeTransportPair();
    let aCloses = 0;
    let bCloses = 0;
    a.onClose(() => {
      aCloses += 1;
    });
    b.onClose(() => {
      bCloses += 1;
    });
    a.close();
    a.close(); // idempotent
    expect(aCloses).toBe(1);
    expect(bCloses).toBe(1);
  });

  test('writes after close are silently dropped', () => {
    const { a, b } = fakeTransportPair();
    const got: string[] = [];
    b.onLine((line) => got.push(line));
    b.close();
    a.write('after-close\n');
    expect(got).toEqual([]);
  });

  test('listener errors do not break delivery to siblings', () => {
    const { a, b } = fakeTransportPair();
    const got: string[] = [];
    b.onLine(() => {
      throw new Error('listener exploded');
    });
    b.onLine((line) => got.push(line));
    a.write('survives\n');
    expect(got).toEqual(['survives']);
  });

  test('unsubscribe from onLine stops further delivery', () => {
    const { a, b } = fakeTransportPair();
    const got: string[] = [];
    const unsub = b.onLine((line) => got.push(line));
    a.write('one\n');
    unsub();
    a.write('two\n');
    expect(got).toEqual(['one']);
  });
});

// Channel layer: typed sends + parsed receives + error routing.
describe('IPC channel', () => {
  test('end-to-end typed send via fake pair', () => {
    const { a, b } = fakeTransportPair();
    const parent = createChannel(a);
    const child = createChannel(b);
    const received: IpcMessage[] = [];
    parent.onMessage((m) => received.push(m));

    const start = makeSessionStart('s-1');
    const ev = makeEvent({ kind: 'step_start', stepN: 1 });
    const fin = makeSessionFinished();
    child.send(start);
    child.send(ev);
    child.send(fin);

    expect(received).toEqual([start, ev, fin]);
  });

  test('malformed lines surface via onError without breaking the wire', () => {
    const { a, b } = fakeTransportPair();
    const parent = createChannel(a);
    const errors: { line: string; reason: string }[] = [];
    const messages: IpcMessage[] = [];
    parent.onError((e) => errors.push(e));
    parent.onMessage((m) => messages.push(m));

    // Inject a malformed line directly (not via channel.send,
    // since send only accepts typed messages). Simulates a
    // deserialization failure on the peer.
    b.write('not json\n');
    b.write(`${JSON.stringify(makeShutdown())}\n`);
    b.write('{"type":"event","id":"x","ts":1}\n'); // missing event field
    b.write(`${JSON.stringify(makeInterruptSoft())}\n`);

    expect(errors.length).toBe(2);
    expect(errors[0]?.reason).toBe('json_parse_failed');
    expect(errors[1]?.reason).toBe('event.missing_event');
    expect(messages.length).toBe(2);
    expect(messages[0]?.type).toBe('shutdown');
    expect(messages[1]?.type).toBe('interrupt:soft');
  });

  test('close on one channel propagates onClose to the other', () => {
    const { a, b } = fakeTransportPair();
    const parent = createChannel(a);
    const child = createChannel(b);
    let parentClosed = false;
    let childClosed = false;
    parent.onClose(() => {
      parentClosed = true;
    });
    child.onClose(() => {
      childClosed = true;
    });
    parent.close();
    expect(parentClosed).toBe(true);
    expect(childClosed).toBe(true);
  });

  // Late-subscriber replay (review finding #1). Without this the
  // subprocess transport's pump loop would deliver messages to a
  // channel whose `onMessage` subscriber hasn't attached yet — the
  // emitter has no history, so any pre-subscribe lines are lost.
  test('messages delivered before first subscriber are replayed on subscribe', () => {
    const { a, b } = fakeTransportPair();
    const parent = createChannel(a);
    const child = createChannel(b);
    // Child sends three messages BEFORE the parent attaches its
    // observer. In production this models the subprocess writing
    // session_start before runtime.ts threads its onMessage in.
    child.send(makeSessionStart('s-1'));
    child.send(makeEvent({ type: 'step_start', stepN: 1 }));
    child.send(makeShutdown());

    const received: IpcMessage[] = [];
    parent.onMessage((m) => received.push(m));
    expect(received.map((m) => m.type)).toEqual(['session_start', 'event', 'shutdown']);
  });

  test('errors delivered before first subscriber are replayed on subscribe', () => {
    const { a, b } = fakeTransportPair();
    const parent = createChannel(a);
    // Inject malformed lines via the raw transport (not channel.send,
    // which only takes typed messages).
    b.write('not-json\n');
    b.write('{"type":"unknown_kind","id":"x","ts":1}\n');

    const errors: { line: string; reason: string }[] = [];
    parent.onError((e) => errors.push(e));
    expect(errors).toHaveLength(2);
    expect(errors[0]?.reason).toBe('json_parse_failed');
    expect(errors[1]?.reason).toContain('unknown_type');
  });

  test('multiple subscribers in the same sync frame all receive the buffered replay', () => {
    // Production wires THREE onMessage handlers back-to-back in
    // runSubagent (protocol-version check, optional onIpcMessage,
    // typed onChildEvent forwarder). Each must see the same
    // history — a drain-once-into-first-subscriber semantic would
    // leak every child-emitted event into only the version
    // checker, leaving the typed observer empty (regression
    // caught by the real-subprocess smoke).
    const { a, b } = fakeTransportPair();
    const parent = createChannel(a);
    const child = createChannel(b);
    child.send(makeSessionStart('s-1'));
    child.send(makeShutdown());

    const first: IpcMessage[] = [];
    const second: IpcMessage[] = [];
    parent.onMessage((m) => first.push(m));
    parent.onMessage((m) => second.push(m));
    // Both same-frame subscribers see the full pre-subscribe
    // replay.
    expect(first.map((m) => m.type)).toEqual(['session_start', 'shutdown']);
    expect(second.map((m) => m.type)).toEqual(['session_start', 'shutdown']);
  });

  test('subscriber attaching AFTER first real-time emit sees only real-time (buffer committed)', () => {
    // Once the buffer commits (first real-time message lands on
    // an attached subscriber), it can't be replayed — late
    // subscribers are "late" by construction. Matches the
    // standard emitter contract.
    const { a, b } = fakeTransportPair();
    const parent = createChannel(a);
    const child = createChannel(b);
    // Buffer one message, attach first subscriber (drains buffer
    // into it), emit a second message live (commits the buffer),
    // then attach a late subscriber.
    child.send(makeSessionStart('s-1'));
    const first: IpcMessage[] = [];
    parent.onMessage((m) => first.push(m));
    child.send(makeShutdown());
    const late: IpcMessage[] = [];
    parent.onMessage((m) => late.push(m));
    // First subscriber: replay (1) + real-time (1) = 2.
    expect(first).toHaveLength(2);
    // Late subscriber: nothing (the buffer committed when the
    // shutdown landed live).
    expect(late).toEqual([]);
    // Real-time still flows to both going forward.
    child.send(makeInterruptHard());
    expect(first).toHaveLength(3);
    expect(late).toHaveLength(1);
  });

  test('replay buffer caps at 64 messages with a stderr diagnostic', () => {
    const stderrChunks: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: stub for stderr capture
    (process.stderr as any).write = (chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    try {
      const { a, b } = fakeTransportPair();
      const parent = createChannel(a);
      const child = createChannel(b);
      // Send 70 messages — 6 over the cap.
      for (let i = 0; i < 70; i += 1) {
        child.send(makeEvent({ idx: i }));
      }
      const received: IpcMessage[] = [];
      parent.onMessage((m) => received.push(m));
      // Buffer cap is 64; subsequent messages dropped.
      expect(received.length).toBe(64);
      // One diagnostic line on stderr noting the drop count.
      const joined = stderrChunks.join('');
      expect(joined).toContain('replay buffer overflow');
      expect(joined).toContain('6 message');
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore stub
      (process.stderr as any).write = realWrite;
    }
  });
});

// Subprocess transport: framer behavior across chunk boundaries.
// We don't actually spawn — we drive the Web streams directly to
// exercise the same surface Bun.spawn would provide.
describe('IPC subprocessTransport — framer', () => {
  // Helper: spin up an in-memory pair of Web streams. The "child"
  // is simulated by enqueueing chunks into the readable's
  // controller and reading the parent's writes from the writable's
  // sink.
  const buildStreams = () => {
    let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller;
      },
    });
    const writes: Uint8Array[] = [];
    const stdin = new WritableStream<Uint8Array>({
      write(chunk) {
        writes.push(chunk);
      },
    });
    const enqueue = (s: string) => {
      stdoutController.enqueue(new TextEncoder().encode(s));
    };
    const closeStdout = () => stdoutController.close();
    return { stdin, stdout, writes, enqueue, closeStdout };
  };

  test('frames lines split across multiple chunks', async () => {
    const s = buildStreams();
    const t = subprocessTransport({ stdin: s.stdin, stdout: s.stdout });
    const got: string[] = [];
    t.onLine((l) => got.push(l));

    s.enqueue('hel');
    s.enqueue('lo\nwor');
    s.enqueue('ld\n');
    // Yield to the pump loop.
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual(['hello', 'world']);
  });

  test('partial line at EOF is delivered via flush', async () => {
    const s = buildStreams();
    const t = subprocessTransport({ stdin: s.stdin, stdout: s.stdout });
    const got: string[] = [];
    let closed = false;
    t.onLine((l) => got.push(l));
    t.onClose(() => {
      closed = true;
    });
    s.enqueue('partial-without-lf');
    s.closeStdout();
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual(['partial-without-lf']);
    expect(closed).toBe(true);
  });

  test('UTF-8 multi-byte characters split across chunks decode cleanly', async () => {
    // Inject raw bytes via a separate readable that we control
    // chunk-by-chunk. 'é' = 0xC3 0xA9 in UTF-8; we split it.
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const stdin = new WritableStream<Uint8Array>({ write() {} });
    const t = subprocessTransport({ stdin, stdout });
    const got: string[] = [];
    t.onLine((l) => got.push(l));
    controller.enqueue(new Uint8Array([0xc3]));
    controller.enqueue(new Uint8Array([0xa9, 0x0a])); // 0xa9 + LF
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual(['é']);
  });

  test('write goes through to the WritableStream sink', async () => {
    const s = buildStreams();
    const t = subprocessTransport({ stdin: s.stdin, stdout: s.stdout });
    t.write('payload-line\n');
    // The writer is async; let its microtask resolve.
    await new Promise((r) => setTimeout(r, 10));
    const decoded = s.writes.map((b) => new TextDecoder().decode(b)).join('');
    expect(decoded).toBe('payload-line\n');
  });

  test('close cancels the reader and shuts down', async () => {
    const s = buildStreams();
    const t = subprocessTransport({ stdin: s.stdin, stdout: s.stdout });
    let closed = false;
    t.onClose(() => {
      closed = true;
    });
    t.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBe(true);
  });
});

// processTransport: same contract, listening on a Node-style
// Readable. We construct a fake EventEmitter-like that conforms to
// the minimal interface processTransport requires.
describe('IPC processTransport — Node streams', () => {
  // Minimal Readable: emits 'data' / 'end' / 'error'. Listeners
  // registered via on(); removable via removeListener().
  const buildFakeStdin = () => {
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const emit = (event: string, ...args: unknown[]) => {
      for (const h of handlers[event] ?? []) h(...args);
    };
    // Cast through unknown to satisfy the overloaded signature
    // declared on ReadableStdin — the test only exercises the
    // event names processTransport itself registers, so the
    // narrow lookup type is fine in practice.
    const stream = {
      on(event: string, cb: (...args: unknown[]) => void) {
        const bucket = handlers[event] ?? [];
        bucket.push(cb);
        handlers[event] = bucket;
      },
      removeListener(event: string, cb: (...args: unknown[]) => void) {
        const list = handlers[event];
        if (!list) return;
        const i = list.indexOf(cb);
        if (i !== -1) list.splice(i, 1);
      },
    } as unknown as ProcessStreams['stdin'];
    return { stream, emit };
  };

  test('frames stdin chunks into lines and writes through stdout', () => {
    const stdin = buildFakeStdin();
    const writes: string[] = [];
    const stdout = {
      write(chunk: string) {
        writes.push(chunk);
      },
    };
    const t: IpcTransport = processTransport({
      stdin: stdin.stream,
      stdout,
    });
    const got: string[] = [];
    t.onLine((l) => got.push(l));

    stdin.emit('data', Buffer.from('aaa\nbbb\n'));
    expect(got).toEqual(['aaa', 'bbb']);

    t.write('out-1\n');
    expect(writes).toEqual(['out-1\n']);
  });

  test('end event fires onClose and flushes a partial line', () => {
    const stdin = buildFakeStdin();
    const stdout = { write: () => undefined };
    const t = processTransport({ stdin: stdin.stream, stdout });
    const got: string[] = [];
    let closed = 0;
    t.onLine((l) => got.push(l));
    t.onClose(() => {
      closed += 1;
    });
    stdin.emit('data', Buffer.from('partial-no-lf'));
    stdin.emit('end');
    expect(got).toEqual(['partial-no-lf']);
    expect(closed).toBe(1);
  });

  test('string chunks are normalized to bytes via TextEncoder', () => {
    const stdin = buildFakeStdin();
    const stdout = { write: () => undefined };
    const t = processTransport({ stdin: stdin.stream, stdout });
    const got: string[] = [];
    t.onLine((l) => got.push(l));
    // Some Readables (when an encoding is set) emit strings.
    // The transport must treat them the same as buffers.
    stdin.emit('data', 'literal-string\n');
    expect(got).toEqual(['literal-string']);
  });
});
