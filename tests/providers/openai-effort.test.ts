import { describe, expect, test } from 'bun:test';
import { openaiReasoningParam } from '../../src/providers/openai/index.ts';
import type { GenerateRequest, ProviderCapabilities } from '../../src/providers/types.ts';

const reasoningCaps = { supports_reasoning_effort: true } as unknown as ProviderCapabilities;
// gpt-4o / gpt-4o-mini shape: no reasoning-effort capability.
const plainCaps = {} as unknown as ProviderCapabilities;

const req = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 4096,
  ...over,
});

describe('openaiReasoningParam', () => {
  test('emits the FLAT `reasoning_effort` field (not a nested `reasoning` object) when supported', () => {
    const out = openaiReasoningParam(req({ effort: 'high' }), reasoningCaps);
    expect(out).toEqual({ reasoning_effort: 'high' });
    // Regression guard against the Responses-API nested shape that
    // chat.completions rejects with HTTP 400.
    expect('reasoning' in out).toBe(false);
  });

  test('max maps to xhigh (OpenAI has no "max")', () => {
    expect(openaiReasoningParam(req({ effort: 'max' }), reasoningCaps)).toEqual({
      reasoning_effort: 'xhigh',
    });
  });

  test('omitted entirely when the model lacks the reasoning-effort capability (e.g. gpt-4o)', () => {
    expect(openaiReasoningParam(req({ effort: 'high' }), plainCaps)).toEqual({});
  });

  test('omitted when no effort is set', () => {
    expect(openaiReasoningParam(req(), reasoningCaps)).toEqual({});
  });
});
