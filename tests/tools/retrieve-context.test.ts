// retrieve_context tool tests (RETRIEVAL.md §15.4, slice 4.9).
//
// Two layers: the tool's validation surface (rejects malformed
// args with structured errors) and the runner builder integration
// (buildRetrievalRunner end-to-end against real memory + session
// substrates).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import { buildRetrievalRunner } from '../../src/retrieval/index.ts';
import type { RetrieveFn } from '../../src/retrieval/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { appendMessage } from '../../src/storage/repos/messages.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { retrieveContextTool } from '../../src/tools/builtin/retrieve-context.ts';
import { makeCtx } from './_helpers.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-retrieve-tool-'));
  tmpDirs.push(dir);
  return dir;
};

const makeRoots = (repo: string): ScopeRoots => ({
  user: join(repo, 'user'),
  projectShared: join(repo, 'shared'),
  projectLocal: join(repo, 'local'),
});

const writeBody = (dir: string, name: string, body: string): void => {
  mkdirSync(dir, { recursive: true });
  const lines = [
    `name: ${name}`,
    `description: description for ${name}`,
    'type: feedback',
    'source: inferred',
  ];
  writeFileSync(join(dir, `${name}.md`), `---\n${lines.join('\n')}\n---\n\n${body}\n`);
};

const writeIndex = (dir: string, body: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), body);
};

let db: DB;
let sessionId: string;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
});

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// ─── tool validation ──────────────────────────────────────────────────

