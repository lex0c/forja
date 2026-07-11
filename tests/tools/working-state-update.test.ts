import { describe, expect, test } from 'bun:test';
import { workingStateUpdateTool } from '../../src/tools/builtin/working-state-update.ts';
import { isToolError, type ToolContext } from '../../src/tools/types.ts';
import { createWorkingStateStore, type WorkingStateStore } from '../../src/working-state/index.ts';
import { makeCtx } from './_helpers.ts';

const setup = (
  step = 1,
): { store: WorkingStateStore; ctx: ToolContext; setStep: (n: number) => void } => {
  const store = createWorkingStateStore();
  let stepN = step;
  const ctx = makeCtx({
    workingStateStore: store,
    sessionId: 's1',
    getStepNumber: () => stepN,
  });
  return {
    store,
    ctx,
    setStep: (n) => {
      stepN = n;
    },
  };
};

const run = (ctx: ToolContext, args: Parameters<typeof workingStateUpdateTool.execute>[0]) =>
  workingStateUpdateTool.execute(args, ctx);

const expectError = (result: unknown, code: string): void => {
  if (!isToolError(result))
    throw new Error(`expected tool error ${code}, got ${JSON.stringify(result)}`);
  expect(result.error_code).toBe(code);
};

describe('working_state_update — guards', () => {
  test('clean error when no store is wired', async () => {
    const ctx = makeCtx({ sessionId: 's1' }); // no workingStateStore
    expectError(await run(ctx, { focus: 'x' }), 'working_state.store_unavailable');
  });

  test('aborted signal short-circuits', async () => {
    const store = createWorkingStateStore();
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ workingStateStore: store, sessionId: 's1', signal: ac.signal });
    expectError(await run(ctx, { focus: 'x' }), 'tool.aborted');
  });

  test('empty patch is rejected', async () => {
    const { ctx } = setup();
    expectError(await run(ctx, {}), 'tool.invalid_arg');
  });

  test('type errors are clean invalid_arg', async () => {
    const { ctx } = setup();
    expectError(await run(ctx, { focus: 5 as unknown as string }), 'tool.invalid_arg');
    expectError(await run(ctx, { next: 'a' as unknown as string[] }), 'tool.invalid_arg');
    expectError(
      await run(ctx, { hypothesis_add: { text: 'x', source: 'nope' as unknown as 'user' } }),
      'tool.invalid_arg',
    );
  });
});

describe('working_state_update — focus / next / log', () => {
  test('focus is set and echoed', async () => {
    const { ctx } = setup();
    const r = await run(ctx, { focus: 'investigate cache' });
    if (isToolError(r)) throw new Error(r.error_message);
    expect(r.focus).toBe('investigate cache');
    expect(r.mutations.focusChanged).toBe(1);
  });

  test('next overflow yields a notice and caps the list', async () => {
    const { ctx } = setup();
    const r = await run(ctx, { next: ['a', 'b', 'c', 'd', 'e', 'f'] });
    if (isToolError(r)) throw new Error(r.error_message);
    expect(r.next).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(r.notices.some((n) => n.includes('todo_create'))).toBe(true);
  });

  test('log_append accumulates across calls', async () => {
    const { ctx } = setup();
    await run(ctx, { log_append: ['m1'] });
    const r = await run(ctx, { log_append: ['m2', 'm3'] });
    if (isToolError(r)) throw new Error(r.error_message);
    expect(r.log_size).toBe(3);
    expect(r.mutations.logAppended).toBe(2);
  });
});

describe('working_state_update — hypotheses', () => {
  test('add returns the created id and defaults source to model', async () => {
    const { ctx } = setup();
    const r = await run(ctx, { hypothesis_add: { text: 'bug in glob' } });
    if (isToolError(r)) throw new Error(r.error_message);
    expect(r.created_hypothesis_id).toBe('H1');
    expect(r.hypotheses[0]?.source).toBe('model');
    expect(r.mutations.hypothesisCreated).toBe(1);
  });

  test('confirming a hypothesis removes it from the active list', async () => {
    const { ctx } = setup();
    const added = await run(ctx, { hypothesis_add: { text: 'is auth' } });
    if (isToolError(added)) throw new Error(added.error_message);
    const id = added.created_hypothesis_id as string;

    const r = await run(ctx, { hypothesis_update: { id, status: 'confirmed' } });
    if (isToolError(r)) throw new Error(r.error_message);
    expect(r.hypotheses).toHaveLength(0);
    expect(r.mutations.hypothesisConfirmed).toBe(1);
  });

  test('unknown hypothesis id is a non-fatal no-op + notice; sibling fields still apply', async () => {
    const { ctx } = setup();
    // The whole call must NOT fail (that would discard `focus` and loop the model
    // into inventing placeholder ids).
    const r = await run(ctx, {
      focus: 'mapping the repo',
      hypothesis_update: { id: 'H99', evidence_append: ['x'] },
    });
    if (isToolError(r)) throw new Error(`should not error: ${r.error_message}`);
    expect(r.focus).toBe('mapping the repo'); // sibling field applied
    expect(r.hypotheses).toHaveLength(0); // nothing updated/created
    expect(r.notices.some((n) => n.includes('H99'))).toBe(true); // skip surfaced
  });

  test('updating a confirmed (archived) hypothesis is a no-op notice, not an error', async () => {
    const { ctx } = setup();
    const added = await run(ctx, { hypothesis_add: { text: 'h' } });
    if (isToolError(added)) throw new Error(added.error_message);
    const id = added.created_hypothesis_id as string;
    await run(ctx, { hypothesis_update: { id, status: 'confirmed' } });
    // id is now archived → unknown to the active list → no-op + notice (this call
    // has only the bad update, so it's an empty-after-drop soft result).
    const r = await run(ctx, { hypothesis_update: { id, evidence_append: ['late'] } });
    if (isToolError(r)) throw new Error(`should not error: ${r.error_message}`);
    expect(r.notices.some((n) => n.includes(id))).toBe(true);
  });

  test('age_steps reflects the step gap via getStepNumber', async () => {
    const { ctx, setStep } = setup(5);
    const added = await run(ctx, { hypothesis_add: { text: 'h' } });
    if (isToolError(added)) throw new Error(added.error_message);
    expect(added.hypotheses[0]?.age_steps).toBe(0);

    setStep(12);
    const r = await run(ctx, { focus: 'still here' });
    if (isToolError(r)) throw new Error(r.error_message);
    expect(r.hypotheses[0]?.age_steps).toBe(7);
  });

  test('state persists across calls through the injected store', async () => {
    const { store, ctx } = setup();
    await run(ctx, { focus: 'f', hypothesis_add: { text: 'h' } });
    expect(store.get('s1').focus?.text).toBe('f');
    expect(store.get('s1').hypotheses).toHaveLength(1);
  });
});
