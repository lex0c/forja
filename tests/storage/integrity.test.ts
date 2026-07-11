// Persisted-log integrity invariants. Each test states a property
// the schema + repo logic should preserve under every code path,
// then exercises sequences that have produced violations of the
// same property class in past bugs:
//
// - Two consecutive Step 2.4 review fixes were violations of these
//   invariants (UUID-ordering breaks seq, parent_id=null on resume
//   forks the chain). The dedicated unit tests cover each fix in
//   isolation; this file's tests cover the INVARIANTS, so any
//   future refactor that breaks the same property in a different
//   way still gets caught.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DB, openDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { appendMessage, listMessagesBySession } from '../../src/storage/repos/messages.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let tempDir: string;
let db: DB;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'forja-integrity-'));
  db = openDb(join(tempDir, 'agent.sqlite'));
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('invariant: seq is contiguous 0..N-1 per session', () => {
  test('after N appends, seq values are exactly {0..N-1}', () => {
    // The seq subquery in appendMessage uses MAX(seq)+1; a bug
    // that made it MAX(seq)+2 (off-by-one) or that read stale
    // state would create gaps. Direct assertion catches that.
    const s = createSession(db, { model: 'm', cwd: '/p' });
    for (let i = 0; i < 7; i++) {
      appendMessage(db, { sessionId: s.id, role: 'user', content: `m${i}` });
    }
    const seqs = (
      db.query('SELECT seq FROM messages WHERE session_id = ? ORDER BY seq ASC').all(s.id) as {
        seq: number;
      }[]
    ).map((r) => r.seq);
    expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test('seq is per-session, not global', () => {
    // Two sessions' seq counters are independent. A bug that used
    // a global counter would interleave their values.
    const a = createSession(db, { model: 'm', cwd: '/p' });
    const b = createSession(db, { model: 'm', cwd: '/p' });
    appendMessage(db, { sessionId: a.id, role: 'user', content: 'a0' });
    appendMessage(db, { sessionId: b.id, role: 'user', content: 'b0' });
    appendMessage(db, { sessionId: a.id, role: 'user', content: 'a1' });
    appendMessage(db, { sessionId: b.id, role: 'user', content: 'b1' });
    const aSeqs = (
      db.query('SELECT seq FROM messages WHERE session_id = ? ORDER BY seq ASC').all(a.id) as {
        seq: number;
      }[]
    ).map((r) => r.seq);
    const bSeqs = (
      db.query('SELECT seq FROM messages WHERE session_id = ? ORDER BY seq ASC').all(b.id) as {
        seq: number;
      }[]
    ).map((r) => r.seq);
    expect(aSeqs).toEqual([0, 1]);
    expect(bSeqs).toEqual([0, 1]);
  });
});

describe('invariant: parent_id chain integrity per session', () => {
  test('a session has exactly one root (parent_id IS NULL)', () => {
    // Resume's parent_id=null bug created a SECOND root inside the
    // same session — every traversal walking back from the tail
    // dead-ended at the resume boundary instead of reaching the
    // original root. SQL count is the cleanest property to assert.
    const s = createSession(db, { model: 'm', cwd: '/p' });
    let parent: string | null = null;
    for (let i = 0; i < 5; i++) {
      const m = appendMessage(db, {
        sessionId: s.id,
        role: 'user',
        content: `m${i}`,
        ...(parent !== null ? { parentId: parent } : {}),
      });
      parent = m.id;
    }
    const roots = (
      db
        .query('SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND parent_id IS NULL')
        .get(s.id) as { n: number }
    ).n;
    expect(roots).toBe(1);
  });

  test('every non-root parent_id resolves within the same session', () => {
    // Repo enforces this on insert (cross-session parent_id throws).
    // The DB-level invariant is: every non-null parent_id refers to
    // a row in the same session_id. A LEFT JOIN that finds rows
    // failing to match indicates corruption.
    const s = createSession(db, { model: 'm', cwd: '/p' });
    let parent: string | null = null;
    for (let i = 0; i < 4; i++) {
      const m = appendMessage(db, {
        sessionId: s.id,
        role: 'user',
        content: `m${i}`,
        ...(parent !== null ? { parentId: parent } : {}),
      });
      parent = m.id;
    }
    const dangling = (
      db
        .query(
          `SELECT COUNT(*) AS n
           FROM messages c
           LEFT JOIN messages p ON p.id = c.parent_id
           WHERE c.session_id = ?
             AND c.parent_id IS NOT NULL
             AND (p.id IS NULL OR p.session_id != c.session_id)`,
        )
        .get(s.id) as { n: number }
    ).n;
    expect(dangling).toBe(0);
  });

  test('walking parent_id from the tail reaches the root in O(N) steps', () => {
    // No cycles, no orphans: starting at the tail and walking
    // parent_id should visit every message exactly once and end at
    // the root. A cycle (a -> b -> a) would loop forever; an
    // orphan (parent_id pointing to a deleted row) would break.
    const s = createSession(db, { model: 'm', cwd: '/p' });
    let parent: string | null = null;
    const N = 10;
    for (let i = 0; i < N; i++) {
      const m = appendMessage(db, {
        sessionId: s.id,
        role: 'user',
        content: `m${i}`,
        ...(parent !== null ? { parentId: parent } : {}),
      });
      parent = m.id;
    }
    const list = listMessagesBySession(db, s.id);
    const byId = new Map(list.map((m) => [m.id, m]));
    const tail = list[list.length - 1];
    if (tail === undefined) throw new Error('expected tail');
    const visited = new Set<string>();
    let cursor: typeof tail | undefined = tail;
    let steps = 0;
    while (cursor !== undefined && steps < N + 5) {
      if (visited.has(cursor.id)) throw new Error(`cycle detected at ${cursor.id}`);
      visited.add(cursor.id);
      if (cursor.parentId === null) break;
      cursor = byId.get(cursor.parentId);
      steps += 1;
    }
    expect(visited.size).toBe(N);
    expect(steps).toBe(N - 1);
  });
});

describe('invariant: ordering is insertion-stable under timestamp ties', () => {
  test('100 appends at exactly the same created_at preserve insertion order', () => {
    // Stress the seq tiebreaker: every row has identical
    // created_at, every UUID is random. Without seq, listMessages
    // would shuffle on each query (sorted by UUID lex). With seq,
    // the order is exactly the insertion order.
    const s = createSession(db, { model: 'm', cwd: '/p' });
    const ms = 1_700_000_000_000;
    const expected: string[] = [];
    for (let i = 0; i < 100; i++) {
      const c = `msg-${i}`;
      expected.push(c);
      appendMessage(db, { sessionId: s.id, role: 'user', content: c, createdAt: ms });
    }
    const actual = listMessagesBySession(db, s.id).map((m) => m.content);
    expect(actual).toEqual(expected);
  });
});
