// mesh_events repo — Forja Mesh boundary audit (MESH.md §8). Append-only
// operational log; NOT hash-chained (schema + rationale in migration
// 084-mesh-events.ts). The manager emits `MeshAuditEvent`s at the wire hub; the
// bootstrap sink calls `recordMeshAuditEvent`. Correlation is by conversationId.

import { createHash } from 'node:crypto';
import { safeJsonParse } from '../../broker/safe-json.ts';
import type { MeshAuditEvent } from '../../mesh/types.ts';
import type { DB } from '../db.ts';

// mesh_events is a non-chained operational log (migration 084): a corrupt or
// tampered payload row must not crash the forensic read. Parse defensively —
// safeJsonParse also blocks prototype pollution from a hand-edited DB — and drop
// an unparseable payload to null rather than throwing out the whole conversation.
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
  conversationId: string;
  peerAlias: string;
  payload: Record<string, unknown> | null;
  createdAt: number;
}

// Persist a mesh boundary event. For `reply_published`, store the output's
// SHA-256 + byte length — never the raw output (the full text lives in the
// mesh_reply tool args / message log; the hash is enough to verify what left).
export const recordMeshAuditEvent = (
  db: DB,
  event: MeshAuditEvent,
  at: number = Date.now(),
): void => {
  const payload =
    event.kind === 'reply_published'
      ? {
          output_bytes: Buffer.byteLength(event.output, 'utf8'),
          output_sha256: createHash('sha256').update(event.output).digest('hex'),
        }
      : null;
  db.query(
    `INSERT INTO mesh_events (id, kind, conversation_id, peer_alias, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    event.kind,
    event.conversationId,
    event.peerAlias,
    payload !== null ? JSON.stringify(payload) : null,
    at,
  );
};

// Forensic read: every boundary event for a conversation, oldest first. The
// cross-Forja reconstruction joins this by `conversationId` with the peer's DB.
export const listMeshEventsByConversation = (db: DB, conversationId: string): MeshEventRow[] => {
  const rows = db
    .query(
      `SELECT id, kind, conversation_id, peer_alias, payload_json, created_at
         FROM mesh_events
        WHERE conversation_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(conversationId) as {
    id: string;
    kind: string;
    conversation_id: string;
    peer_alias: string;
    payload_json: string | null;
    created_at: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    conversationId: r.conversation_id,
    peerAlias: r.peer_alias,
    payload: parsePayload(r.payload_json),
    createdAt: r.created_at,
  }));
};
