import { describe, expect, test } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import {
  ANTHROPIC_CACHE_EPHEMERAL,
  MAX_CACHE_BREAKPOINTS_PER_REQUEST,
  cacheMarker,
  countCacheBreakpoints,
  messagesWithTailCacheBreakpoint,
  systemSegmentsWithCacheBreakpoints,
  systemWithCacheBreakpoint,
  toolsWithCacheBreakpoint,
} from '../../src/providers/anthropic/cache.ts';
import {
  type ProviderContentBlock,
  type ProviderMessage,
  type SystemSegment,
  flattenSystemSegments,
} from '../../src/providers/types.ts';

const tool = (name: string): Anthropic.Tool => ({
  name,
  description: `${name} description`,
  input_schema: { type: 'object' as const, properties: {} },
});

const userMsg = (
  content: string | ProviderContentBlock[],
): { role: ProviderMessage['role']; content: string | ProviderContentBlock[] } => ({
  role: 'user',
  content,
});

describe('cacheMarker', () => {
  test('5m is the bare ephemeral marker (no ttl)', () => {
    expect(cacheMarker('5m')).toEqual({ type: 'ephemeral' });
  });

  test('1h carries an explicit ttl', () => {
    expect(cacheMarker('1h')).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  test('the marker propagates to every breakpoint helper', () => {
    const m = cacheMarker('1h');
    const sys = systemWithCacheBreakpoint('SYS', m);
    expect(sys?.[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const tools = toolsWithCacheBreakpoint([tool('grep')], m);
    expect(tools[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const segs = systemSegmentsWithCacheBreakpoints(
      [{ id: 'stable', text: 'stable', cacheBreakpoint: true }],
      m,
    );
    expect(segs?.[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const tail = messagesWithTailCacheBreakpoint([userMsg('hi')], m);
    const block = tail[0]?.content;
    if (Array.isArray(block)) {
      expect((block[0] as { cache_control?: unknown }).cache_control).toEqual({
        type: 'ephemeral',
        ttl: '1h',
      });
    }
  });
});

describe('systemWithCacheBreakpoint', () => {
  test('returns undefined when system is absent', () => {
    expect(systemWithCacheBreakpoint(undefined)).toBeUndefined();
  });

  test('returns undefined when system is empty', () => {
    // An empty string carries no useful content; emitting an
    // empty cache breakpoint would charge a write for nothing.
    expect(systemWithCacheBreakpoint('')).toBeUndefined();
  });

  test('wraps system text into a cached TextBlockParam', () => {
    const out = systemWithCacheBreakpoint('you are a helpful agent');
    expect(out).toEqual([
      { type: 'text', text: 'you are a helpful agent', cache_control: ANTHROPIC_CACHE_EPHEMERAL },
    ]);
  });
});

describe('systemSegmentsWithCacheBreakpoints', () => {
  test('emits one block per segment with cache_control where flagged', () => {
    const segments: SystemSegment[] = [
      { id: 'stable', text: 'identity + env', cacheBreakpoint: true },
      { id: 'memory', text: 'memory index body', cacheBreakpoint: true },
    ];
    expect(systemSegmentsWithCacheBreakpoints(segments)).toEqual([
      { type: 'text', text: 'identity + env', cache_control: ANTHROPIC_CACHE_EPHEMERAL },
      { type: 'text', text: 'memory index body', cache_control: ANTHROPIC_CACHE_EPHEMERAL },
    ]);
  });

  test('omits cache_control on segments without cacheBreakpoint flag', () => {
    const out = systemSegmentsWithCacheBreakpoints([
      { id: 'stable', text: 'unmarked' },
      { id: 'memory', text: 'marked', cacheBreakpoint: true },
    ]);
    expect(out).toEqual([
      { type: 'text', text: 'unmarked' },
      { type: 'text', text: 'marked', cache_control: ANTHROPIC_CACHE_EPHEMERAL },
    ]);
  });

  test('drops empty-text segments instead of wasting a breakpoint slot', () => {
    const out = systemSegmentsWithCacheBreakpoints([
      { id: 'stable', text: 'body', cacheBreakpoint: true },
      { id: 'memory', text: '', cacheBreakpoint: true },
    ]);
    expect(out).toEqual([{ type: 'text', text: 'body', cache_control: ANTHROPIC_CACHE_EPHEMERAL }]);
  });

  test('returns undefined when every segment is empty', () => {
    expect(systemSegmentsWithCacheBreakpoints([])).toBeUndefined();
    expect(
      systemSegmentsWithCacheBreakpoints([
        { id: 'stable', text: '' },
        { id: 'memory', text: '' },
      ]),
    ).toBeUndefined();
  });

  test('countCacheBreakpoints sees 2 from this layout plus tool + tail = 4 (within limit)', () => {
    const cachedSystem = systemSegmentsWithCacheBreakpoints([
      { id: 'stable', text: 'a', cacheBreakpoint: true },
      { id: 'memory', text: 'b', cacheBreakpoint: true },
    ]);
    const cachedTools = toolsWithCacheBreakpoint([tool('t1')]);
    const cachedMessages = messagesWithTailCacheBreakpoint([userMsg('hi')]);
    const count = countCacheBreakpoints({
      system: cachedSystem,
      tools: cachedTools,
      messages: cachedMessages,
    });
    expect(count).toBe(4);
    expect(count).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS_PER_REQUEST);
  });
});

describe('flattenSystemSegments', () => {
  test('joins segments with the same `\\n\\n` separator composeSystemPrompt uses', () => {
    expect(
      flattenSystemSegments([
        { id: 'stable', text: 'identity + env' },
        { id: 'memory', text: 'memory body' },
      ]),
    ).toBe('identity + env\n\nmemory body');
  });

  test('drops empty segments — flattened form omits double-blank artifacts', () => {
    expect(
      flattenSystemSegments([
        { id: 'stable', text: 'identity' },
        { id: 'memory', text: '' },
      ]),
    ).toBe('identity');
  });

  test('empty array → empty string', () => {
    expect(flattenSystemSegments([])).toBe('');
  });
});

describe('toolsWithCacheBreakpoint', () => {
  test('passes empty tool list through unchanged', () => {
    expect(toolsWithCacheBreakpoint([])).toEqual([]);
  });

  test('attaches cache_control only to the last tool', () => {
    const tools = [tool('read_file'), tool('grep'), tool('write_file')];
    const out = toolsWithCacheBreakpoint(tools);
    expect(out[0]?.cache_control).toBeUndefined();
    expect(out[1]?.cache_control).toBeUndefined();
    expect(out[2]?.cache_control).toEqual(ANTHROPIC_CACHE_EPHEMERAL);
  });

  test('does not mutate the input array', () => {
    const tools = [tool('read_file'), tool('grep')];
    const snapshot = JSON.parse(JSON.stringify(tools));
    toolsWithCacheBreakpoint(tools);
    expect(tools).toEqual(snapshot);
  });
});

describe('messagesWithTailCacheBreakpoint', () => {
  test('returns empty list unchanged', () => {
    expect(messagesWithTailCacheBreakpoint([])).toEqual([]);
  });

  test('expands string content on the tail message into a cached text block', () => {
    const out = messagesWithTailCacheBreakpoint([userMsg('hello')]);
    expect(out).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello', cache_control: ANTHROPIC_CACHE_EPHEMERAL }],
      },
    ]);
  });

  test('attaches cache_control to the last block of the tail array message', () => {
    const blocks: ProviderContentBlock[] = [
      { type: 'text', text: 'analyze the failure' },
      { type: 'tool_use', id: 'a1', name: 'grep', input: { pattern: 'foo' } },
    ];
    const out = messagesWithTailCacheBreakpoint([userMsg(blocks)]);
    const tail = (out[0]?.content ?? []) as Array<{ cache_control?: unknown }>;
    expect(tail[0]?.cache_control).toBeUndefined();
    expect(tail[1]?.cache_control).toEqual(ANTHROPIC_CACHE_EPHEMERAL);
  });

  test('only the LAST message is anchored — earlier messages stay untouched', () => {
    const out = messagesWithTailCacheBreakpoint([
      userMsg('first'),
      { role: 'assistant', content: 'second' },
      userMsg('third'),
    ]);
    // Earlier messages unchanged (string content stays string).
    expect(typeof out[0]?.content).toBe('string');
    expect(typeof out[1]?.content).toBe('string');
    // Tail message expanded with cache_control.
    expect(Array.isArray(out[2]?.content)).toBe(true);
    const tailBlocks = (out[2]?.content ?? []) as Array<{ cache_control?: unknown }>;
    expect(tailBlocks[0]?.cache_control).toEqual(ANTHROPIC_CACHE_EPHEMERAL);
  });

  test('skips empty string content (degenerate tail) without throwing', () => {
    // Empty content would produce an empty array on the API side
    // and trip a 400. The helper preserves the original message
    // shape; the conversation cache anchor is a best-effort
    // optimization, not a correctness contract.
    const out = messagesWithTailCacheBreakpoint([userMsg('')]);
    expect(out[0]?.content).toBe('');
  });

  test('skips empty array content (no blocks to anchor)', () => {
    const out = messagesWithTailCacheBreakpoint([userMsg([])]);
    expect(out[0]?.content).toEqual([]);
  });

  test('never anchors on a trailing thinking block — falls back to the last cache-eligible block', () => {
    // Anthropic 400s on cache_control over thinking/redacted_thinking blocks,
    // which reasoning replay can leave at the tail. The marker must land on the
    // last NON-thinking block instead.
    const blocks = [
      { type: 'thinking', thinking: 'reasoned', signature: 'sig' },
      { type: 'text', text: 'the answer' },
      { type: 'thinking', thinking: 'more', signature: 'sig2' },
    ];
    const out = messagesWithTailCacheBreakpoint([{ role: 'assistant', content: blocks }]);
    const tail = (out[0]?.content ?? []) as Array<{ type: string; cache_control?: unknown }>;
    expect(tail[0]?.cache_control).toBeUndefined();
    expect(tail[1]?.cache_control).toEqual(ANTHROPIC_CACHE_EPHEMERAL); // the text block
    expect(tail[2]?.cache_control).toBeUndefined(); // trailing thinking left clean
  });

  test('skips the breakpoint entirely when the tail is all thinking (reasoning-only turn)', () => {
    const blocks = [
      { type: 'thinking', thinking: 'just thinking', signature: 'sig' },
      { type: 'redacted_thinking', data: 'opaque' },
    ];
    const out = messagesWithTailCacheBreakpoint([{ role: 'assistant', content: blocks }]);
    const tail = (out[0]?.content ?? []) as Array<{ cache_control?: unknown }>;
    expect(tail[0]?.cache_control).toBeUndefined();
    expect(tail[1]?.cache_control).toBeUndefined();
  });
});

describe('countCacheBreakpoints', () => {
  test('returns 0 for a request with no cache markers', () => {
    expect(
      countCacheBreakpoints({
        system: undefined,
        tools: [tool('a'), tool('b')],
        messages: [userMsg('hi')] as Anthropic.MessageParam[],
      }),
    ).toBe(0);
  });

  test('counts the planned three-breakpoint layout exactly', () => {
    const system = systemWithCacheBreakpoint('SYS');
    const tools = toolsWithCacheBreakpoint([tool('grep'), tool('read_file')]);
    const messages = messagesWithTailCacheBreakpoint([userMsg('analyze')]);
    expect(countCacheBreakpoints({ system, tools, messages })).toBe(3);
  });

  test('respects the four-breakpoint hard cap', () => {
    expect(MAX_CACHE_BREAKPOINTS_PER_REQUEST).toBe(4);
    // A request with three breakpoints stays well within the cap;
    // pinning the cap as a value the assertion uses keeps the
    // contract change visible in one place.
    expect(MAX_CACHE_BREAKPOINTS_PER_REQUEST).toBeGreaterThanOrEqual(3);
  });
});
