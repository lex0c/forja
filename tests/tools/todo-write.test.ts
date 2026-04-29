import { describe, expect, test } from 'bun:test';
import { createTodoStore } from '../../src/todo/index.ts';
import { todoWriteTool } from '../../src/tools/builtin/todo-write.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

describe('todo_write tool: happy paths', () => {
  test('writes a list and echoes it back with counts', async () => {
    const store = createTodoStore();
    const ctx = makeCtx({ sessionId: 's1', todoStore: store });
    const r = await todoWriteTool.execute(
      {
        items: [
          { content: 'design schema', status: 'done', active_form: 'designing schema' },
          { content: 'write tests', status: 'in_progress', active_form: 'writing tests' },
          { content: 'wire harness', status: 'pending', active_form: 'wiring harness' },
        ],
      },
      ctx,
    );
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.items).toHaveLength(3);
    expect(r.pending).toBe(1);
    expect(r.in_progress).toBe(1);
    expect(r.done).toBe(1);
    // Stored under the right session key.
    const stored = store.get('s1');
    expect(stored).toHaveLength(3);
    expect(stored[1]?.activeForm).toBe('writing tests');
  });

  test('replaces the list atomically', async () => {
    const store = createTodoStore();
    const ctx = makeCtx({ sessionId: 's1', todoStore: store });
    await todoWriteTool.execute(
      {
        items: [
          { content: 'a', status: 'pending', active_form: 'doing a' },
          { content: 'b', status: 'pending', active_form: 'doing b' },
        ],
      },
      ctx,
    );
    const r = await todoWriteTool.execute(
      { items: [{ content: 'c', status: 'done', active_form: 'did c' }] },
      ctx,
    );
    if (isToolError(r)) throw new Error('unexpected');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.content).toBe('c');
    expect(store.get('s1')).toHaveLength(1);
  });

  test('empty array clears the list', async () => {
    const store = createTodoStore();
    const ctx = makeCtx({ sessionId: 's1', todoStore: store });
    await todoWriteTool.execute(
      { items: [{ content: 'a', status: 'pending', active_form: 'doing a' }] },
      ctx,
    );
    const r = await todoWriteTool.execute({ items: [] }, ctx);
    if (isToolError(r)) throw new Error('unexpected');
    expect(r.items).toHaveLength(0);
    expect(r.pending).toBe(0);
    expect(store.get('s1')).toEqual([]);
  });

  test('per-session isolation', async () => {
    const store = createTodoStore();
    await todoWriteTool.execute(
      { items: [{ content: 'A', status: 'pending', active_form: 'doing A' }] },
      makeCtx({ sessionId: 's1', todoStore: store }),
    );
    await todoWriteTool.execute(
      { items: [{ content: 'B', status: 'done', active_form: 'did B' }] },
      makeCtx({ sessionId: 's2', todoStore: store }),
    );
    expect(store.get('s1')[0]?.content).toBe('A');
    expect(store.get('s2')[0]?.content).toBe('B');
  });
});

