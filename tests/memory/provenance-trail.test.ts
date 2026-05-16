// End-to-end provenance trail integration test (MEMORY.md §11.2,
// S1/T1.8). Exercises all THREE emitters against a real
// memory/registry/db substrate within one session and verifies
// `memory_provenance` carries the complete picture.
//
// The unit tests in T1.1-T1.7 pin each emitter and helper in
// isolation; this file is the cross-cut. If a future refactor
// breaks the schema/repo/registry/runner contract in a way each
// unit test happens to miss but the operator forensic surface
// would notice — that gap surfaces here.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EagerExposure } from '../../src/memory/index.ts';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import { buildRetrievalRunner } from '../../src/retrieval/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  MEMORY_PROVENANCE_RETENTION_MS,
  listExposuresInRetrieval,
  listGlobalProvenanceForMemory,
  listProvenanceByName,
  listProvenanceForMemory,
  listProvenanceForToolCall,
  pruneMemoryProvenance,
  recordProvenance,
} from '../../src/storage/repos/memory-provenance.ts';
import { appendMessage } from '../../src/storage/repos/messages.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { createToolCall } from '../../src/storage/repos/tool-calls.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-prov-trail-'));
  tmpDirs.push(dir);
  return dir;
};

const makeRoots = (repo: string): ScopeRoots => ({
  user: join(repo, 'user'),
  projectShared: join(repo, 'shared'),
  projectLocal: join(repo, 'local'),
});

const writeIndex = (dir: string, body: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), body);
};

const writeBody = (dir: string, name: string, body: string): void => {
  mkdirSync(dir, { recursive: true });
  const lines = [
    `name: ${name}`,
    `description: hook for ${name}`,
    'type: feedback',
    'source: user_explicit',
  ];
  writeFileSync(join(dir, `${name}.md`), `---\n${lines.join('\n')}\n---\n\n${body}\n`);
};

