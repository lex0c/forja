// memory_provenance repo tests (migration 054, Slice 1).
//
// Repo is intentionally append-only for production paths (only the
// pruneMemoryProvenance GC sweep removes rows). Tests pin:
//   - Insert validation (surface enum, retrieval-grouping
//     invariants).
//   - Listing helpers are session-scoped (no cross-session leak).
//   - Hash + state snapshot survive round-trip.
//   - countExposuresInWindow honors the window cutoff.
//   - Cross-session aggregate is reachable only via the explicit
//     listGlobalProvenanceForMemory function.
//   - Prune sweep removes only old rows.

import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  countExposuresInWindow,
  hashMemoryContent,
  listExposuresInRetrieval,
  listGlobalProvenanceForMemory,
  listProvenanceForMemory,
  listProvenanceForToolCall,
  pruneMemoryProvenance,
  recordProvenance,
} from '../../src/storage/repos/memory-provenance.ts';
import { appendMessage } from '../../src/storage/repos/messages.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { createToolCall } from '../../src/storage/repos/tool-calls.ts';

let db: DB;
let sessionId: string;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
});

// Helper: seed a tool_call so per-call surfaces have a valid FK.
const seedToolCall = (toolName = 'memory_read'): string => {
  const msgId = appendMessage(db, { sessionId, role: 'assistant', content: 'x' }).id;
  return createToolCall(db, { messageId: msgId, toolName, input: {} }).id;
};