describe('todo_write tool: validation', () => {
  test('rejects non-array items', async () => {
    const ctx = makeCtx({ sessionId: 's1', todoStore: createTodoStore() });
    const r = await todoWriteTool.execute(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
      { items: 'not-array' as any },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
  });

  test('rejects non-object item', async () => {
    const ctx = makeCtx({ sessionId: 's1', todoStore: createTodoStore() });
    const r = await todoWriteTool.execute(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
      { items: ['not-an-object'] as any },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('items[0]');
  });

  test('rejects empty content', async () => {
    const ctx = makeCtx({ sessionId: 's1', todoStore: createTodoStore() });
    const r = await todoWriteTool.execute(
      { items: [{ content: '', status: 'pending', active_form: 'x' }] },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('content');
  });

  test('rejects unknown status', async () => {
    const ctx = makeCtx({ sessionId: 's1', todoStore: createTodoStore() });
    const r = await todoWriteTool.execute(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
      { items: [{ content: 'a', status: 'wip' as any, active_form: 'doing a' }] },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('status');
  });

  test('rejects empty active_form', async () => {
    const ctx = makeCtx({ sessionId: 's1', todoStore: createTodoStore() });
    const r = await todoWriteTool.execute(
      { items: [{ content: 'a', status: 'pending', active_form: '' }] },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('active_form');
  });

  test('rejects more than one in_progress item', async () => {
    // Spec §7.4: at most one item in_progress at a time. The tool
    // enforces this so the TUI's "what am I doing right now"
    // signal stays trustworthy.
    const ctx = makeCtx({ sessionId: 's1', todoStore: createTodoStore() });
    const r = await todoWriteTool.execute(
      {
        items: [
          { content: 'a', status: 'in_progress', active_form: 'doing a' },
          { content: 'b', status: 'in_progress', active_form: 'doing b' },
        ],
      },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('in_progress');
  });

  test('exactly one in_progress is allowed', async () => {
    const ctx = makeCtx({ sessionId: 's1', todoStore: createTodoStore() });
    const r = await todoWriteTool.execute(
      {
        items: [
          { content: 'a', status: 'done', active_form: 'did a' },
          { content: 'b', status: 'in_progress', active_form: 'doing b' },
          { content: 'c', status: 'pending', active_form: 'doing c' },
        ],
      },
      ctx,
    );
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.in_progress).toBe(1);
  });

  test('zero in_progress is allowed (e.g., everything done or pending)', async () => {
    const ctx = makeCtx({ sessionId: 's1', todoStore: createTodoStore() });
    const r = await todoWriteTool.execute(
      {
        items: [
          { content: 'a', status: 'done', active_form: 'did a' },
          { content: 'b', status: 'done', active_form: 'did b' },
        ],
      },
      ctx,
    );
    if (isToolError(r)) throw new Error('unexpected');
    expect(r.in_progress).toBe(0);
  });

  test('rejects non-string content (number)', async () => {
    const ctx = makeCtx({ sessionId: 's1', todoStore: createTodoStore() });
    const r = await todoWriteTool.execute(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
      { items: [{ content: 42 as any, status: 'pending', active_form: 'x' }] },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('content');
  });

  test('rejects null status', async () => {
    const ctx = makeCtx({ sessionId: 's1', todoStore: createTodoStore() });
    const r = await todoWriteTool.execute(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
      { items: [{ content: 'a', status: null as any, active_form: 'x' }] },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('status');
  });

  test('rejects numeric active_form', async () => {
    const ctx = makeCtx({ sessionId: 's1', todoStore: createTodoStore() });
    const r = await todoWriteTool.execute(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
      { items: [{ content: 'a', status: 'pending', active_form: 7 as any }] },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('active_form');
  });

  test('rejects items array exceeding the cap', async () => {
    const ctx = makeCtx({ sessionId: 's1', todoStore: createTodoStore() });
    const items = Array.from({ length: 201 }, (_, i) => ({
      content: `task ${i}`,
      status: 'pending' as const,
      active_form: `doing task ${i}`,
    }));
    const r = await todoWriteTool.execute({ items }, ctx);
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('200');
  });

  test('rejects content exceeding 4 KB', async () => {
    const ctx = makeCtx({ sessionId: 's1', todoStore: createTodoStore() });
    const huge = 'x'.repeat(5000);
    const r = await todoWriteTool.execute(
      { items: [{ content: huge, status: 'pending', active_form: 'x' }] },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('4096');
  });

  test('rejects active_form exceeding 4 KB', async () => {
    const ctx = makeCtx({ sessionId: 's1', todoStore: createTodoStore() });
    const huge = 'x'.repeat(5000);
    const r = await todoWriteTool.execute(
      { items: [{ content: 'a', status: 'pending', active_form: huge }] },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('4096');
  });

  test('accepts content at exactly the byte cap', async () => {
    const ctx = makeCtx({ sessionId: 's1', todoStore: createTodoStore() });
    const exact = 'x'.repeat(4096);
    const r = await todoWriteTool.execute(
      { items: [{ content: exact, status: 'pending', active_form: 'x' }] },
      ctx,
    );
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(r.items[0]?.content.length).toBe(4096);
  });
});

describe('todo_write tool: ctx wiring', () => {
  test('returns todo.store_unavailable when ctx lacks store', async () => {
    const ctx = makeCtx({ sessionId: 's1' }); // no todoStore
    const r = await todoWriteTool.execute(
      { items: [{ content: 'a', status: 'pending', active_form: 'doing a' }] },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('todo.store_unavailable');
  });

  test('returns tool.aborted when ctx.signal is pre-aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({
      sessionId: 's1',
      signal: ac.signal,
      todoStore: createTodoStore(),
    });
    const r = await todoWriteTool.execute(
      { items: [{ content: 'a', status: 'pending', active_form: 'doing a' }] },
      ctx,
    );
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.aborted');
  });
});
