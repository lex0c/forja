import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listMeshEventsByPeer, recordMeshAuditEvent } from '../../src/storage/repos/mesh-events.ts';

let db: DB;
beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

describe('mesh_events repo', () => {
  test('records the message-bus kinds, listed by peer oldest-first, no cross-bleed', () => {
    recordMeshAuditEvent(db, { kind: 'message_received', id: 'm1', peerAlias: 'checkout' }, 10);
    recordMeshAuditEvent(
      db,
      { kind: 'message_sent', id: 'm2', peerAlias: 'checkout', text: 'v2 is live' },
      20,
    );
    // A different peer must not appear in checkout's stream.
    recordMeshAuditEvent(db, { kind: 'message_received', id: 'm3', peerAlias: 'orders' }, 15);
    const rows = listMeshEventsByPeer(db, 'checkout');
    expect(rows.map((r) => r.kind)).toEqual(['message_received', 'message_sent']);
    expect(rows.every((r) => r.peerAlias === 'checkout')).toBe(true);
    // The message id is the correlation handle carried across the two Forjas' DBs.
    expect(rows.map((r) => r.messageId)).toEqual(['m1', 'm2']);
  });

  test('message_sent stores the text hash + byte length, never the raw text', () => {
    recordMeshAuditEvent(
      db,
      { kind: 'message_sent', id: 'm1', peerAlias: 'x', text: 'secret answer' },
      1,
    );
    const row = listMeshEventsByPeer(db, 'x')[0];
    expect(row?.payload?.text_bytes).toBe(Buffer.byteLength('secret answer', 'utf8'));
    expect(typeof row?.payload?.text_sha256).toBe('string');
    // The raw text never lands in the audit row — only its hash.
    expect(JSON.stringify(row)).not.toContain('secret answer');
  });

  test('message_received carries no payload', () => {
    recordMeshAuditEvent(db, { kind: 'message_received', id: 'm1', peerAlias: 'x' }, 1);
    expect(listMeshEventsByPeer(db, 'x')[0]?.payload).toBeNull();
  });

  test('the kind CHECK rejects an unknown event kind at the DB layer', () => {
    expect(() =>
      recordMeshAuditEvent(db, { kind: 'bogus', id: 'm1', peerAlias: 'x' } as never, 1),
    ).toThrow();
  });

  test('a corrupt/tampered payload_json row reads as null, not a thrown parse error', () => {
    // The log is non-chained (operational) — a hand-edited/truncated payload must
    // not crash the forensic read of the whole peer stream.
    db.query(
      `INSERT INTO mesh_events (id, kind, message_id, peer_alias, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('r1', 'message_sent', 'm1', 'x', '{not valid json', 1);
    const rows = listMeshEventsByPeer(db, 'x');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toBeNull();
  });
});
