// mesh_events → the message-bus model (MESH.md §4/§8). Migration 084 minted the
// PAIRED-model shape — kinds `peer_prompt_received`/`reply_published`/
// `reply_received` correlated by a `conversation_id` column. The message bus has
// no conversation lifecycle: the only boundary events are `message_sent` and
// `message_received`, and the cross-Forja correlation handle is the message `id`
// (§4). 084 is immutable, so the CHECK + column change lands HERE, in a successor
// (084's own header flags this ALTER pattern).
//
// SQLite can't alter a CHECK constraint in place, so recreate the table and copy
// forward. Any dev-era rows are mapped by kind (reply_published → message_sent;
// peer_prompt_received / reply_received → message_received) and keep their
// payload_json — the read is defensive about payload shape across the boundary.
// Still non-chained (an operational correlation log, not a decision ledger).

export const migration085MeshEventsMessageBus = {
  id: 85,
  name: '085-mesh-events-message-bus',
  sql: `
    CREATE TABLE mesh_events_v2 (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL
                     CHECK (kind IN ('message_sent','message_received')),
      message_id   TEXT NOT NULL,
      peer_alias   TEXT NOT NULL,
      payload_json TEXT,
      created_at   INTEGER NOT NULL
    );

    INSERT INTO mesh_events_v2 (id, kind, message_id, peer_alias, payload_json, created_at)
    SELECT id,
           CASE kind
             WHEN 'reply_published'      THEN 'message_sent'
             WHEN 'peer_prompt_received' THEN 'message_received'
             WHEN 'reply_received'       THEN 'message_received'
             ELSE kind
           END,
           conversation_id, peer_alias, payload_json, created_at
    FROM mesh_events;

    DROP TABLE mesh_events;
    ALTER TABLE mesh_events_v2 RENAME TO mesh_events;

    CREATE INDEX idx_mesh_events_message ON mesh_events(message_id, created_at DESC);
    CREATE INDEX idx_mesh_events_peer    ON mesh_events(peer_alias, created_at DESC);
    CREATE INDEX idx_mesh_events_created ON mesh_events(created_at DESC);
  `,
} as const;
