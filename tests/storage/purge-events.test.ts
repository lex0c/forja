// purge_events repo + migration 066 tests.
//
// Pin the contracts that cli/purge.ts consumes:
//   - Migration creates the table with all required columns + the
//     (cwd, ts) index.
//   - CHECK constraints reject negative byte/file/dir counts and
//     non-positive ts (defense against test-fixture footguns).
//   - INSERT assigns an autoincrementing id and round-trips every
//     column.
//   - listPurgeEventsByCwd filters by cwd and orders desc by ts.
//   - Append-only contract: repo exports no UPDATE/DELETE surface.

import { describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import * as purgeRepo from '../../src/storage/repos/purge-events.ts';
import {
  insertPurgeEvent,
  listPurgeEventsByCwd,
  prunePurgeEvents,
} from '../../src/storage/repos/purge-events.ts';

const newDb = (): DB => {
  const db = openMemoryDb();
  migrate(db);
  return db;
};

describe('migration 066 — purge_events schema', () => {
  test('CREATE TABLE materialized with expected columns', () => {
    const db = newDb();
    const cols = db.query("PRAGMA table_info('purge_events')").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.has('id')).toBe(true);
    expect(byName.has('ts')).toBe(true);
    expect(byName.has('install_id')).toBe(true);
    expect(byName.has('cwd')).toBe(true);
    expect(byName.has('artifacts_present_json')).toBe(true);
    expect(byName.has('bytes_present')).toBe(true);
    expect(byName.has('files_present')).toBe(true);
    expect(byName.has('dirs_present')).toBe(true);
    expect(byName.has('forja_version')).toBe(true);
    // PK is `id`
    expect(byName.get('id')?.pk).toBe(1);
    // NOT NULL on every payload column
    for (const name of [
      'ts',
      'install_id',
      'cwd',
      'artifacts_present_json',
      'bytes_present',
      'files_present',
      'dirs_present',
      'forja_version',
    ]) {
      expect(byName.get(name)?.notnull).toBe(1);
    }
  });

  test('(cwd, ts) index exists for forensic queries', () => {
    const db = newDb();
    const indexes = db.query("PRAGMA index_list('purge_events')").all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_purge_events_cwd_ts');
  });

  test('CHECK constraint rejects non-positive ts', () => {
    const db = newDb();
    expect(() =>
      insertPurgeEvent(db, {
        ts: 0,
        install_id: 'inst-1',
        cwd: '/p',
        artifacts_present_json: '[]',
        bytes_present: 0,
        files_present: 0,
        dirs_present: 0,
        forja_version: '0.0.0',
      }),
    ).toThrow(/CHECK/);
    expect(() =>
      insertPurgeEvent(db, {
        ts: -1,
        install_id: 'inst-1',
        cwd: '/p',
        artifacts_present_json: '[]',
        bytes_present: 0,
        files_present: 0,
        dirs_present: 0,
        forja_version: '0.0.0',
      }),
    ).toThrow(/CHECK/);
  });

  test('CHECK constraint rejects negative counts', () => {
    const db = newDb();
    const baseRow = {
      ts: 1_700_000_000_000,
      install_id: 'inst-1',
      cwd: '/p',
      artifacts_present_json: '[]',
      forja_version: '0.0.0',
    } as const;
    expect(() =>
      insertPurgeEvent(db, {
        ...baseRow,
        bytes_present: -1,
        files_present: 0,
        dirs_present: 0,
      }),
    ).toThrow(/CHECK/);
    expect(() =>
      insertPurgeEvent(db, {
        ...baseRow,
        bytes_present: 0,
        files_present: -1,
        dirs_present: 0,
      }),
    ).toThrow(/CHECK/);
    expect(() =>
      insertPurgeEvent(db, {
        ...baseRow,
        bytes_present: 0,
        files_present: 0,
        dirs_present: -1,
      }),
    ).toThrow(/CHECK/);
  });

  test('zero counts and empty json are valid (edge: purge of empty .agent/)', () => {
    const db = newDb();
    const row = insertPurgeEvent(db, {
      ts: 1_700_000_000_000,
      install_id: 'inst-1',
      cwd: '/p',
      artifacts_present_json: '[]',
      bytes_present: 0,
      files_present: 0,
      dirs_present: 0,
      forja_version: '0.0.0',
    });
    expect(row.id).toBeGreaterThan(0);
  });
});