describe('retrieve_context — validation', () => {
  const stubRetrieve: RetrieveFn = async () => ({
    contextSlot: { included: [], skipped: [] },
    queryId: 'stub-id',
    stats: {
      candidatesRaw: 0,
      candidatesRanked: 0,
      included: 0,
      skipped: 0,
      budgetUsedTokens: 0,
      budgetRemainingTokens: 0,
      traceMissing: false,
    },
  });

  test('rejects missing retrieveContext (runner not wired)', async () => {
    const r = await retrieveContextTool.execute({ query: 'auth' }, makeCtx());
    expect(r).toMatchObject({
      is_error: true,
      error_code: 'retrieval.unavailable',
    });
  });

  test('rejects non-string query', async () => {
    const r = await retrieveContextTool.execute(
      { query: 42 } as never,
      makeCtx({ retrieveContext: stubRetrieve }),
    );
    expect(r).toMatchObject({ is_error: true, error_code: 'tool.invalid_arg' });
  });

  test('rejects empty / whitespace query', async () => {
    const r = await retrieveContextTool.execute(
      { query: '   ' },
      makeCtx({ retrieveContext: stubRetrieve }),
    );
    expect(r).toMatchObject({ is_error: true, error_code: 'tool.invalid_arg' });
  });

  test('rejects query exceeding MAX_QUERY_LENGTH (audit/DoS cap)', async () => {
    // H2 review: an unbounded query would inflate retrieval_trace
    // query_text, get tokenized by every view's BM25, and persist
    // verbatim into audit storage. Cap is 10k chars — anything
    // larger refused at tool boundary with `tool.invalid_arg`.
    const huge = 'a'.repeat(10_001);
    const r = await retrieveContextTool.execute(
      { query: huge },
      makeCtx({ retrieveContext: stubRetrieve }),
    );
    expect(r).toMatchObject({ is_error: true, error_code: 'tool.invalid_arg' });
    if ('is_error' in r)
      expect((r as { error_message: string }).error_message).toContain('query length capped');
  });

  test('accepts query at exactly MAX_QUERY_LENGTH (boundary)', async () => {
    const exact = 'a'.repeat(10_000);
    const r = await retrieveContextTool.execute(
      { query: exact },
      makeCtx({ retrieveContext: stubRetrieve }),
    );
    expect(r).not.toMatchObject({ is_error: true });
  });

  test('rejects unknown workflow', async () => {
    const r = await retrieveContextTool.execute(
      { query: 'auth', workflow: 'whatever' } as never,
      makeCtx({ retrieveContext: stubRetrieve }),
    );
    expect(r).toMatchObject({ is_error: true, error_code: 'tool.invalid_arg' });
    if ('is_error' in r)
      expect((r as { error_message: string }).error_message).toContain('workflow');
  });

  test('rejects unknown queryType', async () => {
    const r = await retrieveContextTool.execute(
      { query: 'auth', queryType: 'nope' } as never,
      makeCtx({ retrieveContext: stubRetrieve }),
    );
    expect(r).toMatchObject({ is_error: true, error_code: 'tool.invalid_arg' });
  });

  test('rejects budgetTokens below minimum', async () => {
    const r = await retrieveContextTool.execute(
      { query: 'auth', budgetTokens: 0 },
      makeCtx({ retrieveContext: stubRetrieve }),
    );
    expect(r).toMatchObject({ is_error: true, error_code: 'tool.invalid_arg' });
  });

  test('rejects non-integer budgetTokens', async () => {
    const r = await retrieveContextTool.execute(
      { query: 'auth', budgetTokens: 12.5 },
      makeCtx({ retrieveContext: stubRetrieve }),
    );
    expect(r).toMatchObject({ is_error: true, error_code: 'tool.invalid_arg' });
  });

  test('rejects budgetTokens above maximum', async () => {
    const r = await retrieveContextTool.execute(
      { query: 'auth', budgetTokens: 999_999 },
      makeCtx({ retrieveContext: stubRetrieve }),
    );
    expect(r).toMatchObject({ is_error: true, error_code: 'tool.invalid_arg' });
  });

  test('rejects views with invalid entries', async () => {
    const r = await retrieveContextTool.execute(
      { query: 'auth', views: ['memory', 'made_up_view'] } as never,
      makeCtx({ retrieveContext: stubRetrieve }),
    );
    expect(r).toMatchObject({ is_error: true, error_code: 'tool.invalid_arg' });
  });

  test('rejects empty views array (omit field to query all)', async () => {
    const r = await retrieveContextTool.execute(
      { query: 'auth', views: [] },
      makeCtx({ retrieveContext: stubRetrieve }),
    );
    expect(r).toMatchObject({ is_error: true, error_code: 'tool.invalid_arg' });
  });

  test('de-dupes repeated entries in views', async () => {
    // No error — duplicate "memory" should be silently collapsed.
    // We verify by capturing what the runner saw.
    let captured: unknown;
    const captureRunner: RetrieveFn = async (input) => {
      captured = input.views;
      return {
        contextSlot: { included: [], skipped: [] },
        queryId: 'q',
        stats: {
          candidatesRaw: 0,
          candidatesRanked: 0,
          included: 0,
          skipped: 0,
          budgetUsedTokens: 0,
          budgetRemainingTokens: 0,
          traceMissing: false,
        },
      };
    };
    const r = await retrieveContextTool.execute(
      { query: 'auth', views: ['memory', 'memory'] } as never,
      makeCtx({ retrieveContext: captureRunner }),
    );
    expect(r).not.toMatchObject({ is_error: true });
    expect(captured).toEqual(['memory']);
  });

  test('rejects non-boolean loadBodies', async () => {
    const r = await retrieveContextTool.execute(
      { query: 'auth', loadBodies: 'yes' } as never,
      makeCtx({ retrieveContext: stubRetrieve }),
    );
    expect(r).toMatchObject({ is_error: true, error_code: 'tool.invalid_arg' });
  });

  test('aborted signal returns aborted error before invoking the runner', async () => {
    let called = false;
    const controller = new AbortController();
    controller.abort();
    const r = await retrieveContextTool.execute(
      { query: 'auth' },
      makeCtx({
        signal: controller.signal,
        retrieveContext: async () => {
          called = true;
          return stubRetrieve({ query: 'never' });
        },
      }),
    );
    expect(r).toMatchObject({ is_error: true, error_code: 'tool.aborted' });
    expect(called).toBe(false);
  });

  test('signal is forwarded to the runner', async () => {
    let receivedSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const captureRunner: RetrieveFn = async (input, signal) => {
      receivedSignal = signal;
      return stubRetrieve(input);
    };
    await retrieveContextTool.execute(
      { query: 'auth' },
      makeCtx({
        signal: controller.signal,
        retrieveContext: captureRunner,
      }),
    );
    expect(receivedSignal).toBe(controller.signal);
  });

  test('runner-thrown error surfaces as structured tool error (does not propagate)', async () => {
    const throwingRunner: RetrieveFn = async () => {
      throw new Error('pipeline boom');
    };
    const r = await retrieveContextTool.execute(
      { query: 'auth' },
      makeCtx({ retrieveContext: throwingRunner }),
    );
    expect(r).toMatchObject({ is_error: true, error_code: 'retrieval.internal_error' });
    if ('is_error' in r)
      expect((r as { error_message: string }).error_message).toContain('pipeline boom');
  });

  test('mid-flight abort surfaces as tool.aborted (retryable), not retrieval.internal_error', async () => {
    // Regression: the catch block previously mapped every runner
    // throw to `retrieval.internal_error` with retryable=false.
    // When the signal flipped DURING the await (operator Ctrl+C
    // mid-call, parent shutdown propagating, runner detecting the
    // signal between stages and throwing `retrieval aborted
    // before <stage>`), callers lost the standard tool.aborted
    // semantic. The catch now inspects `ctx.signal.aborted` and
    // maps cancellation to tool.aborted / retryable=true.
    const controller = new AbortController();
    const midFlightAbortRunner: RetrieveFn = async () => {
      // Simulate the runner detecting the abort and throwing —
      // matches the pipeline's `aborted before <stage>` message
      // (commit `4935fef`) and the runner's `aborted mid-flight`.
      controller.abort();
      throw new Error('retrieval aborted before expand');
    };
    const r = await retrieveContextTool.execute(
      { query: 'auth' },
      makeCtx({
        signal: controller.signal,
        retrieveContext: midFlightAbortRunner,
      }),
    );
    expect(r).toMatchObject({ is_error: true, error_code: 'tool.aborted' });
    if ('is_error' in r) {
      const err = r as { error_message: string; retryable?: boolean };
      expect(err.retryable).toBe(true);
      expect(err.error_message).toContain('aborted during retrieval');
    }
  });

  test('non-abort throw with signal NOT aborted still maps to retrieval.internal_error', async () => {
    // Counterpart to the regression above: if the runner throws
    // for a genuine reason (DB error, bug) AND the signal stays
    // un-aborted, we keep the `retrieval.internal_error`
    // classification so retries don't fire on a hard failure.
    const controller = new AbortController();
    // Deliberately do NOT call controller.abort().
    const realFailureRunner: RetrieveFn = async () => {
      throw new Error('disk full');
    };
    const r = await retrieveContextTool.execute(
      { query: 'auth' },
      makeCtx({
        signal: controller.signal,
        retrieveContext: realFailureRunner,
      }),
    );
    expect(r).toMatchObject({ is_error: true, error_code: 'retrieval.internal_error' });
    if ('is_error' in r) {
      const err = r as { retryable?: boolean };
      expect(err.retryable).toBe(false);
    }
  });
});

