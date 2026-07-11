// Mesh wire + subsystem types. The message envelope mirrors the IPC channel
// ({ type, id, ts, ...payload }) but the type set is the mesh's own — a peer
// speaks intent (hello/message/error/bye), never IPC commands. A `message` is
// one textual peer message (request, reply, or follow-up — the type does not
// distinguish); there is no conversation lifecycle (§4, §6.4).
// See docs/spec/MESH.md §4.

export const MESH_PROTOCOL_VERSION = 1;

interface MeshCommonFields {
  // UUID v4 from the emitter; the message's own id, used only for audit/dedup
  // (§4 — messages are not paired, so it is not a correlation handle).
  id: string;
  // Wall-clock from the emitter (epoch ms); forensic only.
  ts: number;
}

export type MeshMessage =
  | (MeshCommonFields & { type: 'hello'; alias: string; protocolVersion: number })
  | (MeshCommonFields & { type: 'message'; text: string })
  | (MeshCommonFields & { type: 'error'; code: string; message: string })
  | (MeshCommonFields & { type: 'bye' });

export type MeshMessageType = MeshMessage['type'];

// Boundary audit events the manager emits at the wire hub (§8). The manager is
// byte/lifecycle plumbing — it emits these SEMANTIC events via a `onAuditEvent`
// callback; the sink (wired in bootstrap with the DB) persists them to the
// `mesh_events` table. Correlation across two Forjas is by `peerAlias` + the
// message `id`; no session_id (the manager doesn't own one, and the local
// session is recoverable via the message log).
export type MeshAuditEvent =
  // A message went out on the wire (a mesh_send). The sink stores only hash(text)
  // + byte length — the full text lives in the mesh_send tool args / message log.
  | { kind: 'message_sent'; id: string; peerAlias: string; text: string }
  | { kind: 'message_received'; id: string; peerAlias: string };

export const MESH_ERROR_CODES = {
  versionMismatch: 'mesh.version_mismatch',
  messageTooLarge: 'mesh.message_too_large',
  handshakeFailed: 'mesh.handshake_failed',
  // Connection closed / refused before the message could be delivered (crash,
  // relay-off, or a stale descriptor) — surfaced to the sender's model (§6.5).
  peerLost: 'mesh.peer_lost',
  // The peer is serving but momentarily at its inbound-connection ceiling
  // (admission control, §9): it dropped the connection before the message was
  // enqueued. Sent as an explicit frame so the sender doesn't read the bare close
  // as acceptance (a phantom delivery). Transient + retryable, and DISTINCT from
  // peerLost — the peer is alive, so the sender waits and retries rather than
  // re-running discovery for a peer it thinks is gone.
  atCapacity: 'mesh.at_capacity',
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
  maxMessageBytes: number;
}

export const DEFAULT_MESH_CONFIG: MeshConfig = {
  alias: null,
  maxMessageBytes: 32 * 1024,
};

// Absolute ceilings the loader clamps to (a hostile/typo'd config can't lift
// the mesh past these).
export const ABSOLUTE_MESH_LIMITS = {
  // 128 KiB. maxMessageBytes bounds the RAW text; on the wire the text is a
  // JSON-string-escaped field of an NDJSON message (makeMessage), and a control
  // byte escapes to `\uXXXX` — a 6× WORST-case expansion (256 KiB of NULs → ~1.5
  // MiB). The receiving framer (ndjson DEFAULT_LINE_CAP, 1 MiB) DROPS any line
  // past its cap → a silently lost message, even though both sides accepted the
  // raw size. So the ceiling must stay below cap/6: 128 KiB × 6 = 768 KiB fits
  // even an all-control message, with room for the JSON wrapper. (The prior
  // 256 KiB left only ~4× and could overflow on escape-heavy content.)
  maxMessageBytes: 128 * 1024,
} as const;
