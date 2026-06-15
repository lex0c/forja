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

  test('reasoning output item is captured verbatim as a reasoning event', async () => {
    const reasoningItem = {
      type: 'reasoning',
      id: 'rs_1',
      summary: [],
      encrypted_content: 'ENCRYPTED_BLOB',
    };
    const out = await collect([
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.output_item.done', item: reasoningItem } as RawResponsesEvent,
      { type: 'response.completed', response: {} },
    ]);
    expect(out).toContainEqual({ kind: 'reasoning', provider: 'openai', data: reasoningItem });
  });

  test('codex message phase is captured as a sentinel reasoning event', async () => {
    const out = await collect([
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.output_item.done', item: { type: 'message', phase: 'commentary' } },
      { type: 'response.completed', response: {} },
    ]);
    expect(out).toContainEqual({
      kind: 'reasoning',
      provider: 'openai',
      data: { __forja_message_phase: 'commentary' },
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
      prompt_cache_retention?: unknown;
    };
    expect(p.reasoning).toEqual({ effort: 'high' });
    expect(p.max_output_tokens).toBe(8);
    // Markdown marker prepended as the first line (reasoning models suppress
    // markdown otherwise), with the system prompt following.
    expect(p.instructions).toBe('Formatting re-enabled\nbe concise');
    expect(Array.isArray(p.input)).toBe(true);
    // sampling gate: reasoning models never get temperature.
    expect(p.temperature).toBeUndefined();
    // cache-routing hint set on the Responses path (real OpenAI, no baseURL).
    expect(typeof p.prompt_cache_key).toBe('string');
    expect((p.prompt_cache_key as string).length).toBeGreaterThan(0);
    // gpt-5.4-mini is NOT on OpenAI's extended-retention list, so no 24h param
    // (the routing key above still applies — it's not gated on retention).
    expect(p.prompt_cache_retention).toBeUndefined();
  });

  test('extended retention (24h) is sent only for models on OpenAI’s list (gpt-5.4) ', async () => {
    const handle = mockResponsesClient([
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.completed', response: {} },
    ]);
    const provider = createOpenAIProvider('gpt-5.4', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
      effort: 'high',
    })) {
      // drain
    }
    expect((handle.calls[0] as { prompt_cache_retention?: unknown }).prompt_cache_retention).toBe(
      '24h',
    );
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
    const p = handle.calls[0] as { prompt_cache_key?: unknown; prompt_cache_retention?: unknown };
    expect(p.prompt_cache_key).toBeUndefined();
    // Retention rides the same real-OpenAI gate — also omitted here.
    expect(p.prompt_cache_retention).toBeUndefined();
  });

  test('env opt-out SENDS in_memory (not omit) on a model that supports it (gpt-5.4)', async () => {
    const prev = process.env.FORJA_OPENAI_PROMPT_CACHE_RETENTION;
    process.env.FORJA_OPENAI_PROMPT_CACHE_RETENTION = 'in_memory';
    try {
      const handle = mockResponsesClient([
        { type: 'response.created', response: { id: 'r' } },
        { type: 'response.completed', response: {} },
      ]);
      // gpt-5.4 accepts both 24h and in_memory. Omitting would default to 24h on
      // a non-ZDR org (per OpenAI docs), so the data-residency opt-out must be
      // SENT explicitly as in_memory — not dropped.
      const provider = createOpenAIProvider('gpt-5.4', { client: handle.client });
      for await (const _ of provider.generate({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 8,
        effort: 'high',
      })) {
        // drain
      }
      expect((handle.calls[0] as { prompt_cache_retention?: unknown }).prompt_cache_retention).toBe(
        'in_memory',
      );
    } finally {
      if (prev === undefined) delete process.env.FORJA_OPENAI_PROMPT_CACHE_RETENTION;
      else process.env.FORJA_OPENAI_PROMPT_CACHE_RETENTION = prev;
    }
  });

  test('env opt-out is OMITTED (not in_memory) on a 24h-only model (gpt-5.5)', async () => {
    // gpt-5.5 rejects the in_memory value, so the opt-out cannot be honored —
    // the adapter must omit the param rather than send an invalid value (400).
    const prev = process.env.FORJA_OPENAI_PROMPT_CACHE_RETENTION;
    process.env.FORJA_OPENAI_PROMPT_CACHE_RETENTION = 'in_memory';
    try {
      const handle = mockResponsesClient([
        { type: 'response.created', response: { id: 'r' } },
        { type: 'response.completed', response: {} },
      ]);
      const provider = createOpenAIProvider('gpt-5.5', { client: handle.client });
      for await (const _ of provider.generate({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 8,
        effort: 'high',
      })) {
        // drain
      }
      expect(
        (handle.calls[0] as { prompt_cache_retention?: unknown }).prompt_cache_retention,
      ).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.FORJA_OPENAI_PROMPT_CACHE_RETENTION;
      else process.env.FORJA_OPENAI_PROMPT_CACHE_RETENTION = prev;
    }
  });

  test('default (no env) sends 24h on a 24h-only model (gpt-5.5)', async () => {
    const handle = mockResponsesClient([
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.completed', response: {} },
    ]);
    const provider = createOpenAIProvider('gpt-5.5', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
      effort: 'high',
    })) {
      // drain
    }
    expect((handle.calls[0] as { prompt_cache_retention?: unknown }).prompt_cache_retention).toBe(
      '24h',
    );
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

  test('generateConstrained also prepends the markdown marker to instructions', async () => {
    const handle = mockResponsesClient([], {
      output: [{ type: 'function_call', name: 'render_output', call_id: 'c1', arguments: '{}' }],
    });
    const provider = createOpenAIProvider('gpt-5.4-mini', { client: handle.client });
    await provider.generateConstrained({
      model: 'gpt-5.4-mini',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 64,
      system: 'render it',
      output_schema: { type: 'object' },
      output_schema_name: 'render_output',
    });
    expect((handle.calls[0] as { instructions?: string }).instructions).toBe(
      'Formatting re-enabled\nrender it',
    );
  });

  test('markdown marker is the whole instructions when there is no system prompt', async () => {
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
    })) {
      // drain
    }
    expect((handle.calls[0] as { instructions?: string }).instructions).toBe(
      'Formatting re-enabled',
    );
  });

  describe('reasoning replay (Phase 3, FORJA_OPENAI_REASONING_REPLAY)', () => {
    const reasoningItem = { type: 'reasoning', id: 'rs_9', encrypted_content: 'ENC' };
    const assistantTurn = {
      role: 'assistant' as const,
      content: [
        { type: 'reasoning' as const, provider: 'openai' as const, data: reasoningItem },
        { type: 'tool_use' as const, id: 'call_1', name: 'read', input: { p: '/x' } },
        // Foreign-tagged: dropped regardless of flag.
        { type: 'reasoning' as const, provider: 'anthropic' as const, data: { thinking: 't' } },
      ],
    };
    const drive = async (handle: { client: OpenAI }) => {
      const provider = createOpenAIProvider('gpt-5.4-mini', { client: handle.client });
      for await (const _ of provider.generate({
        model: 'gpt-5.4-mini',
        messages: [assistantTurn, { role: 'user', content: 'go' }],
        max_tokens: 8,
        effort: 'high',
      })) {
        // drain
      }
    };
    const withReplay = async (on: boolean, fn: () => Promise<void>) => {
      const prev = process.env.FORJA_OPENAI_REASONING_REPLAY;
      if (on) process.env.FORJA_OPENAI_REASONING_REPLAY = '1';
      else delete process.env.FORJA_OPENAI_REASONING_REPLAY;
      try {
        await fn();
      } finally {
        if (prev === undefined) delete process.env.FORJA_OPENAI_REASONING_REPLAY;
        else process.env.FORJA_OPENAI_REASONING_REPLAY = prev;
      }
    };

    test('replaysReasoning: true only for Responses models; false for Chat Completions (gpt-4o)', async () => {
      await withReplay(true, async () => {
        // gpt-5.4-mini routes through Responses → actually replays.
        expect(createOpenAIProvider('gpt-5.4-mini', { apiKey: 'sk-test' }).replaysReasoning).toBe(
          true,
        );
        // gpt-4o is Chat Completions → drops reasoning at send, so it must NOT
        // advertise replay (else the token estimator over-counts on a resumed
        // session and compacts prematurely).
        expect(createOpenAIProvider('gpt-4o', { apiKey: 'sk-test' }).replaysReasoning).toBe(false);
      });
    });

    test('countTokens honors replaysReasoning: gpt-4o omits the payload, gpt-5.4-mini counts it', async () => {
      await withReplay(true, async () => {
        const msgs = [
          {
            role: 'assistant' as const,
            content: [
              {
                type: 'reasoning' as const,
                provider: 'openai' as const,
                data: { ec: 'X'.repeat(400) },
              },
              { type: 'text' as const, text: 'hi' },
            ],
          },
        ];
        const mini = createOpenAIProvider('gpt-5.4-mini', { apiKey: 'sk-test' });
        const gpt4o = createOpenAIProvider('gpt-4o', { apiKey: 'sk-test' });
        const miniCount = await mini.countTokens(msgs);
        const gpt4oCount = await gpt4o.countTokens(msgs);
        // gpt-4o (Chat Completions, drops reasoning) must not charge the ~400-char
        // payload it never sends, so its estimate is strictly smaller.
        expect(gpt4oCount).toBeLessThan(miniCount);
      });
    });

    test('off (default): reasoning items are not replayed and `include` is absent', async () => {
      await withReplay(false, async () => {
        const handle = mockResponsesClient([
          { type: 'response.created', response: { id: 'r' } },
          { type: 'response.completed', response: {} },
        ]);
        await drive(handle);
        const p = handle.calls[0] as { input: Array<{ type?: string }>; include?: unknown };
        expect(p.include).toBeUndefined();
        expect(p.input.some((i) => i.type === 'reasoning')).toBe(false);
      });
    });

    test('on: same-provider reasoning item replays into input + `include` is set', async () => {
      await withReplay(true, async () => {
        const handle = mockResponsesClient([
          { type: 'response.created', response: { id: 'r' } },
          { type: 'response.completed', response: {} },
        ]);
        await drive(handle);
        const p = handle.calls[0] as { input: unknown[]; include?: unknown };
        expect(p.include).toEqual(['reasoning.encrypted_content']);
        // The captured OpenAI item rides into the input verbatim; the foreign
        // (anthropic) reasoning block is dropped.
        expect(p.input).toContainEqual(reasoningItem);
        const reasoningCount = (p.input as Array<{ type?: string }>).filter(
          (i) => i.type === 'reasoning',
        ).length;
        expect(reasoningCount).toBe(1);
      });
    });

    test('on: reasoning item precedes the assistant message AND the tool call (model output order)', async () => {
      // OpenAI's stateless replay rejects a reasoning item not directly followed
      // by the item it generated; the reasoning must lead the turn, before any
      // assistant text. Regression guard for the A/B's intermittent 400.
      await withReplay(true, async () => {
        const handle = mockResponsesClient([
          { type: 'response.created', response: { id: 'r' } },
          { type: 'response.completed', response: {} },
        ]);
        const provider = createOpenAIProvider('gpt-5.4-mini', { client: handle.client });
        for await (const _ of provider.generate({
          model: 'gpt-5.4-mini',
          max_tokens: 8,
          effort: 'high',
          messages: [
            {
              role: 'assistant',
              content: [
                { type: 'reasoning', provider: 'openai', data: reasoningItem },
                { type: 'text', text: 'let me read it' },
                { type: 'tool_use', id: 'call_1', name: 'read', input: { p: '/x' } },
              ],
            },
            { role: 'user', content: 'go' },
          ],
        })) {
          // drain
        }
        const { input } = handle.calls[0] as { input: Array<{ type?: string; role?: string }> };
        const reasoningIdx = input.findIndex((i) => i.type === 'reasoning');
        const messageIdx = input.findIndex((i) => i.role === 'assistant');
        const callIdx = input.findIndex((i) => i.type === 'function_call');
        expect(reasoningIdx).toBeGreaterThanOrEqual(0);
        expect(reasoningIdx).toBeLessThan(messageIdx);
        expect(messageIdx).toBeLessThan(callIdx);
      });
    });

    test('on: codex message phase is re-stamped on the assistant message, not pushed as an item', async () => {
      await withReplay(true, async () => {
        const handle = mockResponsesClient([
          { type: 'response.created', response: { id: 'r' } },
          { type: 'response.completed', response: {} },
        ]);
        const provider = createOpenAIProvider('gpt-5.4-mini', { client: handle.client });
        for await (const _ of provider.generate({
          model: 'gpt-5.4-mini',
          max_tokens: 8,
          effort: 'high',
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'reasoning',
                  provider: 'openai',
                  data: { __forja_message_phase: 'final_answer' },
                },
                { type: 'text', text: 'done' },
              ],
            },
            { role: 'user', content: 'go' },
          ],
        })) {
          // drain
        }
        const p = handle.calls[0] as {
          input: Array<{ role?: string; type?: string; phase?: string }>;
        };
        const assistantMsg = p.input.find((i) => i.role === 'assistant');
        expect(assistantMsg?.phase).toBe('final_answer');
        // The sentinel is consumed, not emitted as a reasoning item.
        expect(p.input.some((i) => i.type === 'reasoning')).toBe(false);
      });
    });

    test('on: a reasoning item without encrypted_content is dropped (would 400 in stateless mode)', async () => {
      // Captured under a flag-OFF request (no `include`), so it has no
      // encrypted_content; a later flag flip must not replay it raw.
      await withReplay(true, async () => {
        const handle = mockResponsesClient([
          { type: 'response.created', response: { id: 'r' } },
          { type: 'response.completed', response: {} },
        ]);
        const provider = createOpenAIProvider('gpt-5.4-mini', { client: handle.client });
        for await (const _ of provider.generate({
          model: 'gpt-5.4-mini',
          max_tokens: 8,
          effort: 'high',
          messages: [
            {
              role: 'assistant',
              content: [
                { type: 'reasoning', provider: 'openai', data: { type: 'reasoning', id: 'rs_x' } },
                { type: 'text', text: 'hi' },
              ],
            },
            { role: 'user', content: 'go' },
          ],
        })) {
          // drain
        }
        const p = handle.calls[0] as { input: Array<{ type?: string }>; include?: unknown };
        // `include` is still requested (replay is on) but the unverifiable item
        // is not pushed into the input.
        expect(p.include).toEqual(['reasoning.encrypted_content']);
        expect(p.input.some((i) => i.type === 'reasoning')).toBe(false);
      });
    });
  });
});
