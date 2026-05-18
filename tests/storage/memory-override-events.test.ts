// memory_override_events repo tests (migration 064, S3.1 substrate).
//
// Pin the substrate contracts so the threshold detector (S3.4) and
// the operator-facing status surface (S3.6) can build on stable
// behavior:
//   - INSERT validates scope, signal, name, createdAt.
//   - Counter respects the sliding-window cutoff (inclusive on
//     lower bound).
//   - Listing helpers return rows ordered + scoped correctly.
//   - Cursor poll honors the (createdAt, id) lex tuple so same-ms
//     inserts don't get skipped.
//   - Retention prune uses exclusive cutoff (boundary row KEPT).

import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  MEMORY_OVERRIDE_THRESHOLD_COUNT,
  MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS,
  countOverridesInWindow,
  listOverrideEventsSince,
  listRecentOverridesForMemory,
  pruneOverrideEvents,
  recordOverrideEvent,
} from '../../src/storage/repos/memory-override-events.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;
let sessionId: string;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
});

describe('recordOverrideEvent — validation', () => {
  test('persists well-formed memory_write_rejected row', () => {
    const r = recordOverrideEvent(db, {
      sessionId,
      memoryScope: 'project_local',
      memoryName: 'foo',
      signal: 'memory_write_rejected',
      details: { proposed_name: 'foo', reason: 'too speculative' },
      createdAt: 2_000_000_000_000,
    });
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    const rows = listRecentOverridesForMemory(db, 'project_local', 'foo');
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row?.signal).toBe('memory_write_rejected');
    expect(row?.sessionId).toBe(sessionId);
    expect(row?.toolCallId).toBeNull();
    expect(row?.details).toEqual({ proposed_name: 'foo', reason: 'too speculative' });
  });

  test('rejects invalid scope', () => {
    expect(() =>
      recordOverrideEvent(db, {
        sessionId,
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid scope
        memoryScope: 'invalid' as any,
        memoryName: 'foo',
        signal: 'memory_write_rejected',
      }),
    ).toThrow(/invalid memoryScope/);
  });

  test('rejects empty memoryName', () => {
    expect(() =>
      recordOverrideEvent(db, {
        sessionId,
        memoryScope: 'project_local',
        memoryName: '',
        signal: 'memory_write_rejected',
      }),
    ).toThrow(/memoryName/);
  });

  test('rejects invalid signal', () => {
    expect(() =>
      recordOverrideEvent(db, {
        sessionId,
        memoryScope: 'project_local',
        memoryName: 'foo',
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid signal
        signal: 'unknown' as any,
      }),
    ).toThrow(/invalid signal/);
  });

  test('rejects non-positive createdAt', () => {
    expect(() =>
      recordOverrideEvent(db, {
        sessionId,
        memoryScope: 'project_local',
        memoryName: 'foo',
        signal: 'memory_write_rejected',
        createdAt: 0,
      }),
    ).toThrow(/createdAt must be > 0/);
  });

  test('sessionId NULL preserves cross-session threshold counter intent', () => {
    // SET NULL FK posture: a row without session attribution is
    // legal (boot-time replay paths, future operator-driven manual
    // signal). The counter doesn't filter by session.
    const r = recordOverrideEvent(db, {
      sessionId: null,
      memoryScope: 'user',
      memoryName: 'bar',
      signal: 'edit_reverted',
      createdAt: 2_000_000_000_500,
    });
    const rows = listRecentOverridesForMemory(db, 'user', 'bar');
    expect(rows[0]?.id).toBe(r.id);
    expect(rows[0]?.sessionId).toBeNull();
  });

  test('malformed details JSON parses to null on read (best-effort)', () => {
    // Bypass repo to inject malformed JSON directly — exercises
    // the parser's tolerance to corrupted rows.
    const id = crypto.randomUUID();
    db.query(
      `INSERT INTO memory_override_events
         (id, session_id, memory_scope, memory_name, signal,
          tool_call_id, details, created_at)
        VALUES (?, NULL, 'project_local', 'foo',
                'memory_write_rejected', NULL, '{not json', ?)`,
    ).run(id, 2_000_000_000_000);
    const rows = listRecentOverridesForMemory(db, 'project_local', 'foo');
    expect(rows[0]?.id).toBe(id);
    expect(rows[0]?.details).toBeNull();
  });
});