describe('insertPurgeEvent', () => {
  test('returns row with assigned id and round-trips every column', () => {
    const db = newDb();
    const r = insertPurgeEvent(db, {
      ts: 1_700_000_000_000,
      install_id: 'inst-xyz',
      cwd: '/repo/A',
      artifacts_present_json: '["/repo/A/.agent/permissions.yaml"]',
      bytes_present: 1234,
      files_present: 5,
      dirs_present: 2,
      forja_version: '0.0.0',
    });
    expect(r.id).toBeGreaterThan(0);
    expect(r.ts).toBe(1_700_000_000_000);
    expect(r.install_id).toBe('inst-xyz');
    expect(r.cwd).toBe('/repo/A');
    expect(r.artifacts_present_json).toBe('["/repo/A/.agent/permissions.yaml"]');
    expect(r.bytes_present).toBe(1234);
    expect(r.files_present).toBe(5);
    expect(r.dirs_present).toBe(2);
    expect(r.forja_version).toBe('0.0.0');
  });

  test('consecutive inserts get strictly increasing ids', () => {
    const db = newDb();
    const a = insertPurgeEvent(db, {
      ts: 1,
      install_id: 'i',
      cwd: '/p',
      artifacts_present_json: '[]',
      bytes_present: 0,
      files_present: 0,
      dirs_present: 0,
      forja_version: 'v',
    });
    const b = insertPurgeEvent(db, {
      ts: 2,
      install_id: 'i',
      cwd: '/p',
      artifacts_present_json: '[]',
      bytes_present: 0,
      files_present: 0,
      dirs_present: 0,
      forja_version: 'v',
    });
    expect(b.id).toBeGreaterThan(a.id);
  });
});

describe('listPurgeEventsByCwd', () => {
  test('returns empty for a cwd with no purges', () => {
    const db = newDb();
    expect(listPurgeEventsByCwd(db, '/unknown')).toEqual([]);
  });

  test('filters by cwd — does not bleed across projects', () => {
    const db = newDb();
    insertPurgeEvent(db, {
      ts: 100,
      install_id: 'i',
      cwd: '/a',
      artifacts_present_json: '[]',
      bytes_present: 0,
      files_present: 0,
      dirs_present: 0,
      forja_version: 'v',
    });
    insertPurgeEvent(db, {
      ts: 200,
      install_id: 'i',
      cwd: '/b',
      artifacts_present_json: '[]',
      bytes_present: 0,
      files_present: 0,
      dirs_present: 0,
      forja_version: 'v',
    });
    const rowsA = listPurgeEventsByCwd(db, '/a');
    expect(rowsA.length).toBe(1);
    expect(rowsA[0]?.cwd).toBe('/a');
    const rowsB = listPurgeEventsByCwd(db, '/b');
    expect(rowsB.length).toBe(1);
    expect(rowsB[0]?.cwd).toBe('/b');
  });

  test('orders most recent first (ts DESC)', () => {
    const db = newDb();
    insertPurgeEvent(db, {
      ts: 100,
      install_id: 'i',
      cwd: '/p',
      artifacts_present_json: '[]',
      bytes_present: 0,
      files_present: 0,
      dirs_present: 0,
      forja_version: 'v',
    });
    insertPurgeEvent(db, {
      ts: 300,
      install_id: 'i',
      cwd: '/p',
      artifacts_present_json: '[]',
      bytes_present: 0,
      files_present: 0,
      dirs_present: 0,
      forja_version: 'v',
    });
    insertPurgeEvent(db, {
      ts: 200,
      install_id: 'i',
      cwd: '/p',
      artifacts_present_json: '[]',
      bytes_present: 0,
      files_present: 0,
      dirs_present: 0,
      forja_version: 'v',
    });
    const rows = listPurgeEventsByCwd(db, '/p');
    expect(rows.map((r) => r.ts)).toEqual([300, 200, 100]);
  });

  test('honors limit', () => {
    const db = newDb();
    for (let i = 0; i < 5; i += 1) {
      insertPurgeEvent(db, {
        ts: i + 1,
        install_id: 'i',
        cwd: '/p',
        artifacts_present_json: '[]',
        bytes_present: 0,
        files_present: 0,
        dirs_present: 0,
        forja_version: 'v',
      });
    }
    expect(listPurgeEventsByCwd(db, '/p', 2).length).toBe(2);
  });
});

