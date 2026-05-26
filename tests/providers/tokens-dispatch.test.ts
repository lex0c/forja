// Pins for the family-aware estimate dispatcher in `tokens.ts`.
// Spec: TOKEN_TUNING.md §8.1.

import { describe, expect, test } from 'bun:test';
import {
  estimateMessagesTokensFor,
  estimatePromptTokensFor,
  estimateTextTokensFor,
} from '../../src/providers/tokens.ts';
import type { ProviderMessage } from '../../src/providers/types.ts';

describe('estimate dispatchers (family-aware)', () => {
  // The contract: 'openai' family routes to tiktoken o200k_base,
  // every other family falls back to chars/4. The simplest
  // structural pin is "the result differs across families for the
  // same input" — that's the only invariant the dispatcher owes.

  test('estimateTextTokensFor: openai differs from anthropic on English prose', () => {
    const text = 'The quick brown fox jumps over the lazy dog repeatedly.';
    const oa = estimateTextTokensFor('openai', text);
    const anth = estimateTextTokensFor('anthropic', text);
    expect(oa).not.toBe(anth);
    // For English, tiktoken is meaningfully smaller than chars/4 —
    // common words become single tokens.
    expect(oa).toBeLessThan(anth);
  });

  test('estimateTextTokensFor: empty string is 0 across all families', () => {
    // Defensive: short-circuit empties for both paths so the
    // tokenizer wrapper and the heuristic agree on the trivial
    // case (operator-visible chip cells often drive off "is this 0").
    expect(estimateTextTokensFor('openai', '')).toBe(0);
    expect(estimateTextTokensFor('anthropic', '')).toBe(0);
    expect(estimateTextTokensFor('google', '')).toBe(0);
    expect(estimateTextTokensFor('ollama', '')).toBe(0);
  });

  test('estimateTextTokensFor: non-openai families all use chars/4', () => {
    // Every family except OpenAI shares the chars/4 fallback.
    // 100 chars → ceil(100/4) = 25 across the board.
    const text = 'a'.repeat(100);
    expect(estimateTextTokensFor('anthropic', text)).toBe(25);
    expect(estimateTextTokensFor('google', text)).toBe(25);
    expect(estimateTextTokensFor('ollama', text)).toBe(25);
    expect(estimateTextTokensFor('llama_cpp', text)).toBe(25);
    expect(estimateTextTokensFor('mistral', text)).toBe(25);
  });

  test('estimateMessagesTokensFor: routes to OpenAI walker for openai family', () => {
    // Pin that the messages-only walker also dispatches. Adding
    // tools/system would be redundant for this test; covered by
    // `estimatePromptTokensFor` below.
    const messages: ProviderMessage[] = [{ role: 'user', content: 'hello' }];
    const oa = estimateMessagesTokensFor('openai', messages);
    const anth = estimateMessagesTokensFor('anthropic', messages);
    expect(oa).not.toBe(anth);
  });

  test('estimatePromptTokensFor: dispatches on family for full-request walker', () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'hello world' }];
    const oa = estimatePromptTokensFor('openai', messages, {
      system: 'You are a helpful assistant.',
    });
    const anth = estimatePromptTokensFor('anthropic', messages, {
      system: 'You are a helpful assistant.',
    });
    expect(oa).not.toBe(anth);
  });
});
