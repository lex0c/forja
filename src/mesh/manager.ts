// Mesh manager — mirrors createMcpManager in shape (a subsystem handle held on
// HarnessConfig). Two roles: SERVER (listen + accept peer prompts when
// relayMode is on) and CLIENT (discover peers, send a prompt, receive the
// reply). The manager is byte/lifecycle plumbing + routing; the REPL wires the
// prompt/reply callbacks into the notification queue (Slice 4/6). Intent, not
// authority — a peer prompt becomes a local system-source turn, nothing more.
// See docs/spec/MESH.md §0, §6.

import { resolveAlias } from './config.ts';
import {
  encodeMeshMessage,
  makeBye,
  makeError,
  makeHello,
  makeProgress,
  makePrompt,
  makeResult,
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
  CONVERSATION_ID_RE,
  MESH_ERROR_CODES,
  MESH_PROTOCOL_VERSION,
  type MeshAuditEvent,
  type MeshConfig,
  type MeshProgressState,
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
  // Pre-conversation reap window (see HANDSHAKE_DEADLINE_MS); injectable for
  // tests so they don't wait the full 30 s.
  handshakeDeadlineMs?: number;
  // Optional boundary-audit sink (§8): the manager emits MeshAuditEvents at the
  // wire hub (prompt received / reply published / reply received); the sink,
  // wired in bootstrap with the DB, persists them to `mesh_events`. No-op when
  // absent (headless / tests).
  onAuditEvent?: (event: MeshAuditEvent) => void;
}

export interface InboundPrompt {
  conversationId: string;
  peerAlias: string;
  text: string;
}
export interface InboundReply {
  conversationId: string;
  peerAlias: string;
  text: string;
  // True ONLY for a failure we generate LOCALLY — the connection closed before the
  // peer answered (peer_lost). The REPL frames a failed reply as a trusted-system
  // notice, so peer-SUPPLIED text must NEVER set this: a real result, a neutral
  // "ended without a reply", AND a `type:"error"` frame's message/code are all peer
  // content and go through the untrusted peer envelope instead.
  failed: boolean;
}

export interface MeshManager {
  readonly alias: string;
  // The §8 per-serving-session round bound — the real anti-committee limit
  // behind the wake-cap exemption (the REPL drain reads it to cap consecutive
  // peer turns without operator input).
  readonly maxRounds: number;
  // The §8 per-message byte cap — the mesh_send tool reads it to reject an
  // over-cap message up front with a distinct error (not a generic no-peer).
  readonly maxMessageBytes: number;
  // Discovery (client side, always available).
  listPeers(): PeerInfo[];
  // Send a prompt to a peer, opening a conversation. Resolves when the prompt
  // is written to the transport — NOT when the peer answers (the reply arrives
  // asynchronously via onReply, isomorphic to bash_background).
  send(alias: string, text: string): Promise<{ conversationId: string }>;
  // Server side (relayMode on/off).
  startServing(): Promise<void>;
  stopServing(): Promise<void>;
  isServing(): boolean;
  // Snapshot of in-flight INBOUND conversations (a peer prompted us) — for the
  // operator's /relay status: who is talking to us right now.
  inboundSummary(): { conversationId: string; peerAlias: string }[];
  // REPL wiring: a peer prompted us / a peer answered our send.
  onPrompt(cb: (p: InboundPrompt) => void): void;
  onReply(cb: (r: InboundReply) => void): void;
  // True while an inbound conversation is still open (accepted, connection up, not
  // yet answered). The REPL checks this before running a QUEUED peer turn: a peer
  // that disconnected between enqueue and run must be dropped, not answered into a
  // dead socket after burning a model turn on it.
  isConversationOpen(conversationId: string): boolean;
  // Server → answer / progress on an inbound conversation. Returns false if the
  // conversation is unknown/already closed (mesh_reply surfaces that to the model).
  sendResult(conversationId: string, text: string): boolean;
  sendProgress(conversationId: string, state: MeshProgressState, note?: string): void;
  // Published status (idle / working / waiting-operator).
  setStatus(status: PeerStatus): void;
  shutdown(): Promise<void>;
}

interface Conversation {
  transport: MeshTransport;
  peerAlias: string;
}

