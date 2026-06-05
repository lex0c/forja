import { describe, expect, test } from 'bun:test';
import { type ClarifyInput, clarifyTool } from '../../src/tools/builtin/clarify.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

const OPTS = [
  { id: 'a', label: 'src/orders.ts' },
  { id: 'b', label: 'src/checkout.ts' },
];

const expectError = (result: unknown, code: string): void => {
  if (!isToolError(result)) {
    throw new Error(`expected tool error ${code}, got ${JSON.stringify(result)}`);
  }
  expect(result.error_code).toBe(code);
};

describe('clarify: option validation', () => {
  test('rejects fewer than 2 options', async () => {
    const result = await clarifyTool.execute(
      { question: 'q', options: [{ id: 'a', label: 'only one' }] },
      makeCtx(),
    );
    expectError(result, 'clarify.options_invalid');
  });

  test('rejects duplicate ids', async () => {
    const result = await clarifyTool.execute(
      {
        question: 'q',
        options: [
          { id: 'a', label: 'x' },
          { id: 'a', label: 'y' },
        ],
      },
      makeCtx(),
    );
    expectError(result, 'clarify.options_invalid');
  });

  test('rejects an option with an empty id', async () => {
    const result = await clarifyTool.execute(
      {
        question: 'q',
        options: [
          { id: '', label: 'x' },
          { id: 'b', label: 'y' },
        ],
      },
      makeCtx(),
    );
    expectError(result, 'clarify.options_invalid');
  });
});

describe('clarify: shape validation', () => {
  test('rejects empty question', async () => {
    const result = await clarifyTool.execute({ question: '', options: OPTS }, makeCtx());
    expectError(result, 'tool.invalid_arg');
  });

  test('rejects non-string why_it_matters', async () => {
    const bad = { question: 'q', options: OPTS, why_it_matters: 42 } as unknown as ClarifyInput;
    const result = await clarifyTool.execute(bad, makeCtx());
    expectError(result, 'tool.invalid_arg');
  });
});

describe('clarify: every call routes through the modal bridge', () => {
  test('returns clarify.modal_unavailable when no bridge is attached (headless)', async () => {
    const result = await clarifyTool.execute({ question: 'q', options: OPTS }, makeCtx());
    expectError(result, 'clarify.modal_unavailable');
  });

  test('resolved — operator picked an option', async () => {
    const result = await clarifyTool.execute(
      { question: 'q', options: OPTS },
      makeCtx({ clarify: async () => ({ outcome: 'resolved' as const, chosen_option_id: 'b' }) }),
    );
    if (isToolError(result)) throw new Error(`unexpected: ${result.error_message}`);
    expect(result.outcome).toBe('resolved');
    expect(result.chosen_option_id).toBe('b');
  });

  test('skipped — falls back to options[0] as the assumed default', async () => {
    const result = await clarifyTool.execute(
      { question: 'q', options: OPTS },
      makeCtx({ clarify: async () => ({ outcome: 'skipped' as const }) }),
    );
    if (isToolError(result)) throw new Error(`unexpected: ${result.error_message}`);
    expect(result.outcome).toBe('skipped');
    expect(result.chosen_option_id).toBe('a');
  });

  test('escalated — carries user_text, no chosen option', async () => {
    const result = await clarifyTool.execute(
      { question: 'q', options: OPTS },
      makeCtx({
        clarify: async () => ({ outcome: 'escalated' as const, user_text: 'goal is wrong' }),
      }),
    );
    if (isToolError(result)) throw new Error(`unexpected: ${result.error_message}`);
    expect(result.outcome).toBe('escalated');
    expect(result.user_text).toBe('goal is wrong');
    expect(result.chosen_option_id).toBeUndefined();
  });

  test('forwards the request fields to the bridge', async () => {
    let received: unknown;
    await clarifyTool.execute(
      { question: 'which validateOrder?', options: OPTS, why_it_matters: 'stakes differ' },
      makeCtx({
        clarify: async (req) => {
          received = req;
          return { outcome: 'resolved' as const, chosen_option_id: 'a' };
        },
      }),
    );
    expect(received).toEqual({
      question: 'which validateOrder?',
      options: OPTS,
      why_it_matters: 'stakes differ',
    });
  });
});

describe('clarify: abort', () => {
  test('returns tool.aborted when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await clarifyTool.execute(
      { question: 'q', options: OPTS },
      makeCtx({ signal: ac.signal }),
    );
    expectError(result, 'tool.aborted');
  });
});
