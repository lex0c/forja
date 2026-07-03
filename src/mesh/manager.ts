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
  MESH_ERROR_CODES,
  MESH_PROTOCOL_VERSION,
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
}

export interface MeshManager {
  readonly alias: string;
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
  // REPL wiring: a peer prompted us / a peer answered our send.
  onPrompt(cb: (p: InboundPrompt) => void): void;
  onReply(cb: (r: InboundReply) => void): void;
  // Server → answer / progress on an inbound conversation.
  sendResult(conversationId: string, text: string): void;
  sendProgress(conversationId: string, state: MeshProgressState, note?: string): void;
  // Published status (idle / working / waiting-operator).
  setStatus(status: PeerStatus): void;
  shutdown(): Promise<void>;
}

interface Conversation {
  transport: MeshTransport;
  peerAlias: string;
}

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

  // ---- server side ----
  const onServerConnection = (transport: MeshTransport): void => {
    // null until a valid hello arrives — a prompt before hello is rejected so it
    // can't bypass version negotiation (§4).
    let peerAlias: string | null = null;
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
          inbound.set(msg.conversationId, { transport, peerAlias });
          transport.write(encodeMeshMessage(makeProgress(msg.conversationId, 'accepted')));
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
      for (const [cid, c] of inbound) if (c.transport === transport) inbound.delete(cid);
    });
  };

  const startServing = async (): Promise<void> => {
    if (serving) return;
    // Clear a stale socket/descriptor from a previous crashed run at our alias,
    // then ensure the runtime dir exists before Bun.listen binds the socket.
    removeDescriptor(deps.dir, alias);
    ensureMeshDirs(deps.dir);
    server = listenMesh(socketPath(deps.dir, alias), onServerConnection);
    serving = true;
    try {
      publishDescriptor(deps.dir, descriptor());
    } catch (err) {
      // Roll back the socket so a failed publish (ENOSPC / EROFS / EIO) never
      // leaves an inbound channel open after the operator was told it failed.
      server.stop();
      server = null;
      serving = false;
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
    const target = fsListPeers(deps.dir, { selfAlias: alias }).find((p) => p.alias === targetAlias);
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
    const settle = (replyText: string): void => {
      if (settled) return;
      settled = true;
      clientTransports.delete(transport);
      replyCb?.({ conversationId, peerAlias: targetAlias, text: replyText });
      transport.close();
    };
    transport.onLine((line) => {
      const res = parseMeshLine(line);
      if (!res.ok) return;
      const msg = res.msg;
      if (msg.type === 'result' && msg.conversationId === conversationId) {
        settle(msg.text);
      } else if (msg.type === 'error') {
        settle(`[mesh error ${msg.code}] ${msg.message}`);
      }
      // 'progress' is ignored in Slice 1; surfaced to the model in Slice 6.
    });
    transport.onClose(() => {
      settle(
        `[mesh error ${MESH_ERROR_CODES.peerLost}] peer '${targetAlias}' closed before answering`,
      );
    });
    transport.write(encodeMeshMessage(makeHello(alias)));
    transport.write(encodeMeshMessage(makePrompt(conversationId, text)));
    return { conversationId };
  };

  const sendResult = (conversationId: string, text: string): void => {
    const c = inbound.get(conversationId);
    if (c === undefined) return;
    c.transport.write(encodeMeshMessage(makeProgress(conversationId, 'done')));
    c.transport.write(encodeMeshMessage(makeResult(conversationId, text)));
    // result is the conversation's last message (§4) — graceful close flushes
    // the buffered result before FIN, then reap the entry (no inbound leak).
    c.transport.close();
    inbound.delete(conversationId);
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
    listPeers: () => fsListPeers(deps.dir, { selfAlias: alias }).map(toPeerInfo),
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
    sendResult,
    sendProgress,
    setStatus,
    shutdown,
  };
};
