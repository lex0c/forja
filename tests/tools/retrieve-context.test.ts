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