describe('countOverridesInWindow', () => {
  test('threshold boundary: 3 hits in 24h returns 3; 2 returns 2', () => {
    const now = 2_000_000_000_000;
    // 3 hits within window.
    for (let i = 0; i < MEMORY_OVERRIDE_THRESHOLD_COUNT; i++) {
      recordOverrideEvent(db, {
        sessionId,
        memoryScope: 'project_local',
        memoryName: 'foo',
        signal: 'permission_denied',
        createdAt: now - i * 1000,
      });
    }
    expect(
      countOverridesInWindow(db, 'project_local', 'foo', MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS, now),
    ).toBe(3);

    // Sub-threshold for an adjacent memory.
    recordOverrideEvent(db, {
      sessionId,
      memoryScope: 'project_local',
      memoryName: 'bar',
      signal: 'memory_write_rejected',
      createdAt: now,
    });
    recordOverrideEvent(db, {
      sessionId,
      memoryScope: 'project_local',
      memoryName: 'bar',
      signal: 'memory_write_rejected',
      createdAt: now - 1000,
    });
    expect(
      countOverridesInWindow(db, 'project_local', 'bar', MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS, now),
    ).toBe(2);
  });

  test('events older than the window are excluded', () => {
    const now = 2_000_000_000_000;
    // 1 hit just inside the window.
    recordOverrideEvent(db, {
      sessionId,
      memoryScope: 'user',
      memoryName: 'foo',
      signal: 'permission_denied',
      createdAt: now - MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS + 1,
    });
    // 1 hit just outside (older than window).
    recordOverrideEvent(db, {
      sessionId,
      memoryScope: 'user',
      memoryName: 'foo',
      signal: 'permission_denied',
      createdAt: now - MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS - 1,
    });
    expect(
      countOverridesInWindow(db, 'user', 'foo', MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS, now),
    ).toBe(1);
  });

  test('events at the cutoff boundary are INCLUDED (inclusive lower bound)', () => {
    const now = 2_000_000_000_000;
    recordOverrideEvent(db, {
      sessionId,
      memoryScope: 'user',
      memoryName: 'foo',
      signal: 'edit_reverted',
      createdAt: now - MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS,
    });
    expect(
      countOverridesInWindow(db, 'user', 'foo', MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS, now),
    ).toBe(1);
  });

  test('different scopes do not collide', () => {
    const now = 2_000_000_000_000;
    recordOverrideEvent(db, {
      sessionId,
      memoryScope: 'project_local',
      memoryName: 'foo',
      signal: 'permission_denied',
      createdAt: now,
    });
    recordOverrideEvent(db, {
      sessionId,
      memoryScope: 'user',
      memoryName: 'foo',
      signal: 'permission_denied',
      createdAt: now,
    });
    expect(
      countOverridesInWindow(db, 'project_local', 'foo', MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS, now),
    ).toBe(1);
    expect(
      countOverridesInWindow(db, 'user', 'foo', MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS, now),
    ).toBe(1);
  });

  test('rejects invalid scope + non-positive windowMs', () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid scope
      countOverridesInWindow(db, 'bogus' as any, 'foo', 1000),
    ).toThrow(/invalid scope/);
    expect(() => countOverridesInWindow(db, 'user', 'foo', 0)).toThrow(/windowMs/);
  });
});

describe('listRecentOverridesForMemory', () => {
  test('returns rows DESC by createdAt with tiebreak by id DESC', () => {
    const now = 2_000_000_000_000;
    const r1 = recordOverrideEvent(db, {
      sessionId,
      memoryScope: 'project_local',
      memoryName: 'foo',
      signal: 'permission_denied',
      createdAt: now - 1000,
    });
    const r2 = recordOverrideEvent(db, {
      sessionId,
      memoryScope: 'project_local',
      memoryName: 'foo',
      signal: 'permission_denied',
      createdAt: now,
    });
    const rows = listRecentOverridesForMemory(db, 'project_local', 'foo');
    expect(rows.length).toBe(2);
    expect(rows[0]?.id).toBe(r2.id); // newer first
    expect(rows[1]?.id).toBe(r1.id);
  });

  test('respects limit', () => {
    const now = 2_000_000_000_000;
    for (let i = 0; i < 5; i++) {
      recordOverrideEvent(db, {
        sessionId,
        memoryScope: 'project_local',
        memoryName: 'foo',
        signal: 'memory_write_rejected',
        createdAt: now - i * 1000,
      });
    }
    expect(listRecentOverridesForMemory(db, 'project_local', 'foo', 2).length).toBe(2);
  });
});

