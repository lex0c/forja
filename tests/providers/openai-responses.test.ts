import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { createOpenAIProvider } from '../../src/providers/openai/index.ts';
import {
  type RawResponsesEvent,
  normalizeResponsesStream,
} from '../../src/providers/openai/responses-stream.ts';
import type { StreamEvent } from '../../src/providers/types.ts';

const asyncIter = (events: RawResponsesEvent[]): AsyncIterable<RawResponsesEvent> =>
  (async function* () {
    for (const e of events) yield e;
  })();

const collect = async (events: RawResponsesEvent[]): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const e of normalizeResponsesStream(asyncIter(events))) out.push(e);
  return out;
};

describe('normalizeResponsesStream', () => {
  test('maps the Responses event sequence to canonical StreamEvent', async () => {
    const out = await collect([
      { type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.output_text.delta', delta: 'hi' },
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"/x"}' },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'call_1', arguments: '{"path":"/x"}' },
      },
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 30 },
          },
        },
      },
    ]);
    expect(out).toEqual([
      { kind: 'start', message_id: 'resp_1' },
      { kind: 'text_delta', text: 'hi' },
      { kind: 'tool_use_start', id: 'call_1', name: 'read' },
      { kind: 'tool_use_delta', id: 'call_1', partial_args: '{"path":' },
      { kind: 'tool_use_delta', id: 'call_1', partial_args: '"/x"}' },
      { kind: 'tool_use_stop', id: 'call_1', final_args: { path: '/x' } },
      // input = 100 − cached 30 = 70.
      { kind: 'usage', usage: { input: 70, output: 20, cache_read: 30, cache_creation: 0 } },
      // a turn with a function call ends in tool_use so the loop continues.
      { kind: 'stop', reason: 'tool_use' },
    ]);
  });

  test('tool args fall back to accumulated deltas when output_item.done omits them', async () => {
    const out = await collect([
      { type: 'response.created', response: { id: 'r' } },
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'read' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"/a"}' },
      // done WITHOUT a full `arguments` string — must fall back to the chunks.
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc_1', call_id: 'c1' },
      },
      { type: 'response.completed', response: {} },
    ]);
    expect(out).toContainEqual({ kind: 'tool_use_stop', id: 'c1', final_args: { path: '/a' } });
  });

  test('text-only turn stops with end_turn', async () => {
    const out = await collect([
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.output_text.delta', delta: 'done' },
      { type: 'response.completed', response: {} },
    ]);
    expect(out.at(-1)).toEqual({ kind: 'stop', reason: 'end_turn' });
  });

  test('incomplete with max_output_tokens stops with max_tokens', async () => {
    const out = await collect([
      { type: 'response.created', response: { id: 'r' } },
      {
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'max_output_tokens' }, usage: {} },
      },
    ]);
    expect(out.at(-1)).toEqual({ kind: 'stop', reason: 'max_tokens' });
  });

  test('failed event surfaces an error', async () => {
    const out = await collect([
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.failed', code: 'server_error', message: 'boom' },
    ]);
    expect(out).toContainEqual({
      kind: 'error',
      code: 'server_error',
      message: 'boom',
      retryable: false,
    });
  });
});

// Mock that routes generate (stream) and constrained (object) through
// `client.responses.create`, capturing the params.
const mockResponsesClient = (
  streamEvents: RawResponsesEvent[],
  objectResponse?: unknown,
): { client: OpenAI; calls: unknown[] } => {
  const calls: unknown[] = [];
  const client = {
    responses: {
      async create(params: { stream?: boolean }) {
        calls.push(params);
        if (params.stream === true) return asyncIter(streamEvents);
        return objectResponse;
      },
    },
    // Guard: the reasoning path must NOT touch Chat Completions.
    chat: {
      completions: {
        create() {
          throw new Error('reasoning model must route through responses, not chat.completions');
        },
      },
    },
  } as unknown as OpenAI;
  return { client, calls };
};

describe('createOpenAIProvider — Responses routing for reasoning models', () => {
  test('gpt-5.4-mini generate routes through the Responses API with reasoning+input', async () => {
    const handle = mockResponsesClient([
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.completed', response: {} },
    ]);
    const provider = createOpenAIProvider('gpt-5.4-mini', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'gpt-5.4-mini',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
      effort: 'high',
      system: 'be concise',
    })) {
      // drain
    }
    expect(handle.calls).toHaveLength(1);
    const p = handle.calls[0] as {
      reasoning?: unknown;
      max_output_tokens?: number;
      instructions?: string;
      input?: unknown;
      temperature?: number;
      prompt_cache_key?: unknown;
    };
    expect(p.reasoning).toEqual({ effort: 'high' });
    expect(p.max_output_tokens).toBe(8);
    expect(p.instructions).toBe('be concise');
    expect(Array.isArray(p.input)).toBe(true);
    // sampling gate: reasoning models never get temperature.
    expect(p.temperature).toBeUndefined();
    // cache-routing hint set on the Responses path (real OpenAI, no baseURL).
    expect(typeof p.prompt_cache_key).toBe('string');
    expect((p.prompt_cache_key as string).length).toBeGreaterThan(0);
  });

  test('omits prompt_cache_key on the Responses path when a custom baseURL is set', async () => {
    const handle = mockResponsesClient([
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.completed', response: {} },
    ]);
    const provider = createOpenAIProvider('gpt-5.4-mini', {
      client: handle.client,
      baseURL: 'https://proxy.example/v1',
    });
    for await (const _ of provider.generate({
      model: 'gpt-5.4-mini',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
      effort: 'high',
    })) {
      // drain
    }
    // A custom endpoint may 400 on the unknown param — gate it off (mirrors
    // the Chat Completions path).
    expect((handle.calls[0] as { prompt_cache_key?: unknown }).prompt_cache_key).toBeUndefined();
  });

  test('gpt-5.4-mini generateConstrained via Responses returns args + usage', async () => {
    const handle = mockResponsesClient([], {
      output: [
        { type: 'function_call', name: 'render_output', call_id: 'c1', arguments: '{"ok":true}' },
      ],
      usage: { input_tokens: 50, output_tokens: 5, input_tokens_details: { cached_tokens: 10 } },
    });
    const provider = createOpenAIProvider('gpt-5.4-mini', { client: handle.client });
    const r = await provider.generateConstrained({
      model: 'gpt-5.4-mini',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 64,
      output_schema: { type: 'object' },
      output_schema_name: 'render_output',
    });
    expect(r.output).toBe('{"ok":true}');
    expect(r.usage).toEqual({ input: 40, output: 5, cache_read: 10, cache_creation: 0 });
    const p = handle.calls[0] as { tool_choice?: unknown };
    expect(p.tool_choice).toEqual({ type: 'function', name: 'render_output' });
  });
});
