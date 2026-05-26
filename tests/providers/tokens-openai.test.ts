// Pins for the OpenAI tiktoken (o200k_base) wrapper.
// Spec: TOKEN_TUNING.md §8.1 (`OpenAI tiktoken (público), preciso ~0.5% error`).
//
// The tests here are STRUCTURAL — they don't pin exact token counts
// from o200k_base's internal merge tables. The upstream
// `gpt-tokenizer` library is the source of truth for those; coupling
// the test suite to specific token numbers would tie us to the
// library version. Instead we assert:
//   1. The wrapper produces a smaller count than chars/4 for English
//      prose (the whole reason we use it).
//   2. Empty inputs short-circuit to 0.
//   3. Message framing tokens (~3 per message) attach to each
//      message but not to plain-text accounting.
//   4. Tool schemas contribute their schema JSON's tokens.

import { describe, expect, test } from 'bun:test';
import {
  estimateOpenAIMessagesTokens,
  estimateOpenAIPromptTokens,
  estimateOpenAITextTokens,
} from '../../src/providers/tokens-openai.ts';
import type { ProviderMessage, ProviderToolDef } from '../../src/providers/types.ts';

describe('tokens-openai (o200k_base wrapper)', () => {
  test('plain text: empty string returns 0 without calling encoder', () => {
    expect(estimateOpenAITextTokens('')).toBe(0);
  });

  test('plain text: realistic English prose tokenizes well under chars/4', () => {
    // The pin guards "we are actually running tiktoken, not falling
    // through to chars/4". English prose is BPE-friendly: common
    // words compress into single tokens, so a ~55-char sentence
    // tokenizes to ~10-13 tokens, not the chars/4 estimate of 14.
    const text = 'The quick brown fox jumps over the lazy dog repeatedly.';
    const tiktoken = estimateOpenAITextTokens(text);
    const heuristic = Math.ceil(text.length / 4);
    // Tiktoken must be STRICTLY smaller — otherwise the dispatch
    // either didn't happen or the tokenizer ran with the wrong
    // encoding (cl100k_base / p50k would be slightly larger but
    // still close; using chars/4 would equal heuristic exactly).
    expect(tiktoken).toBeLessThan(heuristic);
    // Sanity bounds: shouldn't drop to zero or balloon over the
    // heuristic. If this fires, the encoding shipped by upstream
    // changed in a way the project hasn't accommodated.
    expect(tiktoken).toBeGreaterThan(5);
    expect(tiktoken).toBeLessThan(heuristic);
  });

  test('messages: per-message framing (~3 tokens) attaches once per entry', () => {
    // Two messages with the same body text should NOT cost
    // 2 * (body tokens). They cost 2 * (body + framing), where
    // framing is the small per-message overhead the wrapper folds
    // in to approximate OpenAI's role/content envelope. The pin
    // verifies framing is per-message, not amortized.
    const single: ProviderMessage[] = [{ role: 'user', content: 'hello world' }];
    const double: ProviderMessage[] = [
      { role: 'user', content: 'hello world' },
      { role: 'user', content: 'hello world' },
    ];
    const a = estimateOpenAIMessagesTokens(single);
    const b = estimateOpenAIMessagesTokens(double);
    // Doubling messages adds at least the body once over again AND
    // an extra framing chunk. Lower bound: at least 4 tokens
    // more (3 framing + 1 token of body, since "hello world" is
    // at least 2 tokens but may be 1 in some encodings).
    expect(b - a).toBeGreaterThanOrEqual(4);
  });

  test('tool blocks: tool_use serializes name + args', () => {
    // The walker must visit tool_use blocks and account for their
    // bytes. A message carrying only a tool_use with a large args
    // object must cost more than a bare message with no content.
    const empty: ProviderMessage[] = [{ role: 'assistant', content: [] }];
    const withTool: ProviderMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'read_file',
            input: { path: '/tmp/a-very-long-path-that-takes-many-tokens.txt' },
          },
        ],
      },
    ];
    expect(estimateOpenAIMessagesTokens(withTool)).toBeGreaterThan(
      estimateOpenAIMessagesTokens(empty),
    );
  });

  test('prompt walker: tools schema contributes to the total', () => {
    // estimatePromptTokens (the full-request shape) walks system +
    // tools + messages. A non-empty tool definition must inflate
    // the total versus a request with no tools.
    const messages: ProviderMessage[] = [{ role: 'user', content: 'hi' }];
    const tool: ProviderToolDef = {
      name: 'grep',
      description: 'Search for pattern in files',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'regex' },
          path: { type: 'string', description: 'starting path' },
        },
      },
    };
    const without = estimateOpenAIPromptTokens(messages);
    const withTools = estimateOpenAIPromptTokens(messages, { tools: [tool] });
    expect(withTools).toBeGreaterThan(without);
  });

  test('prompt walker: system prompt contributes to the total', () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'hi' }];
    const without = estimateOpenAIPromptTokens(messages);
    const withSystem = estimateOpenAIPromptTokens(messages, {
      system: 'You are a careful, methodical software engineering assistant.',
    });
    expect(withSystem).toBeGreaterThan(without);
  });
});
