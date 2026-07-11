import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import { memoryListTool } from '../../src/tools/builtin/memory-list.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-tool-list-'));
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

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('memory_list tool', () => {
  test('returns clean error when registry not wired', async () => {
    const result = await memoryListTool.execute({}, makeCtx());
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe('memory.registry_unavailable');
    }
  });

  test('returns empty list when no scopes have memories', async () => {
    const repo = makeTmp();
    const reg = createMemoryRegistry({ roots: makeRoots(repo) });
    const ctx = makeCtx({ memoryRegistry: reg });
    const result = await memoryListTool.execute({}, ctx);
    expect(isToolError(result)).toBe(false);
    if (!isToolError(result)) {
      expect(result.entries).toEqual([]);
      expect(result.count).toBe(0);
    }
  });

  test('lists entries from all scopes in precedence order', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [U](u.md) — user-entry\n');
    writeIndex(roots.projectShared, '- [S](s.md) — shared-entry\n');
    writeIndex(roots.projectLocal, '- [L](l.md) — local-entry\n');
    const reg = createMemoryRegistry({ roots });
    const ctx = makeCtx({ memoryRegistry: reg });
    const result = await memoryListTool.execute({}, ctx);
    if (isToolError(result)) throw new Error('unexpected error');
    expect(result.entries.map((e) => e.scope)).toEqual(['project_local', 'project_shared', 'user']);
    expect(result.count).toBe(3);
  });

  test('honors scope filter', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [U](u.md) — user\n');
    writeIndex(roots.projectLocal, '- [L](l.md) — local\n');
    const reg = createMemoryRegistry({ roots });
    const ctx = makeCtx({ memoryRegistry: reg });
    const result = await memoryListTool.execute({ scope: 'user' }, ctx);
    if (isToolError(result)) throw new Error('unexpected error');
    expect(result.entries.map((e) => e.name)).toEqual(['u']);
  });

  test('honors dedupe_by_name', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — user\n');
    writeIndex(roots.projectLocal, '- [A](a.md) — local\n');
    const reg = createMemoryRegistry({ roots });
    const ctx = makeCtx({ memoryRegistry: reg });
    const all = await memoryListTool.execute({}, ctx);
    if (isToolError(all)) throw new Error('unexpected error');
    expect(all.count).toBe(2);
    const dedup = await memoryListTool.execute({ dedupe_by_name: true }, ctx);
    if (isToolError(dedup)) throw new Error('unexpected error');
    expect(dedup.count).toBe(1);
    expect(dedup.entries[0]?.scope).toBe('project_local');
  });

  test('rejects invalid scope value', async () => {
    const repo = makeTmp();
    const reg = createMemoryRegistry({ roots: makeRoots(repo) });
    const ctx = makeCtx({ memoryRegistry: reg });
    const result = await memoryListTool.execute({ scope: 'bogus' as unknown as 'user' }, ctx);
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe('tool.invalid_arg');
    }
  });

  test('rejects non-boolean dedupe_by_name', async () => {
    const repo = makeTmp();
    const reg = createMemoryRegistry({ roots: makeRoots(repo) });
    const ctx = makeCtx({ memoryRegistry: reg });
    const result = await memoryListTool.execute(
      { dedupe_by_name: 'yes' as unknown as boolean },
      ctx,
    );
    expect(isToolError(result)).toBe(true);
  });

  test('aborts cleanly when signal is already aborted', async () => {
    const repo = makeTmp();
    const reg = createMemoryRegistry({ roots: makeRoots(repo) });
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ memoryRegistry: reg, signal: ac.signal });
    const result = await memoryListTool.execute({}, ctx);
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe('tool.aborted');
    }
  });
});
