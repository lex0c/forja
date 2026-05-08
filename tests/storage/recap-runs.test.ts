import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  getRecapRun,
  listRecentRecapRuns,
  recordRecapRun,
} from '../../src/storage/repos/recap-runs.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

describe('recap_runs repo', () => {
  test('records and reads back with all fields', () => {
    const run = recordRecapRun(db, {
      scopeKind: 'session_specific',
      sessionIds: ['sess-1'],
      renderer: 'human',
      usedLlm: false,
      outputPath: '/tmp/recap.md',
      createdAt: 1_000,
    });
    expect(run.id).toBeString();
    expect(run.scopeKind).toBe('session_specific');
    expect(run.sessionIds).toEqual(['sess-1']);
    expect(run.renderer).toBe('human');
    expect(run.usedLlm).toBe(false);
    expect(run.outputPath).toBe('/tmp/recap.md');
    expect(run.createdAt).toBe(1_000);

    const fetched = getRecapRun(db, run.id);
    expect(fetched).toEqual(run);
  });

  test('outputPath defaults to null; multi-session ids round-trip', () => {
    const run = recordRecapRun(db, {
      scopeKind: 'day',
      sessionIds: ['s1', 's2', 's3'],
      renderer: 'json',
      usedLlm: false,
    });
    expect(run.outputPath).toBeNull();
    const fetched = getRecapRun(db, run.id);
    expect(fetched?.sessionIds).toEqual(['s1', 's2', 's3']);
  });

  test('listRecentRecapRuns returns newest-first capped by limit', () => {
    recordRecapRun(db, {
      scopeKind: 'session_current',
      sessionIds: ['old'],
      renderer: 'human',
      usedLlm: false,
      createdAt: 100,
    });
    recordRecapRun(db, {
      scopeKind: 'session_current',
      sessionIds: ['mid'],
      renderer: 'human',
      usedLlm: false,
      createdAt: 200,
    });
    recordRecapRun(db, {
      scopeKind: 'session_current',
      sessionIds: ['new'],
      renderer: 'human',
      usedLlm: false,
      createdAt: 300,
    });
    const all = listRecentRecapRuns(db);
    expect(all.map((r) => r.sessionIds[0])).toEqual(['new', 'mid', 'old']);
    const top1 = listRecentRecapRuns(db, 1);
    expect(top1).toHaveLength(1);
    expect(top1[0]?.sessionIds[0]).toBe('new');
  });

  test('CHECK constraint rejects unknown scope_kind', () => {
    expect(() =>
      recordRecapRun(db, {
        // biome-ignore lint/suspicious/noExplicitAny: testing schema enforcement at boundary
        scopeKind: 'mystery' as any,
        sessionIds: [],
        renderer: 'human',
        usedLlm: false,
      }),
    ).toThrow();
  });

  test('used_llm round-trips through INTEGER column', () => {
    const off = recordRecapRun(db, {
      scopeKind: 'session_current',
      sessionIds: ['a'],
      renderer: 'human',
      usedLlm: false,
    });
    const on = recordRecapRun(db, {
      scopeKind: 'session_current',
      sessionIds: ['b'],
      renderer: 'human',
      usedLlm: true,
    });
    expect(getRecapRun(db, off.id)?.usedLlm).toBe(false);
    expect(getRecapRun(db, on.id)?.usedLlm).toBe(true);
  });

  test('malformed session_ids JSON surfaces as empty array (defensive)', () => {
    const run = recordRecapRun(db, {
      scopeKind: 'session_current',
      sessionIds: ['real'],
      renderer: 'human',
      usedLlm: false,
    });
    db.query("UPDATE recap_runs SET session_ids = '{not-json' WHERE id = ?").run(run.id);
    const fetched = getRecapRun(db, run.id);
    expect(fetched?.sessionIds).toEqual([]);
  });
});