describe('listOverrideEventsSince — scheduler cursor', () => {
  test('returns events strictly after (createdAt, id) cursor', () => {
    const now = 2_000_000_000_000;
    const r1 = recordOverrideEvent(db, {
      sessionId,
      memoryScope: 'project_local',
      memoryName: 'foo',
      signal: 'memory_write_rejected',
      createdAt: now,
    });
    const r2 = recordOverrideEvent(db, {
      sessionId,
      memoryScope: 'project_local',
      memoryName: 'foo',
      signal: 'memory_write_rejected',
      createdAt: now + 1000,
    });
    // Cursor at (now, r1.id) — r1 is the cursor row itself so it
    // should be EXCLUDED; r2 is later so included.
    const events = listOverrideEventsSince(db, now, r1.id);
    expect(events.length).toBe(1);
    expect(events[0]?.id).toBe(r2.id);
  });

  test('same-ms inserts ordered by id lex; cursor mid-batch skips the consumed ones', () => {
    const now = 2_000_000_000_000;
    // Insert 3 rows all at the same createdAt; the (createdAt, id)
    // tuple ordering breaks the tie. Pre-seed ids so we control the
    // order deterministically.
    const idA = '00000000-0000-0000-0000-000000000001';
    const idB = '00000000-0000-0000-0000-000000000002';
    const idC = '00000000-0000-0000-0000-000000000003';
    for (const id of [idA, idB, idC]) {
      recordOverrideEvent(db, {
        id,
        sessionId,
        memoryScope: 'project_local',
        memoryName: 'foo',
        signal: 'memory_write_rejected',
        createdAt: now,
      });
    }
    // Cursor at (now, idA) — should return B and C.
    const after = listOverrideEventsSince(db, now, idA);
    expect(after.map((e) => e.id)).toEqual([idB, idC]);
  });

  test('respects limit', () => {
    const now = 2_000_000_000_000;
    for (let i = 0; i < 5; i++) {
      recordOverrideEvent(db, {
        sessionId,
        memoryScope: 'project_local',
        memoryName: 'foo',
        signal: 'memory_write_rejected',
        createdAt: now + i,
      });
    }
    expect(listOverrideEventsSince(db, 0, '', 2).length).toBe(2);
  });
});

describe('pruneOverrideEvents', () => {
  test('deletes rows older than cutoff (exclusive); boundary row KEPT', () => {
    const now = 2_000_000_000_000;
    const old = recordOverrideEvent(db, {
      sessionId,
      memoryScope: 'project_local',
      memoryName: 'foo',
      signal: 'memory_write_rejected',
      createdAt: now - 1,
    });
    const onBoundary = recordOverrideEvent(db, {
      sessionId,
      memoryScope: 'project_local',
      memoryName: 'foo',
      signal: 'memory_write_rejected',
      createdAt: now,
    });
    const fresh = recordOverrideEvent(db, {
      sessionId,
      memoryScope: 'project_local',
      memoryName: 'foo',
      signal: 'memory_write_rejected',
      createdAt: now + 1,
    });
    const deleted = pruneOverrideEvents(db, now);
    expect(deleted).toBe(1);
    const remaining = listRecentOverridesForMemory(db, 'project_local', 'foo')
      .map((r) => r.id)
      .sort();
    expect(remaining).toEqual([onBoundary.id, fresh.id].sort());
    expect(remaining).not.toContain(old.id);
  });

  test('rejects non-positive olderThanMs', () => {
    expect(() => pruneOverrideEvents(db, 0)).toThrow(/olderThanMs/);
  });
});

describe('FK SET NULL behavior', () => {
  test('purging the session drops session_id but keeps the row + counter', () => {
    const now = 2_000_000_000_000;
    recordOverrideEvent(db, {
      sessionId,
      memoryScope: 'project_local',
      memoryName: 'foo',
      signal: 'permission_denied',
      createdAt: now,
    });
    // Purge the session (cascade is FK from memory_override_events
    // to sessions; ON DELETE SET NULL keeps the row).
    db.query('DELETE FROM sessions WHERE id = ?').run(sessionId);
    const rows = listRecentOverridesForMemory(db, 'project_local', 'foo');
    expect(rows.length).toBe(1);
    expect(rows[0]?.sessionId).toBeNull();
    // Counter still counts it.
    expect(
      countOverridesInWindow(db, 'project_local', 'foo', MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS, now),
    ).toBe(1);
  });
});
