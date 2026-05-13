import { describe, expect, test } from 'bun:test';
import { MIGRATIONS, migrate, openMemoryDb } from '../../../src/storage/index.ts';

describe('migration 042-outcome-signals', () => {
  const seedApproval = (db: ReturnType<typeof openMemoryDb>): number => {
    db.query(
      `INSERT INTO approvals_log
        (ts, install_id, session_id, tool_name, args_hash, decision,
         policy_hash, reason_chain_json, prev_hash, this_hash)
       VALUES (1, 'inst-1', 's', 'bash', 'h', 'allow', 'p', '[]', 'prev', 'this')`,
    ).run();
    return 1;
  };

  test('table created', () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='outcome_signals'")
      .get();
    expect(row).not.toBeNull();
  });

  test('required indices', () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const idx = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='outcome_signals'")
      .all() as Array<{ name: string }>;
    const names = idx.map((r) => r.name);
    expect(names).toContain('idx_outcome_signals_approval');
    expect(names).toContain('idx_outcome_signals_install');
    expect(names).toContain('idx_outcome_signals_kind');
  });

  test('CHECK rejects invalid signal_kind', () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const seq = seedApproval(db);
    expect(() => {
      db.query(
        `INSERT INTO outcome_signals (id, approval_seq, install_id, signal_kind, signal_weight,
          observed_at, detected_at, ttl_expires_at)
         VALUES ('id-1', ?, 'inst-1', 'invalid', 0.5, 0, 0, 0)`,
      ).run(seq);
    }).toThrow();
  });

  test('CHECK rejects signal_weight outside [0,1]', () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const seq = seedApproval(db);
    expect(() => {
      db.query(
        `INSERT INTO outcome_signals (id, approval_seq, install_id, signal_kind, signal_weight,
          observed_at, detected_at, ttl_expires_at)
         VALUES ('id-2', ?, 'inst-1', 'tool_error', 1.5, 0, 0, 0)`,
      ).run(seq);
    }).toThrow();
    expect(() => {
      db.query(
        `INSERT INTO outcome_signals (id, approval_seq, install_id, signal_kind, signal_weight,
          observed_at, detected_at, ttl_expires_at)
         VALUES ('id-3', ?, 'inst-1', 'tool_error', -0.1, 0, 0, 0)`,
      ).run(seq);
    }).toThrow();
  });

  test('install_id NOT NULL constraint enforced', () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const seq = seedApproval(db);
    expect(() => {
      db.query(
        `INSERT INTO outcome_signals (id, approval_seq, install_id, signal_kind, signal_weight,
          observed_at, detected_at, ttl_expires_at)
         VALUES ('id-4', ?, NULL, 'tool_error', 0.5, 0, 0, 0)`,
      ).run(seq);
    }).toThrow();
  });

  test('idx_outcome_signals_kind used by kind+time DESC queries', () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const plan = db
      .query(
        `EXPLAIN QUERY PLAN
         SELECT * FROM outcome_signals
         WHERE signal_kind = ? AND detected_at >= ?
         ORDER BY detected_at DESC`,
      )
      .all('tool_error', 0) as Array<{ detail: string }>;
    const planText = plan.map((r) => r.detail).join(' | ');
    expect(planText).toContain('idx_outcome_signals_kind');
  });

  test('idx_outcome_signals_approval is used by approval_seq queries', () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const plan = db
      .query(
        `EXPLAIN QUERY PLAN
         SELECT * FROM outcome_signals WHERE approval_seq = ?`,
      )
      .all(1) as Array<{ detail: string }>;
    const planText = plan.map((r) => r.detail).join(' | ');
    expect(planText).toContain('idx_outcome_signals_approval');
  });

  test('migration idempotent', () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    expect(() => migrate(db, MIGRATIONS)).not.toThrow();
  });
});
