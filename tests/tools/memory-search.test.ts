import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
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
});
