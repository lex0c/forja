import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { GoogleGenAI } from '@google/genai';
import { createGoogleProvider } from '../../src/providers/google/index.ts';
import type { RawGoogleChunk } from '../../src/providers/google/stream.ts';
import type { StreamEvent } from '../../src/providers/types.ts';

interface StreamCall {
  params: unknown;
}

interface CountTokensCall {
  params: unknown;
}

interface MockClientHandle {
  client: GoogleGenAI;
  streamCalls: StreamCall[];
  countTokensCalls: CountTokensCall[];
}

const mockClient = (
  chunks: RawGoogleChunk[],
  countTokensResponse: { totalTokens?: number } = { totalTokens: 0 },
): MockClientHandle => {
  const streamCalls: StreamCall[] = [];
  const countTokensCalls: CountTokensCall[] = [];
  const client = {
    models: {
      async generateContentStream(params: unknown) {
        streamCalls.push({ params });
        return (async function* () {
          for (const c of chunks) yield c;
        })();
      },
      async countTokens(params: unknown) {
        countTokensCalls.push({ params });
        return countTokensResponse;
      },
    },
  } as unknown as GoogleGenAI;
  return { client, streamCalls, countTokensCalls };
};

describe('createGoogleProvider', () => {
  let originalApi: string | undefined;
  let originalGemini: string | undefined;

  beforeEach(() => {
    originalApi = process.env.GOOGLE_API_KEY;
    originalGemini = process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    if (originalApi === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalApi;
    if (originalGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGemini;
  });

  test('refuses unknown model name', () => {
    expect(() => createGoogleProvider('gemini-fake', { apiKey: 'k' })).toThrow(
      /unknown Google model/,
    );
  });

  test('throws when no API key is available', () => {
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    expect(() => createGoogleProvider('gemini-2.5-flash')).toThrow(/API key required/);
  });

  test('reads GEMINI_API_KEY when GOOGLE_API_KEY is unset', () => {
    delete process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = 'k-gem';
    expect(() => createGoogleProvider('gemini-2.5-flash')).not.toThrow();
  });

  test('exposes canonical id, family, and capabilities', () => {
    const provider = createGoogleProvider('gemini-2.5-flash', { apiKey: 'k' });
    expect(provider.id).toBe('google/gemini-2.5-flash');
    expect(provider.family).toBe('google');
    expect(provider.capabilities.tools).toBe('native');
    expect(provider.capabilities.cache).toBe('server_persistent');
    expect(provider.capabilities.context_window).toBe(1_000_000);
  });

  test('generateConstrained rejects with not-implemented error in M1', async () => {
    const provider = createGoogleProvider('gemini-2.5-flash', { apiKey: 'k' });
    await expect(
      provider.generateConstrained({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        output_schema: { type: 'object' },
      }),
    ).rejects.toThrow(/not implemented in M1/);
  });

  test('generate pipes the SDK stream through the canonical normalizer', async () => {
    const handle = mockClient([
      {
        responseId: 'resp_x',
        candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      },
      { candidates: [{ finishReason: 'STOP' }] },
    ]);
    const provider = createGoogleProvider('gemini-2.5-flash', { client: handle.client });
    const events: StreamEvent[] = [];
    for await (const ev of provider.generate({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
    })) {
      events.push(ev);
    }
    expect(events).toEqual([
      { kind: 'start', message_id: 'resp_x' },
      { kind: 'text_delta', text: 'hi' },
      { kind: 'stop', reason: 'end_turn' },
    ]);
  });

  test('generate maps assistant->model and string content to parts[{text}]', async () => {
    const handle = mockClient([{ candidates: [{ finishReason: 'STOP' }] }]);
    const provider = createGoogleProvider('gemini-2.5-flash', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ],
      max_tokens: 1,
    })) {
      // drain
    }
    const params = handle.streamCalls[0]?.params as {
      contents: Array<{ role: string; parts: unknown[] }>;
    };
    expect(params.contents).toEqual([
      { role: 'user', parts: [{ text: 'q' }] },
      { role: 'model', parts: [{ text: 'a' }] },
    ]);
  });

  test('generate forwards system/temperature/stop_sequences/tools into config', async () => {
    const handle = mockClient([{ candidates: [{ finishReason: 'STOP' }] }]);
    const provider = createGoogleProvider('gemini-2.5-flash', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
      system: 'be brief',
      temperature: 0.4,
      stop_sequences: ['END'],
      tools: [
        {
          name: 'read_file',
          description: 'r',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    })) {
      // drain
    }
    const params = handle.streamCalls[0]?.params as { config: Record<string, unknown> };
    expect(params.config.systemInstruction).toBe('be brief');
    expect(params.config.temperature).toBe(0.4);
    expect(params.config.stopSequences).toEqual(['END']);
    expect(params.config.maxOutputTokens).toBe(16);
    const tools = params.config.tools as Array<{ functionDeclarations: Array<{ name: string }> }>;
    expect(tools[0]?.functionDeclarations[0]?.name).toBe('read_file');
  });

  test('tool_result block with name is converted to functionResponse', async () => {
    const handle = mockClient([{ candidates: [{ finishReason: 'STOP' }] }]);
    const provider = createGoogleProvider('gemini-2.5-flash', { client: handle.client });
    for await (const _ of provider.generate({
      model: 'gemini-2.5-flash',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              name: 'read_file',
              content: '{"data":"hello"}',
            },
          ],
        },
      ],
      max_tokens: 1,
    })) {
      // drain
    }
    const params = handle.streamCalls[0]?.params as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    expect(params.contents[0]?.role).toBe('user');
    expect(params.contents[0]?.parts[0]).toEqual({
      functionResponse: {
        name: 'read_file',
        response: { result: '{"data":"hello"}' },
      },
    });
  });

  test('tool_result block without name throws (harness must populate it)', async () => {
    const handle = mockClient([{ candidates: [{ finishReason: 'STOP' }] }]);
    const provider = createGoogleProvider('gemini-2.5-flash', { client: handle.client });
    const stream = provider.generate({
      model: 'gemini-2.5-flash',
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'x', content: 'output' }],
        },
      ],
      max_tokens: 1,
    });
    let err: Error | null = null;
    try {
      for await (const _ of stream) {
        // shouldn't reach
      }
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/missing the function name/i);
  });

  test('countTokens returns the SDK totalTokens value', async () => {
    const handle = mockClient([], { totalTokens: 88 });
    const provider = createGoogleProvider('gemini-2.5-flash', { client: handle.client });
    const tokens = await provider.countTokens([{ role: 'user', content: 'hi' }]);
    expect(tokens).toBe(88);
    const params = handle.countTokensCalls[0]?.params as { model: string };
    expect(params.model).toBe('gemini-2.5-flash');
  });

  test('countTokens falls back to 0 when SDK omits totalTokens', async () => {
    const handle = mockClient([], {});
    const provider = createGoogleProvider('gemini-2.5-flash', { client: handle.client });
    const tokens = await provider.countTokens([{ role: 'user', content: 'hi' }]);
    expect(tokens).toBe(0);
  });
});
