import { beforeEach, describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../../src/storage/db.ts';
import type { DB } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  completeSession,
  countSessions,
  createSession,
  cumulativeCostUsd,
  getSession,
  listChildSessions,
  listSessions,
  reclassifySessionStatus,
  reopenSession,
  updateSessionCost,
} from '../../src/storage/repos/sessions.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

describe('sessions repo', () => {
  test('creates a session in running status', () => {
    const s = createSession(db, { model: 'claude-opus-4-7', cwd: '/tmp/proj' });
    expect(typeof s.id).toBe('string');
    expect(s.status).toBe('running');
    expect(s.endedAt).toBeNull();
    expect(s.totalCostUsd).toBe(0);
  });

  test('roundtrip: create then get matches', () => {
    const created = createSession(db, { model: 'claude-opus-4-7', cwd: '/tmp/proj' });
    expect(getSession(db, created.id)).toEqual(created);
  });

  test('getSession returns null for unknown id', () => {
    expect(getSession(db, 'unknown')).toBeNull();
  });

  test('listSessions orders by started_at DESC', () => {
    createSession(db, { model: 'm', cwd: '/p', startedAt: 1000 });
    createSession(db, { model: 'm', cwd: '/p', startedAt: 3000 });
    createSession(db, { model: 'm', cwd: '/p', startedAt: 2000 });
    const list = listSessions(db);
    expect(list.map((s) => s.startedAt)).toEqual([3000, 2000, 1000]);
  });

  test('listSessions filters by cwd and status', () => {
    createSession(db, { model: 'm', cwd: '/a' });
    createSession(db, { model: 'm', cwd: '/b' });
    const session = createSession(db, { model: 'm', cwd: '/a' });
    completeSession(db, session.id, 'done', 0.5, true);
    expect(listSessions(db, { cwd: '/a' })).toHaveLength(2);
    expect(listSessions(db, { status: 'done' })).toHaveLength(1);
    expect(listSessions(db, { cwd: '/a', status: 'done' })).toHaveLength(1);
    expect(listSessions(db, { cwd: '/b', status: 'done' })).toHaveLength(0);
  });

  test('listSessions respects limit', () => {
    for (let i = 0; i < 5; i++) {
      createSession(db, { model: 'm', cwd: '/p', startedAt: 1000 + i });
    }
    expect(listSessions(db, { limit: 3 })).toHaveLength(3);
  });

  test('completeSession transitions running to terminal', () => {
    const s = createSession(db, { model: 'm', cwd: '/p' });
    completeSession(db, s.id, 'done', 1.23, true);
    const fetched = getSession(db, s.id);
    expect(fetched?.status).toBe('done');
    expect(fetched?.totalCostUsd).toBe(1.23);
    expect(fetched?.usageComplete).toBe(true);
    expect(typeof fetched?.endedAt).toBe('number');
  });

  test('completeSession persists usageComplete=false for partial telemetry', () => {
    const s = createSession(db, { model: 'm', cwd: '/p' });
    completeSession(db, s.id, 'interrupted', 0.42, false);
    const fetched = getSession(db, s.id);
    expect(fetched?.totalCostUsd).toBe(0.42);
    expect(fetched?.usageComplete).toBe(false);
  });

  test('completeSession refuses to re-terminate a finished session', () => {
    const s = createSession(db, { model: 'm', cwd: '/p' });
    completeSession(db, s.id, 'done', 0, true);
    expect(() => completeSession(db, s.id, 'done', 0, true)).toThrow(/not in 'running' state/);
  });

  test('completeSession rejects unknown session', () => {
    expect(() => completeSession(db, 'nope', 'done', 0, true)).toThrow(/not found/);
  });

  test('completeSession persists abortCause when provided (1.g.2)', () => {
    const sSoft = createSession(db, { model: 'm', cwd: '/p' });
    completeSession(db, sSoft.id, 'interrupted', 0.1, true, undefined, 'soft');
    expect(getSession(db, sSoft.id)?.abortCause).toBe('soft');

    const sHard = createSession(db, { model: 'm', cwd: '/p' });
    completeSession(db, sHard.id, 'interrupted', 0.2, true, undefined, 'hard');
    expect(getSession(db, sHard.id)?.abortCause).toBe('hard');
  });

  test('completeSession leaves abortCause null when not provided', () => {
    // Non-abort terminal status (done) shouldn't carry the discriminator.
    const s = createSession(db, { model: 'm', cwd: '/p' });
    completeSession(db, s.id, 'done', 0, true);
    expect(getSession(db, s.id)?.abortCause).toBeNull();
  });

  test('completeSession CHECK constraint rejects invalid abortCause values', () => {
    // The CHECK constraint on the column is the last line of defense
    // against a typo or a future producer regression. Bypass the
    // typed completeSession helper and write the bad value directly
    // to verify SQLite catches it.
    const s = createSession(db, { model: 'm', cwd: '/p' });
    expect(() => {
      db.query(
        "UPDATE sessions SET status='interrupted', abort_cause='cooperative' WHERE id = ?",
      ).run(s.id);
    }).toThrow();
  });

  test('updateSessionCost overwrites the cost field', () => {
    const s = createSession(db, { model: 'm', cwd: '/p' });
    updateSessionCost(db, s.id, 0.01);
    expect(getSession(db, s.id)?.totalCostUsd).toBe(0.01);
    updateSessionCost(db, s.id, 0.05);
    expect(getSession(db, s.id)?.totalCostUsd).toBe(0.05);
  });

  test('listSessions ties on same started_at follow insertion order (newest first)', () => {
    // Direct regression for migration 008. Without the seq
    // tiebreaker, two sessions sharing started_at fall back to
    // SQLite's implementation-defined order; --resume last would
    // attach to whichever the impl picked first, possibly an
    // older session. With seq DESC as the secondary key, the
    // most-recently-inserted session wins deterministically.
    const ms = 1_700_000_000_000;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(createSession(db, { model: 'm', cwd: '/p', startedAt: ms }).id);
    }
    const list = listSessions(db, { limit: 5 });
    // Newest-first: ids inserted last appear first in the listing.
    expect(list.map((s) => s.id)).toEqual([...ids].reverse());
    // 'last' resolution (limit=1) returns the most-recently-inserted.
    const last = listSessions(db, { limit: 1 });
    expect(last[0]?.id).toBe(ids[ids.length - 1]);
  });

  test('CHECK constraint rejects invalid status at the SQL layer', () => {
    expect(() =>
      db.exec(
        'INSERT INTO sessions (id, started_at, model, cwd, status, total_cost_usd) ' +
          "VALUES ('x', 0, 'm', '/p', 'bogus', 0)",
      ),
    ).toThrow();
  });

  test('reopenSession flips a finished session back to running', () => {
    // Resume continuation reuses a prior session id; without
    // reopen, completeSession at the end of the resumed run trips
    // its WHERE status='running' guard.
    const s = createSession(db, { model: 'm', cwd: '/p' });
    completeSession(db, s.id, 'done', 0.5, true);
    expect(getSession(db, s.id)?.status).toBe('done');
    reopenSession(db, s.id);
    expect(getSession(db, s.id)?.status).toBe('running');
    expect(getSession(db, s.id)?.endedAt).toBeNull();
    // completeSession should now succeed again on the resumed run.
    completeSession(db, s.id, 'done', 1.5, true);
    expect(getSession(db, s.id)?.status).toBe('done');
    expect(getSession(db, s.id)?.totalCostUsd).toBe(1.5);
  });

  test('reopenSession is idempotent on an already-running session', () => {
    const s = createSession(db, { model: 'm', cwd: '/p' });
    expect(() => reopenSession(db, s.id)).not.toThrow();
    expect(getSession(db, s.id)?.status).toBe('running');
  });

  test('reopenSession rejects unknown id', () => {
    expect(() => reopenSession(db, 'nope')).toThrow(/not found/);
  });

  test('parent_session_id defaults to null for top-level runs', () => {
    const s = createSession(db, { model: 'm', cwd: '/p' });
    expect(s.parentSessionId).toBeNull();
    expect(s.isSubagent).toBe(false);
    const fetched = getSession(db, s.id);
    expect(fetched?.parentSessionId).toBeNull();
    expect(fetched?.isSubagent).toBe(false);
  });

  test('parent_session_id round-trips when set on a child', () => {
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    const child = createSession(db, {
      model: 'm',
      cwd: '/p',
      parentSessionId: parent.id,
    });
    expect(child.parentSessionId).toBe(parent.id);
    expect(child.isSubagent).toBe(true);
    const fetched = getSession(db, child.id);
    expect(fetched?.parentSessionId).toBe(parent.id);
    expect(fetched?.isSubagent).toBe(true);
  });

  test('listSessions hides children unless includeSubagents is true', () => {
    // Default listing is the user-facing one — only top-level rows.
    // --include-subagents flips the gate for audit/debug listings.
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    createSession(db, { model: 'm', cwd: '/p', parentSessionId: parent.id });
    createSession(db, { model: 'm', cwd: '/p', parentSessionId: parent.id });
    expect(listSessions(db)).toHaveLength(1);
    expect(listSessions(db, { includeSubagents: true })).toHaveLength(3);
  });

  test('isSubagent override flags a parentless row as hidden', () => {
    // Synthetic anchor rows (REPL slash playbook dispatches before
    // any real turn) are parentless but audit-only; they should NOT
    // surface as user-facing sessions even though
    // `parentSessionId` is null. The override flips is_subagent
    // explicitly so the default listing AND `--resume last` skip
    // them.
    const synthetic = createSession(db, { model: 'm', cwd: '/p', isSubagent: true });
    expect(synthetic.parentSessionId).toBeNull();
    expect(synthetic.isSubagent).toBe(true);
    const fetched = getSession(db, synthetic.id);
    expect(fetched?.isSubagent).toBe(true);
    // Default listing — synthetic must be hidden.
    expect(listSessions(db, { cwd: '/p' })).toHaveLength(0);
    // `--resume last` shape: limit:1 over the cwd, default
    // is_subagent filter. Should return nothing — there is no
    // real conversation in /p, so resume falls back to "no
    // session".
    expect(listSessions(db, { cwd: '/p', limit: 1 })).toHaveLength(0);
    // Only includeSubagents:true surfaces the synthetic — used
    // by audit / debug paths that legitimately want to see
    // every row.
    expect(listSessions(db, { cwd: '/p', includeSubagents: true })).toHaveLength(1);
  });

  test('reclassifySessionStatus flips a finalized row from done to error', () => {
    // Used by post-finalize failure detection — the playbook
    // schema validator runs AFTER runAgent finalized the row
    // to `done`, and a schema mismatch needs to mark the row
    // as failed so audit queries keyed on `sessions.status`
    // count the run correctly.
    const s = createSession(db, { model: 'm', cwd: '/p' });
    completeSession(db, s.id, 'done', 0, true);
    reclassifySessionStatus(db, s.id, 'done', 'error');
    const row = getSession(db, s.id);
    expect(row?.status).toBe('error');
  });

  test('reclassifySessionStatus throws when the row is not in the expected state', () => {
    // Strict precondition guard: refusing to override unknown
    // states keeps `completeSession` as the canonical finalize
    // path. A typo'd from-state surfaces at write time rather
    // than silently no-op'ing.
    const s = createSession(db, { model: 'm', cwd: '/p' });
    // Row is 'running' — calling with expectedFrom='done' must throw.
    expect(() => reclassifySessionStatus(db, s.id, 'done', 'error')).toThrow(
      /not in expected 'done' state/,
    );
    // Finalize as 'done', then try to flip from 'interrupted' — must throw.
    completeSession(db, s.id, 'done', 0, true);
    expect(() => reclassifySessionStatus(db, s.id, 'interrupted', 'error')).toThrow(
      /not in expected 'interrupted' state/,
    );
  });

  test('reclassifySessionStatus throws when the session does not exist', () => {
    expect(() => reclassifySessionStatus(db, 'missing-id', 'done', 'error')).toThrow(
      /session missing-id not found/,
    );
  });

  test('synthetic parent does not shadow a real session in --resume last', () => {
    // The exact scenario the bug report describes: operator runs
    // a slash playbook (synthetic created), then types a normal
    // prompt (real session created). `--resume last` must pick
    // the real session, not the synthetic that happened to be
    // newer when its row landed.
    const real = createSession(db, { model: 'm', cwd: '/p', startedAt: 1000 });
    // Synthetic created LATER (newer started_at) — without the
    // is_subagent flag this would shadow the real session in
    // limit:1 ordering. Pinning startedAt makes the test
    // deterministic regardless of system clock granularity.
    createSession(db, {
      model: 'm',
      cwd: '/p',
      isSubagent: true,
      startedAt: 2000,
    });
    const last = listSessions(db, { cwd: '/p', limit: 1 });
    expect(last).toHaveLength(1);
    expect(last[0]?.id).toBe(real.id);
  });

  test('listChildSessions returns children oldest-first', () => {
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    const c1 = createSession(db, {
      model: 'm',
      cwd: '/p',
      parentSessionId: parent.id,
      startedAt: 1000,
    });
    const c2 = createSession(db, {
      model: 'm',
      cwd: '/p',
      parentSessionId: parent.id,
      startedAt: 2000,
    });
    const list = listChildSessions(db, parent.id);
    expect(list.map((s) => s.id)).toEqual([c1.id, c2.id]);
  });

  test('parent deletion sets child parent_session_id to null (not cascade)', () => {
    // Spec §11 + migration 010: child audit trail must survive
    // a parent retention purge. Cost incurred by the child IS
    // billed history; cascading would erase it.
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    const child = createSession(db, {
      model: 'm',
      cwd: '/p',
      parentSessionId: parent.id,
    });
    db.query('DELETE FROM sessions WHERE id = ?').run(parent.id);
    const fetched = getSession(db, child.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.parentSessionId).toBeNull();
  });

  test('orphaned subagent stays excluded from default top-level listing', () => {
    // Migration 011 fix. The original filter used
    // `parent_session_id IS NULL` as the top-level predicate, but
    // ON DELETE SET NULL turns purged children into rows with
    // null parent_session_id — those would re-surface in the
    // user-facing listing AND get picked up by `--resume last`
    // (which calls listSessions(limit:1)). is_subagent is the
    // identity flag set at create time and never updated, so
    // orphans stay flagged.
    const parent = createSession(db, { model: 'm', cwd: '/p', startedAt: 1000 });
    const child = createSession(db, {
      model: 'm',
      cwd: '/p',
      parentSessionId: parent.id,
      startedAt: 9999,
    });
    // Simulate retention purge of the parent.
    db.query('DELETE FROM sessions WHERE id = ?').run(parent.id);
    // After purge: child still exists, parent_session_id is now
    // NULL (SET NULL fired), but is_subagent stays 1.
    const refetched = getSession(db, child.id);
    expect(refetched?.parentSessionId).toBeNull();
    expect(refetched?.isSubagent).toBe(true);

    // Default listing must NOT surface the orphaned child as
    // top-level, even though it now satisfies the old
    // parent_session_id IS NULL predicate.
    const topLevel = listSessions(db);
    expect(topLevel).toHaveLength(0);

    // includeSubagents:true brings it back for raw audit queries.
    const all = listSessions(db, { includeSubagents: true });
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(child.id);
    expect(all[0]?.isSubagent).toBe(true);
  });

  test('countSessions: respects same filters as listSessions, ignores limit', () => {
    // Companion to listSessions for the truncation hint in
    // --list-sessions. The CLI needs to know the TOTAL count
    // matching its filters so the omitted-from-listing figure is
    // accurate. Filters (cwd, status, includeSubagents) must
    // mirror listSessions; the limit is intentionally ignored.
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    completeSession(db, parent.id, 'done', 0, true);
    createSession(db, { model: 'm', cwd: '/p', parentSessionId: parent.id });
    createSession(db, { model: 'm', cwd: '/q' });
    // Default: top-level only (is_subagent=0). 2 rows match.
    expect(countSessions(db)).toBe(2);
    // Filter by cwd narrows further.
    expect(countSessions(db, { cwd: '/p' })).toBe(1);
    expect(countSessions(db, { cwd: '/q' })).toBe(1);
    // Filter by status narrows on completion.
    expect(countSessions(db, { status: 'done' })).toBe(1);
    expect(countSessions(db, { status: 'running' })).toBe(1);
    // Combined filters AND.
    expect(countSessions(db, { cwd: '/p', status: 'done' })).toBe(1);
    expect(countSessions(db, { cwd: '/q', status: 'done' })).toBe(0);
    // includeSubagents flips the gate to count children too.
    expect(countSessions(db, { includeSubagents: true })).toBe(3);
  });

  test('countSessions: returns 0 on empty DB', () => {
    expect(countSessions(db)).toBe(0);
  });

  test('cumulativeCostUsd: leaf row returns its own cost', () => {
    const s = createSession(db, { model: 'm', cwd: '/p' });
    updateSessionCost(db, s.id, 0.0042);
    expect(cumulativeCostUsd(db, s.id)).toBeCloseTo(0.0042, 9);
  });

  test('cumulativeCostUsd: walks descendants and sums', () => {
    // Tree: root → c1 → gc1
    //              → c2
    // Costs: root=$0.001, c1=$0.002, gc1=$0.003, c2=$0.004
    // Sum: 0.010
    const root = createSession(db, { model: 'm', cwd: '/p' });
    updateSessionCost(db, root.id, 0.001);
    const c1 = createSession(db, { model: 'm', cwd: '/p', parentSessionId: root.id });
    updateSessionCost(db, c1.id, 0.002);
    const gc1 = createSession(db, { model: 'm', cwd: '/p', parentSessionId: c1.id });
    updateSessionCost(db, gc1.id, 0.003);
    const c2 = createSession(db, { model: 'm', cwd: '/p', parentSessionId: root.id });
    updateSessionCost(db, c2.id, 0.004);
    expect(cumulativeCostUsd(db, root.id)).toBeCloseTo(0.01, 9);
    // Sub-tree from c1: c1 + gc1 = 0.005
    expect(cumulativeCostUsd(db, c1.id)).toBeCloseTo(0.005, 9);
    // Leaf
    expect(cumulativeCostUsd(db, gc1.id)).toBeCloseTo(0.003, 9);
  });

  test('cumulativeCostUsd: orphan with surviving descendants still rolls them up', () => {
    // The orphan exclusion is about NOT rolling the orphan's
    // cost up to its (deleted) parent — the FK link is gone.
    // Walking DOWNWARD from the orphan still works because the
    // grandchild's parent_session_id points at the orphan, which
    // exists. Without this test, a future "orphan exclusion"
    // refactor that filters by parent_session_id IS NOT NULL on
    // the orphan itself would silently break the rollup.
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    const orphan = createSession(db, { model: 'm', cwd: '/p', parentSessionId: parent.id });
    updateSessionCost(db, orphan.id, 0.01);
    const grandchild = createSession(db, {
      model: 'm',
      cwd: '/p',
      parentSessionId: orphan.id,
    });
    updateSessionCost(db, grandchild.id, 0.02);
    db.query('DELETE FROM sessions WHERE id = ?').run(parent.id);
    // Walking from the orphan: orphan + grandchild = 0.03.
    expect(cumulativeCostUsd(db, orphan.id)).toBeCloseTo(0.03, 9);
  });

  test('cumulativeCostUsd: orphans (parent purged) do NOT count', () => {
    // FK is the rollup channel. After the parent is deleted the
    // child's parent_session_id goes NULL via SET NULL — there's
    // no live tree to walk from the (now-gone) root. The orphan's
    // cost stays on its own row but doesn't roll up to anyone.
    // An audit pass that wants total spend including detached
    // children iterates listSessions({includeSubagents:true})
    // directly.
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    updateSessionCost(db, parent.id, 0.001);
    const child = createSession(db, { model: 'm', cwd: '/p', parentSessionId: parent.id });
    updateSessionCost(db, child.id, 0.5);
    db.query('DELETE FROM sessions WHERE id = ?').run(parent.id);
    // Child still exists, but it has no live parent to roll up to.
    // Walking from the orphan returns just the orphan's own cost.
    expect(cumulativeCostUsd(db, child.id)).toBeCloseTo(0.5, 9);
  });

  test('cumulativeCostUsd: returns 0 for unknown id', () => {
    expect(cumulativeCostUsd(db, 'nope')).toBe(0);
  });

  test('cumulativeCostUsd: defense against self-referential row', () => {
    // Cycle protection. The seen-set prevents an infinite loop
    // when a corrupt write makes parent_session_id point at the
    // row's own id. We emit the row's cost exactly once.
    const s = createSession(db, { model: 'm', cwd: '/p' });
    updateSessionCost(db, s.id, 0.123);
    db.query('UPDATE sessions SET parent_session_id = id WHERE id = ?').run(s.id);
    expect(cumulativeCostUsd(db, s.id)).toBeCloseTo(0.123, 9);
  });

  test('migration 011 backfill: pre-existing rows with parent_session_id are flagged', () => {
    // Defense for the migration's UPDATE clause. The migration
    // sets is_subagent=1 for any existing row that already had a
    // parent_session_id at upgrade time. We can't run the bare
    // migration here (test DB starts fully migrated), but we can
    // verify that a row inserted today via createSession with a
    // parentSessionId lands with is_subagent=1 — same code path
    // the migration's invariant relies on.
    const parent = createSession(db, { model: 'm', cwd: '/p' });
    const child = createSession(db, {
      model: 'm',
      cwd: '/p',
      parentSessionId: parent.id,
    });
    const raw = db
      .query<{ is_subagent: number }, [string]>('SELECT is_subagent FROM sessions WHERE id = ?')
      .get(child.id);
    expect(raw?.is_subagent).toBe(1);
  });
});
