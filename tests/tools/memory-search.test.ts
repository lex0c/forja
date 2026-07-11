import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listMemoryEventsByName } from '../../src/storage/repos/memory-events.ts';
import { listProvenanceForToolCall } from '../../src/storage/repos/memory-provenance.ts';
import { appendMessage } from '../../src/storage/repos/messages.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { createToolCall } from '../../src/storage/repos/tool-calls.ts';
import { memorySearchTool } from '../../src/tools/builtin/memory-search.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-tool-search-'));
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

const writeMemory = (dir: string, name: string, body: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: hook for ${name}\ntype: user\nsource: user_explicit\n---\n\n${body}`,
  );
};

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('memory_search tool', () => {
  test('clean error when registry not wired', async () => {
    const result = await memorySearchTool.execute({ query: 'x' }, makeCtx());
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe('memory.registry_unavailable');
    }
  });

  test('rejects empty query', async () => {
    const repo = makeTmp();
    const reg = createMemoryRegistry({ roots: makeRoots(repo) });
    const ctx = makeCtx({ memoryRegistry: reg });
    const result = await memorySearchTool.execute({ query: '' }, ctx);
    expect(isToolError(result)).toBe(true);
  });

  test('finds match in name', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Commit](commit-style.md) — verbs\n');
    const reg = createMemoryRegistry({ roots });
    const ctx = makeCtx({ memoryRegistry: reg });
    const result = await memorySearchTool.execute({ query: 'commit' }, ctx);
    if (isToolError(result)) throw new Error('unexpected');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.matched_in).toBe('name');
  });

  test('finds match in description', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Q](q.md) — workshop deadline\n');
    const reg = createMemoryRegistry({ roots });
    const ctx = makeCtx({ memoryRegistry: reg });
    const result = await memorySearchTool.execute({ query: 'workshop' }, ctx);
    if (isToolError(result)) throw new Error('unexpected');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.matched_in).toBe('description');
  });

  test('shallow search ignores body', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — surface\n');
    writeMemory(roots.user, 'a', 'body has zebra inside\n');
    const reg = createMemoryRegistry({ roots });
    const ctx = makeCtx({ memoryRegistry: reg });
    const result = await memorySearchTool.execute({ query: 'zebra' }, ctx);
    if (isToolError(result)) throw new Error('unexpected');
    expect(result.hits).toEqual([]);
  });

  test('deep search matches body', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — surface\n');
    writeMemory(roots.user, 'a', 'body has zebra inside\n');
    const reg = createMemoryRegistry({ roots });
    const ctx = makeCtx({ memoryRegistry: reg });
    const result = await memorySearchTool.execute({ query: 'zebra', deep: true }, ctx);
    if (isToolError(result)) throw new Error('unexpected');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.matched_in).toBe('body');
  });

  test('respects limit and reports truncation', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) lines.push(`- [E${i}](e${i}.md) — alpha hit ${i}\n`);
    writeIndex(roots.user, lines.join(''));
    const reg = createMemoryRegistry({ roots });
    const ctx = makeCtx({ memoryRegistry: reg });
    const result = await memorySearchTool.execute({ query: 'alpha', limit: 3 }, ctx);
    if (isToolError(result)) throw new Error('unexpected');
    expect(result.hits).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  test('truncated=false when fewer hits than limit', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — alpha\n');
    const reg = createMemoryRegistry({ roots });
    const ctx = makeCtx({ memoryRegistry: reg });
    const result = await memorySearchTool.execute({ query: 'alpha', limit: 50 }, ctx);
    if (isToolError(result)) throw new Error('unexpected');
    expect(result.truncated).toBe(false);
  });

  test('rejects invalid limit', async () => {
    const repo = makeTmp();
    const reg = createMemoryRegistry({ roots: makeRoots(repo) });
    const ctx = makeCtx({ memoryRegistry: reg });
    const negative = await memorySearchTool.execute({ query: 'x', limit: -1 }, ctx);
    expect(isToolError(negative)).toBe(true);
    const tooBig = await memorySearchTool.execute({ query: 'x', limit: 9999 }, ctx);
    expect(isToolError(tooBig)).toBe(true);
  });

  test('rejects invalid scope', async () => {
    const repo = makeTmp();
    const reg = createMemoryRegistry({ roots: makeRoots(repo) });
    const ctx = makeCtx({ memoryRegistry: reg });
    const result = await memorySearchTool.execute(
      { query: 'x', scope: 'bogus' as unknown as 'user' },
      ctx,
    );
    expect(isToolError(result)).toBe(true);
  });

  test('deep over-fetch does NOT emit exposure for the dropped sentinel row', async () => {
    // Review regression. memory_search asks the registry for
    // `limit + 1` results to detect truncation, then slices the
    // response back down to `limit` before returning to the model.
    // Pre-fix the registry's deep branch audited every body-match
    // hit at read time, so the over-fetched +1 row landed as both
    // a memory_events `read` AND a memory_provenance row — even
    // though the model never saw its body. Detectors that treat
    // provenance as "visible to model" evidence got inflated
    // counts. Post-fix the tool passes `auditLimit: limit` and the
    // registry buffers audits until after the slice.
    //
    // Setup: 5 user-scope memories whose bodies all hit `zebra`.
    // Tool called with limit=3 → registry asked for 4 hits, the
    // model sees 3 hits + truncated=true. Exactly 3 read events +
    // 3 provenance rows must land — NOT 4.
    const db = openMemoryDb();
    migrate(db);
    const sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
    const messageId = appendMessage(db, {
      sessionId,
      role: 'assistant',
      content: { text: 'searching' },
    }).id;
    const toolCallId = createToolCall(db, {
      messageId,
      toolName: 'memory_search',
      input: { query: 'zebra', deep: true, limit: 3 },
    }).id;

    const repo = makeTmp();
    const roots = makeRoots(repo);
    const names = ['a', 'b', 'c', 'd', 'e'];
    writeIndex(roots.user, names.map((n) => `- [${n.toUpperCase()}](${n}.md) — h\n`).join(''));
    for (const n of names) {
      writeMemory(roots.user, n, `${n} body has zebra inside\n`);
    }
    const reg = createMemoryRegistry({ roots, db, sessionId });
    const ctx = makeCtx({ memoryRegistry: reg, sessionId, toolCallId });
    const result = await memorySearchTool.execute({ query: 'zebra', deep: true, limit: 3 }, ctx);
    if (isToolError(result)) throw new Error('unexpected');
    expect(result.hits).toHaveLength(3);
    expect(result.truncated).toBe(true);

    // memory_events: exactly 3 read rows across the 5 memories.
    // Pre-fix this would have been 4 (one per over-fetched hit).
    const allReads = names.flatMap((n) =>
      listMemoryEventsByName(db, n).filter((e) => e.action === 'read'),
    );
    expect(allReads).toHaveLength(3);

    // memory_provenance: exactly 3 rows linked to THIS tool_call.
    // Surface is memory_read because the search's deep branch
    // shares accountability with a direct read.
    const provenance = listProvenanceForToolCall(db, sessionId, toolCallId);
    expect(provenance).toHaveLength(3);
    for (const p of provenance) {
      expect(p.surface).toBe('memory_read');
    }
  });
});
