import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import {
  getSubagentOutput,
  insertSubagentOutput,
  listStaleSubagentOutputs,
  setSubagentPayload,
  updateSubagentHeartbeat,
} from '../../src/storage/repos/subagent-outputs.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

const seedSession = (parentId?: string) =>
  createSession(db, {
    model: 'm',
    cwd: '/p',
    ...(parentId !== undefined ? { parentSessionId: parentId } : {}),
  });

describe('subagent_outputs repo', () => {
  test('insert + get round-trip with all fields populated', () => {
    const child = seedSession(seedSession().id);
    insertSubagentOutput(db, {
      sessionId: child.id,
      payload: { status: 'done', output: 'hello', cost_usd: 0.0042 },
      lastHeartbeat: 1_700_000_000_000,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
    });
    const row = getSubagentOutput(db, child.id);
    expect(row).not.toBeNull();
    expect(row?.sessionId).toBe(child.id);
    expect(row?.payload).toEqual({ status: 'done', output: 'hello', cost_usd: 0.0042 });
    expect(row?.lastHeartbeat).toBe(1_700_000_000_000);
    expect(row?.createdAt).toBe(1_700_000_000_000);
    expect(row?.updatedAt).toBe(1_700_000_001_000);
  });

  test('insert with default null payload and null heartbeat (pre-spawn shape)', () => {
    // The subprocess flow inserts at startup, BEFORE the child has
    // anything to publish. payload + lastHeartbeat both null is
    // the canonical "row exists but child not active yet" state.
    const child = seedSession(seedSession().id);
    insertSubagentOutput(db, { sessionId: child.id });
    const row = getSubagentOutput(db, child.id);
    expect(row?.payload).toBeNull();
    expect(row?.lastHeartbeat).toBeNull();
    // Both timestamps default from Date.now(); we don't assert
    // exact values, just non-zero and consistent.
    expect(row?.createdAt).toBeGreaterThan(0);
    expect(row?.updatedAt).toBe(row?.createdAt);
  });

  test('PK conflict on second insert for the same session_id', () => {
    // Contract: only the child subprocess inserts, exactly once.
    // A second insert for the same session is a sequencing bug
    // and must fail loud, not silently overwrite.
    const child = seedSession(seedSession().id);
    insertSubagentOutput(db, { sessionId: child.id });
    expect(() => insertSubagentOutput(db, { sessionId: child.id })).toThrow();
  });

  test('updateSubagentHeartbeat bumps both heartbeat and updated_at', () => {
    const child = seedSession(seedSession().id);
    insertSubagentOutput(db, {
      sessionId: child.id,
      createdAt: 100,
      updatedAt: 100,
    });
    updateSubagentHeartbeat(db, child.id, 200);
    const row = getSubagentOutput(db, child.id);
    expect(row?.lastHeartbeat).toBe(200);
    expect(row?.updatedAt).toBe(200);
    // created_at is immutable.
    expect(row?.createdAt).toBe(100);
  });

  test('updateSubagentHeartbeat on a missing row throws (programmer bug)', () => {
    expect(() => updateSubagentHeartbeat(db, 'nonexistent', 200)).toThrow(
      /no subagent_outputs row for session nonexistent/,
    );
  });

  test('setSubagentPayload writes terminal envelope and bumps heartbeat', () => {
    // A payload write is itself a liveness signal — there is no
    // scenario where the child publishes its terminal result and
    // the parent should still believe it's hung. The repo writes
    // both fields in the same UPDATE so consumers see them
    // atomically.
    const child = seedSession(seedSession().id);
    insertSubagentOutput(db, {
      sessionId: child.id,
      createdAt: 100,
      updatedAt: 100,
    });
    setSubagentPayload(db, child.id, { status: 'done', output: 'hi' }, 500);
    const row = getSubagentOutput(db, child.id);
    expect(row?.payload).toEqual({ status: 'done', output: 'hi' });
    expect(row?.lastHeartbeat).toBe(500);
    expect(row?.updatedAt).toBe(500);
  });

  test('setSubagentPayload on a missing row throws', () => {
    expect(() => setSubagentPayload(db, 'nonexistent', { status: 'done' })).toThrow(
      /no subagent_outputs row for session nonexistent/,
    );
  });

  test('FK CASCADE on session delete drops the outputs row', () => {
    const child = seedSession(seedSession().id);
    insertSubagentOutput(db, {
      sessionId: child.id,
      payload: { status: 'done' },
    });
    db.query('DELETE FROM sessions WHERE id = ?').run(child.id);
    expect(getSubagentOutput(db, child.id)).toBeNull();
  });

  test('parent-session purge does NOT cascade through parent_session_id', () => {
    // Mirror of the contract locked for migrations 012 and 013:
    // the FK on subagent_outputs targets sessions(id) directly,
    // not parent_session_id. A parent purge that ON DELETE SET
    // NULL's the child's parent_session_id leaves the child + its
    // outputs intact; only when the child session itself is
    // deleted does the outputs row vanish.
    const parent = seedSession();
    const child = seedSession(parent.id);
    insertSubagentOutput(db, {
      sessionId: child.id,
      payload: { status: 'done' },
    });
    db.query('DELETE FROM sessions WHERE id = ?').run(parent.id);
    const row = getSubagentOutput(db, child.id);
    expect(row).not.toBeNull();
    expect(row?.payload).toEqual({ status: 'done' });
  });

  test('malformed payload returns null defensively, surrounding columns intact', () => {
    // Storage corruption is unlikely (only our own code writes
    // payload), but a malformed JSON in TEXT must NOT crash an
    // audit listing. Repo returns payload=null and the rest of
    // the row uncorrupted; consumers detect via payload===null
    // paired with non-null timestamps.
    const child = seedSession(seedSession().id);
    db.query(
      `INSERT INTO subagent_outputs
         (session_id, payload, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(child.id, '{not valid json', 100, 100, 100);
    const row = getSubagentOutput(db, child.id);
    expect(row).not.toBeNull();
    expect(row?.payload).toBeNull();
    expect(row?.lastHeartbeat).toBe(100);
    expect(row?.createdAt).toBe(100);
  });

  test('non-object payload (array / scalar) treated as null on read', () => {
    // The repo's typed shape is `Record<string, unknown> | null`.
    // A JSON array or scalar is structurally valid but doesn't
    // match the contract; reading should yield null rather than
    // surfacing a shape the consumer wasn't typed for.
    const child = seedSession(seedSession().id);
    db.query(
      `INSERT INTO subagent_outputs
         (session_id, payload, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(child.id, '[1,2,3]', 100, 100, 100);
    expect(getSubagentOutput(db, child.id)?.payload).toBeNull();
  });

  test('listStaleSubagentOutputs surfaces oldest-heartbeat first, excludes nulls', () => {
    // The parent's timeout poller wants to act on the
    // longest-quiet children first; the index supports that
    // ordering. Rows with last_heartbeat IS NULL are excluded —
    // those represent pre-spawn or spawn-failed children that
    // the timeout subsystem doesn't own.
    const a = seedSession(seedSession().id);
    const b = seedSession(seedSession().id);
    const c = seedSession(seedSession().id);
    const d = seedSession(seedSession().id);
    insertSubagentOutput(db, { sessionId: a.id, lastHeartbeat: 100 });
    insertSubagentOutput(db, { sessionId: b.id, lastHeartbeat: 200 });
    insertSubagentOutput(db, { sessionId: c.id, lastHeartbeat: 50 });
    // d has never beat — must be excluded.
    insertSubagentOutput(db, { sessionId: d.id });
    const stale = listStaleSubagentOutputs(db, 150);
    expect(stale.map((r) => r.sessionId)).toEqual([c.id, a.id]);
  });

  test('listStaleSubagentOutputs returns [] when nothing is stale', () => {
    const a = seedSession(seedSession().id);
    insertSubagentOutput(db, { sessionId: a.id, lastHeartbeat: 1000 });
    expect(listStaleSubagentOutputs(db, 500)).toEqual([]);
  });

  test('getSubagentOutput returns null for an unknown session', () => {
    expect(getSubagentOutput(db, 'never-inserted')).toBeNull();
  });

  test('setSubagentPayload twice — second wins, ts moves forward (idempotent retry)', () => {
    // The doc treats setSubagentPayload as "called on last write
    // before exit", but the repo permits re-publish: a retried
    // final-write must end up with the latest envelope, not the
    // first one. Locks the contract so a future "throw on
    // re-publish" refactor surfaces here.
    //
    // Insert with explicit early ts so the MAX() guard on
    // updated_at doesn't keep the insert-time Date.now() value
    // (~1.7T) and obscure the assertion against the test's small
    // numeric ts.
    const child = seedSession(seedSession().id);
    insertSubagentOutput(db, { sessionId: child.id, createdAt: 1, updatedAt: 1 });
    setSubagentPayload(db, child.id, { status: 'done', output: 'first' }, 100);
    setSubagentPayload(db, child.id, { status: 'done', output: 'second' }, 200);
    const row = getSubagentOutput(db, child.id);
    expect(row?.payload).toEqual({ status: 'done', output: 'second' });
    expect(row?.lastHeartbeat).toBe(200);
    expect(row?.updatedAt).toBe(200);
  });

  test('empty object payload {} round-trips intact (boundary case)', () => {
    // Boundary between the non-object reject path (arrays, scalars
    // → null) and the valid Record<string, unknown> path. A
    // payload of {} is structurally a valid object with no keys;
    // it must survive the parse/serialize cycle as an empty
    // object, not collapse to null.
    const child = seedSession(seedSession().id);
    insertSubagentOutput(db, { sessionId: child.id });
    setSubagentPayload(db, child.id, {}, 100);
    const row = getSubagentOutput(db, child.id);
    expect(row?.payload).toEqual({});
    // Key distinction from the null-payload case: the value is
    // an object reference, not null.
    expect(row?.payload).not.toBeNull();
  });

  test('out-of-order heartbeat does NOT regress last_heartbeat (clock-skew defense)', () => {
    // C1 fix: NTP step backward on the child host, container
    // reinit, or VM migration between hosts with skewed clocks
    // can produce a heartbeat ts older than the previous one.
    // Without MAX() guard the column would roll back, the
    // parent's poller would see a healthy child as stale, and
    // SIGTERM it. The MAX(IFNULL(...,0), ?) clause keeps
    // last_heartbeat monotonically forward.
    const child = seedSession(seedSession().id);
    insertSubagentOutput(db, { sessionId: child.id, createdAt: 1, updatedAt: 1 });
    updateSubagentHeartbeat(db, child.id, 500);
    updateSubagentHeartbeat(db, child.id, 200); // backwards — must not regress
    expect(getSubagentOutput(db, child.id)?.lastHeartbeat).toBe(500);
    // Forward write still works.
    updateSubagentHeartbeat(db, child.id, 700);
    expect(getSubagentOutput(db, child.id)?.lastHeartbeat).toBe(700);
  });

  test('out-of-order setSubagentPayload does NOT regress timestamps (payload still overwrites)', () => {
    // Re-publish with an OLDER ts must still write the new
    // payload (the child's terminal envelope is authoritative)
    // but must NOT regress last_heartbeat or updated_at —
    // otherwise the parent's poller could mark a just-published
    // child as timed-out. Splits the two concerns: payload =
    // overwrite, ts columns = monotonic.
    const child = seedSession(seedSession().id);
    insertSubagentOutput(db, { sessionId: child.id, createdAt: 1, updatedAt: 1 });
    setSubagentPayload(db, child.id, { v: 1 }, 500);
    setSubagentPayload(db, child.id, { v: 2 }, 200); // backwards ts
    const row = getSubagentOutput(db, child.id);
    expect(row?.payload).toEqual({ v: 2 });
    expect(row?.lastHeartbeat).toBe(500);
    expect(row?.updatedAt).toBe(500);
  });

  test('payload survives a heartbeat-only update unchanged', () => {
    // Regression: heartbeat updates must NOT clobber the payload.
    // A child that publishes its terminal payload and then beats
    // one more time before exit (legal sequence) must end up
    // with both fields intact.
    const child = seedSession(seedSession().id);
    insertSubagentOutput(db, { sessionId: child.id });
    setSubagentPayload(db, child.id, { status: 'done', output: 'final' }, 200);
    updateSubagentHeartbeat(db, child.id, 300);
    const row = getSubagentOutput(db, child.id);
    expect(row?.payload).toEqual({ status: 'done', output: 'final' });
    expect(row?.lastHeartbeat).toBe(300);
  });
});
