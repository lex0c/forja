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
});
