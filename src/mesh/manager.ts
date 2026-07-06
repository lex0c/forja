// Mesh manager — mirrors createMcpManager in shape (a subsystem handle held on
// HarnessConfig). Two roles: SERVER (listen + accept peer messages when
// relayMode is on) and CLIENT (discover peers, send a message). The manager is
// byte/lifecycle plumbing + routing; the REPL wires the onMessage callback into
// the notification queue (§6.2). Intent, not authority — a peer message becomes
// a local system-source turn, nothing more.
//
// A free message bus (§4, §6.4): a message is ONE short connection
// (connect → hello → message → close), fire-and-forget. A reply is a NEW message
// in the reverse direction, so two-way exchange needs BOTH sides serving. There
// is no conversation lifecycle, no awaited reply, no result/progress frame.
// See docs/spec/MESH.md §0, §4, §6.

import { resolveAlias } from './config.ts';
import {
  encodeMeshMessage,
  makeBye,
  makeError,
  makeHello,
  makeMessage,
  parseMeshLine,
} from './protocol.ts';
import {
  ensureMeshDirs,
  listPeers as fsListPeers,
  publishDescriptor,
  removeDescriptor,
  socketPath,
} from './registry.ts';
import { type MeshServer, type MeshTransport, connectMesh, listenMesh } from './transport.ts';
import {
  ALIAS_MAX,
  ALIAS_RE,
  MESH_ERROR_CODES,
  MESH_PROTOCOL_VERSION,
  type MeshAuditEvent,
  type MeshConfig,
  type PeerDescriptor,
  type PeerInfo,
  type PeerStatus,
  toPeerInfo,
} from './types.ts';

export interface MeshManagerDeps {
  // Runtime dir (from meshRuntimeDir) where sockets + descriptors live.
  dir: string;
  config: MeshConfig;
  repoRoot: string;
  branch: string;
  // Defaults to process.pid; injectable for tests.
  pid?: number;
  // Pre-message reap window (see HANDSHAKE_DEADLINE_MS); injectable for tests so
  // they don't wait the full 30 s.
  handshakeDeadlineMs?: number;
  // Concurrent-connection ceiling (see MAX_INBOUND_CONNECTIONS); injectable so a
  // test can exercise admission control without opening 64 real sockets.
  maxInboundConnections?: number;
  // Optional boundary-audit sink (§8): the manager emits MeshAuditEvents at the
  // wire hub (message received / message sent); the sink, wired in bootstrap with
  // the DB, persists them to `mesh_events`. No-op when absent (headless / tests).
  onAuditEvent?: (event: MeshAuditEvent) => void;
}

export interface InboundMessage {
  // The peer's message id (audit/dedup only — not a correlation handle, §4).
  id: string;
  peerAlias: string;
  text: string;
}

export interface MeshManager {
  readonly alias: string;
  // The §9 per-message byte cap — the mesh_send tool reads it to reject an
  // over-cap message up front with a distinct error (not a generic no-peer).
  readonly maxMessageBytes: number;
  // Discovery (client side, always available). Async — liveness is a connect probe
  // (a present socket file isn't a live listener; §2).
  listPeers(): Promise<PeerInfo[]>;
  // Send a message to a peer: connect → hello → message → close, fire-and-forget.
  // Resolves with the message id once the message is written to the transport.
  // Throws (no live peer / peer_lost) if the peer is unreachable or the write
  // fails — the sender's model learns immediately, never a silent hang (§6.5). A
  // reply, if any, arrives later as its OWN inbound message via onMessage
  // (isomorphic to bash_background); the exchange is symmetric, so this works
  // whether or not THIS instance is serving.
  send(alias: string, text: string): Promise<{ id: string }>;
  // Server side (relayMode on/off).
  startServing(): Promise<void>;
  stopServing(): Promise<void>;
  isServing(): boolean;
  // REPL wiring: a peer sent us a message.
  onMessage(cb: (m: InboundMessage) => void): void;
  // Published status (idle / working / waiting-operator).
  setStatus(status: PeerStatus): void;
  shutdown(): Promise<void>;
}

// A connection that opens but never sends a valid message pins an fd + a
// partial-line framer buffer indefinitely — there is no OS liveness signal
// across independent processes. Bound the pre-message window generously: a real
// client sends hello+message within milliseconds, so 30 s only ever reaps a
// stalled/half-open connection, never a legitimate one.
const HANDSHAKE_DEADLINE_MS = 30_000;

