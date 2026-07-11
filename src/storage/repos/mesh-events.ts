// mesh_events repo — Forja Mesh boundary audit (MESH.md §8). Append-only
// operational log; NOT hash-chained (schema + rationale in migration
// 084-mesh-events.ts, message-bus shape in 085). The manager emits
// `MeshAuditEvent`s at the wire hub; the bootstrap sink calls
// `recordMeshAuditEvent`. Correlation is by peer alias + the message id.

import { createHash } from 'node:crypto';
import { safeJsonParse } from '../../broker/safe-json.ts';
import type { MeshAuditEvent } from '../../mesh/types.ts';
import type { DB } from '../db.ts';

// mesh_events is a non-chained operational log: a corrupt or tampered payload row
// must not crash the forensic read. Parse defensively — safeJsonParse also blocks
// prototype pollution from a hand-edited DB — and drop an unparseable payload to
// null rather than throwing out the whole read.
const parsePayload = (raw: string | null): Record<string, unknown> | null => {
  if (raw === null) return null;
  try {
    const parsed = safeJsonParse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

export interface MeshEventRow {
  id: string;
  kind: string;
  messageId: string;
  peerAlias: string;
  payload: Record<string, unknown> | null;
  createdAt: number;
}

// Persist a mesh boundary event. For `message_sent`, store the text's SHA-256 +
// byte length — never the raw text (the full text lives in the mesh_send tool
// args / message log; the hash is enough to verify what left). The row's own `id`
// is a fresh uuid; `message_id` is the wire message's id (the correlation handle).
export const recordMeshAuditEvent = (
  db: DB,
  event: MeshAuditEvent,
  at: number = Date.now(),
): void => {
  const payload =
    event.kind === 'message_sent'
      ? {
          text_bytes: Buffer.byteLength(event.text, 'utf8'),
          text_sha256: createHash('sha256').update(event.text).digest('hex'),
        }
      : null;
  db.query(
    `INSERT INTO mesh_events (id, kind, message_id, peer_alias, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    event.kind,
    event.id,
    event.peerAlias,
    payload !== null ? JSON.stringify(payload) : null,
    at,
  );
};

// Forensic read: every boundary event with a peer, oldest first. The cross-Forja
// reconstruction joins the two DBs by the message `id` (both sides log the same
// id for a given message); within one DB, grouping by peer is the natural view.
export const listMeshEventsByPeer = (db: DB, peerAlias: string): MeshEventRow[] => {
  const rows = db
    .query(
      `SELECT id, kind, message_id, peer_alias, payload_json, created_at
         FROM mesh_events
        WHERE peer_alias = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(peerAlias) as {
    id: string;
    kind: string;
    message_id: string;
    peer_alias: string;
    payload_json: string | null;
    created_at: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    messageId: r.message_id,
    peerAlias: r.peer_alias,
    payload: parsePayload(r.payload_json),
    createdAt: r.created_at,
  }));
};
