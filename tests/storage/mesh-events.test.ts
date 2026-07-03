import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  listMeshEventsByConversation,
  recordMeshAuditEvent,
} from '../../src/storage/repos/mesh-events.ts';

let db: DB;
beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

describe('mesh_events repo', () => {
  test('records the boundary kinds, listed by conversation oldest-first, no cross-bleed', () => {
    recordMeshAuditEvent(
      db,
      { kind: 'peer_prompt_received', conversationId: 'c1', peerAlias: 'checkout' },
      10,
    );
    recordMeshAuditEvent(
      db,
      {
        kind: 'reply_published',
        conversationId: 'c1',
        peerAlias: 'checkout',
        output: 'v2 is live',
      },
      20,
    );
    // A different conversation must not appear in c1's stream.
    recordMeshAuditEvent(
      db,
      { kind: 'reply_received', conversationId: 'c2', peerAlias: 'orders' },
      15,
    );
    const rows = listMeshEventsByConversation(db, 'c1');
    expect(rows.map((r) => r.kind)).toEqual(['peer_prompt_received', 'reply_published']);
    expect(rows.every((r) => r.peerAlias === 'checkout')).toBe(true);
  });

  test('reply_published stores the output hash + byte length, never the raw output', () => {
    recordMeshAuditEvent(
      db,
      { kind: 'reply_published', conversationId: 'c1', peerAlias: 'x', output: 'secret answer' },
      1,
    );
    const row = listMeshEventsByConversation(db, 'c1')[0];
    expect(row?.payload?.output_bytes).toBe(Buffer.byteLength('secret answer', 'utf8'));
    expect(typeof row?.payload?.output_sha256).toBe('string');
    // The raw output never lands in the audit row — only its hash.
    expect(JSON.stringify(row)).not.toContain('secret answer');
  });

  test('non-reply kinds carry no payload', () => {
    recordMeshAuditEvent(db, { kind: 'reply_received', conversationId: 'c1', peerAlias: 'x' }, 1);
    expect(listMeshEventsByConversation(db, 'c1')[0]?.payload).toBeNull();
  });

  test('the kind CHECK rejects an unknown event kind at the DB layer', () => {
    expect(() =>
      recordMeshAuditEvent(db, { kind: 'bogus', conversationId: 'c1', peerAlias: 'x' } as never, 1),
    ).toThrow();
  });

  test('a corrupt/tampered payload_json row reads as null, not a thrown parse error', () => {
    // The log is non-chained (operational) — a hand-edited/truncated payload must
    // not crash the forensic read of the whole conversation.
    db.query(
      `INSERT INTO mesh_events (id, kind, conversation_id, peer_alias, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('r1', 'reply_published', 'c1', 'x', '{not valid json', 1);
    const rows = listMeshEventsByConversation(db, 'c1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toBeNull();
  });
});
