import { describe, expect, test } from 'bun:test';
import { MIGRATIONS, migrate, openMemoryDb } from '../../../src/storage/index.ts';

describe('migration 041-failure-events', () => {
  test('creates failure_events table', () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='failure_events'")
      .get();
    expect(row).not.toBeNull();
  });

  test('creates required indices', () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const idx = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='failure_events'")
      .all() as Array<{ name: string }>;
    const names = idx.map((r) => r.name);
    expect(names).toContain('idx_failure_events_code');
    expect(names).toContain('idx_failure_events_session');
  });

  test('CHECK constraint rejects invalid classe', () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    expect(() => {
      db.query(
        `INSERT INTO failure_events
         (id, session_id, code, classe, recovery_action, user_visible,
          created_at, prev_chain_hash, this_chain_hash)
         VALUES ('id-1', 's', 'x.y', 'INVALID', 'fatal', 1, 0, 'p', 't')`,
      ).run();
    }).toThrow();
  });

  test('CHECK constraint rejects invalid user_visible', () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    expect(() => {
      db.query(
        `INSERT INTO failure_events
         (id, session_id, code, classe, recovery_action, user_visible,
          created_at, prev_chain_hash, this_chain_hash)
         VALUES ('id-1', 's', 'x.y', 'sandbox', 'fatal', 2, 0, 'p', 't')`,
      ).run();
    }).toThrow();
  });

  test('UNIQUE constraint on this_chain_hash', () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    db.query(
      `INSERT INTO failure_events
       (id, session_id, code, classe, recovery_action, user_visible,
        created_at, prev_chain_hash, this_chain_hash)
       VALUES ('id-1', 's', 'sandbox.tool_unavailable', 'sandbox', 'fatal', 1, 0, 'p', 'h1')`,
    ).run();
    expect(() => {
      db.query(
        `INSERT INTO failure_events
         (id, session_id, code, classe, recovery_action, user_visible,
          created_at, prev_chain_hash, this_chain_hash)
         VALUES ('id-2', 's', 'sandbox.tool_unavailable', 'sandbox', 'fatal', 1, 1, 'h1', 'h1')`,
      ).run();
    }).toThrow();
  });

  test('migration is idempotent (running twice does not error)', () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    expect(() => migrate(db, MIGRATIONS)).not.toThrow();
  });

  // Slice 130 fixup #7: prove the indices the migration creates
  // are actually USABLE by the query planner. A future column
  // reorder or index-name typo would silently disable index
  // usage; the existing "indices exist" test wouldn't catch it.
  test('idx_failure_events_code is used by code+created_at queries', () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const plan = db
      .query(
        `EXPLAIN QUERY PLAN
         SELECT * FROM failure_events
         WHERE code = ? AND created_at >= ?
         ORDER BY created_at DESC LIMIT 10`,
      )
      .all('sandbox.tool_unavailable', 0) as Array<{ detail: string }>;
    const planText = plan.map((r) => r.detail).join(' | ');
    expect(planText).toContain('idx_failure_events_code');
  });

  test('idx_failure_events_session is used by session+created_at queries', () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const plan = db
      .query(
        `EXPLAIN QUERY PLAN
         SELECT * FROM failure_events
         WHERE session_id = ?
         ORDER BY created_at DESC`,
      )
      .all('sess-x') as Array<{ detail: string }>;
    const planText = plan.map((r) => r.detail).join(' | ');
    expect(planText).toContain('idx_failure_events_session');
  });
});