let db: DB;
let sessionId: string;
let toolCallId: string;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  const msgId = appendMessage(db, { sessionId, role: 'assistant', content: 'x' }).id;
  toolCallId = createToolCall(db, { messageId: msgId, toolName: 'memory_read', input: {} }).id;
});

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('provenance trail — three-surface end-to-end (S1/T1.8)', () => {
  test('all three emitters land rows for the same memory in one session', async () => {
    // Setup: one memory the model can be exposed to via three
    // distinct paths.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Auth](auth.md) — auth hook\n');
    writeBody(roots.user, 'auth', 'memory body about authentication');
    const registry = createMemoryRegistry({ roots, db, sessionId, cwd: '/p' });

    // Emitter 1: eager-load. Simulate the harness loop's
    // post-createSession emit by recording the row directly
    // — the inventory plumbing is unit-tested in T1.4; this
    // file checks the SHAPE of what lands.
    recordProvenance(db, {
      sessionId,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'auth',
      surface: 'eager',
      memoryContentHash: 'eager-hash',
      memoryStateAtExposure: 'active',
    });

    // Emitter 2: memory_read tool call. The registry layer emits
    // the provenance row alongside the existing memory_events
    // audit row when auditToolCallId is forwarded by the tool.
    const readResult = registry.read('auth', { auditToolCallId: toolCallId });
    expect(readResult.kind).toBe('present');

    // Emitter 3: retrieve_context. The runner emits one row per
    // included memory entry after createRetrievalTrace succeeds.
    const runner = buildRetrievalRunner({ db, sessionId, memoryRegistry: registry });
    const retrieval = await runner({ query: 'authentication', loadBodies: true }, undefined, {
      toolCallId,
    });
    expect(retrieval.contextSlot.included.length).toBeGreaterThan(0);

    // Now assert the trail. The same memory landed via all three
    // surfaces; the operator's by-name query MUST see all of them.
    const rows = listProvenanceByName(db, sessionId, 'auth');
    const surfaces = rows.map((r) => r.surface).sort();
    expect(surfaces).toEqual(['eager', 'memory_read', 'retrieve_context']);

    // Per-surface invariants:
    const eager = rows.find((r) => r.surface === 'eager');
    expect(eager?.toolCallId).toBeNull();
    expect(eager?.retrievalQueryId).toBeNull();

    const read = rows.find((r) => r.surface === 'memory_read');
    expect(read?.toolCallId).toBe(toolCallId);
    expect(read?.retrievalQueryId).toBeNull();

    const ret = rows.find((r) => r.surface === 'retrieve_context');
    expect(ret?.toolCallId).toBe(toolCallId);
    expect(ret?.retrievalQueryId).toBe(retrieval.queryId);
    expect(ret?.positionInCorpus).not.toBeNull();
  });

  test('content hash is stable across memory_read and retrieve_context for unchanged file', async () => {
    // The two per-call emitters compute the hash via the same
    // `serializeMemoryFile` + `hashMemoryContent` pipeline; an
    // unchanged file MUST hash identically across the two
    // surfaces. If a future refactor diverged the canonical
    // form (one uses serializeMemoryFile, another uses a manual
    // join), this test catches it.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Notes](notes.md) — h\n');
    writeBody(roots.user, 'notes', 'body about zebra');
    const registry = createMemoryRegistry({ roots, db, sessionId, cwd: '/p' });

    registry.read('notes', { auditToolCallId: toolCallId });
    const runner = buildRetrievalRunner({ db, sessionId, memoryRegistry: registry });
    await runner({ query: 'zebra', loadBodies: true }, undefined, { toolCallId });

    const rows = listProvenanceByName(db, sessionId, 'notes');
    const read = rows.find((r) => r.surface === 'memory_read');
    const ret = rows.find((r) => r.surface === 'retrieve_context');
    expect(read?.memoryContentHash).toBeDefined();
    expect(ret?.memoryContentHash).toBeDefined();
    expect(read?.memoryContentHash).toBe(ret?.memoryContentHash);
    expect(read?.memoryContentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('eager exposures dedupe to one row per (session, memory)', () => {
    // Spec semantic: eager-load emits "exactly once per session ×
    // memory". The inventory layer (memory-prompt assembleMemorySection)
    // dedupes via the Set<name>. If a future refactor accidentally
    // emits the eager surface from a per-call site (e.g., on every
    // memory_read), session-by-session eager counts blow up.
    // Here we model the harness behavior (a single emit at session
    // start) and pin the count.
    const exposure: EagerExposure = {
      scope: 'user',
      name: 'role',
      memoryContentHash: 'h1',
      memoryStateAtExposure: 'active',
    };
    // Caller (loop.ts) iterates HarnessConfig.eagerExposures and
    // emits each entry. The inventory layer (assembleMemorySection)
    // dedupes by name BEFORE this iteration runs — the schema
    // itself does NOT enforce uniqueness. This test documents the
    // contract by emitting once for the (session, memory) pair and
    // asserting a single row lands.
    recordProvenance(db, {
      sessionId,
      toolCallId: null,
      memoryScope: exposure.scope,
      memoryName: exposure.name,
      surface: 'eager',
      memoryContentHash: exposure.memoryContentHash,
      memoryStateAtExposure: exposure.memoryStateAtExposure,
    });
    const rows = listProvenanceForMemory(db, sessionId, 'user', 'role');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.surface).toBe('eager');
  });

  test('retrieve_context exposures group by retrieval_query_id with position ordering', async () => {
    // Two memories included in one retrieval batch ⇒ two rows
    // sharing retrieval_query_id. listExposuresInRetrieval returns
    // them ordered by position_in_corpus ASC so the slot's
    // ranking shows up directly.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — h\n- [B](b.md) — h\n');
    writeBody(roots.user, 'a', 'zebra alpha');
    writeBody(roots.user, 'b', 'zebra bravo');
    const registry = createMemoryRegistry({ roots, db, sessionId, cwd: '/p' });
    const runner = buildRetrievalRunner({ db, sessionId, memoryRegistry: registry });

    const result = await runner({ query: 'zebra', loadBodies: true }, undefined, { toolCallId });
    expect(result.contextSlot.included.length).toBeGreaterThanOrEqual(2);

    const grouped = listExposuresInRetrieval(db, sessionId, result.queryId);
    // Every grouped row points at the same retrieval_query_id.
    for (const row of grouped) {
      expect(row.retrievalQueryId).toBe(result.queryId);
      expect(row.surface).toBe('retrieve_context');
    }
    // Positions are monotone non-decreasing in the returned order.
    for (let i = 1; i < grouped.length; i++) {
      const prev = grouped[i - 1];
      const curr = grouped[i];
      if (prev === undefined || curr === undefined) continue;
      const prevPos = prev.positionInCorpus ?? 0;
      const currPos = curr.positionInCorpus ?? 0;
      expect(currPos).toBeGreaterThanOrEqual(prevPos);
    }
  });

  test('session scoping: another session does NOT see this session rows (regression)', () => {
    // Privacy default — same fix shape as commit 55ba11a's
    // listRetrievalTracesByWorkflow. Every session-scoped helper
    // MUST refuse cross-session reads silently (no error, just an
    // empty result set), so an operator running a slash command
    // in session A can't accidentally see B's exposures.
    const other = createSession(db, { model: 'm', cwd: '/q' }).id;
    recordProvenance(db, {
      sessionId: other,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'foo',
      surface: 'eager',
    });
    // Querying this session's rows for 'foo' returns nothing
    // even though the row exists in another session.
    expect(listProvenanceForMemory(db, sessionId, 'user', 'foo')).toEqual([]);
    expect(listProvenanceByName(db, sessionId, 'foo')).toEqual([]);
    // But the global helper sees it — explicit cross-session
    // surface, named clearly.
    expect(listGlobalProvenanceForMemory(db, 'user', 'foo')).toHaveLength(1);
  });

  test('retention sweep removes only rows older than the cutoff', () => {
    // Bootstrap's sweep at T1.7 fires `pruneMemoryProvenance(db,
    // Date.now() - MEMORY_PROVENANCE_RETENTION_MS)`. Verify the
    // boundary direction end-to-end with the same constant the
    // bootstrap uses.
    const nowMs = Date.now();
    // One row well past the window — must be swept.
    recordProvenance(db, {
      sessionId,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'old',
      surface: 'eager',
      createdAt: nowMs - MEMORY_PROVENANCE_RETENTION_MS - 1000,
    });
    // One row inside the window — must survive.
    recordProvenance(db, {
      sessionId,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'fresh',
      surface: 'eager',
      createdAt: nowMs - 1000,
    });
    const removed = pruneMemoryProvenance(db, nowMs - MEMORY_PROVENANCE_RETENTION_MS);
    expect(removed).toBe(1);
    expect(listProvenanceForMemory(db, sessionId, 'user', 'old')).toEqual([]);
    expect(listProvenanceForMemory(db, sessionId, 'user', 'fresh')).toHaveLength(1);
  });

  test('multi-session aggregate: 3 sessions each expose memory X, --all surfaces all 3', async () => {
    // Cross-session forensic shape that `/memory provenance X
    // --all` ultimately answers. The listGlobalProvenanceByName
    // path is unit-pinned; this is the cross-cut against the
    // schema's FK CASCADE + session_id index to verify that 3
    // distinct sessions each contributing one row produces 3
    // rows under the global lookup, ordered newest-first.
    const { listGlobalProvenanceByName } = await import(
      '../../src/storage/repos/memory-provenance.ts'
    );
    // sessionId from beforeEach is session #1.
    recordProvenance(db, {
      sessionId,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'cross-cut',
      surface: 'eager',
      createdAt: 1000,
    });
    const s2 = createSession(db, { model: 'm', cwd: '/p' }).id;
    recordProvenance(db, {
      sessionId: s2,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'cross-cut',
      surface: 'eager',
      createdAt: 2000,
    });
    const s3 = createSession(db, { model: 'm', cwd: '/p' }).id;
    recordProvenance(db, {
      sessionId: s3,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'cross-cut',
      surface: 'eager',
      createdAt: 3000,
    });

    const all = listGlobalProvenanceByName(db, 'cross-cut');
    expect(all).toHaveLength(3);
    // Newest first per the global helper's DESC ordering.
    expect(all.map((r) => r.sessionId)).toEqual([s3, s2, sessionId]);
    // None of the per-session helpers leak across.
    expect(listProvenanceByName(db, sessionId, 'cross-cut')).toHaveLength(1);
    expect(listProvenanceByName(db, s2, 'cross-cut')).toHaveLength(1);
    expect(listProvenanceByName(db, s3, 'cross-cut')).toHaveLength(1);
  });

  test('operator-by-tool-call query sees the per-call surfaces only (no eager)', async () => {
    // Eager rows have toolCallId=NULL by construction;
    // listProvenanceForToolCall MUST not surface them — the
    // operator asking "what did THIS tool_call expose?" gets
    // per-call surfaces only. An eager row leaking in would
    // confuse the answer (the eager exposure isn't bound to any
    // specific tool_call — it happened before the call existed).
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — h\n');
    writeBody(roots.user, 'a', 'body');
    const registry = createMemoryRegistry({ roots, db, sessionId, cwd: '/p' });

    // Eager emit (toolCallId=null).
    recordProvenance(db, {
      sessionId,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'a',
      surface: 'eager',
    });
    // Per-call emit (toolCallId set).
    registry.read('a', { auditToolCallId: toolCallId });

    const rows = listProvenanceForToolCall(db, sessionId, toolCallId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.surface).toBe('memory_read');
  });
});
