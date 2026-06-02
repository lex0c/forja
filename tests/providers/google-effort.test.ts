import { describe, expect, test } from 'bun:test';
import { EFFORT_THINKING_BUDGET } from '../../src/providers/effort.ts';
import { googleThinkingBudget } from '../../src/providers/google/index.ts';
import type { GenerateRequest, ProviderCapabilities } from '../../src/providers/types.ts';

const caps = { supports_reasoning_effort: true } as unknown as ProviderCapabilities;
const noEffortCaps = {} as unknown as ProviderCapabilities;

const req = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 100_000,
  ...over,
});

describe('googleThinkingBudget', () => {
  test('effort maps to the canonical ladder when supported', () => {
    expect(googleThinkingBudget(req({ effort: 'high' }), caps)).toBe(EFFORT_THINKING_BUDGET.high);
  });

  test('explicit thinking_budget 0 disables thinking even when effort is set', () => {
    expect(googleThinkingBudget(req({ effort: 'high', thinking_budget: 0 }), caps)).toBeUndefined();
  });

  test('effort dropped when the model lacks the capability; legacy budget still honored', () => {
    expect(googleThinkingBudget(req({ effort: 'high' }), noEffortCaps)).toBeUndefined();
    expect(googleThinkingBudget(req({ effort: 'high', thinking_budget: 4000 }), noEffortCaps)).toBe(
      4000,
    );
  });

  test('legacy thinking_budget used when no effort set', () => {
    expect(googleThinkingBudget(req({ thinking_budget: 4000 }), caps)).toBe(4000);
  });

  test('effort takes precedence over a legacy budget when both set and supported', () => {
    expect(googleThinkingBudget(req({ effort: 'low', thinking_budget: 4000 }), caps)).toBe(
      EFFORT_THINKING_BUDGET.low,
    );
  });
});
