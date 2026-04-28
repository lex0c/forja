import { describe, expect, test } from 'bun:test';
import { type RawOpenAIChunk, normalizeOpenAIStream } from '../../src/providers/openai/stream.ts';
import type { StreamEvent } from '../../src/providers/types.ts';
import { collect, collectNonUsage } from './_stream-helpers.ts';

const fromChunks = (chunks: RawOpenAIChunk[]): AsyncIterable<RawOpenAIChunk> =>
  (async function* () {
    for (const c of chunks) yield c;
  })();

describe('normalizeOpenAIStream', () => {
  test('text-only stream: id from first chunk, deltas, stop', async () => {
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          { id: 'chatcmpl-1', choices: [{ delta: { role: 'assistant', content: '' } }] },
          { id: 'chatcmpl-1', choices: [{ delta: { content: 'hello' } }] },
          { id: 'chatcmpl-1', choices: [{ delta: { content: ' world' } }] },
          { id: 'chatcmpl-1', choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      ),
    );
    expect(events).toEqual([
      { kind: 'start', message_id: 'chatcmpl-1' },
      { kind: 'text_delta', text: 'hello' },
      { kind: 'text_delta', text: ' world' },
      { kind: 'stop', reason: 'end_turn' },
    ]);
  });

  test('synthesizes message_id when first chunk has none', async () => {
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }]),
      ),
    );
    const start = events.find((e) => e.kind === 'start');
    expect(start).toBeDefined();
    if (start?.kind === 'start') {
      expect(start.message_id).toMatch(/^openai_/);
    }
  });

  test('tool_call: name in first chunk, args streamed across chunks, stop after stream end', async () => {
    const events = await collectNonUsage(
      normalizeOpenAIStream(
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
                      function: { name: 'read_file', arguments: '' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '{"path":' } }],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '"/etc/hosts"}' } }],
                },
              },
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
      { kind: 'tool_use_delta', id: 'call_abc', partial_args: '"/etc/hosts"}' },
      { kind: 'tool_use_stop', id: 'call_abc', final_args: { path: '/etc/hosts' } },
      { kind: 'stop', reason: 'tool_use' },
    ]);
  });

  test('multiple tool_calls tracked by index, finalized in index order', async () => {
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 1,
                      id: 'b',
                      type: 'function',
                      function: { name: 'glob', arguments: '{"p":"*.ts"}' },
                    },
                    {
                      index: 0,
                      id: 'a',
                      type: 'function',
                      function: { name: 'read_file', arguments: '{"path":"/x"}' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );
    const stops = events.filter((e) => e.kind === 'tool_use_stop');
    // Sorted by tool_call index, regardless of arrival order.
    expect(stops).toEqual([
      { kind: 'tool_use_stop', id: 'a', final_args: { path: '/x' } },
      { kind: 'tool_use_stop', id: 'b', final_args: { p: '*.ts' } },
    ]);
  });

  test('synthesizes tool_call id when SDK omits it', async () => {
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, type: 'function', function: { name: 'foo', arguments: '{}' } },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]),
      ),
    );
    const start = events.find((e) => e.kind === 'tool_use_start');
    expect(start).toBeDefined();
    if (start?.kind === 'tool_use_start') {
      expect(start.id).toMatch(/^call_/);
    }
  });

  test('id is locked at start: a later id is ignored to keep start/stop coherent', async () => {
    // First chunk has no id (we synthesize one). A second chunk includes
    // a real id. The harness's id↔name lookup keys on the id seen at
    // tool_use_start; if we silently swapped to the late id, the
    // matching tool_use_stop would orphan in collect.ts and the tool
    // call would be dropped (`harness.orphan_tool_use_stop`).
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, type: 'function', function: { name: 'foo' } }],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: { tool_calls: [{ index: 0, id: 'late_id', function: { arguments: '{}' } }] },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]),
      ),
    );
    const start = events.find((e) => e.kind === 'tool_use_start');
    const stop = events.find((e) => e.kind === 'tool_use_stop');
    expect(start).toBeDefined();
    expect(stop).toBeDefined();
    if (start?.kind === 'tool_use_start' && stop?.kind === 'tool_use_stop') {
      // Critical invariant: start.id === stop.id so the harness can
      // correlate them. The actual value (synth or real) doesn't matter.
      expect(stop.id).toBe(start.id);
      // The late real id must NOT have replaced the synthesized one.
      expect(stop.id).not.toBe('late_id');
    }
  });

  test('name straggling to a later chunk: start fires once name is known with the right name', async () => {
    // Chunk 1 carries the id but no function.name (and some args).
    // Chunk 2 supplies the name (and more args). Without deferral, the
    // old code emitted tool_use_start with name='' — the harness then
    // tried to invoke "" → unknown tool, dropping a valid call.
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_x',
                      type: 'function',
                      function: { arguments: '{"path":' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { name: 'read_file', arguments: '"/etc/hosts"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]),
      ),
    );
    const start = events.find((e) => e.kind === 'tool_use_start');
    const stop = events.find((e) => e.kind === 'tool_use_stop');
    expect(start).toBeDefined();
    expect(stop).toBeDefined();
    if (start?.kind === 'tool_use_start') {
      expect(start.name).toBe('read_file');
      expect(start.id).toBe('call_x');
    }
    if (stop?.kind === 'tool_use_stop') {
      expect(stop.id).toBe('call_x');
      expect(stop.final_args).toEqual({ path: '/etc/hosts' });
    }
    // The first delta arrived BEFORE start would have been an orphan.
    // With deferral, start fires first; the buffered bytes are flushed
    // as a single delta after.
    const startIdx = events.findIndex((e) => e.kind === 'tool_use_start');
    const firstDeltaIdx = events.findIndex((e) => e.kind === 'tool_use_delta');
    expect(firstDeltaIdx).toBeGreaterThan(startIdx);
  });

  test('tool_call that ends without a name emits an error (no orphan stop)', async () => {
    // Pathological stream: a tool_call delta with id and args but no
    // name ever arrives. We must not emit tool_use_stop with name='' —
    // that would orphan in collect.ts (which keys on the start name).
    // Instead, emit an error event so the harness fails the step.
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_orphan',
                      type: 'function',
                      function: { arguments: '{}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]),
      ),
    );
    expect(events.find((e) => e.kind === 'tool_use_start')).toBeUndefined();
    expect(events.find((e) => e.kind === 'tool_use_stop')).toBeUndefined();
    const error = events.find((e) => e.kind === 'error');
    expect(error).toBeDefined();
    if (error?.kind === 'error') {
      expect(error.code).toBe('openai.tool_use_no_name');
      expect(error.message).toContain('call_orphan');
    }
  });

  test('start/delta/stop ids stay consistent across the lifecycle', async () => {
    // Three chunks: name-only, args-only, finish. All emitted events for
    // index 0 must share the same id. This is the contract collect.ts
    // depends on.
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_locked', type: 'function', function: { name: 'foo' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );
    const ids = events
      .filter(
        (e) =>
          e.kind === 'tool_use_start' || e.kind === 'tool_use_delta' || e.kind === 'tool_use_stop',
      )
      .map((e) => ('id' in e ? e.id : ''));
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe('call_locked');
  });

  test('refusal field is emitted as text_delta', async () => {
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          { id: 'c', choices: [{ delta: { refusal: "I can't help with that." } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      ),
    );
    expect(events).toContainEqual({ kind: 'text_delta', text: "I can't help with that." });
  });

  test('content and refusal in the same chunk both emit, in declared order', async () => {
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          {
            id: 'c',
            choices: [{ delta: { content: 'visible.', refusal: 'sorry, refused.' } }],
          },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      ),
    );
    const textDeltas = events.filter((e) => e.kind === 'text_delta');
    expect(textDeltas).toEqual([
      { kind: 'text_delta', text: 'visible.' },
      { kind: 'text_delta', text: 'sorry, refused.' },
    ]);
  });

  test('a real-looking id in chunk 1 is not overwritten by a later chunk', async () => {
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_real_xyz',
                      type: 'function',
                      function: { name: 'foo', arguments: '{' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: 'call_other_abc', function: { arguments: '}' } }],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]),
      ),
    );
    // The original id from chunk 1 must survive — even though a different
    // (also `call_`-prefixed) id arrived later. This test would fail with
    // the old `startsWith('call_')` heuristic.
    const stop = events.find((e) => e.kind === 'tool_use_stop');
    expect(stop).toBeDefined();
    if (stop?.kind === 'tool_use_stop') {
      expect(stop.id).toBe('call_real_xyz');
    }
    const start = events.find((e) => e.kind === 'tool_use_start');
    if (start?.kind === 'tool_use_start') {
      expect(start.id).toBe('call_real_xyz');
    }
  });

  test('finish_reason mapping: stop / length / tool_calls / function_call / content_filter', async () => {
    const cases: Array<[string, StreamEvent]> = [
      ['stop', { kind: 'stop', reason: 'end_turn' }],
      ['length', { kind: 'stop', reason: 'max_tokens' }],
      ['tool_calls', { kind: 'stop', reason: 'tool_use' }],
      ['function_call', { kind: 'stop', reason: 'tool_use' }],
      ['content_filter', { kind: 'stop', reason: 'refusal' }],
      ['something_new', { kind: 'stop', reason: 'end_turn' }],
    ];
    for (const [reason, expected] of cases) {
      const events = await collectNonUsage(
        normalizeOpenAIStream(fromChunks([{ choices: [{ delta: {}, finish_reason: reason }] }])),
      );
      expect(events).toContainEqual(expected);
    }
  });

  test('null finish_reason in earlier chunk does not clobber a later valid one', async () => {
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          { choices: [{ delta: { content: 'a' }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );
    expect(events).toContainEqual({ kind: 'stop', reason: 'tool_use' });
  });

  test('malformed tool_call args emit an error event and drop the tool_use_stop', async () => {
    const events = await collectNonUsage(
      normalizeOpenAIStream(
        fromChunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 't',
                      type: 'function',
                      function: { name: 'foo', arguments: '{not json' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
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

  test('empty stream still yields a well-formed start+stop sequence', async () => {
    const events = await collectNonUsage(normalizeOpenAIStream(fromChunks([])));
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('start');
    expect(events[1]).toEqual({ kind: 'stop', reason: 'end_turn' });
  });

  test('extracts usage from final chunk and splits cached_tokens out of prompt total', async () => {
    const events = await collect(
      normalizeOpenAIStream(
        fromChunks([
          { id: 'cmpl-x', choices: [{ delta: { content: 'hi' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 1200,
              completion_tokens: 50,
              prompt_tokens_details: { cached_tokens: 1000 },
            },
          },
        ]),
      ),
    );
    const u = events.find((e) => e.kind === 'usage');
    if (u?.kind !== 'usage') throw new Error('expected usage event');
    // prompt - cached splits the total into the rate it'll actually be
    // billed at: input billed at full rate, cache_read at the discount.
    expect(u.usage).toEqual({ input: 200, output: 50, cache_read: 1000, cache_creation: 0 });
  });
});
