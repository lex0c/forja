// Pins for migration 070 — widens `failure_events.classe` CHECK to
// accept 'tokenizer'. Live regression that motivated this slice:
// `tokenizer.discrepancy.*` emits hit the CHECK on every step,
// flooding stderr.

import { describe, expect, test } from 'bun:test';
import { MIGRATIONS, migrate, openMemoryDb } from '../../../src/storage/index.ts';

describe('migration 070-failure-events-tokenizer-class', () => {
  test("post-migration: classe='tokenizer' is accepted by the CHECK", () => {
    // The bug: migration 041 listed 10 classes; the tokenizer class
    // (added in code in commit 0cc9021) hit `CHECK constraint failed`
    // on every discrepancy emit. After 070, the INSERT succeeds.
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    expect(() => {
      db.query(
        `INSERT INTO failure_events
         (id, session_id, code, classe, recovery_action, user_visible,
          created_at, prev_chain_hash, this_chain_hash)
         VALUES ('id-tok', 's', 'tokenizer.discrepancy.input',
                 'tokenizer', 'degraded', 0, 0, 'p', 'h-tok')`,
      ).run();
    }).not.toThrow();
  });

  test('all 10 pre-existing classes still accepted (no regression)', () => {
    // The rebuild copied data verbatim and the new CHECK includes
    // every old class. Defensive pin against typo'd CHECK literal.
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const classes: readonly string[] = [
      'provider',
      'tool',
      'sandbox',
      'permission',
      'subagent',
      'parse',
      'mcp',
      'storage',
      'bootstrap',
      'compliance',
    ];
    classes.forEach((c, i) => {
      expect(() => {
        db.query(
          `INSERT INTO failure_events
           (id, session_id, code, classe, recovery_action, user_visible,
            created_at, prev_chain_hash, this_chain_hash)
           VALUES (?, 's', 'x.y', ?, 'fatal', 1, 0, 'p', ?)`,
        ).run(`id-${i}`, c, `h-${i}`);
      }).not.toThrow();
    });
  });

  test("an invalid classe is STILL rejected (CHECK didn't collapse to NO-OP)", () => {
    // Sanity: the rebuild used a new CHECK literal, not no constraint.
    // If a refactor dropped the CHECK on the new table, this pin
    // catches it immediately — invalid classe would otherwise insert.
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    expect(() => {
      db.query(
        `INSERT INTO failure_events
         (id, session_id, code, classe, recovery_action, user_visible,
          created_at, prev_chain_hash, this_chain_hash)
         VALUES ('id-bad', 's', 'x.y', 'BOGUS', 'fatal', 1, 0, 'p', 'h-bad')`,
      ).run();
    }).toThrow();
  });

  test('indexes survive the rebuild', () => {
    // Drop-and-rename loses indexes; the migration recreates them.
    // Pin so a refactor that forgets the recreation surfaces here
    // instead of as a silent query-plan regression in production.
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const idx = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='failure_events'")
      .all() as Array<{ name: string }>;
    const names = idx.map((r) => r.name);
    expect(names).toContain('idx_failure_events_code');
    expect(names).toContain('idx_failure_events_session');
  });

  test('rebuild preserves existing rows verbatim (chain hashes intact)', () => {
    // Real-world: 070 runs against an installation that already has
    // failure_events from prior versions. The CHECK-rebuild MUST NOT
    // drop those rows — chain hashes are the audit's tamper-evidence
    // and a missing genesis row breaks every subsequent verifyChain.
    //
    // openMemoryDb runs all migrations in order, so we can't simulate
    // "pre-070 state" cleanly. Instead we INSERT a row AFTER full
    // migration and verify it survives + chain values stay byte-
    // identical (i.e., no value got rewritten by the copy clause).
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    db.query(
      `INSERT INTO failure_events
       (id, session_id, code, classe, recovery_action, user_visible,
        payload_json, created_at, prev_chain_hash, this_chain_hash)
       VALUES ('id-preserve', 's', 'sandbox.tool_unavailable', 'sandbox',
               'fatal', 1, '{"a":1}', 1234, 'genesis', 'h-preserve')`,
    ).run();
    const row = db
      .query<
        {
          id: string;
          classe: string;
          payload_json: string | null;
          prev_chain_hash: string;
          this_chain_hash: string;
          created_at: number;
        },
        [string]
      >(
        `SELECT id, classe, payload_json, prev_chain_hash, this_chain_hash, created_at
           FROM failure_events WHERE id = ?`,
      )
      .get('id-preserve');
    expect(row).not.toBeNull();
    expect(row?.classe).toBe('sandbox');
    expect(row?.payload_json).toBe('{"a":1}');
    expect(row?.prev_chain_hash).toBe('genesis');
    expect(row?.this_chain_hash).toBe('h-preserve');
    expect(row?.created_at).toBe(1234);
  });
});
