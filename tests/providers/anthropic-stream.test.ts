import { describe, expect, test } from 'bun:test';
import {
  type RawAnthropicEvent,
  normalizeAnthropicStream,
} from '../../src/providers/anthropic/stream.ts';
import { collect, collectNonUsage } from './_stream-helpers.ts';

const fromEvents = (events: RawAnthropicEvent[]): AsyncIterable<RawAnthropicEvent> => {
  return (async function* () {
    for (const e of events) yield e;
  })();
};

describe('normalizeAnthropicStream', () => {
  test('text-only message: start, text deltas, stop', async () => {
    const events = await collectNonUsage(
      normalizeAnthropicStream(
        fromEvents([
          { type: 'message_start', message: { id: 'msg_1' } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
          { type: 'message_stop' },
        ]),
      ),
    );
    expect(events).toEqual([
      { kind: 'start', message_id: 'msg_1' },
      { kind: 'text_delta', text: 'hello' },
      { kind: 'text_delta', text: ' world' },
      { kind: 'stop', reason: 'end_turn' },
    ]);
  });

  test('tool_use: start, partial json deltas, stop with parsed args', async () => {
    const events = await collectNonUsage(
      normalizeAnthropicStream(
        fromEvents([
          { type: 'message_start', message: { id: 'msg_2' } },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'tool_1', name: 'read_file' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"path":' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '"/etc/hosts"}' },
          },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
          { type: 'message_stop' },
        ]),
      ),
    );
    expect(events).toEqual([
      { kind: 'start', message_id: 'msg_2' },
      { kind: 'tool_use_start', id: 'tool_1', name: 'read_file' },
      { kind: 'tool_use_delta', id: 'tool_1', partial_args: '{"path":' },
      { kind: 'tool_use_delta', id: 'tool_1', partial_args: '"/etc/hosts"}' },
      { kind: 'tool_use_stop', id: 'tool_1', final_args: { path: '/etc/hosts' } },
      { kind: 'stop', reason: 'tool_use' },
    ]);
  });

  test('empty tool_use args produce final_args = {}', async () => {
    const events = await collectNonUsage(
      normalizeAnthropicStream(
        fromEvents([
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 't', name: 'noop' },
          },
          { type: 'content_block_stop', index: 0 },
        ]),
      ),
    );
    expect(events).toContainEqual({ kind: 'tool_use_stop', id: 't', final_args: {} });
  });

  test('malformed tool_use json emits an error event and drops the tool_use_stop', async () => {
    const events = await collectNonUsage(
      normalizeAnthropicStream(
        fromEvents([
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 't', name: 'foo' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{not json' },
          },
          { type: 'content_block_stop', index: 0 },
        ]),
      ),
    );
    const error = events.find((e) => e.kind === 'error');
    expect(error).toBeDefined();
    if (error?.kind === 'error') {
      expect(error.code).toBe('tool_args_parse_error');
      expect(error.retryable).toBe(false);
    }
    expect(events.find((e) => e.kind === 'tool_use_stop')).toBeUndefined();
  });

  test('tool_use args that decode to a non-object are rejected', async () => {
    const events = await collectNonUsage(
      normalizeAnthropicStream(
        fromEvents([
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 't', name: 'foo' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '"a string"' },
          },
          { type: 'content_block_stop', index: 0 },
        ]),
      ),
    );
    const error = events.find((e) => e.kind === 'error');
    expect(error).toBeDefined();
    expect(events.find((e) => e.kind === 'tool_use_stop')).toBeUndefined();
  });

  test('thinking_delta passes through; signature_delta is dropped', async () => {
    const events = await collectNonUsage(
      normalizeAnthropicStream(
        fromEvents([
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'hmm...' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'signature_delta', signature: 'abc' },
          },
          { type: 'content_block_stop', index: 0 },
        ]),
      ),
    );
    expect(events).toContainEqual({ kind: 'thinking_delta', text: 'hmm...' });
    // signature_delta produces nothing
    expect(events.filter((e) => e.kind === 'thinking_delta')).toHaveLength(1);
  });

  test('multiple content blocks: text then tool_use', async () => {
    const events = await collectNonUsage(
      normalizeAnthropicStream(
        fromEvents([
          { type: 'message_start', message: { id: 'm' } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'using read_file' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 't', name: 'read_file' },
          },
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{}' },
          },
          { type: 'content_block_stop', index: 1 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
          { type: 'message_stop' },
        ]),
      ),
    );
    expect(events.map((e) => e.kind)).toEqual([
      'start',
      'text_delta',
      'tool_use_start',
      'tool_use_delta',
      'tool_use_stop',
      'stop',
    ]);
  });

  test('parallel tool_use blocks track partial args per index', async () => {
    const events = await collectNonUsage(
      normalizeAnthropicStream(
        fromEvents([
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'a', name: 'read_file' },
          },
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'b', name: 'glob' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"path":"/a"}' },
          },
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{"pattern":"*.ts"}' },
          },
          { type: 'content_block_stop', index: 1 },
          { type: 'content_block_stop', index: 0 },
        ]),
      ),
    );
    const stops = events.filter((e) => e.kind === 'tool_use_stop');
    expect(stops).toEqual([
      { kind: 'tool_use_stop', id: 'b', final_args: { pattern: '*.ts' } },
      { kind: 'tool_use_stop', id: 'a', final_args: { path: '/a' } },
    ]);
  });

  test('unknown stop_reason falls back to end_turn', async () => {
    const events = await collectNonUsage(
      normalizeAnthropicStream(
        fromEvents([
          { type: 'message_delta', delta: { stop_reason: 'something_new' } },
          { type: 'message_stop' },
        ]),
      ),
    );
    expect(events).toContainEqual({ kind: 'stop', reason: 'end_turn' });
  });

  test('defaults to end_turn when no stop_reason is ever set', async () => {
    const events = await collectNonUsage(
      normalizeAnthropicStream(fromEvents([{ type: 'message_stop' }])),
    );
    expect(events).toContainEqual({ kind: 'stop', reason: 'end_turn' });
  });

  test('null stop_reason in a later delta does not clobber an earlier valid one', async () => {
    const events = await collectNonUsage(
      normalizeAnthropicStream(
        fromEvents([
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
          { type: 'message_delta', delta: { stop_reason: null } },
          { type: 'message_stop' },
        ]),
      ),
    );
    expect(events).toContainEqual({ kind: 'stop', reason: 'tool_use' });
  });

  test('omitted stop_reason is treated as no signal', async () => {
    const events = await collectNonUsage(
      normalizeAnthropicStream(
        fromEvents([
          { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
          { type: 'message_delta', delta: {} },
          { type: 'message_stop' },
        ]),
      ),
    );
    expect(events).toContainEqual({ kind: 'stop', reason: 'max_tokens' });
  });

  test('emits a usage event with input/output/cache splits from message_start + message_delta', async () => {
    const events = await collect(
      normalizeAnthropicStream(
        fromEvents([
          {
            type: 'message_start',
            message: {
              id: 'msg_u',
              usage: {
                input_tokens: 200,
                cache_read_input_tokens: 1000,
                cache_creation_input_tokens: 500,
                output_tokens: 0,
              },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 17 },
          },
          { type: 'message_stop' },
        ]),
      ),
    );
    const u = events.find((e) => e.kind === 'usage');
    if (u?.kind !== 'usage') throw new Error('expected usage event');
    expect(u.usage).toEqual({ input: 200, output: 17, cache_read: 1000, cache_creation: 500 });
  });

  test('mergeUsage takes the running max so a partial later event cannot shrink totals', async () => {
    // Defensive against a hypothetical SDK shift to incremental deltas
    // (or interim message_deltas with partial counts). With Math.max,
    // the stream still emits the largest cumulative reading we ever saw
    // — never a smaller "interim" snapshot reported after a larger one.
    const events = await collect(
      normalizeAnthropicStream(
        fromEvents([
          {
            type: 'message_start',
            message: { id: 'msg_x', usage: { input_tokens: 200, output_tokens: 0 } },
          },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 50 },
          },
          // Pathological interim event: smaller cumulative output than already seen.
          { type: 'message_delta', delta: {}, usage: { output_tokens: 30 } },
          { type: 'message_stop' },
        ]),
      ),
    );
    const u = events.find((e) => e.kind === 'usage');
    if (u?.kind !== 'usage') throw new Error('expected usage event');
    expect(u.usage.output).toBe(50);
    expect(u.usage.input).toBe(200);
  });

  test('does NOT emit a usage event when the SDK never carries a usage payload', async () => {
    // Synthetic zero-usage would flip the harness's `usageSeen` flag and
    // persist 0 instead of NULL — conflating "no telemetry" with
    // "measured zero". Adapter must stay silent when nothing was reported.
    const events = await collect(
      normalizeAnthropicStream(
        fromEvents([
          { type: 'message_start', message: { id: 'msg_z' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
          { type: 'message_stop' },
        ]),
      ),
    );
    expect(events.find((e) => e.kind === 'usage')).toBeUndefined();
  });

  test('emits a usage event even when only one field is reported', async () => {
    // Partial measurement is still measurement — emit so downstream can
    // record what the provider did say.
    const events = await collect(
      normalizeAnthropicStream(
        fromEvents([
          {
            type: 'message_start',
            message: { id: 'msg_p', usage: { input_tokens: 42 } },
          },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
          { type: 'message_stop' },
        ]),
      ),
    );
    const u = events.find((e) => e.kind === 'usage');
    if (u?.kind !== 'usage') throw new Error('expected usage event');
    expect(u.usage.input).toBe(42);
    expect(u.usage.output).toBe(0);
  });
});
