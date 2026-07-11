// Mesh transport: Unix domain socket speaking NDJSON, framed by the shared wire
// framer. Server side (listenMesh) accepts connections; client side (connectMesh)
// dials a peer socket. Auth is the FS permission on the socket path (§0.7); this
// layer is byte-plumbing only. See docs/spec/MESH.md §3.

import { chmodSync } from 'node:fs';
import type { Socket } from 'bun';
import { createLineFramer, type LineFramer } from '../wire/ndjson.ts';

export interface MeshTransport {
  // Write an already-framed line (encodeMeshMessage output, trailing LF included).
  // Returns false if the transport is already closed or the socket write errored
  // synchronously (the bytes did NOT leave); true if accepted or buffered for drain.
  write(line: string): boolean;
  onLine(cb: (line: string) => void): () => void;
  onClose(cb: () => void): () => void;
  onError(cb: (err: unknown) => void): () => void;
  // Graceful close: flush any buffered bytes, THEN FIN. Safe to call right after
  // write() — the FIN waits for backpressured data to drain (so a large final
  // `result` is delivered whole, not truncated).
  close(): void;
}

interface SocketState {
  framer: LineFramer;
  lineCbs: Set<(line: string) => void>;
  closeCbs: Set<() => void>;
  errorCbs: Set<(err: unknown) => void>;
  transport: MeshTransport;
  // Invoked from the socket's `drain` handler to push buffered bytes.
  onDrain: () => void;
  // Invoked from the socket's `close` handler so a remote FIN flips the same
  // `closed` flag a local close() sets — otherwise write() after a remote close
  // would keep pumping to a dead socket and report success.
  markClosed: () => void;
}

// Per-socket state keyed off the socket object — avoids threading Bun's generic
// socket-data type through listen/connect.
const states = new WeakMap<object, SocketState>();
const encoder = new TextEncoder();

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

const attachSocket = (socket: Socket<undefined>): MeshTransport => {
  const lineCbs = new Set<(line: string) => void>();
  const closeCbs = new Set<() => void>();
  const errorCbs = new Set<(err: unknown) => void>();
  const framer = createLineFramer((line) => {
    for (const cb of lineCbs) cb(line);
  });
  let closed = false;
  // Bun sockets do NOT buffer: socket.write may accept FEWER bytes than offered
  // and drops the rest unless we re-send on `drain`. `pending` holds the bytes
  // the socket hasn't accepted yet; `closeAfterDrain` makes close() wait for it.
  let pending: Uint8Array | null = null;
  let closeAfterDrain = false;

  const doEnd = (): void => {
    if (closed) return;
    closed = true;
    try {
      socket.end();
    } catch {
      // already torn down
    }
  };

  // Push `bytes` onto the socket; buffer whatever it didn't accept. Returns
  // false if the bytes did not leave (socket dead / shutting down), true if
  // written or buffered for drain.
  const pump = (bytes: Uint8Array): boolean => {
    try {
      const wrote = socket.write(bytes);
      if (wrote < 0) {
        // Bun's socket.write returns -1 (it does NOT throw) when the socket is
        // closed or shutting down — the bytes did NOT leave. Without this guard the
        // `wrote < bytes.length` branch below would read -1 as a partial write
        // (`pending = bytes.subarray(-1)`, the last byte) and return true, so a send
        // to a peer that closed mid-handshake (the /relay off race) would report a
        // phantom success — and mesh_send would resolve + audit a delivery that
        // never happened, defeating the peer_lost guard. Surface it as a dead socket.
        for (const cb of errorCbs) cb(new Error('socket closed'));
        return false;
      }
      if (wrote < bytes.length) {
        pending = bytes.subarray(wrote);
      } else {
        pending = null;
        if (closeAfterDrain) doEnd();
      }
      return true;
    } catch (err) {
      for (const cb of errorCbs) cb(err);
      return false;
    }
  };

  const onDrain = (): void => {
    if (pending !== null) pump(pending);
    else if (closeAfterDrain) doEnd();
  };

  const transport: MeshTransport = {
    write(line) {
      if (closed) return false;
      const bytes = encoder.encode(line);
      if (pending !== null) {
        // Already backpressured — queue behind the tail (preserve order); the
        // drain handler flushes it. Don't interleave a fresh socket.write.
        pending = concat(pending, bytes);
        return true;
      }
      return pump(bytes);
    },
    onLine(cb) {
      lineCbs.add(cb);
      return () => {
        lineCbs.delete(cb);
      };
    },
    onClose(cb) {
      closeCbs.add(cb);
      return () => {
        closeCbs.delete(cb);
      };
    },
    onError(cb) {
      errorCbs.add(cb);
      return () => {
        errorCbs.delete(cb);
      };
    },
    close() {
      if (closed) return;
      if (pending !== null) {
        closeAfterDrain = true; // FIN once the buffered tail drains
      } else {
        doEnd();
      }
    },
  };
  const markClosed = (): void => {
    closed = true;
  };
  states.set(socket, { framer, lineCbs, closeCbs, errorCbs, transport, onDrain, markClosed });
  return transport;
};

