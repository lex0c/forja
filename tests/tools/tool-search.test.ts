import { describe, expect, test } from 'bun:test';
import { rankDeferredTools, toolSearchTool } from '../../src/tools/builtin/tool-search.ts';
import { ERROR_CODES, isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

const CATALOG = [
  { name: 'bash_kill', description: 'Terminate a background process. SIGTERM then SIGKILL.' },
  { name: 'bash_list', description: 'List the session background processes.' },
  { name: 'task_cancel', description: 'Cancel a running async subagent by handle.' },
  { name: 'memory_write', description: 'Persist a cross-session memory entry to disk.' },
];

describe('rankDeferredTools', () => {
  test('keyword ranks by how many terms hit name+description', () => {
    const { names } = rankDeferredTools(CATALOG, 'background process');
    // bash_list ("background processes") and bash_kill ("background process")
    // both hit both terms; the unrelated tools score 0 and drop out.
    expect(names).toContain('bash_kill');
    expect(names).toContain('bash_list');
    expect(names).not.toContain('memory_write');
  });

  test('zero-score query returns nothing (no accidental reveal)', () => {
    expect(rankDeferredTools(CATALOG, 'wholly unrelated zzz').names).toEqual([]);
  });

  test('matches the tool NAME, not only the description', () => {
    expect(rankDeferredTools(CATALOG, 'task_cancel').names).toEqual(['task_cancel']);
  });

  test('select: fetches exact names and reports misses in notFound', () => {
    const { names, notFound } = rankDeferredTools(CATALOG, 'select:memory_write,nope,bash_kill');
    expect(names).toEqual(['memory_write', 'bash_kill']);
    expect(notFound).toEqual(['nope']);
  });

  test('select: ignores empty segments and whitespace', () => {
    const { names, notFound } = rankDeferredTools(CATALOG, 'select: bash_kill , , memory_write ');
    expect(names).toEqual(['bash_kill', 'memory_write']);
    expect(notFound).toEqual([]);
  });

  test('select: dedupes repeated names (no double reveal / double hit)', () => {
    const { names, notFound } = rankDeferredTools(CATALOG, 'select:bash_kill,bash_kill,nope,nope');
    expect(names).toEqual(['bash_kill']);
    expect(notFound).toEqual(['nope']);
  });

  test('keyword hits are capped at 8', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      name: `tool_${i}`,
      description: 'shared keyword widget',
    }));
    expect(rankDeferredTools(many, 'widget').names).toHaveLength(8);
  });
});

describe('toolSearchTool.execute', () => {
  test('empty / whitespace query is a clean invalid-arg', async () => {
    const res = await toolSearchTool.execute({ query: '   ' }, makeCtx());
    expect(isToolError(res)).toBe(true);
    if (isToolError(res)) expect(res.error_code).toBe(ERROR_CODES.invalidArg);
  });

  test('without ctx.searchTools wiring → tool_search.unavailable (subagent/headless)', async () => {
    const res = await toolSearchTool.execute({ query: 'anything' }, makeCtx());
    expect(isToolError(res)).toBe(true);
    if (isToolError(res)) expect(res.error_code).toBe(ERROR_CODES.toolSearchUnavailable);
  });

  test('delegates to ctx.searchTools and passes the result through', async () => {
    const hit = { name: 'memory_write', description: 'persist', inputSchema: { type: 'object' } };
    const ctx = {
      ...makeCtx(),
      searchTools: (q: string) => {
        expect(q).toBe('persist memory');
        return { tools: [hit], notFound: [] };
      },
    };
    const res = await toolSearchTool.execute({ query: 'persist memory' }, ctx);
    expect(isToolError(res)).toBe(false);
    if (!isToolError(res)) {
      expect(res.tools).toEqual([hit]);
      expect(res.notFound).toEqual([]);
    }
  });
});
