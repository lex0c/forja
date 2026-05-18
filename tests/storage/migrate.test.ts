import { describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import type { Migration } from '../../src/storage/migrations/index.ts';

describe('migrate', () => {
  test('applies all bundled migrations on first run', () => {
    const db = openMemoryDb();
    const result = migrate(db);
    expect(result.applied).toContain('001-initial');
    expect(result.skipped).toEqual([]);
    db.close();
  });

  test('skips already-applied migrations on second run', () => {
    const db = openMemoryDb();
    migrate(db);
    const result = migrate(db);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toContain('001-initial');
    db.close();
  });

  test('refuses to proceed when an applied migration changed (hash mismatch)', () => {
    const db = openMemoryDb();
    const original: Migration = {
      id: 99,
      name: 'test',
      sql: 'CREATE TABLE foo (id TEXT);',
    };
    const tampered: Migration = {
      id: 99,
      name: 'test',
      sql: 'CREATE TABLE foo (id INTEGER);',
    };
    migrate(db, [original]);
    expect(() => migrate(db, [tampered])).toThrow(/different hash/);
    db.close();
  });

  test('creates the expected tables and tracking table', () => {
    const db = openMemoryDb();
    migrate(db);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('sessions');
    expect(names).toContain('messages');
    expect(names).toContain('tool_calls');
    expect(names).toContain('_migrations');
    db.close();
  });

  test('whitespace-only changes do not invalidate the hash', () => {
    const db = openMemoryDb();
    const original: Migration = {
      id: 99,
      name: 'test',
      sql: 'CREATE TABLE foo (id TEXT);',
    };
    const reformatted: Migration = {
      id: 99,
      name: 'test',
      sql: '  CREATE  TABLE   foo\n  (id TEXT);  ',
    };
    migrate(db, [original]);
    expect(() => migrate(db, [reformatted])).not.toThrow();
    db.close();
  });

  test('hash mismatch error includes both hashes', () => {
    const db = openMemoryDb();
    migrate(db, [{ id: 99, name: 'test', sql: 'CREATE TABLE foo (id TEXT);' }]);
    const err = (() => {
      try {
        migrate(db, [{ id: 99, name: 'test', sql: 'CREATE TABLE foo (id INTEGER);' }]);
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(err).not.toBeNull();
    expect(err?.message).toContain('applied hash:');
    expect(err?.message).toContain('current hash:');
    db.close();
  });

  test('records hash and timestamp in _migrations for every applied migration', () => {
    const db = openMemoryDb();
    migrate(db);
    const rows = db
      .query('SELECT id, name, hash, applied_at FROM _migrations ORDER BY id ASC')
      .all() as {
      id: number;
      name: string;
      hash: string;
      applied_at: number;
    }[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const first = rows[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.id).toBe(1);
    expect(first.name).toBe('001-initial');
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.applied_at).toBeGreaterThan(0);
    // Every applied migration shares the same shape.
    for (const r of rows) {
      expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.applied_at).toBeGreaterThan(0);
    }
    db.close();
  });

  // Slice 134 P0-6: forward-compat check. A DB written by a newer
  // Forja (with a higher-id migration) must NOT be silently opened
  // by an older binary — the older binary doesn't know the row
  // shapes the newer migrations create.
  test('refuses to open a DB with an unknown future migration id', async () => {
    const db = openMemoryDb();
    const { MIGRATIONS } = await import('../../src/storage/migrations/index.ts');
    migrate(db, MIGRATIONS);
    // Plant an extra row in _migrations pretending a newer
    // migration (id=9999) ran on this DB. Re-run migrate — must
    // refuse loud rather than silently proceed.
    db.query('INSERT INTO _migrations (id, name, hash, applied_at) VALUES (?, ?, ?, ?)').run(
      9999,
      '099-future-version',
      'a'.repeat(64),
      Date.now(),
    );
    expect(() => migrate(db, MIGRATIONS)).toThrow(/id=9999.*NEWER Forja/);
    db.close();
  });

  // R3 / migration 058 — rebuilds subagent_runs to widen the scope
  // CHECK and add parent_approval_id. The DROP TABLE step runs with
  // PRAGMA foreign_keys=ON (migrate.ts wraps each migration in a
  // transaction; SQLite ignores PRAGMA foreign_keys=OFF inside one),
  // so the drop fires ON DELETE SET NULL on
  // memory_verify_attempts.subagent_run_session_id — the forensic
  // chain from the dedup cache to the audit row is severed for rows
  // that existed before 058 ran. This is a KNOWN data-loss documented
  // in 058's comment block and codified in 059's binding pattern for
  // future rebuilds. Editing 058 to preserve the pointers would have
  // broken append-only (every existing operator install would have
  // hit a hash mismatch). The test pins the actual behavior so a
  // future regression that thinks it's "fixing" 058 by editing the
  // SQL in place fails this test loud.
  test('migration 058: pre-existing memory_verify_attempts.subagent_run_session_id is severed by the rebuild (documented audit drift)', async () => {
    const { MIGRATIONS } = await import('../../src/storage/migrations/index.ts');
    const { createSession } = await import('../../src/storage/repos/sessions.ts');
    const pre058 = MIGRATIONS.filter((m) => m.id < 58);
    const db = openMemoryDb();
    migrate(db, pre058);
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    const child = createSession(db, { model: 'm', cwd: '/p', parentSessionId: parent.id });
    db.query(
      `INSERT INTO subagent_runs
       (session_id, name, scope, source_path, source_sha256, system_prompt, tools_whitelist,
        budget_max_steps, budget_max_cost_usd, captured_at)
       VALUES (?, 'verify-semantic', 'user', '/builtin/v.md', 'a', 'p', '[]', 15, 0.1, 1)`,
    ).run(child.id);
    db.query(
      `INSERT INTO memory_verify_attempts
       (id, memory_scope, memory_name, content_hash, verdict, confidence, model_id, prompt_hash,
        subagent_run_session_id, attempted_at)
       VALUES ('mva-058', 'user', 'foo', 'abc', 'passed', 0.9, 'm', 'h', ?, 1)`,
    ).run(child.id);
    // Apply 058 only (NOT 059 yet — we want to observe the raw 058 effect).
    migrate(
      db,
      MIGRATIONS.filter((m) => m.id <= 58),
    );
    // subagent_runs row survived with original scope (pre-058 the
    // mapping wrote 'user').
    const run = db
      .query<{ scope: string; parent_approval_id: string | null }, []>(
        'SELECT scope, parent_approval_id FROM subagent_runs',
      )
      .get();
    expect(run?.scope).toBe('user');
    expect(run?.parent_approval_id).toBeNull();
    // FK pointer in memory_verify_attempts was severed by the DROP
    // TABLE (ON DELETE SET NULL fired). Documented data loss.
    const mva = db
      .query<{ subagent_run_session_id: string | null }, [string]>(
        'SELECT subagent_run_session_id FROM memory_verify_attempts WHERE id = ?',
      )
      .get('mva-058');
    expect(mva?.subagent_run_session_id).toBeNull();
    // FK integrity itself is intact (the SET NULL is a clean
    // operation; only the forensic pointer is gone).
    const violations = db.query('PRAGMA foreign_key_check').all();
    expect(violations).toEqual([]);
    db.close();
  });

  // R3 / migration 059 — codifies the FK preservation discipline for
  // future subagent_runs rebuilds + adds a `provenance_drift_at`
  // column to memory_verify_attempts so forensic readers can
  // discriminate "pointer was always NULL" from "pointer was severed
  // by 058 on date X". The column itself is just an ALTER ADD; the
  // binding pattern lives in 059's comment block. This test pins the
  // column shape so a future schema reformat fails if the column is
  // dropped without a successor migration documenting the move.
  test('migration 059 adds provenance_drift_at to memory_verify_attempts', async () => {
    const db = openMemoryDb();
    migrate(db);
    const cols = db.query<{ name: string }, []>('PRAGMA table_info(memory_verify_attempts)').all();
    const names = cols.map((c) => c.name);
    expect(names).toContain('provenance_drift_at');
    db.close();
  });

  // Migration 060 — backfills the drift marker for rows pre-existing
  // 060 with NULL subagent_run_session_id. 059 only added the
  // column; rows that pre-dated 060 stayed indistinguishable from
  // rows INSERTed afterwards, defeating the discriminator. Editing
  // 059 would have violated append-only; the fix landed in 060.
  test('migration 060 backfills provenance_drift_at for pre-existing NULL-pointer rows', async () => {
    const { MIGRATIONS } = await import('../../src/storage/migrations/index.ts');
    const { createSession } = await import('../../src/storage/repos/sessions.ts');
    const pre060 = MIGRATIONS.filter((m) => m.id < 60);
    const db = openMemoryDb();
    migrate(db, pre060);
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    const child = createSession(db, { model: 'm', cwd: '/p', parentSessionId: parent.id });
    db.query(
      `INSERT INTO subagent_runs
       (session_id, name, scope, source_path, source_sha256, system_prompt, tools_whitelist,
        budget_max_steps, budget_max_cost_usd, captured_at)
       VALUES (?, 'verify-semantic', 'user', '/builtin/v.md', 'a', 'p', '[]', 15, 0.1, 1)`,
    ).run(child.id);
    db.query(
      `INSERT INTO memory_verify_attempts
       (id, memory_scope, memory_name, content_hash, verdict, confidence, model_id, prompt_hash,
        subagent_run_session_id, attempted_at)
       VALUES ('mva-null', 'user', 'foo', 'a', 'passed', 0.9, 'm', 'h', NULL, 1)`,
    ).run();
    db.query(
      `INSERT INTO memory_verify_attempts
       (id, memory_scope, memory_name, content_hash, verdict, confidence, model_id, prompt_hash,
        subagent_run_session_id, attempted_at)
       VALUES ('mva-intact', 'user', 'bar', 'b', 'passed', 0.9, 'm', 'h', ?, 2)`,
    ).run(child.id);
    migrate(
      db,
      MIGRATIONS.filter((m) => m.id <= 60),
    );
    const rows = db
      .query<
        { id: string; subagent_run_session_id: string | null; provenance_drift_at: number | null },
        []
      >(
        'SELECT id, subagent_run_session_id, provenance_drift_at FROM memory_verify_attempts ORDER BY id',
      )
      .all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('mva-null')?.provenance_drift_at).not.toBeNull();
    expect(byId.get('mva-null')?.provenance_drift_at).toBeGreaterThan(0);
    expect(byId.get('mva-intact')?.provenance_drift_at).toBeNull();
    expect(byId.get('mva-intact')?.subagent_run_session_id).toBe(child.id);
    db.close();
  });

  test('migration 060: rows INSERTed AFTER 060 with NULL pointer are not retroactively marked', async () => {
    const db = openMemoryDb();
    migrate(db);
    db.query(
      `INSERT INTO memory_verify_attempts
       (id, memory_scope, memory_name, content_hash, verdict, confidence, model_id, prompt_hash,
        subagent_run_session_id, attempted_at)
       VALUES ('mva-post', 'user', 'baz', 'c', 'inconclusive', 0.3, 'm', 'h', NULL, 100)`,
    ).run();
    const row = db
      .query<{ provenance_drift_at: number | null }, [string]>(
        'SELECT provenance_drift_at FROM memory_verify_attempts WHERE id = ?',
      )
      .get('mva-post');
    expect(row?.provenance_drift_at).toBeNull();
    db.close();
  });
});
