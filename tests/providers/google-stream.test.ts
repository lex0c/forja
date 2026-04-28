import { describe, expect, test } from 'bun:test';
import { type RawGoogleChunk, normalizeGoogleStream } from '../../src/providers/google/stream.ts';
import type { StreamEvent } from '../../src/providers/types.ts';
import { collect, collectNonUsage } from './_stream-helpers.ts';

const fromChunks = (chunks: RawGoogleChunk[]): AsyncIterable<RawGoogleChunk> =>
  (async function* () {
    for (const c of chunks) yield c;
  })();

describe('normalizeGoogleStream', () => {
  test('text-only stream: synth start, text deltas, stop', async () => {
    const events = await collectNonUsage(
      normalizeGoogleStream(
        fromChunks([
          { responseId: 'resp_1', candidates: [{ content: { parts: [{ text: 'hello' }] } }] },
          { candidates: [{ content: { parts: [{ text: ' world' }] } }] },
          { candidates: [{ finishReason: 'STOP' }] },
        ]),
      ),
    );
    expect(events).toEqual([
      { kind: 'start', message_id: 'resp_1' },
      { kind: 'text_delta', text: 'hello' },
      { kind: 'text_delta', text: ' world' },
      { kind: 'stop', reason: 'end_turn' },
    ]);
  });

  test('synthesizes a message_id when responseId is absent', async () => {
    const events = await collectNonUsage(
      normalizeGoogleStream(
        fromChunks([{ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }]),
      ),
    );
    const start = events.find((e) => e.kind === 'start');
    expect(start).toBeDefined();
    if (start?.kind === 'start') {
      expect(start.message_id).toMatch(/^gemini_/);
    }
  });

  test('functionCall part emits start, delta with serialized args, stop', async () => {
    const events = await collectNonUsage(
      normalizeGoogleStream(
        fromChunks([
          {
            responseId: 'r',
            candidates: [
              {
                content: {
                  parts: [{ functionCall: { name: 'read_file', args: { path: '/etc/hosts' } } }],
                },
                finishReason: 'TOOL_CALLS',
              },
            ],
          },
        ]),
      ),
    );
    expect(events).toEqual([
      { kind: 'start', message_id: 'r' },
      expect.objectContaining({ kind: 'tool_use_start', name: 'read_file' }),
      expect.objectContaining({ kind: 'tool_use_delta', partial_args: '{"path":"/etc/hosts"}' }),
      expect.objectContaining({
        kind: 'tool_use_stop',
        final_args: { path: '/etc/hosts' },
      }),
      { kind: 'stop', reason: 'tool_use' },
    ]);
  });

  test('synthesized tool_use ids are stable across the three events', async () => {
    const events = await collectNonUsage(
      normalizeGoogleStream(
        fromChunks([
          {
            candidates: [{ content: { parts: [{ functionCall: { name: 'foo', args: {} } }] } }],
          },
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
  });

  test('respects functionCall.id when the SDK provides one', async () => {
    const events = await collectNonUsage(
      normalizeGoogleStream(
        fromChunks([
          {
            candidates: [
              {
                content: {
                  parts: [{ functionCall: { id: 'sdk_id_42', name: 'foo', args: {} } }],
                },
              },
            ],
          },
        ]),
      ),
    );
    const ids = events
      .filter((e) => 'id' in e && (e.kind.startsWith('tool_use_') as boolean))
      .map((e) => ('id' in e ? e.id : ''));
    expect(ids.every((id) => id === 'sdk_id_42')).toBe(true);
  });

  test('thought parts become thinking_delta', async () => {
    const events = await collectNonUsage(
      normalizeGoogleStream(
        fromChunks([
          {
            candidates: [{ content: { parts: [{ thought: true, text: 'hmm...' }] } }],
          },
        ]),
      ),
    );
    expect(events).toContainEqual({ kind: 'thinking_delta', text: 'hmm...' });
  });

  test('text part with thought:false stays text_delta', async () => {
    const events = await collectNonUsage(
      normalizeGoogleStream(
        fromChunks([{ candidates: [{ content: { parts: [{ text: 'visible' }] } }] }]),
      ),
    );
    expect(events).toContainEqual({ kind: 'text_delta', text: 'visible' });
  });

  test('finishReason mapping: STOP→end_turn, MAX_TOKENS→max_tokens, SAFETY→refusal', async () => {
    const cases: Array<[string, StreamEvent]> = [
      ['STOP', { kind: 'stop', reason: 'end_turn' }],
      ['MAX_TOKENS', { kind: 'stop', reason: 'max_tokens' }],
      ['TOOL_CALLS', { kind: 'stop', reason: 'tool_use' }],
      ['FUNCTION_CALL', { kind: 'stop', reason: 'tool_use' }],
      ['SAFETY', { kind: 'stop', reason: 'refusal' }],
      ['RECITATION', { kind: 'stop', reason: 'refusal' }],
      ['BLOCKLIST', { kind: 'stop', reason: 'refusal' }],
      ['SOMETHING_NEW', { kind: 'stop', reason: 'end_turn' }],
    ];
    for (const [reason, expected] of cases) {
      const events = await collectNonUsage(
        normalizeGoogleStream(fromChunks([{ candidates: [{ finishReason: reason }] }])),
      );
      expect(events).toContainEqual(expected);
    }
  });

  test('null finishReason in earlier chunk does not clobber a later valid one', async () => {
    const events = await collectNonUsage(
      normalizeGoogleStream(
        fromChunks([
          { candidates: [{ content: { parts: [{ text: 'a' }] }, finishReason: null }] },
          { candidates: [{ finishReason: 'TOOL_CALLS' }] },
        ]),
      ),
    );
    expect(events).toContainEqual({ kind: 'stop', reason: 'tool_use' });
  });

  test('empty stream still yields a well-formed start+stop sequence', async () => {
    const events = await collectNonUsage(normalizeGoogleStream(fromChunks([])));
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('start');
    expect(events[1]).toEqual({ kind: 'stop', reason: 'end_turn' });
  });

  test('mixed text and tool_use parts in a single chunk', async () => {
    const events = await collectNonUsage(
      normalizeGoogleStream(
        fromChunks([
          {
            candidates: [
              {
                content: {
                  parts: [
                    { text: 'using read_file' },
                    { functionCall: { name: 'read_file', args: { path: '/x' } } },
                  ],
                },
                finishReason: 'TOOL_CALLS',
              },
            ],
          },
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

  test('does NOT emit a usage event when usageMetadata is an empty object', async () => {
    const events = await collect(
      normalizeGoogleStream(
        fromChunks([
          {
            responseId: 'r',
            candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
            usageMetadata: {},
          },
        ]),
      ),
    );
    expect(events.find((e) => e.kind === 'usage')).toBeUndefined();
  });

  test('partial later usageMetadata does not zero earlier prompt/cache values', async () => {
    // Bug regression: a later chunk reporting only candidatesTokenCount
    // must not reset previously captured promptTokenCount/cached values
    // to 0 via `?? 0` defaults.
    const events = await collect(
      normalizeGoogleStream(
        fromChunks([
          {
            responseId: 'r',
            candidates: [{ content: { parts: [{ text: 'one ' }] } }],
            usageMetadata: {
              promptTokenCount: 1500,
              cachedContentTokenCount: 1000,
              candidatesTokenCount: 3,
            },
          },
          {
            candidates: [{ content: { parts: [{ text: 'two' }] }, finishReason: 'STOP' }],
            // Partial: only the latest output count.
            usageMetadata: { candidatesTokenCount: 30 },
          },
        ]),
      ),
    );
    const u = events.find((e) => e.kind === 'usage');
    if (u?.kind !== 'usage') throw new Error('expected usage event');
    expect(u.usage).toEqual({ input: 500, output: 30, cache_read: 1000, cache_creation: 0 });
  });

  test('emits a usage event with partial measurement (only candidatesTokenCount)', async () => {
    const events = await collect(
      normalizeGoogleStream(
        fromChunks([
          {
            responseId: 'r',
            candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
            usageMetadata: { candidatesTokenCount: 7 },
          },
        ]),
      ),
    );
    const u = events.find((e) => e.kind === 'usage');
    if (u?.kind !== 'usage') throw new Error('expected usage event');
    expect(u.usage.output).toBe(7);
    expect(u.usage.input).toBe(0);
  });

  test('does NOT emit a usage event when no chunk carries usageMetadata', async () => {
    const events = await collect(
      normalizeGoogleStream(
        fromChunks([
          {
            responseId: 'r',
            candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
          },
        ]),
      ),
    );
    expect(events.find((e) => e.kind === 'usage')).toBeUndefined();
  });

  test('extracts usage from usageMetadata, splitting cached tokens out of prompt total', async () => {
    const events = await collect(
      normalizeGoogleStream(
        fromChunks([
          {
            responseId: 'resp_u',
            candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
            usageMetadata: {
              promptTokenCount: 1500,
              cachedContentTokenCount: 1000,
              candidatesTokenCount: 30,
            },
          },
        ]),
      ),
    );
    const u = events.find((e) => e.kind === 'usage');
    if (u?.kind !== 'usage') throw new Error('expected usage event');
    expect(u.usage).toEqual({ input: 500, output: 30, cache_read: 1000, cache_creation: 0 });
  });
});
