import { describe, expect, test } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import {
  ANTHROPIC_CACHE_EPHEMERAL,
  MAX_CACHE_BREAKPOINTS_PER_REQUEST,
  countCacheBreakpoints,
  messagesWithTailCacheBreakpoint,
  systemWithCacheBreakpoint,
  toolsWithCacheBreakpoint,
} from '../../src/providers/anthropic/cache.ts';
import type { ProviderContentBlock, ProviderMessage } from '../../src/providers/types.ts';

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
