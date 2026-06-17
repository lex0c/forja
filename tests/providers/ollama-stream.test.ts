import { describe, expect, test } from 'bun:test';
import type { OllamaChatResponse } from '../../src/providers/ollama/http.ts';
import { normalizeOllamaStream } from '../../src/providers/ollama/stream.ts';
import type { StreamEvent } from '../../src/providers/types.ts';

const res = (over: Partial<OllamaChatResponse> = {}): OllamaChatResponse => ({
  model: 'qwen2.5-coder:14b',
  created_at: '2026-01-01T00:00:00Z',
  message: { role: 'assistant', content: '' },
  done: true,
  ...over,
});

async function* streamOf(...chunks: OllamaChatResponse[]): AsyncIterable<OllamaChatResponse> {
  for (const c of chunks) {
    yield c;
  }
}

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const e of it) {
    out.push(e);
  }
  return out;
};

describe('normalizeOllamaStream', () => {
  test('single text chunk → start, text_delta, usage, stop(end_turn)', async () => {
    const ev = await collect(
      normalizeOllamaStream(
        streamOf(
          res({
            message: { role: 'assistant', content: 'hello' },
            done_reason: 'stop',
            prompt_eval_count: 12,
            eval_count: 4,
          }),
        ),
      ),
    );
    expect(ev.map((e) => e.kind)).toEqual(['start', 'text_delta', 'usage', 'stop']);
    expect(ev[1]).toEqual({ kind: 'text_delta', text: 'hello' });
    expect(ev.at(-1)).toEqual({ kind: 'stop', reason: 'end_turn' });
  });

  test('start carries a message id (created_at)', async () => {
    const ev = await collect(
      normalizeOllamaStream(streamOf(res({ message: { role: 'assistant', content: 'x' } }))),
    );
    expect(ev[0]).toEqual({ kind: 'start', message_id: '2026-01-01T00:00:00Z' });
  });

  test('accumulates text deltas across chunks (one start/usage/stop)', async () => {
    const ev = await collect(
      normalizeOllamaStream(
        streamOf(
          res({ message: { role: 'assistant', content: 'he' }, done: false }),
          res({ message: { role: 'assistant', content: 'llo' }, done: false }),
          res({
            message: { role: 'assistant', content: '!' },
            done: true,
            done_reason: 'stop',
            eval_count: 3,
          }),
        ),
      ),
    );
    expect(ev.filter((e) => e.kind === 'text_delta')).toEqual([
      { kind: 'text_delta', text: 'he' },
      { kind: 'text_delta', text: 'llo' },
      { kind: 'text_delta', text: '!' },
    ]);
    expect(ev.filter((e) => e.kind === 'start')).toHaveLength(1);
    expect(ev.filter((e) => e.kind === 'usage')).toHaveLength(1);
    expect(ev.at(-1)).toEqual({ kind: 'stop', reason: 'end_turn' });
  });

  test('thinking precedes text within a chunk', async () => {
    const ev = await collect(
      normalizeOllamaStream(
        streamOf(res({ message: { role: 'assistant', content: 'answer', thinking: 'because' } })),
      ),
    );
    expect(ev.map((e) => e.kind)).toEqual([
      'start',
      'thinking_delta',
      'text_delta',
      'usage',
      'stop',
    ]);
    expect(ev[1]).toEqual({ kind: 'thinking_delta', text: 'because' });
  });

  test('empty content emits no text_delta', async () => {
    const ev = await collect(
      normalizeOllamaStream(streamOf(res({ message: { role: 'assistant', content: '' } }))),
    );
    expect(ev.map((e) => e.kind)).toEqual(['start', 'usage', 'stop']);
  });

  test('tool call → start+stop with object args; stop reason tool_use', async () => {
    const ev = await collect(
      normalizeOllamaStream(
        streamOf(
          res({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.ts' } } }],
            },
            done_reason: 'stop',
          }),
        ),
      ),
    );
    expect(ev.map((e) => e.kind)).toEqual([
      'start',
      'tool_use_start',
      'tool_use_stop',
      'usage',
      'stop',
    ]);
    expect(ev[1]).toEqual({ kind: 'tool_use_start', id: 'ollama-0', name: 'read_file' });
    expect(ev[2]).toEqual({ kind: 'tool_use_stop', id: 'ollama-0', final_args: { path: 'a.ts' } });
    expect(ev.at(-1)).toEqual({ kind: 'stop', reason: 'tool_use' });
  });

  test('accumulates tool calls across chunks with distinct ids', async () => {
    const ev = await collect(
      normalizeOllamaStream(
        streamOf(
          res({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'a', arguments: {} } }],
            },
            done: false,
          }),
          res({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'b', arguments: {} } }],
            },
            done: true,
          }),
        ),
      ),
    );
    expect(ev.filter((e) => e.kind === 'tool_use_start')).toEqual([
      { kind: 'tool_use_start', id: 'ollama-0', name: 'a' },
      { kind: 'tool_use_start', id: 'ollama-1', name: 'b' },
    ]);
  });

  test('usage maps prompt_eval_count/eval_count from the final chunk', async () => {
    const ev = await collect(
      normalizeOllamaStream(streamOf(res({ prompt_eval_count: 100, eval_count: 25 }))),
    );
    expect(ev.find((e) => e.kind === 'usage')).toEqual({
      kind: 'usage',
      usage: { input: 100, output: 25, cache_read: 0, cache_creation: 0 },
    });
  });

  test('missing usage counts default to 0', async () => {
    const ev = await collect(
      normalizeOllamaStream(streamOf(res({ message: { role: 'assistant', content: 'x' } }))),
    );
    expect(ev.find((e) => e.kind === 'usage')).toEqual({
      kind: 'usage',
      usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
    });
  });

  test('done_reason length → max_tokens', async () => {
    const ev = await collect(
      normalizeOllamaStream(
        streamOf(res({ message: { role: 'assistant', content: 'x' }, done_reason: 'length' })),
      ),
    );
    expect(ev.at(-1)).toEqual({ kind: 'stop', reason: 'max_tokens' });
  });

  test('tool_use stop even when the final chunk omits tool_calls', async () => {
    const ev = await collect(
      normalizeOllamaStream(
        streamOf(
          res({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'read_file', arguments: {} } }],
            },
            done: false,
          }),
          res({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }),
        ),
      ),
    );
    expect(ev.filter((e) => e.kind === 'tool_use_start')).toHaveLength(1);
    expect(ev.at(-1)).toEqual({ kind: 'stop', reason: 'tool_use' });
  });

  test('a stream that never sends done:true → error event, no stop', async () => {
    const ev = await collect(
      normalizeOllamaStream(
        streamOf(res({ message: { role: 'assistant', content: 'partial' }, done: false })),
      ),
    );
    expect(ev.some((e) => e.kind === 'error' && e.code === 'local.stream_incomplete')).toBe(true);
    expect(ev.some((e) => e.kind === 'stop')).toBe(false);
  });

  test('an empty stream → error event', async () => {
    const ev = await collect(normalizeOllamaStream(streamOf()));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'error', code: 'local.stream_incomplete' });
  });

  test('a chunk without content does not crash (tool-call-only)', async () => {
    const chunk = {
      model: 'm',
      created_at: 't',
      done: true,
      message: { role: 'assistant', tool_calls: [{ function: { name: 'x', arguments: {} } }] },
    } as unknown as OllamaChatResponse;
    const ev = await collect(normalizeOllamaStream(streamOf(chunk)));
    expect(ev.some((e) => e.kind === 'text_delta')).toBe(false);
    expect(ev.some((e) => e.kind === 'tool_use_start')).toBe(true);
  });

  test('length truncation wins over tool_calls (max_tokens, not tool_use)', async () => {
    const ev = await collect(
      normalizeOllamaStream(
        streamOf(
          res({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a' } } }],
            },
            done_reason: 'length',
          }),
        ),
      ),
    );
    expect(ev.at(-1)).toEqual({ kind: 'stop', reason: 'max_tokens' });
  });
});
