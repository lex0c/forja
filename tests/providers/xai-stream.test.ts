import { describe, expect, test } from 'bun:test';
import { normalizeXaiStream, type RawXaiChunk } from '../../src/providers/xai/stream.ts';
import { collect, collectNonUsage } from './_stream-helpers.ts';

const fromChunks = (chunks: RawXaiChunk[]): AsyncIterable<RawXaiChunk> =>
  (async function* () {
    for (const c of chunks) yield c;
  })();

describe('normalizeXaiStream', () => {
  test('text-only stream: id from first chunk, deltas, stop', async () => {
    const events = await collectNonUsage(
      normalizeXaiStream(
        fromChunks([
          { id: 'x-1', choices: [{ delta: { role: 'assistant', content: '' } }] },
          { id: 'x-1', choices: [{ delta: { content: 'hello' } }] },
          { id: 'x-1', choices: [{ delta: { content: ' world' } }] },
          { id: 'x-1', choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      ),
    );
    expect(events).toEqual([
      { kind: 'start', message_id: 'x-1' },
      { kind: 'text_delta', text: 'hello' },
      { kind: 'text_delta', text: ' world' },
      { kind: 'stop', reason: 'end_turn' },
    ]);
  });

  test('synthesizes message_id (xai_ prefix) when first chunk has none', async () => {
    const events = await collectNonUsage(
      normalizeXaiStream(
        fromChunks([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }]),
      ),
    );
    const start = events.find((e) => e.kind === 'start');
    expect(start?.kind === 'start' && start.message_id).toMatch(/^xai_/);
  });

  test('reasoning_content is surfaced as thinking_delta (display only, no reasoning block)', async () => {
    const events = await collectNonUsage(
      normalizeXaiStream(
        fromChunks([
          { id: 'x', choices: [{ delta: { reasoning_content: 'let me think' } }] },
          { id: 'x', choices: [{ delta: { content: 'answer' } }] },
          { id: 'x', choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      ),
    );
    expect(events).toEqual([
      { kind: 'start', message_id: 'x' },
      { kind: 'thinking_delta', text: 'let me think' },
      { kind: 'text_delta', text: 'answer' },
      { kind: 'stop', reason: 'end_turn' },
    ]);
    // Chat Completions has no reasoning-input slot → nothing to replay.
    expect(events.some((e) => e.kind === 'reasoning')).toBe(false);
  });

  test('accepts the `reasoning` alias for streamed thinking', async () => {
    const events = await collectNonUsage(
      normalizeXaiStream(
        fromChunks([
          { id: 'x', choices: [{ delta: { reasoning: 'aliased thought' } }] },
          { id: 'x', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
        ]),
      ),
    );
    expect(events).toContainEqual({ kind: 'thinking_delta', text: 'aliased thought' });
  });

  test('tool_call: name in first chunk, args streamed, stop after stream end', async () => {
    const events = await collectNonUsage(
      normalizeXaiStream(
        fromChunks([
          { id: 'c', choices: [{ delta: { role: 'assistant' } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_abc',
                      type: 'function',
                      function: { name: 'read_file', arguments: '{"path":' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );
    expect(events).toEqual([
      { kind: 'start', message_id: 'c' },
      { kind: 'tool_use_start', id: 'call_abc', name: 'read_file' },
      { kind: 'tool_use_delta', id: 'call_abc', partial_args: '{"path":' },
      { kind: 'tool_use_delta', id: 'call_abc', partial_args: '"a.ts"}' },
      { kind: 'tool_use_stop', id: 'call_abc', final_args: { path: 'a.ts' } },
      { kind: 'stop', reason: 'tool_use' },
    ]);
  });

  test('tool_call whose name never arrives yields an error, not an orphan stop', async () => {
    const events = await collectNonUsage(
      normalizeXaiStream(
        fromChunks([
          {
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );
    expect(events.some((e) => e.kind === 'error' && e.code === 'xai.tool_use_no_name')).toBe(true);
    expect(events.some((e) => e.kind === 'tool_use_stop')).toBe(false);
  });

  test('usage: prompt includes cached; input = prompt - cached; cache_creation is 0', async () => {
    const events = await collect(
      normalizeXaiStream(
        fromChunks([
          { id: 'x', choices: [{ delta: { content: 'hi' } }] },
          {
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              prompt_tokens_details: { cached_tokens: 30 },
            },
          },
        ]),
      ),
    );
    expect(events).toContainEqual({
      kind: 'usage',
      usage: { input: 70, output: 20, cache_read: 30, cache_creation: 0 },
    });
  });

  test('reasoning_tokens are added to output (xAI bills them separately from completion_tokens)', async () => {
    const events = await collect(
      normalizeXaiStream(
        fromChunks([
          { id: 'x', choices: [{ delta: { content: 'ans' } }] },
          {
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 231,
              completion_tokens: 14,
              total_tokens: 642,
              prompt_tokens_details: { cached_tokens: 128 },
              // Visible answer is 14 tokens; 397 billed reasoning tokens are
              // reported here, NOT inside completion_tokens (prompt+completion+
              // reasoning == total == 642).
              completion_tokens_details: { reasoning_tokens: 397 },
            },
          },
        ]),
      ),
    );
    expect(events).toContainEqual({
      kind: 'usage',
      // output = completion (14) + reasoning (397) = 411; input = 231 - 128.
      usage: { input: 103, output: 411, cache_read: 128, cache_creation: 0 },
    });
  });

  test('no usage chunk → no synthetic usage event (compat proxy dropping stream_options)', async () => {
    const events = await collect(
      normalizeXaiStream(
        fromChunks([{ id: 'x', choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }]),
      ),
    );
    expect(events.some((e) => e.kind === 'usage')).toBe(false);
  });

  test('finish_reason=length maps to max_tokens', async () => {
    const events = await collectNonUsage(
      normalizeXaiStream(
        fromChunks([{ id: 'x', choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] }]),
      ),
    );
    expect(events).toContainEqual({ kind: 'stop', reason: 'max_tokens' });
  });
});