// ─── runner end-to-end ───────────────────────────────────────────────

describe('buildRetrievalRunner — end-to-end', () => {
  test('returns ranked + compressed slot for a real query', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Auth](auth.md) — h\n');
    writeBody(roots.user, 'auth', 'body about authentication flow');
    appendMessage(db, { sessionId, role: 'user', content: 'how does auth work?' });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const runner = buildRetrievalRunner({ db, sessionId, memoryRegistry: registry });

    const result = await runner({ query: 'auth', budgetTokens: 500 });
    expect(result.queryId).toBeTruthy();
    expect(result.contextSlot.included.length).toBeGreaterThan(0);
    expect(result.stats.included).toBe(result.contextSlot.included.length);
    expect(result.stats.budgetUsedTokens).toBeGreaterThan(0);
    expect(result.stats.budgetRemainingTokens).toBeGreaterThanOrEqual(0);
    expect(result.stats.budgetUsedTokens + result.stats.budgetRemainingTokens).toBeLessThanOrEqual(
      500,
    );
  });

  test('views filter restricts the candidate corpus', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Auth](auth.md) — h\n');
    writeBody(roots.user, 'auth', 'memory body');
    appendMessage(db, { sessionId, role: 'user', content: 'auth question' });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const runner = buildRetrievalRunner({ db, sessionId, memoryRegistry: registry });

    // memory-only run should not surface the session message.
    const memOnly = await runner({ query: 'auth', views: ['memory'] });
    for (const entry of memOnly.contextSlot.included) {
      expect(entry.view).toBe('memory');
    }

    const sessOnly = await runner({ query: 'auth', views: ['session'] });
    for (const entry of sessOnly.contextSlot.included) {
      expect(entry.view).toBe('session');
    }
  });

  test('loadBodies surfaces matches that only exist in the body', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Notes](notes.md) — generic description\n');
    writeBody(roots.user, 'notes', 'this body alone mentions xenoglossy');
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const runner = buildRetrievalRunner({ db, sessionId, memoryRegistry: registry });

    const shallow = await runner({ query: 'xenoglossy' });
    expect(shallow.stats.candidatesRaw).toBe(0);

    const deep = await runner({ query: 'xenoglossy', loadBodies: true });
    expect(deep.stats.candidatesRaw).toBeGreaterThan(0);
  });

  test('caller-supplied views are NOT overridden when loadBodies=true (regression)', async () => {
    // Regression: the loadBodies branch unconditionally replaced
    // `viewsForCall.memory` with a fresh default view, discarding
    // a caller-injected memory view (custom limits, stubs,
    // alternative scoring). A test/fixture / custom-wireup
    // expecting its view to run would silently query a different
    // corpus. The override now skips when views were
    // caller-supplied.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Real](real.md) — auth\n');
    writeBody(roots.user, 'real', 'real body about auth');
    const registry = createMemoryRegistry({ roots, db, sessionId });

    // Custom memory view that emits a sentinel candidate so we
    // can prove it was called (and that the default view was NOT
    // substituted in its place).
    let sentinelCalls = 0;
    const sentinelMemoryView = {
      async search() {
        sentinelCalls++;
        return [
          {
            nodeId: 'memory:user/sentinel',
            view: 'memory' as const,
            bootstrapScore: 1.0,
            reason: 'sentinel candidate (custom view)',
          },
        ];
      },
    };

    const runner = buildRetrievalRunner({
      db,
      sessionId,
      memoryRegistry: registry,
      views: { memory: sentinelMemoryView },
    });

    // loadBodies=true would, pre-fix, have rebuilt the default
    // memory view and dropped sentinelMemoryView. With the fix,
    // sentinelMemoryView still runs and its candidate appears.
    const result = await runner({ query: 'auth', loadBodies: true });
    expect(sentinelCalls).toBe(1);
    expect(result.stats.candidatesRaw).toBe(1);
  });

  test('honors the default budget when budgetTokens is omitted', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const runner = buildRetrievalRunner({
      db,
      sessionId,
      memoryRegistry: registry,
      defaultBudgetTokens: 5,
    });

    appendMessage(db, { sessionId, role: 'user', content: 'auth' });
    const result = await runner({ query: 'auth' });
    expect(result.stats.budgetUsedTokens + result.stats.budgetRemainingTokens).toBeLessThanOrEqual(
      5,
    );
  });

  test('pre-aborted signal throws before dispatch', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const runner = buildRetrievalRunner({ db, sessionId, memoryRegistry: registry });
    const controller = new AbortController();
    controller.abort();
    await expect(runner({ query: 'auth' }, controller.signal)).rejects.toThrow(
      'aborted before dispatch',
    );
  });

  test('persists a retrieval_trace row per call', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Auth](auth.md) — h\n');
    writeBody(roots.user, 'auth', 'body');
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const runner = buildRetrievalRunner({ db, sessionId, memoryRegistry: registry });

    const { listRetrievalTracesBySession } = await import(
      '../../src/storage/repos/retrieval-trace.ts'
    );
    expect(listRetrievalTracesBySession(db, sessionId)).toHaveLength(0);

    await runner({ query: 'auth' });
    await runner({ query: 'authentication' });
    const traces = listRetrievalTracesBySession(db, sessionId);
    expect(traces).toHaveLength(2);
  });
});