// Ceiling on concurrent inbound connections (admission control). The handshake
// reaper bounds each connection's LIFETIME (30 s), not the COUNT — so a peer stuck
// in a reconnect loop could open thousands within one reaper window and exhaust
// the process fd limit (starving Forja's own tools). Each mesh message is a short
// connection, so legitimate concurrency is a handful; this ceiling sits well under
// a typical 1024 soft fd limit, leaving ample room for the rest of Forja.
const MAX_INBOUND_CONNECTIONS = 64;

// How long send() reads for the receiver's synchronous verdict (an `error` frame,
// or a clean close = accepted) before treating silence as delivered. A conforming
// receiver errors/closes within a local round-trip (sub-ms); this only bounds a
// non-conforming/hung peer so a send never waits indefinitely.
const SEND_ACK_DEADLINE_MS = 1000;

export const createMeshManager = (deps: MeshManagerDeps): MeshManager => {
  const pid = deps.pid ?? process.pid;
  const alias = resolveAlias(deps.config, deps.repoRoot);
  const startedAt = Date.now();
  let status: PeerStatus = 'idle';
  let serving = false;
  let server: MeshServer | null = null;

  // Server connections currently open (each is one short inbound message in
  // flight). Tracked so /relay off can say bye + close them cleanly (§6.5).
  const openConnections = new Set<MeshTransport>();

  let messageCb: ((m: InboundMessage) => void) | null = null;

  const descriptor = (): PeerDescriptor => ({
    alias,
    repoRoot: deps.repoRoot,
    branch: deps.branch,
    pid,
    socket: socketPath(deps.dir, alias),
    status,
    startedAt,
  });

  const republish = (): void => {
    if (serving) publishDescriptor(deps.dir, descriptor());
  };

  // Emit a boundary audit event best-effort (§8): audit is operational, not
  // critical, so a sink failure (DB locked/closed, or any throw) must NEVER
  // break the mesh operation it is observing — swallow it.
  const emitAudit = (event: MeshAuditEvent): void => {
    try {
      deps.onAuditEvent?.(event);
    } catch {
      // best-effort — the wire operation must not fail because audit did
    }
  };

  // ---- server side ----
  const maxInbound = deps.maxInboundConnections ?? MAX_INBOUND_CONNECTIONS;
  const onServerConnection = (transport: MeshTransport): void => {
    if (openConnections.size >= maxInbound) {
      // Admission control (§9): reject a new connection once we're at the ceiling,
      // so a reconnect-looping / flooding peer can't pin fds up to the handshake
      // window and exhaust the process. Close immediately — don't add, don't parse.
      transport.close();
      return;
    }
    openConnections.add(transport);
    // null until a valid hello arrives — a message before hello is rejected so it
    // can't bypass version negotiation (§4).
    let peerAlias: string | null = null;
    // One message (or one terminal error) per connection (§4). The wire framer
    // delivers EVERY complete line in a buffered chunk synchronously, and close()
    // neither stops it nor unregisters the callback — so a non-conforming peer
    // that writes `hello\n{msgA}\n{msgB}` in one chunk would otherwise drive two
    // turns + two audit events on one "short connection". Once handled, ignore any
    // further pipelined line.
    let handled = false;
    // Reap a connection that stalls before sending any message (see
    // HANDSHAKE_DEADLINE_MS); unref'd so it never keeps the process alive.
    let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
    const clearHandshakeTimer = (): void => {
      if (handshakeTimer !== null) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
    };
    // Terminal teardown: mark handled, disarm the reaper, close. Idempotent.
    const closeConn = (): void => {
      handled = true;
      clearHandshakeTimer();
      transport.close();
    };
    handshakeTimer = setTimeout(closeConn, deps.handshakeDeadlineMs ?? HANDSHAKE_DEADLINE_MS);
    handshakeTimer.unref?.();
    transport.onLine((line) => {
      if (handled) return; // one message / terminal error per connection (§4)
      const res = parseMeshLine(line);
      if (!res.ok) return; // drop malformed, keep channel open (§4.5 lineage)
      const msg = res.msg;
      switch (msg.type) {
        case 'hello': {
          if (msg.protocolVersion !== MESH_PROTOCOL_VERSION) {
            transport.write(
              encodeMeshMessage(
                makeError(
                  MESH_ERROR_CODES.versionMismatch,
                  `mesh protocol v${MESH_PROTOCOL_VERSION} required`,
                ),
              ),
            );
            closeConn();
            return;
          }
          // Revalidate the peer's declared alias against the grammar — it feeds
          // the operator's scrollback header + the untrusted preamble, so reject a
          // control/injection alias at the door (the local alias is validated on
          // load; this inbound one is attacker-controlled). Grammar AND length:
          // ALIAS_RE's `*` is unbounded, so without the cap a ~1 MiB alias (under
          // the wire line cap) would ride into the model's envelope + audit.
          if (!ALIAS_RE.test(msg.alias) || msg.alias.length > ALIAS_MAX) {
            transport.write(
              encodeMeshMessage(makeError(MESH_ERROR_CODES.handshakeFailed, 'invalid alias')),
            );
            closeConn();
            return;
          }
          peerAlias = msg.alias;
          transport.write(encodeMeshMessage(makeHello(alias)));
          break; // NOT handled — a message is expected next on this connection
        }
        case 'message': {
          if (peerAlias === null) {
            transport.write(
              encodeMeshMessage(
                makeError(MESH_ERROR_CODES.handshakeFailed, 'hello required before message'),
              ),
            );
            closeConn();
            return;
          }
          // §9 anti-DoS: reject an over-cap message with an explicit error and
          // BEFORE it drives a local turn. The sender's own mesh_send rejects
          // over-cap up front, but a foreign/hostile peer can write directly.
          if (Buffer.byteLength(msg.text, 'utf8') > deps.config.maxMessageBytes) {
            transport.write(
              encodeMeshMessage(
                makeError(
                  MESH_ERROR_CODES.messageTooLarge,
                  `message exceeds the ${deps.config.maxMessageBytes}-byte cap`,
                ),
              ),
            );
            closeConn();
            return;
          }
          // Tear the connection down FIRST (one message per connection, §4), then
          // hand off: closing before the REPL enqueue means a throw in messageCb
          // can't leak the fd (the reaper is already disarmed), and `handled`
          // blocks any pipelined follow-on line.
          const { id, text } = msg;
          const from = peerAlias;
          closeConn();
          emitAudit({ kind: 'message_received', id, peerAlias: from });
          messageCb?.({ id, peerAlias: from, text });
          break;
        }
        case 'bye':
          closeConn();
          break;
        default:
          break;
      }
    });
    transport.onClose(() => {
      clearHandshakeTimer();
      openConnections.delete(transport);
    });
  };

  const startServing = async (): Promise<void> => {
    if (serving) return;
    // Refuse if a LIVE peer already holds our alias (e.g. a second /relay on in the
    // same repo — the default alias is the repo basename). Unlinking its socket
    // below would make that peer unreachable to new mesh_send calls while it still
    // believes it is serving. listPeers liveness-checks AND sweeps a STALE
    // descriptor from a crashed run, so a leftover at our alias is cleared here; a
    // live hit is a real collision (we have not published our own descriptor yet,
    // so any hit is a different process).
    const collision = (await fsListPeers(deps.dir, {})).find((p) => p.alias === alias);
    if (collision !== undefined) {
      throw new Error(
        `mesh: alias '${alias}' is already served by a live peer (pid ${collision.pid}); set a distinct alias in [mesh]`,
      );
    }
    // Clear a now-confirmed-stale socket/descriptor (or an orphan socket with no
    // descriptor, which listPeers does not see), then ensure the runtime dir exists
    // before Bun.listen binds the socket.
    removeDescriptor(deps.dir, alias);
    ensureMeshDirs(deps.dir);
    server = listenMesh(socketPath(deps.dir, alias), onServerConnection);
    serving = true;
    try {
      publishDescriptor(deps.dir, descriptor());
    } catch (err) {
      // Roll back FULLY so a failed publish (ENOSPC / EROFS / EIO / EISDIR) leaves
      // neither an inbound channel open NOR an orphan socket behind after the
      // operator was told it failed. server.stop() closes the listener but leaves
      // the .sock file listenMesh created; removeDescriptor clears it (and any
      // partial .json) — the same cleanup stopServing does. Without it, since
      // serving is reset to false, a later shutdown() no-ops and the orphan lingers.
      server.stop();
      server = null;
      serving = false;
      removeDescriptor(deps.dir, alias);
      throw err;
    }
  };

  const stopServing = async (): Promise<void> => {
    if (!serving) return;
    serving = false;
    // Say bye in-band to any connection open right now (a message mid-delivery),
    // so a peer distinguishes relay-off from a crash (§6.5), then tear down.
    for (const t of openConnections) {
      t.write(encodeMeshMessage(makeBye()));
      t.close();
    }
    openConnections.clear();
    server?.stop();
    server = null;
    removeDescriptor(deps.dir, alias);
  };

  // ---- client side ----
  const send = async (targetAlias: string, text: string): Promise<{ id: string }> => {
    // §9 message cap: refuse an over-budget message at the boundary so the
    // operator/model sees "too large" up front, not a mid-flight peer rejection.
    if (Buffer.byteLength(text, 'utf8') > deps.config.maxMessageBytes) {
      throw new Error(`mesh: message exceeds the ${deps.config.maxMessageBytes}-byte cap`);
    }
    // Only exclude our OWN descriptor when WE are serving — that is the only time
    // it exists. A non-serving client has no self descriptor, so excluding by
    // alias would wrongly hide a DIFFERENT live peer that shares our derived alias
    // (same repo basename, or another session in this repo). F1's collision check
    // guarantees no other live peer holds our alias while we serve.
    const target = (await fsListPeers(deps.dir, serving ? { selfAlias: alias } : {})).find(
      (p) => p.alias === targetAlias,
    );
    if (target === undefined) {
      throw new Error(`mesh: no live peer '${targetAlias}'`);
    }
    // connectMesh rejects on a refused/gone socket (a stale descriptor, or a
    // /relay off race) — the message never left, so surface peer_lost to the
    // model (§6.5), never a silent hang.
    let transport: MeshTransport;
    try {
      transport = await connectMesh(target.socket);
    } catch {
      throw new Error(`mesh: peer '${targetAlias}' is unreachable — ${MESH_ERROR_CODES.peerLost}`);
    }
    const msg = makeMessage(text);
    // Read the receiver's synchronous verdict BEFORE reporting delivery. A valid
    // message → the receiver just closes (no ack); a REJECTED one → an `error`
    // frame before close. The common miss: the receiver caps messages SMALLER than
    // we do (our up-front check used OUR maxMessageBytes), so a size we accept trips
    // ITS ingress message_too_large. Fire-and-forget means not awaiting the peer's
    // REPLY (§6.4) — not ignoring a synchronous protocol rejection, which would
    // report a phantom delivery AND audit a message the peer dropped.
    const rejection = new Promise<{ code: string; message: string } | null>((resolve) => {
      let settled = false;
      let err: { code: string; message: string } | null = null;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(err);
      };
      // A conforming receiver errors/closes within a round-trip; the deadline only
      // fires for a non-conforming/hung peer → treat silence as accepted (the
      // fire-and-forget fallback), never a hang.
      const timer = setTimeout(done, SEND_ACK_DEADLINE_MS);
      timer.unref?.();
      transport.onLine((line) => {
        const res = parseMeshLine(line);
        if (res.ok && res.msg.type === 'error') {
          err = { code: res.msg.code, message: res.msg.message };
          done();
        }
        // A `hello` ack is just the handshake echo — ignore it.
      });
      transport.onClose(done); // closed with no error frame → the peer accepted it
    });
    const helloOk = transport.write(encodeMeshMessage(makeHello(alias)));
    const msgOk = transport.write(encodeMeshMessage(msg));
    if (!helloOk || !msgOk) {
      // The peer's socket was already closed/dead when we wrote: the message never
      // left. Surface peer_lost so the model gets an explicit failure now.
      transport.close();
      throw new Error(
        `mesh: peer '${targetAlias}' closed before the message was sent — ${MESH_ERROR_CODES.peerLost}`,
      );
    }
    const rejected = await rejection;
    // One message = one short connection (§4): close after the verdict (idempotent
    // if the peer already closed).
    transport.close();
    if (rejected !== null) {
      // The peer rejected it on the wire (message_too_large, version mismatch, …) —
      // surface it instead of a false "delivered", and DON'T audit a dropped send.
      throw new Error(
        `mesh: peer '${targetAlias}' rejected the message — ${rejected.code}: ${rejected.message}`,
      );
    }
    emitAudit({ kind: 'message_sent', id: msg.id, peerAlias: targetAlias, text });
    return { id: msg.id };
  };

  const setStatus = (s: PeerStatus): void => {
    status = s;
    republish();
  };

  const shutdown = async (): Promise<void> => {
    await stopServing(); // sends bye + closes open connections, removes descriptor
  };

  return {
    alias,
    maxMessageBytes: deps.config.maxMessageBytes,
    // Exclude our own descriptor only while serving (see send()) — else a live peer
    // sharing our derived alias would be hidden from discovery.
    listPeers: async () =>
      (await fsListPeers(deps.dir, serving ? { selfAlias: alias } : {})).map(toPeerInfo),
    send,
    startServing,
    stopServing,
    isServing: () => serving,
    onMessage: (cb) => {
      messageCb = cb;
    },
    setStatus,
    shutdown,
  };
};