// Clamp text to a UTF-8 byte budget on a char boundary, marking the cut so the
// truncation is never silent (§8 message cap; no-silent-caps). Returns the
// input untouched when it already fits.
const clampUtf8 = (text: string, maxBytes: number): string => {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const marker = '\n[…truncated: over the mesh message cap]';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  // Degenerate cap (smaller than the marker itself — a misconfigured
  // maxMessageBytes): hard-truncate to the byte budget with no marker, so the
  // result still can't exceed the cap. Strip a trailing replacement char left by
  // cutting mid-codepoint.
  if (maxBytes <= markerBytes) {
    return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/�+$/, '');
  }
  let s = Buffer.from(text, 'utf8')
    .subarray(0, maxBytes - markerBytes)
    .toString('utf8');
  // A partial trailing char decodes to U+FFFD — drop it so the seam is clean.
  if (s.endsWith('�')) s = s.slice(0, -1);
  return s + marker;
};

// A connection that opens but never drives a conversation (never sends a valid
// prompt) pins an fd + a partial-line framer buffer indefinitely — there is no
// OS liveness signal across independent processes. Bound the pre-conversation
// window generously: a real client sends hello+prompt within milliseconds, so
// 30 s only ever reaps a stalled/half-open connection, never a legitimate one.
const HANDSHAKE_DEADLINE_MS = 30_000;

