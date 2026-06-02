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

  test('clamps a legacy thinking_budget to the model cap (the 50000 → HTTP 400 bug)', () => {
    // The loader allows large legacy values for provider-specific
    // handling; the adapter must fit them rather than 400.
    const capped = {
      supports_reasoning_effort: true,
      max_thinking_budget: 24_576,
    } as unknown as ProviderCapabilities;
    expect(googleThinkingBudget(req({ thinking_budget: 50_000 }), capped)).toBe(24_576);
    // Under the cap → unchanged.
    expect(googleThinkingBudget(req({ thinking_budget: 10_000 }), capped)).toBe(10_000);
  });

  test('clamps the effort-derived budget to the model cap too', () => {
    // effort high ladder (16384) exceeds an 8000 cap → clamped.
    const capped = {
      supports_reasoning_effort: true,
      max_thinking_budget: 8_000,
    } as unknown as ProviderCapabilities;
    expect(googleThinkingBudget(req({ effort: 'high' }), capped)).toBe(8_000);
  });

  test('no max_thinking_budget cap → no clamp (forward raw)', () => {
    expect(googleThinkingBudget(req({ thinking_budget: 50_000 }), caps)).toBe(50_000);
  });
});
