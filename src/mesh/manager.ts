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
  acquireAliasLock,
  ensureMeshDirs,
  listPeers as fsListPeers,
  publishDescriptor,
  releaseAliasLock,
  removeDescriptor,
  removeSocket,
  socketPath,
} from './registry.ts';
import {
  connectMesh,
  listenMesh,
  type MeshServer,
  type MeshTransport,
  probeSocket,
} from './transport.ts';
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
  // REPL wiring: a message WE sent to a peer landed (a successful send, after the
  // receiver's verdict). Fires with the target alias — the REPL clears the "owed a
  // reply" state with it (the reply-nudge safety net, §6.4). Fires for BOTH a
  // peer-turn reply and the operator's own outbound send: the peer got an answer
  // either way, so the owed-reply signal should clear.
  onMessageSent(cb: (peerAlias: string) => void): void;
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
  let messageSentCb: ((alias: string) => void) | null = null;

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
      // window and exhaust the process. Send an explicit rejection frame BEFORE
      // closing — a bare close reads as acceptance on the sender (send() treats a
      // clean close with no error frame as delivered), so without it an admission
      // drop would report a phantom delivery and audit a message we never enqueued.
      // Don't add, don't parse — just error + close.
      transport.write(
        encodeMeshMessage(
          makeError(MESH_ERROR_CODES.atCapacity, `at the ${maxInbound}-connection ceiling`),
        ),
      );
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

  // Claim the alias by binding its socket, PROBING for a live listener FIRST. The
  // probe-first refuses before any bind/unlink can clobber the path, so it protects a
  // peer that bound our alias but hasn't published its descriptor yet (the concurrent
  // /relay on path the descriptor collision check misses) REGARDLESS of whether the
  // platform's Bun.listen throws EADDRINUSE on an occupied path or silently replaces
  // the socket — the bind never runs against a live peer. On a throws-on-occupied
  // platform the bind is ALSO the atomic claim (the loser gets EADDRINUSE → re-probe →
  // collision); a path is cleared only after a fresh probe proves it a DEAD leftover,
  // never orphaning a live peer. Residual: two claimants that BOTH probe-dead before
  // either binds still race on a platform whose bind is non-exclusive — closing that
  // needs a separate lock (e.g. an O_EXCL lockfile), out of scope here.
  const bindAlias = async (sockPath: string): Promise<MeshServer> => {
    // Probe-first (§2): a live listener already answers on the path → refuse WITHOUT
    // touching it. This is the sole guard that does not depend on the bind throwing.
    if (await probeSocket(sockPath)) {
      throw new Error(
        `mesh: alias '${alias}' is already served by a live peer; set a distinct alias in [mesh]`,
      );
    }
    const tryListen = (): MeshServer | null => {
      try {
        return listenMesh(sockPath, onServerConnection);
      } catch (err) {
        // A leftover file at the path (a dead socket OR a planted regular file) and a
        // LIVE listener that raced in since the probe BOTH surface as EADDRINUSE — a
        // re-probe distinguishes them. Anything else (EACCES, a missing dir): rethrow.
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') return null;
        throw err;
      }
    };
    const first = tryListen();
    if (first !== null) return first;
    // Occupied, but the probe above found no live listener → a dead leftover (crashed
    // relay's orphan .sock, which listPeers never sweeps as it has no .json), OR a peer
    // that bound in the tiny gap since the probe. Re-probe: live → collision, dead →
    // clear it and retry the bind ONCE.
    if (await probeSocket(sockPath)) {
      throw new Error(
        `mesh: alias '${alias}' was just claimed by a live peer; set a distinct alias in [mesh]`,
      );
    }
    removeSocket(deps.dir, alias);
    const second = tryListen();
    if (second === null) {
      // Occupied AGAIN after clearing a dead leftover: a peer bound it in the gap.
      // Don't loop or clobber it — report the collision honestly (the loser refuses).
      throw new Error(
        `mesh: alias '${alias}' was just claimed by a live peer; set a distinct alias in [mesh]`,
      );
    }
    return second;
  };

  const startServing = async (): Promise<void> => {
    if (serving) return;
    const sockPath = socketPath(deps.dir, alias);
    // Serialize the claim with an atomic O_EXCL lock BEFORE any check or bind: of N
    // managers racing `/relay on` on one alias, exactly one creates the lock and the rest
    // refuse — so two can't both bind + publish even where the socket bind isn't a
    // reliable cross-platform serializer (§2). A stale lock from a crashed relay is stolen
    // inside acquire. Held for the serving lifetime; released here on any failure and by
    // stopServing.
    if (!acquireAliasLock(deps.dir, alias, pid)) {
      throw new Error(
        `mesh: alias '${alias}' is already served by a live peer; set a distinct alias in [mesh]`,
      );
    }
    try {
      // Refuse if a LIVE peer already ADVERTISES our alias (a published descriptor —
      // e.g. an older relay whose lock predates this feature, or a live one whose lock we
      // couldn't observe). listPeers liveness-checks AND sweeps a STALE descriptor from a
      // crashed run, so a leftover .json is cleared here; the lock above already serialized
      // a concurrent unpublished racer.
      const collision = (await fsListPeers(deps.dir, {})).find((p) => p.alias === alias);
      if (collision !== undefined) {
        throw new Error(
          `mesh: alias '${alias}' is already served by a live peer (pid ${collision.pid}); set a distinct alias in [mesh]`,
        );
      }
      // Ensure the runtime dir exists before Bun.listen binds, then bind (bindAlias still
      // clears a stale orphan .sock left by a crashed relay whose lock we stole).
      ensureMeshDirs(deps.dir);
      server = await bindAlias(sockPath);
      serving = true;
      publishDescriptor(deps.dir, descriptor());
    } catch (err) {
      // Always drop the lock — we're not serving. Then tear down ONLY what WE created:
      //   - server !== null → we bound before failing (a failed publish) → close the
      //     listener and clear OUR socket + partial descriptor (else, since serving
      //     resets to false, a later shutdown() no-ops and the orphan lingers).
      //   - server === null → we REFUSED before binding (live collision, or bindAlias
      //     found a live peer): the socket/descriptor at the path belong to that peer —
      //     removeDescriptor would clobber a live peer's socket, so touch NOTHING.
      releaseAliasLock(deps.dir, alias);
      if (server !== null) {
        server.stop();
        server = null;
        serving = false;
        removeDescriptor(deps.dir, alias);
      }
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
    releaseAliasLock(deps.dir, alias); // drop the claim so the alias is free to re-serve
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
      // The receiver's hello ack — proof it is a LIVE, conforming peer that read our
      // hello (and, absent an error frame, will read the message). Delivery is inferred
      // from a COMPLETED handshake + a clean close; a close/timeout BEFORE the ack means
      // a stale/hostile listener that accepted the socket then dropped, or a crash
      // mid-handshake — it never enqueued our message.
      let handshaken = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // A clean close / silence counts as delivery ONLY once the handshake completed.
        // Before the ack (accept-then-drop, or a hung listener) the message never
        // landed → peer_lost, not a phantom "delivered" + audit of a dropped send.
        if (err === null && !handshaken) {
          err = {
            code: MESH_ERROR_CODES.peerLost,
            message: 'the peer closed before completing the handshake',
          };
        }
        resolve(err);
      };
      // A conforming receiver acks the hello within a round-trip; the deadline only
      // fires for a non-conforming/hung peer — no ack by then is peer_lost (above); an
      // ack followed by a slow close is accepted (fire-and-forget fallback), never a hang.
      const timer = setTimeout(done, SEND_ACK_DEADLINE_MS);
      timer.unref?.();
      transport.onLine((line) => {
        const res = parseMeshLine(line);
        if (!res.ok) return;
        if (res.msg.type === 'error') {
          err = { code: res.msg.code, message: res.msg.message };
          done();
        } else if (res.msg.type === 'bye') {
          // The peer said bye (relay-off, §6.5) after accepting our connection but
          // BEFORE enqueuing our message — it is going away and dropped the message.
          // Read it as peer_lost (relay-off is a listed peer_lost cause) so the send
          // FAILS; otherwise the close that FOLLOWS the bye resolves via onClose as
          // acceptance — a phantom delivery + audit of a message the peer never took.
          err = {
            code: MESH_ERROR_CODES.peerLost,
            message: 'the peer stopped serving (bye) before the message was enqueued',
          };
          done();
        } else if (res.msg.type === 'hello') {
          // The receiver's hello ack: the handshake completed. A clean close after this
          // (no error frame) is now a real delivery, not a pre-handshake drop.
          handshaken = true;
        }
      });
      transport.onClose(done); // clean close AFTER the handshake → the peer accepted it
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
    // The send landed → tell the REPL so it can clear the owed-reply signal for this
    // peer (best-effort, like the audit; a throwing observer must not fail the send).
    try {
      messageSentCb?.(targetAlias);
    } catch {
      // observer must not break the wire operation
    }
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
    onMessageSent: (cb) => {
      messageSentCb = cb;
    },
    setStatus,
    shutdown,
  };
};
