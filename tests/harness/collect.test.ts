import { describe, expect, test } from 'bun:test';
import { collectStep } from '../../src/harness/collect.ts';
import type { StreamEvent } from '../../src/providers/index.ts';

const fromEvents = (events: StreamEvent[]): AsyncIterable<StreamEvent> =>
  (async function* () {
    for (const e of events) yield e;
  })();

describe('collectStep', () => {
  test('text-only stream', async () => {
    const out = await collectStep(
      fromEvents([
        { kind: 'start', message_id: 'm1' },
        { kind: 'text_delta', text: 'hello ' },
        { kind: 'text_delta', text: 'world' },
        { kind: 'stop', reason: 'end_turn' },
      ]),
    );
    expect(out.message_id).toBe('m1');
    expect(out.text).toBe('hello world');
    expect(out.tool_uses).toEqual([]);
    expect(out.stop_reason).toBe('end_turn');
    expect(out.errors).toEqual([]);
  });

  test('reasoning events are collected verbatim into reasoning[]', async () => {
    const out = await collectStep(
      fromEvents([
        { kind: 'start', message_id: 'm_r' },
        { kind: 'thinking_delta', text: 'think live' },
        {
          kind: 'reasoning',
          provider: 'anthropic',
          data: { thinking: 'think live', signature: 'SIG1' },
        },
        { kind: 'text_delta', text: 'answer' },
        { kind: 'stop', reason: 'end_turn' },
      ]),
    );
    expect(out.reasoning).toEqual([
      {
        type: 'reasoning',
        provider: 'anthropic',
        data: { thinking: 'think live', signature: 'SIG1' },
      },
    ]);
    // thinking-delta still feeds the live-display text channel, orthogonally.
    expect(out.thinking).toBe('think live');
    expect(out.text).toBe('answer');
  });

  test('order preserves interleaved reasoning/tool_use/text (not bucketed grouping)', async () => {
    const out = await collectStep(
      fromEvents([
        { kind: 'start', message_id: 'm_i' },
        { kind: 'reasoning', provider: 'anthropic', data: { thinking: 't1', signature: 'S1' } },
        { kind: 'text_delta', text: 'let me look' },
        { kind: 'tool_use_start', id: 'c1', name: 'read' },
        { kind: 'tool_use_stop', id: 'c1', final_args: { p: '/a' } },
        { kind: 'reasoning', provider: 'anthropic', data: { thinking: 't2', signature: 'S2' } },
        { kind: 'tool_use_start', id: 'c2', name: 'read' },
        { kind: 'tool_use_stop', id: 'c2', final_args: { p: '/b' } },
        { kind: 'stop', reason: 'tool_use' },
      ]),
    );
    // Buckets still populated for order-agnostic consumers.
    expect(out.reasoning).toHaveLength(2);
    expect(out.tool_uses).toHaveLength(2);
    // order captures the exact emission sequence.
    expect(out.order.map((b) => b.kind)).toEqual([
      'reasoning',
      'text',
      'tool_use',
      'reasoning',
      'tool_use',
    ]);
    const textBlock = out.order.find((b) => b.kind === 'text');
    expect(textBlock).toEqual({ kind: 'text', text: 'let me look' });
  });

  test('single tool_use accumulates name from start, args from stop', async () => {
    const out = await collectStep(
      fromEvents([
        { kind: 'start', message_id: 'm2' },
        { kind: 'tool_use_start', id: 't1', name: 'read_file' },
        { kind: 'tool_use_delta', id: 't1', partial_args: '{"path":' },
        { kind: 'tool_use_delta', id: 't1', partial_args: '"/x"}' },
        { kind: 'tool_use_stop', id: 't1', final_args: { path: '/x' } },
        { kind: 'stop', reason: 'tool_use' },
      ]),
    );
    expect(out.tool_uses).toEqual([{ id: 't1', name: 'read_file', input: { path: '/x' } }]);
    expect(out.stop_reason).toBe('tool_use');
  });

  test('parallel tool_uses are tracked independently by id', async () => {
    const out = await collectStep(
      fromEvents([
        { kind: 'start', message_id: 'm' },
        { kind: 'tool_use_start', id: 'a', name: 'read_file' },
        { kind: 'tool_use_start', id: 'b', name: 'glob' },
        { kind: 'tool_use_stop', id: 'b', final_args: { pattern: '*' } },
        { kind: 'tool_use_stop', id: 'a', final_args: { path: '/x' } },
        { kind: 'stop', reason: 'tool_use' },
      ]),
    );
    expect(out.tool_uses).toHaveLength(2);
    expect(out.tool_uses.find((t) => t.id === 'a')?.name).toBe('read_file');
    expect(out.tool_uses.find((t) => t.id === 'b')?.name).toBe('glob');
  });

  test('text and tool_use coexist', async () => {
    const out = await collectStep(
      fromEvents([
        { kind: 'start', message_id: 'm' },
        { kind: 'text_delta', text: 'using read_file' },
        { kind: 'tool_use_start', id: 't', name: 'read_file' },
        { kind: 'tool_use_stop', id: 't', final_args: {} },
        { kind: 'stop', reason: 'tool_use' },
      ]),
    );
    expect(out.text).toBe('using read_file');
    expect(out.tool_uses).toHaveLength(1);
  });

  test('thinking_delta accumulates separately from text', async () => {
    const out = await collectStep(
      fromEvents([
        { kind: 'start', message_id: 'm' },
        { kind: 'thinking_delta', text: 'pondering...' },
        { kind: 'text_delta', text: 'reply' },
        { kind: 'stop', reason: 'end_turn' },
      ]),
    );
    expect(out.thinking).toBe('pondering...');
    expect(out.text).toBe('reply');
  });

  test('error events are captured', async () => {
    const out = await collectStep(
      fromEvents([
        { kind: 'start', message_id: 'm' },
        {
          kind: 'error',
          code: 'tool_args_parse_error',
          message: 'bad json',
          retryable: false,
        },
        { kind: 'stop', reason: 'end_turn' },
      ]),
    );
    expect(out.errors).toEqual([
      { code: 'tool_args_parse_error', message: 'bad json', retryable: false },
    ]);
  });

  test('orphan tool_use_stop becomes a harness error (defensive)', async () => {
    const out = await collectStep(
      fromEvents([
        { kind: 'start', message_id: 'm' },
        { kind: 'tool_use_stop', id: 'never-started', final_args: {} },
        { kind: 'stop', reason: 'end_turn' },
      ]),
    );
    expect(out.tool_uses).toEqual([]);
    expect(out.errors[0]?.code).toBe('harness.orphan_tool_use_stop');
  });

  test('defaults stop_reason to end_turn when no stop event', async () => {
    const out = await collectStep(fromEvents([{ kind: 'text_delta', text: 'x' }]));
    expect(out.stop_reason).toBe('end_turn');
  });

  test('captures usage event and flips usageSeen', async () => {
    const out = await collectStep(
      fromEvents([
        { kind: 'start', message_id: 'm' },
        { kind: 'usage', usage: { input: 50, output: 10, cache_read: 5, cache_creation: 0 } },
        { kind: 'stop', reason: 'end_turn' },
      ]),
    );
    expect(out.usageSeen).toBe(true);
    expect(out.usage).toEqual({ input: 50, output: 10, cache_read: 5, cache_creation: 0 });
  });

  test('absent usage event leaves usageSeen=false and usage at zero', async () => {
    const out = await collectStep(
      fromEvents([
        { kind: 'start', message_id: 'm' },
        { kind: 'text_delta', text: 'hi' },
        { kind: 'stop', reason: 'end_turn' },
      ]),
    );
    expect(out.usageSeen).toBe(false);
    expect(out.usage).toEqual({ input: 0, output: 0, cache_read: 0, cache_creation: 0 });
  });

  test('usage emitted mid-stream is honored; later usage events overwrite', async () => {
    // The canonical contract is "usage right before stop", but the
    // collector's `last usage wins` rule lets adapters that report
    // partial counts mid-stream still produce sensible numbers.
    const out = await collectStep(
      fromEvents([
        { kind: 'start', message_id: 'm' },
        { kind: 'usage', usage: { input: 50, output: 5, cache_read: 0, cache_creation: 0 } },
        { kind: 'text_delta', text: 'more' },
        { kind: 'usage', usage: { input: 50, output: 12, cache_read: 0, cache_creation: 0 } },
        { kind: 'stop', reason: 'end_turn' },
      ]),
    );
    expect(out.usage.output).toBe(12);
    expect(out.usageSeen).toBe(true);
  });
});