describe('buildRetrievalRunner — retrieve_context provenance (S1/T1.5)', () => {
  const seedToolCall = async (): Promise<string> => {
    const { createToolCall } = await import('../../src/storage/repos/tool-calls.ts');
    const msgId = appendMessage(db, { sessionId, role: 'assistant', content: 'x' }).id;
    return createToolCall(db, { messageId: msgId, toolName: 'retrieve_context', input: {} }).id;
  };

  test('emits one provenance row per included memory entry', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Auth](auth.md) — h\n- [Logs](logs.md) — h\n');
    writeBody(roots.user, 'auth', 'auth body talks about authentication');
    writeBody(roots.user, 'logs', 'logs body talks about authentication too');
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const runner = buildRetrievalRunner({ db, sessionId, memoryRegistry: registry });
    const toolCallId = await seedToolCall();

    // loadBodies=true so the BM25 corpus indexes body content;
    // the bodies (not names) carry the "authentication" token.
    const result = await runner({ query: 'authentication', loadBodies: true }, undefined, {
      toolCallId,
    });
    expect(result.contextSlot.included.length).toBeGreaterThan(0);

    const { listExposuresInRetrieval } = await import(
      '../../src/storage/repos/memory-provenance.ts'
    );
    const rows = listExposuresInRetrieval(db, sessionId, result.queryId);
    const memoryEntries = result.contextSlot.included.filter((e) => e.view === 'memory');
    expect(rows).toHaveLength(memoryEntries.length);
    for (const row of rows) {
      expect(row.surface).toBe('retrieve_context');
      expect(row.toolCallId).toBe(toolCallId);
      expect(row.retrievalQueryId).toBe(result.queryId);
      expect(row.memoryScope).toBe('user');
      // Position 0 = top hit; sequential for the rest. Set
      // comparison against the actual ordering.
      expect(row.positionInCorpus).toBeGreaterThanOrEqual(0);
      expect(row.positionInCorpus).toBeLessThan(memoryEntries.length);
    }
  });

  test('position_in_corpus matches the entry index in slot.included', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — h\n- [B](b.md) — h\n');
    writeBody(roots.user, 'a', 'zebra apple');
    writeBody(roots.user, 'b', 'zebra banana');
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const runner = buildRetrievalRunner({ db, sessionId, memoryRegistry: registry });
    const toolCallId = await seedToolCall();

    const result = await runner({ query: 'zebra', loadBodies: true }, undefined, { toolCallId });
    const memoryEntries = result.contextSlot.included.filter((e) => e.view === 'memory');
    const { listExposuresInRetrieval } = await import(
      '../../src/storage/repos/memory-provenance.ts'
    );
    const rows = listExposuresInRetrieval(db, sessionId, result.queryId);
    // listExposuresInRetrieval orders by position_in_corpus ASC.
    // Each row's position must match the index of the entry whose
    // nodeId matches `memory:<scope>/<name>`.
    for (const row of rows) {
      const expectedNodeId = `memory:${row.memoryScope}/${row.memoryName}`;
      const idx = memoryEntries.findIndex((e) => e.nodeId === expectedNodeId);
      expect(row.positionInCorpus).toBe(idx);
    }
  });

  test('hash + state captured per entry', async () => {
    // The retrieval memory view filters to state='active' (see
    // src/retrieval/views/memory.ts), so non-active memories never
    // reach included/provenance. We pin the captured state on the
    // active default — verifying that the snapshot pipeline reads
    // and stores frontmatter.state correctly.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — h\n');
    writeBody(roots.user, 'a', 'zebra body');
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const runner = buildRetrievalRunner({ db, sessionId, memoryRegistry: registry });
    const toolCallId = await seedToolCall();

    const result = await runner({ query: 'zebra', loadBodies: true }, undefined, { toolCallId });
    const { listExposuresInRetrieval } = await import(
      '../../src/storage/repos/memory-provenance.ts'
    );
    const rows = listExposuresInRetrieval(db, sessionId, result.queryId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.memoryContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.memoryStateAtExposure).toBe('active');
  });

  test('NO provenance emitted when toolCallId is absent (test-context posture)', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — h\n');
    writeBody(roots.user, 'a', 'zebra body');
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const runner = buildRetrievalRunner({ db, sessionId, memoryRegistry: registry });

    const result = await runner({ query: 'zebra', loadBodies: true });
    const { listExposuresInRetrieval } = await import(
      '../../src/storage/repos/memory-provenance.ts'
    );
    expect(listExposuresInRetrieval(db, sessionId, result.queryId)).toEqual([]);
  });

  test('session-view entries do NOT produce memory provenance rows', async () => {
    // The pipeline mixes views in contextSlot.included; provenance
    // is memory-specific. A session-view entry MUST NOT be
    // mistaken for a memory exposure (different audit semantic —
    // session messages are already captured in the `messages`
    // table; conflating them with memory_provenance would invent
    // a "memory" exposure that never happened).
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — h\n');
    writeBody(roots.user, 'a', 'zebra body');
    appendMessage(db, { sessionId, role: 'user', content: 'zebra question' });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const runner = buildRetrievalRunner({ db, sessionId, memoryRegistry: registry });
    const toolCallId = await seedToolCall();

    const result = await runner({ query: 'zebra', loadBodies: true }, undefined, { toolCallId });
    const { listExposuresInRetrieval } = await import(
      '../../src/storage/repos/memory-provenance.ts'
    );
    const rows = listExposuresInRetrieval(db, sessionId, result.queryId);
    // Only memory-view rows survive — session entries weren't
    // emitted into memory_provenance.
    expect(rows.length).toBe(result.contextSlot.included.filter((e) => e.view === 'memory').length);
  });
});