export const createMeshManager = (deps: MeshManagerDeps): MeshManager => {
  const pid = deps.pid ?? process.pid;
  const alias = resolveAlias(deps.config, deps.repoRoot);
  const startedAt = Date.now();
  let status: PeerStatus = 'idle';
  let serving = false;
  let server: MeshServer | null = null;

  // Inbound (a peer prompted us): conversationId → transport for the reply.
  const inbound = new Map<string, Conversation>();
  // Client transports we opened, kept alive to receive the reply.
  const clientTransports = new Set<MeshTransport>();

  let promptCb: ((p: InboundPrompt) => void) | null = null;
  let replyCb: ((r: InboundReply) => void) | null = null;

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
  const onServerConnection = (transport: MeshTransport): void => {
    // null until a valid hello arrives — a prompt before hello is rejected so it
    // can't bypass version negotiation (§4).
    let peerAlias: string | null = null;
    // Reap a connection that stalls before driving any conversation (see
    // HANDSHAKE_DEADLINE_MS). Cleared once the first prompt is accepted (a real
    // peer) and on close; unref'd so it never keeps the process alive.
    let handshakeTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      handshakeTimer = null;
      transport.close();
    }, deps.handshakeDeadlineMs ?? HANDSHAKE_DEADLINE_MS);
    handshakeTimer.unref?.();
    const clearHandshakeTimer = (): void => {
      if (handshakeTimer !== null) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
    };
    transport.onLine((line) => {
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
            transport.close();
            return;
          }
          // Revalidate the peer's declared alias against the grammar — it feeds
          // the operator's scrollback header, so reject a control/injection alias
          // at the door (the local alias is validated on load; this inbound one
          // is attacker-controlled).
          if (!ALIAS_RE.test(msg.alias) || msg.alias.length > ALIAS_MAX) {
            // Grammar AND length — ALIAS_RE's `*` is unbounded; without the cap a
            // ~1 MiB alias (under the wire line cap) would ride into the model's
            // envelope + scrollback + audit. The config loader and the registry
            // both pair the grammar with ALIAS_MAX; the wire ingress must too.
            transport.write(
              encodeMeshMessage(makeError(MESH_ERROR_CODES.handshakeFailed, 'invalid alias')),
            );
            transport.close();
            return;
          }
          peerAlias = msg.alias;
          transport.write(encodeMeshMessage(makeHello(alias)));
          break;
        }
        case 'prompt': {
          if (peerAlias === null) {
            transport.write(
              encodeMeshMessage(
                makeError(MESH_ERROR_CODES.handshakeFailed, 'hello required before prompt'),
              ),
            );
            transport.close();
            return;
          }
          // The conversationId is surfaced to the model as the reply handle (§6.2),
          // embedded in the untrusted preamble OUTSIDE the nonce fence — reject a
          // non-conforming (control/injection) id at the door. Don't echo the bad
          // id back (it's the thing we're refusing to trust).
          if (!CONVERSATION_ID_RE.test(msg.conversationId)) {
            transport.write(
              encodeMeshMessage(
                makeError(MESH_ERROR_CODES.invalidConversation, 'invalid conversationId'),
              ),
            );
            transport.close();
            return;
          }
          if (inbound.has(msg.conversationId)) {
            // A conversationId already in flight — accepting it would overwrite the
            // live conversation's reply transport (the first answer would go
            // nowhere) AND drive a second local turn + double audit for one id.
            // The initiator mints a unique id per send; a collision is malformed.
            transport.write(
              encodeMeshMessage(
                makeError(
                  MESH_ERROR_CODES.invalidConversation,
                  'conversationId already in flight',
                  msg.conversationId,
                ),
              ),
            );
            transport.close();
            return;
          }
          // §8 anti-DoS: reject an over-cap prompt or a saturated server with an
          // explicit error the initiator materializes — never an unbounded queue
          // or a silent drop, and BEFORE it drives a local turn.
          if (Buffer.byteLength(msg.text, 'utf8') > deps.config.maxMessageBytes) {
            transport.write(
              encodeMeshMessage(
                makeError(
                  MESH_ERROR_CODES.messageTooLarge,
                  `prompt exceeds the ${deps.config.maxMessageBytes}-byte cap`,
                  msg.conversationId,
                ),
              ),
            );
            transport.close();
            return;
          }
          if (inbound.size >= deps.config.maxConcurrentConversations) {
            transport.write(
              encodeMeshMessage(
                makeError(
                  MESH_ERROR_CODES.peerBusy,
                  'peer is at its concurrent-conversation limit',
                  msg.conversationId,
                ),
              ),
            );
            transport.close();
            return;
          }
          inbound.set(msg.conversationId, { transport, peerAlias });
          clearHandshakeTimer(); // a real conversation is in flight — connection is legit
          transport.write(encodeMeshMessage(makeProgress(msg.conversationId, 'accepted')));
          emitAudit({
            kind: 'peer_prompt_received',
            conversationId: msg.conversationId,
            peerAlias,
          });
          promptCb?.({ conversationId: msg.conversationId, peerAlias, text: msg.text });
          break;
        }
        case 'bye':
          transport.close();
          break;
        default:
          break;
      }
    });
    transport.onClose(() => {
      clearHandshakeTimer();
      for (const [cid, c] of inbound) if (c.transport === transport) inbound.delete(cid);
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
    const collision = fsListPeers(deps.dir, {}).find((p) => p.alias === alias);
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
    // Say bye in-band to open inbound conversations before tearing the socket
    // down, so a peer distinguishes relay-off from a crash (§6.5).
    for (const c of inbound.values()) {
      c.transport.write(encodeMeshMessage(makeBye()));
      c.transport.close();
    }
    inbound.clear();
    server?.stop();
    server = null;
    removeDescriptor(deps.dir, alias);
  };

  // ---- client side ----
  const send = async (targetAlias: string, text: string): Promise<{ conversationId: string }> => {
    // §8 message cap: refuse an over-budget prompt at the boundary so the
    // operator sees "too large" up front, not a mid-conversation peer rejection.
    if (Buffer.byteLength(text, 'utf8') > deps.config.maxMessageBytes) {
      throw new Error(`mesh: message exceeds the ${deps.config.maxMessageBytes}-byte cap`);
    }
    // Only exclude our OWN descriptor when WE are serving — that is the only time
    // it exists. A non-serving client (mesh_send always runs non-serving) has no
    // self descriptor, so excluding by alias would wrongly hide a DIFFERENT live
    // peer that shares our derived alias (same repo basename, or another session in
    // this repo). F1's collision check guarantees no other live peer holds our
    // alias while we serve, so the alias-exclusion is exact there.
    const target = fsListPeers(deps.dir, serving ? { selfAlias: alias } : {}).find(
      (p) => p.alias === targetAlias,
    );
    if (target === undefined) {
      throw new Error(`mesh: no live peer '${targetAlias}'`);
    }
    const transport = await connectMesh(target.socket);
    clientTransports.add(transport);
    const conversationId = crypto.randomUUID();
    // Settle exactly once — the first of {result, error, connection-close} wins.
    // Guarantees the initiator is always woken (§0.6: connection loss is an
    // explicit error, never a silently hung conversation) and closes the
    // transport once we have the answer (no per-conversation socket leak, §6.5).
    let settled = false;
    const settle = (replyText: string, failed: boolean): void => {
      if (settled) return;
      settled = true;
      clientTransports.delete(transport);
      try {
        replyCb?.({ conversationId, peerAlias: targetAlias, text: replyText, failed });
      } finally {
        // Always reclaim the socket — if the reply sink throws, skipping close()
        // would strand the fd + leave the transport in clientTransports forever.
        transport.close();
      }
    };
    transport.onLine((line) => {
      const res = parseMeshLine(line);
      if (!res.ok) return;
      const msg = res.msg;
      if (msg.type === 'result' && msg.conversationId === conversationId) {
        emitAudit({ kind: 'reply_received', conversationId, peerAlias: targetAlias });
        settle(msg.text, false); // a real result — the peer's published content
      } else if (msg.type === 'error') {
        // An error frame is still PEER-CONTROLLED content (a malicious peer can put
        // arbitrary text in `message`/`code`) — NOT a locally-generated failure.
        // Mark it unfailed so the REPL frames it as untrusted peer DATA, never as a
        // trusted [mesh system notice]. Only the connection-close path below (text
        // WE generate) earns the trusted framing.
        settle(`[mesh error ${msg.code}] ${msg.message}`, false);
      }
      // Inbound 'progress' (accepted/working/waiting-operator) is not surfaced to
      // the initiator's MODEL yet — only the final 'result' drives a peer_reply
      // (§6.3). The peer's coarse status is visible to the operator via mesh_peers
      // (setStatus on the receiver, §7). Per-conversation progress → model is a
      // deliberate follow-up: it needs a noise policy (not every state a wake).
    });
    transport.onClose(() => {
      settle(
        `[mesh error ${MESH_ERROR_CODES.peerLost}] peer '${targetAlias}' closed before answering`,
        true, // connection lost — a transport failure, not the peer's answer
      );
    });
    const helloOk = transport.write(encodeMeshMessage(makeHello(alias)));
    const promptOk = transport.write(encodeMeshMessage(makePrompt(conversationId, text)));
    if (!helloOk || !promptOk) {
      // The peer's socket was already closed/dead when we wrote (a stale descriptor,
      // or a /relay off race that closed it before our first byte): the prompt never
      // left, and onClose is NOT guaranteed to fire — the close can race ahead of our
      // handler registration, marking the transport closed without ever invoking our
      // callback. Settle explicitly (peer_lost) so the initiator gets the promised
      // reply instead of hanging on a prompt reported as delivered. settle() closes +
      // removes the transport; it is idempotent, so a later onClose is a no-op.
      settle(
        `[mesh error ${MESH_ERROR_CODES.peerLost}] peer '${targetAlias}' closed before the request was sent`,
        true,
      );
    }
    return { conversationId };
  };

  const sendResult = (conversationId: string, text: string): boolean => {
    const c = inbound.get(conversationId);
    if (c === undefined) return false;
    // Clamp ONCE. The §8 cap keeps the receiver from pushing an unbounded result
    // (the two-audiences filter §7 already stripped tool output; this bounds
    // size). Audit exactly what LEAVES on the wire — hashing the raw pre-clamp
    // text would record bytes different from what the peer actually receives.
    const clamped = clampUtf8(text, deps.config.maxMessageBytes);
    c.transport.write(encodeMeshMessage(makeProgress(conversationId, 'done')));
    const delivered = c.transport.write(encodeMeshMessage(makeResult(conversationId, clamped)));
    if (!delivered) {
      // The socket was already closed / the write errored synchronously: don't
      // claim success or emit a reply_published for a result that never left.
      // (A buffered write the peer never reads is a residual we can't observe —
      // there is no application ACK; the initiator learns via its own peer_lost.)
      c.transport.close();
      inbound.delete(conversationId);
      return false;
    }
    emitAudit({
      kind: 'reply_published',
      conversationId,
      peerAlias: c.peerAlias,
      output: clamped,
    });
    // result is the conversation's last message (§4) — graceful close flushes
    // the buffered result before FIN, then reap the entry (no inbound leak).
    c.transport.close();
    inbound.delete(conversationId);
    return true;
  };

  const sendProgress = (conversationId: string, state: MeshProgressState, note?: string): void => {
    inbound
      .get(conversationId)
      ?.transport.write(encodeMeshMessage(makeProgress(conversationId, state, note)));
  };

  const setStatus = (s: PeerStatus): void => {
    status = s;
    republish();
  };

  const shutdown = async (): Promise<void> => {
    await stopServing(); // sends bye + closes inbound conversations
    for (const t of clientTransports) {
      t.write(encodeMeshMessage(makeBye()));
      t.close();
    }
    clientTransports.clear();
    inbound.clear();
  };

  return {
    alias,
    maxRounds: deps.config.maxRounds,
    maxMessageBytes: deps.config.maxMessageBytes,
    inboundSummary: () =>
      Array.from(inbound.entries()).map(([conversationId, c]) => ({
        conversationId,
        peerAlias: c.peerAlias,
      })),
    // Exclude our own descriptor only while serving (see send()) — else a live peer
    // sharing our derived alias would be hidden from discovery.
    listPeers: () => fsListPeers(deps.dir, serving ? { selfAlias: alias } : {}).map(toPeerInfo),
    send,
    startServing,
    stopServing,
    isServing: () => serving,
    onPrompt: (cb) => {
      promptCb = cb;
    },
    onReply: (cb) => {
      replyCb = cb;
    },
    isConversationOpen: (cid) => inbound.has(cid),
    sendResult,
    sendProgress,
    setStatus,
    shutdown,
  };
};
