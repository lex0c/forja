// Mesh wire + subsystem types. The message envelope mirrors the IPC channel
// ({ type, id, ts, ...payload }) but the type set is the mesh's own — a peer
// speaks intent (hello/prompt/progress/result/error/bye), never IPC commands.
// See docs/spec/MESH.md §4.

export const MESH_PROTOCOL_VERSION = 1;

interface MeshCommonFields {
  // UUID v4 from the emitter; correlates a request/response pair.
  id: string;
  // Wall-clock from the emitter (epoch ms); forensic only.
  ts: number;
}

// High-level conversation state surfaced to the initiator. Deliberately coarse
// — never a raw tool output (privacy, §7).
export type MeshProgressState = 'accepted' | 'working' | 'waiting-operator' | 'done';

export type MeshMessage =
  | (MeshCommonFields & { type: 'hello'; alias: string; protocolVersion: number })
  | (MeshCommonFields & { type: 'prompt'; conversationId: string; text: string })
  | (MeshCommonFields & {
      type: 'progress';
      conversationId: string;
      state: MeshProgressState;
      note?: string;
    })
  | (MeshCommonFields & { type: 'result'; conversationId: string; text: string })
  | (MeshCommonFields & {
      type: 'error';
      conversationId?: string;
      code: string;
      message: string;
    })
  | (MeshCommonFields & { type: 'bye' });

export type MeshMessageType = MeshMessage['type'];

export const MESH_ERROR_CODES = {
  versionMismatch: 'mesh.version_mismatch',
  roundsExceeded: 'mesh.rounds_exceeded',
  peerBusy: 'mesh.peer_busy',
  messageTooLarge: 'mesh.message_too_large',
  noSuchPeer: 'mesh.no_such_peer',
  notServing: 'mesh.not_serving',
  handshakeFailed: 'mesh.handshake_failed',
  // Connection closed before the peer answered (crash / relay-off without bye).
  peerLost: 'mesh.peer_lost',
} as const;

// ---- Registry (discovery) ----

export type PeerStatus = 'idle' | 'working' | 'waiting-operator';

// Alias grammar — path-safe (no `/` or `..`, so it can't traverse out of the
// runtime dir when interpolated into a socket/descriptor path) and wire-safe (a
// lowercase word). Shared by the config loader (validates what we PUBLISH) and
// the registry (validates what we CONSUME from foreign descriptors).
export const ALIAS_RE = /^[a-z][a-z0-9_-]*$/;
export const ALIAS_MAX = 40;
export const PEER_STATUSES: ReadonlySet<PeerStatus> = new Set([
  'idle',
  'working',
  'waiting-operator',
]);

// Published to <runtime>/forja/mesh/peers/<alias>.json. `repoRoot` is for the
// local runtime/operator only — NEVER surfaced to the model (which sees alias
// + branch + status via mesh_peers, §2).
export interface PeerDescriptor {
  alias: string;
  repoRoot: string;
  branch: string;
  pid: number;
  socket: string;
  status: PeerStatus;
  startedAt: number;
}

// The model-facing projection (no absolute path).
export interface PeerInfo {
  alias: string;
  branch: string;
  status: PeerStatus;
}

export const toPeerInfo = (d: PeerDescriptor): PeerInfo => ({
  alias: d.alias,
  branch: d.branch,
  status: d.status,
});

// ---- Config ----

export interface MeshConfig {
  // null → derive from the repo-root basename at manager construction.
  alias: string | null;
  maxRounds: number;
  maxMessageBytes: number;
  maxConcurrentConversations: number;
}

export const DEFAULT_MESH_CONFIG: MeshConfig = {
  alias: null,
  maxRounds: 8,
  maxMessageBytes: 32 * 1024,
  maxConcurrentConversations: 4,
};

// Absolute ceilings the loader clamps to (a hostile/typo'd config can't lift
// the mesh past these).
export const ABSOLUTE_MESH_LIMITS = {
  maxRounds: 64,
  maxMessageBytes: 1 << 20, // 1 MiB — matches the wire line cap
  maxConcurrentConversations: 16,
} as const;