const pushData = (socket: object, chunk: Uint8Array): void => {
  states.get(socket)?.framer.push(chunk);
};
const emitClose = (socket: object): void => {
  const s = states.get(socket);
  if (s) {
    s.markClosed(); // flip `closed` before notifying, so a close-cb's write() is a clean no-op
    for (const cb of s.closeCbs) cb();
  }
};
const emitError = (socket: object, err: unknown): void => {
  const s = states.get(socket);
  if (s) for (const cb of s.errorCbs) cb(err);
};

export interface MeshServer {
  stop(): void;
}

// Listen on a Unix socket. Each accepted connection becomes a MeshTransport; the
// caller MUST register onLine synchronously inside onConnection (the peer's first
// line arrives on a later tick, but registering late risks a drop).
export const listenMesh = (
  socketPath: string,
  onConnection: (transport: MeshTransport) => void,
): MeshServer => {
  const listener = Bun.listen<undefined>({
    unix: socketPath,
    socket: {
      open(socket) {
        onConnection(attachSocket(socket));
      },
      data(socket, chunk) {
        pushData(socket, chunk);
      },
      drain(socket) {
        states.get(socket)?.onDrain();
      },
      close(socket) {
        emitClose(socket);
      },
      error(socket, err) {
        emitError(socket, err);
      },
    },
  });
  // §0.7/§2: the socket must be owner-only. Bun.listen leaves the mode to the
  // umask; force 0600 so a loose umask can't expose connect to group/other.
  try {
    chmodSync(socketPath, 0o600);
  } catch {
    // best-effort; the 0700 parent dir is the primary boundary
  }
  return {
    stop() {
      listener.stop(true);
    },
  };
};

// Liveness probe: does a listener ACCEPT a connection on this unix socket? A
// present socket FILE is not liveness — a crashed relay leaves the file behind,
// and pid reuse makes a stale descriptor's pid look alive (registry §2). Only a
// real connect distinguishes a live listener (which accepts, even into a busy
// backlog) from an orphaned socket file, a planted regular file (ENOTSOCK), or a
// missing one (ENOENT). Local unix connects settle immediately; the timeout is a
// backstop against a pathological hang (a full backlog), treated as dead.
export const probeSocket = (socketPath: string, timeoutMs = 500): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false;
    const done = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(alive);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    Bun.connect<undefined>({
      unix: socketPath,
      socket: {
        open(sock) {
          // Accepted → a listener is live. We only needed the accept; close now.
          sock.end();
          done(true);
        },
        data() {},
        close() {},
        error() {},
      },
    }).catch(() => done(false)); // ECONNREFUSED / ENOTSOCK / ENOENT → no live listener
  });

// Dial a peer's Unix socket. Attaches in `open` (before any data arrives) so the
// server's hello is never dropped between connect-resolve and attach.
export const connectMesh = async (socketPath: string): Promise<MeshTransport> => {
  let transport: MeshTransport | undefined;
  await Bun.connect<undefined>({
    unix: socketPath,
    socket: {
      open(sock) {
        transport = attachSocket(sock);
      },
      data(sock, chunk) {
        pushData(sock, chunk);
      },
      drain(sock) {
        states.get(sock)?.onDrain();
      },
      close(sock) {
        emitClose(sock);
      },
      error(sock, err) {
        emitError(sock, err);
      },
    },
  });
  // Bun invokes `open` before resolving connect (the connectError path rejects
  // AFTER its handler, so the success path resolves after `open`). Guard instead
  // of a silent second attach that would bind a state `data` never routes to.
  if (transport === undefined) {
    throw new Error('mesh: connect resolved before open attached the transport');
  }
  return transport;
};
