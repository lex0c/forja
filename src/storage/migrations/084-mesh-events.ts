// mesh_events — Forja Mesh boundary audit (MESH.md §8). The manager emits three
// events at the wire hub — a peer prompt was received, a reply was published, a
// reply was received — and this table records them so the A↔B interaction is
// reconstructable by correlating `conversation_id` across the two Forjas' DBs.
//
// Distinct from `approvals_log` (migration 034, the hash-chained permission
// ledger): the tamper-critical DECISIONS a peer prompt drives (edit/bash/
// mesh_reply confirm-or-auto) are already chained there, and the turn content is
// in `messages`. This table is an operational CORRELATION log, so — like
// `purge_events` / `memory_events` — it is NOT hash-chained: mesh events are not
// policy decisions with replay semantics, and a per-write read-modify-write chain
// would be disproportionate to what it records.
//
// No session_id column: the manager (byte plumbing) has no session, and the
// local session that handled a conversation is recoverable via the message log
// (since v2, the peer prompt's untrusted envelope carries the conversationId).
//
// `payload_json` carries event-specific context — for `reply_published`, the
// SHA-256 hash + byte length of the published output (never the raw output; that
// lives in the mesh_reply tool args). `kind` is CHECK-constrained; a new event
// kind is an ALTER against this migration's successor (the approvals_log/
// failure_events defensive pattern).

export const migration084MeshEvents = {
  id: 84,
  name: '084-mesh-events',
  sql: `
    CREATE TABLE mesh_events (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL
                        CHECK (kind IN (
                          'peer_prompt_received','reply_published','reply_received'
                        )),
      conversation_id TEXT NOT NULL,
      peer_alias      TEXT NOT NULL,
      payload_json    TEXT,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX idx_mesh_events_conversation ON mesh_events(conversation_id, created_at DESC);
    CREATE INDEX idx_mesh_events_created      ON mesh_events(created_at DESC);
  `,
} as const;