describe('hashMemoryContent', () => {
  test('deterministic SHA-256 hex of the input bytes', () => {
    const a = hashMemoryContent('hello world');
    const b = hashMemoryContent('hello world');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('different inputs produce different hashes', () => {
    expect(hashMemoryContent('a')).not.toBe(hashMemoryContent('b'));
  });

  test('empty input hashes deterministically (no throw on edge)', () => {
    const h = hashMemoryContent('');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test('algorithm pinned to SHA-256 (empty string canonical)', () => {
    // RFC 6234 reference: SHA-256("") = e3b0c4429...b855. Pinning
    // the value catches a silent algorithm swap (MD5, SHA-1,
    // truncation) that the shape assertion alone would miss.
    expect(hashMemoryContent('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('recordProvenance', () => {
  test('eager surface persists with tool_call_id NULL', () => {
    const row = recordProvenance(db, {
      sessionId,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'role',
      surface: 'eager',
      memoryContentHash: hashMemoryContent('frontmatter+body'),
      memoryStateAtExposure: 'active',
      createdAt: 1000,
    });
    expect(row.id).toBeTruthy();
    expect(row.toolCallId).toBeNull();
    expect(row.surface).toBe('eager');
    expect(row.retrievalQueryId).toBeNull();
    expect(row.positionInCorpus).toBeNull();
  });

  test('memory_read surface links to its tool_call_id', () => {
    // memory_read happens AFTER the model issued a tool call; the
    // provenance row links to that call. Per the invariant added
    // alongside the schema, per-call surfaces REQUIRE a non-null
    // toolCallId — a NULL there would orphan the row from its
    // causal context.
    const toolCallId = seedToolCall('memory_read');
    const row = recordProvenance(db, {
      sessionId,
      toolCallId,
      memoryScope: 'project_local',
      memoryName: 'auth',
      surface: 'memory_read',
      memoryContentHash: hashMemoryContent('x'),
      memoryStateAtExposure: 'active',
      createdAt: 2000,
    });
    expect(row.surface).toBe('memory_read');
    expect(row.toolCallId).toBe(toolCallId);
  });

  test('memory_read surface REFUSES null toolCallId (invariant)', () => {
    expect(() =>
      recordProvenance(db, {
        sessionId,
        toolCallId: null,
        memoryScope: 'user',
        memoryName: 'foo',
        surface: 'memory_read',
      }),
    ).toThrow(/surface=memory_read requires a non-null toolCallId/);
  });

  test('eager surface REFUSES non-null toolCallId (invariant)', () => {
    const toolCallId = seedToolCall();
    expect(() =>
      recordProvenance(db, {
        sessionId,
        toolCallId,
        memoryScope: 'user',
        memoryName: 'foo',
        surface: 'eager',
      }),
    ).toThrow(/surface=eager requires toolCallId=null/);
  });

  test('invalid memoryScope throws (defense in depth vs the CHECK constraint)', () => {
    expect(() =>
      recordProvenance(db, {
        sessionId,
        toolCallId: null,
        memoryScope: 'wat' as never,
        memoryName: 'foo',
        surface: 'eager',
      }),
    ).toThrow(/invalid memoryScope/);
  });

  test('FK violation: non-null toolCallId that does not exist throws SQLiteError', () => {
    expect(() =>
      recordProvenance(db, {
        sessionId,
        toolCallId: 'does-not-exist',
        memoryScope: 'user',
        memoryName: 'foo',
        surface: 'memory_read',
      }),
    ).toThrow(/FOREIGN KEY/);
  });

  test('hash + state snapshot round-trip unchanged through INSERT → SELECT', () => {
    const hash = hashMemoryContent('frontmatter+body');
    recordProvenance(db, {
      sessionId,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'foo',
      surface: 'eager',
      memoryContentHash: hash,
      memoryStateAtExposure: 'quarantined',
      createdAt: 1000,
    });
    const rows = listProvenanceForMemory(db, sessionId, 'user', 'foo');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.memoryContentHash).toBe(hash);
    expect(rows[0]?.memoryStateAtExposure).toBe('quarantined');
  });

  test('omitted id + createdAt default to crypto.randomUUID() + Date.now()', () => {
    const before = Date.now();
    const row = recordProvenance(db, {
      sessionId,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'foo',
      surface: 'eager',
    });
    const after = Date.now();
    // UUID v4 shape: 8-4-4-4-12 hex.
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(row.createdAt).toBeGreaterThanOrEqual(before);
    expect(row.createdAt).toBeLessThanOrEqual(after);
  });

  test('retrieve_context REQUIRES retrievalQueryId + positionInCorpus', () => {
    // Seed a valid toolCallId so the per-call-surface invariant
    // doesn't fire first — we want the retrieval-grouping check.
    const toolCallId = seedToolCall('retrieve_context');
    expect(() =>
      recordProvenance(db, {
        sessionId,
        toolCallId,
        memoryScope: 'user',
        memoryName: 'foo',
        surface: 'retrieve_context',
        // Missing retrievalQueryId + positionInCorpus.
      }),
    ).toThrow(/requires both retrievalQueryId and positionInCorpus/);
  });

  test('non-retrieval surface MUST NOT set retrievalQueryId / positionInCorpus', () => {
    expect(() =>
      recordProvenance(db, {
        sessionId,
        toolCallId: null,
        memoryScope: 'user',
        memoryName: 'foo',
        surface: 'eager',
        retrievalQueryId: 'spurious',
        positionInCorpus: 3,
      }),
    ).toThrow(/must not set retrievalQueryId/);
  });

  test('invalid surface throws (defense in depth vs the CHECK constraint)', () => {
    expect(() =>
      recordProvenance(db, {
        sessionId,
        toolCallId: null,
        memoryScope: 'user',
        memoryName: 'foo',
        surface: 'made_up' as never,
      }),
    ).toThrow(/invalid surface/);
  });
});

describe('listProvenanceForToolCall', () => {
  test('session-scoped: foreign session NOT returned even with matching tool_call_id', () => {
    const other = createSession(db, { model: 'm', cwd: '/p' }).id;
    recordProvenance(db, {
      sessionId: other,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'mine-but-foreign',
      surface: 'eager',
      createdAt: 1000,
    });
    // Calling on our own session: zero rows.
    const rows = listProvenanceForToolCall(db, sessionId, 'tool-1');
    expect(rows).toEqual([]);
  });
});

describe('listProvenanceForMemory', () => {
  test('newest-first ordering with id tiebreaker on equal ms', () => {
    // Three rows at the same createdAt; the id tiebreaker takes
    // over. Pin ids for deterministic order.
    const ids = [
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
    ];
    for (const id of ids) {
      recordProvenance(db, {
        id,
        sessionId,
        toolCallId: null,
        memoryScope: 'user',
        memoryName: 'foo',
        surface: 'eager',
        createdAt: 5000,
      });
    }
    const rows = listProvenanceForMemory(db, sessionId, 'user', 'foo');
    // DESC tiebreaker: lexically largest id first.
    expect(rows.map((r) => r.id)).toEqual([...ids].reverse());
  });

  test('honors the limit', () => {
    for (let i = 0; i < 10; i++) {
      recordProvenance(db, {
        sessionId,
        toolCallId: null,
        memoryScope: 'user',
        memoryName: 'foo',
        surface: 'eager',
        createdAt: 1000 + i,
      });
    }
    const rows = listProvenanceForMemory(db, sessionId, 'user', 'foo', 3);
    expect(rows).toHaveLength(3);
  });

  test('cross-session leak refused (regression — privacy)', () => {
    const other = createSession(db, { model: 'm', cwd: '/p' }).id;
    recordProvenance(db, {
      sessionId: other,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'foo',
      surface: 'eager',
      createdAt: 1000,
    });
    expect(listProvenanceForMemory(db, sessionId, 'user', 'foo')).toEqual([]);
  });
});

describe('listExposuresInRetrieval', () => {
  test('returns slot.included rows in position order', async () => {
    // Simulate a retrieve_context call that exposed 3 memories.
    // Position 0 is the top hit; we insert out-of-order to prove
    // the ORDER BY position_in_corpus. The retrieval_query_id has
    // an FK to `retrieval_trace`; seed a parent row so the FK
    // resolves.
    const { createRetrievalTrace } = await import('../../src/storage/repos/retrieval-trace.ts');
    const trace = createRetrievalTrace(db, {
      sessionId,
      queryText: 'q',
      workflow: 'default',
      queryType: 'semantic',
      budgetTokens: 100,
      candidatesRaw: [],
      candidatesExpanded: [],
      candidatesRanked: [],
      contextSlot: { included: [], skipped: [] },
      timings: { searchMs: 0, expandMs: 0, rankMs: 0, compressMs: 0 },
    });
    const qid = trace.id;
    const toolCallId = seedToolCall('retrieve_context');
    recordProvenance(db, {
      sessionId,
      toolCallId,
      memoryScope: 'user',
      memoryName: 'mid',
      surface: 'retrieve_context',
      retrievalQueryId: qid,
      positionInCorpus: 1,
      createdAt: 1000,
    });
    recordProvenance(db, {
      sessionId,
      toolCallId,
      memoryScope: 'user',
      memoryName: 'top',
      surface: 'retrieve_context',
      retrievalQueryId: qid,
      positionInCorpus: 0,
      createdAt: 1001,
    });
    recordProvenance(db, {
      sessionId,
      toolCallId,
      memoryScope: 'user',
      memoryName: 'tail',
      surface: 'retrieve_context',
      retrievalQueryId: qid,
      positionInCorpus: 2,
      createdAt: 1002,
    });
    const rows = listExposuresInRetrieval(db, sessionId, qid);
    expect(rows.map((r) => r.memoryName)).toEqual(['top', 'mid', 'tail']);
  });
});

describe('countExposuresInWindow', () => {
  test('counts only rows inside the window (mix of surfaces)', () => {
    const nowMs = 10_000;
    const windowMs = 1000;
    const toolCallId = seedToolCall('memory_read');
    // Inside window (eager + memory_read both contribute to the count):
    recordProvenance(db, {
      sessionId,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'foo',
      surface: 'eager',
      createdAt: 9500,
    });
    recordProvenance(db, {
      sessionId,
      toolCallId,
      memoryScope: 'user',
      memoryName: 'foo',
      surface: 'memory_read',
      createdAt: 9700,
    });
    // Outside (older than cutoff = nowMs - windowMs = 9000):
    recordProvenance(db, {
      sessionId,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'foo',
      surface: 'eager',
      createdAt: 8000,
    });
    expect(countExposuresInWindow(db, sessionId, 'user', 'foo', windowMs, nowMs)).toBe(2);
  });

  test('zero count when no rows match', () => {
    expect(countExposuresInWindow(db, sessionId, 'user', 'nope', 1000, 5000)).toBe(0);
  });

  test('session-scoped — does not bleed across sessions', () => {
    const other = createSession(db, { model: 'm', cwd: '/p' }).id;
    recordProvenance(db, {
      sessionId: other,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'foo',
      surface: 'eager',
      createdAt: 5000,
    });
    expect(countExposuresInWindow(db, sessionId, 'user', 'foo', 10_000, 10_000)).toBe(0);
  });

  test('inclusive cutoff: row at exactly created_at = nowMs - windowMs counts', () => {
    // The cutoff math is `cutoffMs = nowMs - windowMs` and the
    // WHERE clause is `>= cutoffMs`. A row at exactly the cutoff
    // boundary MUST be included — pinning this prevents a future
    // change to `>` from silently dropping boundary rows.
    const nowMs = 10_000;
    const windowMs = 1000;
    recordProvenance(db, {
      sessionId,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'foo',
      surface: 'eager',
      createdAt: 9000, // == cutoff
    });
    expect(countExposuresInWindow(db, sessionId, 'user', 'foo', windowMs, nowMs)).toBe(1);
  });
});

describe('listGlobalProvenanceForMemory (cross-session)', () => {
  test('surfaces rows from every session — explicit aggregate', () => {
    // The session-scoped helpers (listProvenanceForMemory) refuse
    // to cross sessions. This one ONLY surfaces rows when called
    // explicitly — explicit-naming is the privacy-aware default.
    const other = createSession(db, { model: 'm', cwd: '/p' }).id;
    recordProvenance(db, {
      sessionId,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'foo',
      surface: 'eager',
      createdAt: 1000,
    });
    recordProvenance(db, {
      sessionId: other,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'foo',
      surface: 'eager',
      createdAt: 2000,
    });
    const rows = listGlobalProvenanceForMemory(db, 'user', 'foo');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.sessionId).sort()).toEqual([sessionId, other].sort());
  });
});

describe('pruneMemoryProvenance', () => {
  test('removes only rows older than cutoff', () => {
    recordProvenance(db, {
      sessionId,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'old',
      surface: 'eager',
      createdAt: 1000,
    });
    recordProvenance(db, {
      sessionId,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'new',
      surface: 'eager',
      createdAt: 5000,
    });
    const removed = pruneMemoryProvenance(db, 3000);
    expect(removed).toBe(1);
    const remaining = listProvenanceForMemory(db, sessionId, 'user', 'new');
    expect(remaining).toHaveLength(1);
  });

  test('exclusive cutoff: row at exactly created_at = cutoff is KEPT', () => {
    // The DELETE is `WHERE created_at < ?` — strictly less than.
    // A row whose timestamp matches the cutoff stays, intentional
    // so callers can treat the cutoff as the inclusive lower-bound
    // of the retention window.
    recordProvenance(db, {
      sessionId,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'edge',
      surface: 'eager',
      createdAt: 3000,
    });
    const removed = pruneMemoryProvenance(db, 3000);
    expect(removed).toBe(0);
    expect(listProvenanceForMemory(db, sessionId, 'user', 'edge')).toHaveLength(1);
  });

  test('empty table prune returns 0 (no rows, no errors)', () => {
    expect(pruneMemoryProvenance(db, Date.now())).toBe(0);
  });
});

describe('FK CASCADE (session purge)', () => {
  test('deleting a session removes its provenance rows', () => {
    recordProvenance(db, {
      sessionId,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'foo',
      surface: 'eager',
      createdAt: 1000,
    });
    db.query('DELETE FROM sessions WHERE id = ?').run(sessionId);
    expect(listGlobalProvenanceForMemory(db, 'user', 'foo')).toEqual([]);
  });

  test('deleting a tool_call cascades to its provenance rows', () => {
    // tool_call lifecycle is separate from session lifecycle —
    // regressing the ON DELETE CASCADE on the tool_call FK would
    // leave orphaned provenance rows pointing at a non-existent
    // call. Pinned here independently of the session-cascade test.
    const toolCallId = seedToolCall('memory_read');
    recordProvenance(db, {
      sessionId,
      toolCallId,
      memoryScope: 'user',
      memoryName: 'foo',
      surface: 'memory_read',
      createdAt: 1000,
    });
    expect(listProvenanceForToolCall(db, sessionId, toolCallId)).toHaveLength(1);
    db.query('DELETE FROM tool_calls WHERE id = ?').run(toolCallId);
    expect(listProvenanceForToolCall(db, sessionId, toolCallId)).toEqual([]);
    expect(listGlobalProvenanceForMemory(db, 'user', 'foo')).toEqual([]);
  });
});