describe('append-only contract', () => {
  test('repo exports only the operator-visible inserts/reads and the retention-only prune', () => {
    const exports = Object.keys(purgeRepo);
    // Whitelist what we DO export. From the operator's perspective
    // this table is append-only — there is NO per-row DELETE/UPDATE
    // surface, only:
    //   - insertPurgeEvent: the only writer (called by cli/purge.ts
    //     after the operator confirms a --force purge).
    //   - listPurgeEventsByCwd: forensic read for "purge history of
    //     project X" (called by the future `agent purge log` reader).
    //   - prunePurgeEvents: retention-only mutation, called ONLY by
    //     the gc orchestrator (src/audit/gc.ts:sweepOne) with an
    //     age cutoff. AUDIT.md §1.2 specifies 365d retention; the
    //     migration 066 header pre-declared this exception ("no
    //     DELETE outside the retention sweep").
    // Adding any per-row DELETE/UPDATE here should fail this test
    // and force a discussion about why the append-only contract
    // should bend further.
    expect(exports.sort()).toEqual([
      'insertPurgeEvent',
      'listPurgeEventsByCwd',
      'prunePurgeEvents',
    ]);
  });
});

describe('prunePurgeEvents — retention sweep', () => {
  const ts = (n: number) => 1_700_000_000_000 + n; // anchor + offset for readability
  const baseRow = {
    install_id: 'inst-1',
    cwd: '/repo',
    artifacts_present_json: '[]',
    bytes_present: 0,
    files_present: 0,
    dirs_present: 0,
    forja_version: '0.0.0',
  } as const;

  test('deletes rows strictly older than cutoffMs', () => {
    const db = newDb();
    insertPurgeEvent(db, { ...baseRow, ts: ts(100) }); // old
    insertPurgeEvent(db, { ...baseRow, ts: ts(200) }); // old
    insertPurgeEvent(db, { ...baseRow, ts: ts(500) }); // young (after cutoff)
    const cutoff = ts(300);
    const deleted = prunePurgeEvents(db, cutoff);
    expect(deleted).toBe(2);
    const remaining = listPurgeEventsByCwd(db, '/repo');
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.ts).toBe(ts(500));
  });

  test('preserves rows with ts exactly equal to cutoffMs (strict <)', () => {
    // Boundary parity with other age-based prunes: equal-cutoff
    // rows survive. An operator who sets retention to "1 day"
    // shouldn't see a row that's exactly 24h old vanish on the
    // boundary tick.
    const db = newDb();
    insertPurgeEvent(db, { ...baseRow, ts: ts(100) });
    const deleted = prunePurgeEvents(db, ts(100));
    expect(deleted).toBe(0);
    expect(listPurgeEventsByCwd(db, '/repo').length).toBe(1);
  });

  test('idempotent: second call deletes nothing', () => {
    const db = newDb();
    insertPurgeEvent(db, { ...baseRow, ts: ts(100) });
    insertPurgeEvent(db, { ...baseRow, ts: ts(200) });
    const first = prunePurgeEvents(db, ts(300));
    expect(first).toBe(2);
    const second = prunePurgeEvents(db, ts(300));
    expect(second).toBe(0);
  });

  test('returns 0 on empty table', () => {
    const db = newDb();
    expect(prunePurgeEvents(db, ts(1000))).toBe(0);
  });

  test('deletes across all cwd values (install-scoped, not project-scoped)', () => {
    // prunePurgeEvents is install-wide hygiene — operator running
    // `agent gc --force` shouldn't have to enumerate every project's
    // cwd. Confirm the SQL does not filter by cwd.
    const db = newDb();
    insertPurgeEvent(db, { ...baseRow, cwd: '/a', ts: ts(100) });
    insertPurgeEvent(db, { ...baseRow, cwd: '/b', ts: ts(100) });
    insertPurgeEvent(db, { ...baseRow, cwd: '/c', ts: ts(100) });
    const deleted = prunePurgeEvents(db, ts(200));
    expect(deleted).toBe(3);
  });
});
