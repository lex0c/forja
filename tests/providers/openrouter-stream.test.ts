import { describe, expect, test } from 'bun:test';
import {
  normalizeOpenRouterStream,
  type RawORChunk,
} from '../../src/providers/openrouter/stream.ts';
import type { StreamEvent } from '../../src/providers/types.ts';

const gen = async function* (chunks: RawORChunk[]): AsyncIterable<RawORChunk> {
  for (const c of chunks) yield c;
};

const collect = async (chunks: RawORChunk[]): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const e of normalizeOpenRouterStream(gen(chunks))) out.push(e);
  return out;
};

describe('normalizeOpenRouterStream', () => {
  test('text + usage: splits cached input and maps cache_write to cache_creation', async () => {
    const ev = await collect([
      { id: 'm1', choices: [{ delta: { content: 'hi' } }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 3 },
        },
      },
    ]);
    expect(ev.map((e) => e.kind)).toEqual(['start', 'text_delta', 'usage', 'stop']);
    expect(ev[0]).toEqual({ kind: 'start', message_id: 'm1' });
    expect(ev.find((e) => e.kind === 'usage')).toEqual({
      kind: 'usage',
      usage: { input: 6, output: 2, cache_read: 4, cache_creation: 3 },
    });
    expect(ev.at(-1)).toEqual({ kind: 'stop', reason: 'end_turn' });
  });

  test('reasoning: delta.reasoning → thinking_delta, reasoning_details → one reasoning block', async () => {
    const ev = await collect([
      {
        id: 'm1',
        choices: [
          {
            delta: {
              reasoning: 'think ',
              reasoning_details: [{ type: 'reasoning.text', text: 'think ' }],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              reasoning: 'more',
              reasoning_details: [{ type: 'reasoning.text', text: 'more' }],
            },
          },
        ],
      },
      { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
    ]);
    const thinking = ev.filter((e) => e.kind === 'thinking_delta');
    expect(thinking.map((e) => (e as { text: string }).text)).toEqual(['think ', 'more']);
    const reasoning = ev.find((e) => e.kind === 'reasoning');
    expect(reasoning).toEqual({
      kind: 'reasoning',
      provider: 'openrouter',
      data: {
        reasoning_details: [
          { type: 'reasoning.text', text: 'think ' },
          { type: 'reasoning.text', text: 'more' },
        ],
      },
    });
    // reasoning block leads the textual answer's stop.
    expect(ev.at(-1)).toEqual({ kind: 'stop', reason: 'end_turn' });
  });

  test('reasoning_details-only (no plaintext reasoning) still emits thinking_delta from text', async () => {
    const ev = await collect([
      {
        id: 'm1',
        choices: [
          { delta: { reasoning_details: [{ type: 'reasoning.text', text: 'silent think' }] } },
        ],
      },
      { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
    ]);
    expect(
      ev.filter((e) => e.kind === 'thinking_delta').map((e) => (e as { text: string }).text),
    ).toEqual(['silent think']);
    expect(ev.find((e) => e.kind === 'reasoning')).toEqual({
      kind: 'reasoning',
      provider: 'openrouter',
      data: { reasoning_details: [{ type: 'reasoning.text', text: 'silent think' }] },
    });
  });

  test('plaintext-only reasoning (delta.reasoning, no details) is persisted for replay', async () => {
    const ev = await collect([
      { id: 'm1', choices: [{ delta: { reasoning: 'step one ' } }] },
      { choices: [{ delta: { reasoning: 'step two' } }] },
      { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
    ]);
    expect(
      ev.filter((e) => e.kind === 'thinking_delta').map((e) => (e as { text: string }).text),
    ).toEqual(['step one ', 'step two']);
    // No reasoning_details streamed → the reasoning event carries the accumulated
    // plaintext so messages.ts can replay it via `message.reasoning`.
    expect(ev.find((e) => e.kind === 'reasoning')).toEqual({
      kind: 'reasoning',
      provider: 'openrouter',
      data: { reasoning: 'step one step two' },
    });
  });

  test('reasoning_content alias is surfaced as thinking_delta and persisted for replay', async () => {
    const ev = await collect([
      { id: 'm1', choices: [{ delta: { reasoning_content: 'via alias' } }] },
      { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
    ]);
    expect(
      ev.filter((e) => e.kind === 'thinking_delta').map((e) => (e as { text: string }).text),
    ).toEqual(['via alias']);
    expect(ev.find((e) => e.kind === 'reasoning')).toEqual({
      kind: 'reasoning',
      provider: 'openrouter',
      data: { reasoning: 'via alias' },
    });
  });

  test('tool call accumulates args across deltas and stops with tool_use', async () => {
    // Split across deltas: id+name arrive first, args (balanced JSON) follow.
    const ev = await collect([
      {
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read' } }] } }],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"p":1}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    expect(ev.find((e) => e.kind === 'tool_use_start')).toEqual({
      kind: 'tool_use_start',
      id: 'c1',
      name: 'read',
    });
    expect(ev.find((e) => e.kind === 'tool_use_stop')).toEqual({
      kind: 'tool_use_stop',
      id: 'c1',
      final_args: { p: 1 },
    });
    expect(ev.at(-1)).toEqual({ kind: 'stop', reason: 'tool_use' });
  });

  test('in-band error via finish_reason=error surfaces an error event and stops', async () => {
    const ev = await collect([
      { id: 'm1', choices: [{ delta: { content: 'partial' } }] },
      { choices: [{ delta: {}, finish_reason: 'error' }] },
    ]);
    const err = ev.find((e) => e.kind === 'error');
    expect(err).toMatchObject({ kind: 'error', code: 'openrouter.stream_error', retryable: false });
    // No clean stop after an error.
    expect(ev.some((e) => e.kind === 'stop')).toBe(false);
  });

  test('in-band top-level error: 429 code is retryable', async () => {
    const ev = await collect([{ id: 'm1', error: { code: 429, message: 'rate limited' } }]);
    expect(ev.find((e) => e.kind === 'error')).toMatchObject({
      kind: 'error',
      retryable: true,
      message: 'rate limited',
    });
  });
});
