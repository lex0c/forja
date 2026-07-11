import { describe, expect, test } from 'bun:test';
import {
  anthropicEffort,
  EFFORT_THINKING_BUDGET,
  effortThinkingBudget,
  OPENAI_REASONING_EFFORT,
} from '../../src/providers/effort.ts';
import type { ProviderEffort } from '../../src/providers/types.ts';

const LEVELS: ProviderEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

describe('anthropicEffort', () => {
  test('clamps xhigh → high when the model does not expose it', () => {
    expect(anthropicEffort('xhigh', false)).toBe('high');
  });

  test('passes xhigh through when supported (Opus 4.7/4.8)', () => {
    expect(anthropicEffort('xhigh', true)).toBe('xhigh');
  });

  test('every other level is identity, regardless of xhigh support', () => {
    for (const e of ['low', 'medium', 'high', 'max'] as ProviderEffort[]) {
      expect(anthropicEffort(e, false)).toBe(e);
      expect(anthropicEffort(e, true)).toBe(e);
    }
  });
});

describe('OPENAI_REASONING_EFFORT', () => {
  test('low/medium/high/xhigh are 1:1; max also maps to xhigh (OpenAI tops at xhigh)', () => {
    expect(OPENAI_REASONING_EFFORT.low).toBe('low');
    expect(OPENAI_REASONING_EFFORT.medium).toBe('medium');
    expect(OPENAI_REASONING_EFFORT.high).toBe('high');
    expect(OPENAI_REASONING_EFFORT.xhigh).toBe('xhigh');
    expect(OPENAI_REASONING_EFFORT.max).toBe('xhigh');
  });
});

describe('EFFORT_THINKING_BUDGET', () => {
  test('monotonic and capped at the smallest numeric ceiling we ship', () => {
    for (let i = 1; i < LEVELS.length; i++) {
      expect(EFFORT_THINKING_BUDGET[LEVELS[i] as ProviderEffort]).toBeGreaterThan(
        EFFORT_THINKING_BUDGET[LEVELS[i - 1] as ProviderEffort],
      );
    }
    // `max` pins at Gemini 2.5 Flash's thinking ceiling (24_576) so a
    // single ladder is safe across numeric providers without branching.
    expect(EFFORT_THINKING_BUDGET.max).toBeLessThanOrEqual(24_576);
  });
});

describe('effortThinkingBudget', () => {
  test('returns the ladder value when max_tokens has headroom', () => {
    expect(effortThinkingBudget('medium', 100_000)).toBe(EFFORT_THINKING_BUDGET.medium);
  });

  test('clamps to strictly below max_tokens', () => {
    expect(effortThinkingBudget('max', 1_000)).toBe(999);
  });

  test('returns undefined when there is no headroom (API rejects budget >= max_tokens)', () => {
    expect(effortThinkingBudget('low', 1)).toBeUndefined();
    expect(effortThinkingBudget('low', 0)).toBeUndefined();
  });

  test('returns undefined when headroom is below the model thinking floor (Gemini Pro ≥128)', () => {
    // maxTokens 100 → ceiling 99 < MIN_THINKING_BUDGET(128) → omit
    // rather than send a sub-minimum budget the API would reject.
    expect(effortThinkingBudget('low', 100)).toBeUndefined();
    // Just clearing the floor returns a clamped value at/above it.
    expect(effortThinkingBudget('low', 200)).toBe(199);
  });
});
