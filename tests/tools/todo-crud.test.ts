import { describe, expect, test } from 'bun:test';
import { createTodoStore } from '../../src/todo/index.ts';
import { todoClearTool } from '../../src/tools/builtin/todo-clear.ts';
import { todoCreateTool } from '../../src/tools/builtin/todo-create.ts';
import { todoGetTool } from '../../src/tools/builtin/todo-get.ts';
import { todoListTool } from '../../src/tools/builtin/todo-list.ts';
import { todoUpdateTool } from '../../src/tools/builtin/todo-update.ts';
import { type ToolContext, isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

const setup = (): { store: ReturnType<typeof createTodoStore>; ctx: ToolContext } => {
  const store = createTodoStore();
  return { store, ctx: makeCtx({ todoStore: store, sessionId: 's1' }) };
};

const expectError = (result: unknown, code: string): void => {
  if (!isToolError(result)) {
    throw new Error(`expected tool error ${code}, got ${JSON.stringify(result)}`);
  }
  expect(result.error_code).toBe(code);
};

const seedOne = (ctx: ToolContext) =>
  todoCreateTool.execute({ items: [{ content: 'a', active_form: 'doing a' }] }, ctx);

describe('todo_create', () => {
  test('assigns sequential ids, defaults pending, appends to existing', async () => {
    const { ctx } = setup();
    const r1 = await todoCreateTool.execute(
      { items: [{ content: 'a', active_form: 'doing a' }] },
      ctx,
    );
    if (isToolError(r1)) throw new Error(r1.error_message);
    expect(r1.created.map((i) => i.id)).toEqual(['1']);
    expect(r1.created[0]?.status).toBe('pending');

    const r2 = await todoCreateTool.execute(
      { items: [{ content: 'b', active_form: 'doing b' }] },
      ctx,
    );
    if (isToolError(r2)) throw new Error(r2.error_message);
    expect(r2.created.map((i) => i.id)).toEqual(['2']);
    expect(r2.items.map((i) => i.content)).toEqual(['a', 'b']);
    expect(r2.pending).toBe(2);
  });

  test('accepts an explicit status', async () => {
    const { ctx } = setup();
    const r = await todoCreateTool.execute(
      {
        items: [
          { content: 'a', active_form: 'doing a' },
          { content: 'b', status: 'in_progress', active_form: 'doing b' },
        ],
      },
      ctx,
    );
    if (isToolError(r)) throw new Error(r.error_message);
    expect(r.pending).toBe(1);
    expect(r.in_progress).toBe(1);
  });

  test('rejects a 2nd in_progress across the combined list', async () => {
    const { ctx } = setup();
    await todoCreateTool.execute(
      { items: [{ content: 'a', status: 'in_progress', active_form: 'doing a' }] },
      ctx,
    );
    const r = await todoCreateTool.execute(
      { items: [{ content: 'b', status: 'in_progress', active_form: 'doing b' }] },
      ctx,
    );
    expectError(r, 'tool.invalid_arg');
  });

  test('rejects control characters in content (source-level guard)', async () => {
    const { ctx } = setup();
    const r = await todoCreateTool.execute({ items: [{ content: 'a\nb', active_form: 'x' }] }, ctx);
    expectError(r, 'tool.invalid_arg');
  });

  test('rejects exceeding the item cap', async () => {
    const { ctx } = setup();
    const items = Array.from({ length: 201 }, (_, i) => ({
      content: `t${i}`,
      active_form: `doing ${i}`,
    }));
    expectError(await todoCreateTool.execute({ items }, ctx), 'tool.invalid_arg');
  });

  test('store_unavailable when no todoStore is wired', async () => {
    const ctx = makeCtx({ sessionId: 's1' });
    const r = await todoCreateTool.execute({ items: [{ content: 'a', active_form: 'x' }] }, ctx);
    expectError(r, 'todo.store_unavailable');
  });

  test('a rejected create does not burn ids (no gap on the next create)', async () => {
    const { ctx } = setup();
    // empty content rejects AFTER no id is consumed
    await todoCreateTool.execute({ items: [{ content: '', active_form: 'x' }] }, ctx);
    const r = await todoCreateTool.execute({ items: [{ content: 'a', active_form: 'x' }] }, ctx);
    if (isToolError(r)) throw new Error(r.error_message);
    expect(r.created[0]?.id).toBe('1');
  });

  test('rejects status:removed at create (soft-delete is via todo_update)', async () => {
    const { ctx } = setup();
    const r = await todoCreateTool.execute(
      { items: [{ content: 'a', status: 'removed', active_form: 'a' }] },
      ctx,
    );
    expectError(r, 'tool.invalid_arg');
  });
});

describe('todo_update', () => {
  test('patches a single field, leaves the rest intact', async () => {
    const { ctx } = setup();
    await seedOne(ctx);
    const r = await todoUpdateTool.execute({ id: '1', status: 'done' }, ctx);
    if (isToolError(r)) throw new Error(r.error_message);
    expect(r.item.status).toBe('done');
    expect(r.item.content).toBe('a');
    expect(r.item.active_form).toBe('doing a');
  });

  test('not_found for an unknown id', async () => {
    const { ctx } = setup();
    await seedOne(ctx);
    expectError(await todoUpdateTool.execute({ id: '999', status: 'done' }, ctx), 'todo.not_found');
  });

  test('can mark a row failed', async () => {
    const { ctx } = setup();
    await seedOne(ctx);
    const r = await todoUpdateTool.execute({ id: '1', status: 'failed' }, ctx);
    if (isToolError(r)) throw new Error(r.error_message);
    expect(r.item.status).toBe('failed');
    expect(r.failed).toBe(1);
  });

  test('idempotent — same patch twice yields the same store state', async () => {
    const { ctx, store } = setup();
    await seedOne(ctx);
    await todoUpdateTool.execute({ id: '1', status: 'done' }, ctx);
    const after1 = store.get('s1');
    await todoUpdateTool.execute({ id: '1', status: 'done' }, ctx);
    expect(store.get('s1')).toEqual(after1);
  });

  test('rejects a patch with no fields', async () => {
    const { ctx } = setup();
    await seedOne(ctx);
    expectError(await todoUpdateTool.execute({ id: '1' }, ctx), 'tool.invalid_arg');
  });

  test('rejects a patch that would create a 2nd in_progress', async () => {
    const { ctx } = setup();
    await todoCreateTool.execute(
      {
        items: [
          { content: 'a', status: 'in_progress', active_form: 'doing a' },
          { content: 'b', active_form: 'doing b' },
        ],
      },
      ctx,
    );
    expectError(
      await todoUpdateTool.execute({ id: '2', status: 'in_progress' }, ctx),
      'tool.invalid_arg',
    );
  });
});

describe('todo_list', () => {
  test('lists all; filters by status; counts stay over the full set', async () => {
    const { ctx } = setup();
    await todoCreateTool.execute(
      {
        items: [
          { content: 'a', status: 'done', active_form: 'a' },
          { content: 'b', active_form: 'b' },
          { content: 'c', active_form: 'c' },
        ],
      },
      ctx,
    );
    const all = await todoListTool.execute({}, ctx);
    if (isToolError(all)) throw new Error(all.error_message);
    expect(all.total).toBe(3);
    expect(all.done).toBe(1);
    expect(all.pending).toBe(2);
    expect(all.items).toHaveLength(3);

    const pending = await todoListTool.execute({ status: 'pending' }, ctx);
    if (isToolError(pending)) throw new Error(pending.error_message);
    expect(pending.items).toHaveLength(2);
    expect(pending.total).toBe(3);
    expect(pending.done).toBe(1);
  });

  test('empty session → empty list and zero counts', async () => {
    const { ctx } = setup();
    const r = await todoListTool.execute({}, ctx);
    if (isToolError(r)) throw new Error(r.error_message);
    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
  });
});

describe('todo_get', () => {
  test('returns the item by id', async () => {
    const { ctx } = setup();
    await seedOne(ctx);
    const r = await todoGetTool.execute({ id: '1' }, ctx);
    if (isToolError(r)) throw new Error(r.error_message);
    expect(r.item.id).toBe('1');
    expect(r.item.content).toBe('a');
  });

  test('not_found for an unknown id', async () => {
    const { ctx } = setup();
    expectError(await todoGetTool.execute({ id: '1' }, ctx), 'todo.not_found');
  });
});

describe('soft-delete (todo_update status removed)', () => {
  test('a removed todo drops out of todo_list and counts', async () => {
    const { ctx } = setup();
    await todoCreateTool.execute(
      {
        items: [
          { content: 'a', active_form: 'a' },
          { content: 'b', active_form: 'b' },
        ],
      },
      ctx,
    );
    await todoUpdateTool.execute({ id: '1', status: 'removed' }, ctx);
    const r = await todoListTool.execute({}, ctx);
    if (isToolError(r)) throw new Error(r.error_message);
    expect(r.total).toBe(1);
    expect(r.items.map((i) => i.id)).toEqual(['2']);
    expect(r.pending).toBe(1);
  });

  test('ids are not recycled after a removal', async () => {
    const { ctx } = setup();
    await todoCreateTool.execute({ items: [{ content: 'a', active_form: 'a' }] }, ctx);
    await todoUpdateTool.execute({ id: '1', status: 'removed' }, ctx);
    const r = await todoCreateTool.execute({ items: [{ content: 'b', active_form: 'b' }] }, ctx);
    if (isToolError(r)) throw new Error(r.error_message);
    expect(r.created[0]?.id).toBe('2');
  });

  test('removed rows do not consume the active cap', async () => {
    const { ctx } = setup();
    const items = Array.from({ length: 200 }, (_, i) => ({
      content: `t${i}`,
      active_form: `${i}`,
    }));
    await todoCreateTool.execute({ items }, ctx);
    await todoUpdateTool.execute({ id: '1', status: 'removed' }, ctx);
    // 200 created, 1 removed → 199 active, so one more fits.
    const r = await todoCreateTool.execute(
      { items: [{ content: 'extra', active_form: 'x' }] },
      ctx,
    );
    if (isToolError(r)) throw new Error(`expected fit, got ${r.error_message}`);
    expect(r.created).toHaveLength(1);
  });

  test('todo_get on a removed id resolves to not_found', async () => {
    const { ctx } = setup();
    await todoCreateTool.execute({ items: [{ content: 'a', active_form: 'a' }] }, ctx);
    await todoUpdateTool.execute({ id: '1', status: 'removed' }, ctx);
    expectError(await todoGetTool.execute({ id: '1' }, ctx), 'todo.not_found');
  });

  test('todo_update on a removed id is not_found (no resurrection)', async () => {
    const { ctx } = setup();
    await todoCreateTool.execute({ items: [{ content: 'a', active_form: 'a' }] }, ctx);
    await todoUpdateTool.execute({ id: '1', status: 'removed' }, ctx);
    expectError(
      await todoUpdateTool.execute({ id: '1', status: 'pending' }, ctx),
      'todo.not_found',
    );
  });
});

describe('todo_clear', () => {
  const seed3 = (ctx: ToolContext) =>
    todoCreateTool.execute(
      {
        items: [
          { content: 'a', status: 'done', active_form: 'a' },
          { content: 'b', active_form: 'b' },
          { content: 'c', active_form: 'c' },
        ],
      },
      ctx,
    );

  test('no args empties the whole list', async () => {
    const { ctx } = setup();
    await seed3(ctx);
    const r = await todoClearTool.execute({}, ctx);
    if (isToolError(r)) throw new Error(r.error_message);
    expect(r.cleared).toBe(3);
    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
  });

  test('with a status removes only that status', async () => {
    const { ctx } = setup();
    await seed3(ctx);
    const r = await todoClearTool.execute({ status: 'done' }, ctx);
    if (isToolError(r)) throw new Error(r.error_message);
    expect(r.cleared).toBe(1);
    expect(r.total).toBe(2);
    expect(r.items.every((i) => i.status !== 'done')).toBe(true);
  });

  test('does not reset the id counter', async () => {
    const { ctx } = setup();
    await seed3(ctx);
    await todoClearTool.execute({}, ctx);
    const r = await todoCreateTool.execute({ items: [{ content: 'd', active_form: 'd' }] }, ctx);
    if (isToolError(r)) throw new Error(r.error_message);
    expect(r.created[0]?.id).toBe('4');
  });

  test('store_unavailable when no todoStore', async () => {
    const ctx = makeCtx({ sessionId: 's1' });
    expectError(await todoClearTool.execute({}, ctx), 'todo.store_unavailable');
  });
});
