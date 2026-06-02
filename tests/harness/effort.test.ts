import { describe, expect, test } from 'bun:test';
import {
  EFFORT_PROFILES,
  FORJA_EFFORT_LEVELS,
  type ForjaEffort,
  effortBudgetPatch,
  providerEffortFor,
  resolveProviderEffort,
} from '../../src/harness/effort.ts';
import { DEFAULT_BUDGET, type RunBudget, effectiveBudget } from '../../src/harness/types.ts';

describe('EFFORT_PROFILES', () => {
  test('defines exactly the four ordered levels', () => {
    expect([...FORJA_EFFORT_LEVELS]).toEqual(['low', 'medium', 'high', 'max']);
    expect(Object.keys(EFFORT_PROFILES).sort()).toEqual(['high', 'low', 'max', 'medium']);
  });

  test('operational caps increase monotonically with level', () => {
    for (let i = 1; i < FORJA_EFFORT_LEVELS.length; i++) {
      const lo = EFFORT_PROFILES[FORJA_EFFORT_LEVELS[i - 1] as ForjaEffort];
      const hi = EFFORT_PROFILES[FORJA_EFFORT_LEVELS[i] as ForjaEffort];
      expect(hi.maxSteps).toBeGreaterThan(lo.maxSteps);
      expect(hi.maxConcurrentSubagents).toBeGreaterThanOrEqual(lo.maxConcurrentSubagents);
      expect(hi.maxToolErrors).toBeGreaterThan(lo.maxToolErrors);
    }
  });

  test('providerEffort is 1:1 with the level today', () => {
    for (const level of FORJA_EFFORT_LEVELS) {
      expect(EFFORT_PROFILES[level].providerEffort).toBe(level);
      expect(providerEffortFor(level)).toBe(level);
    }
  });

  test('max stays within the ORCHESTRATION §11 subagent hard cap (8)', () => {
    expect(EFFORT_PROFILES.max.maxConcurrentSubagents).toBeLessThanOrEqual(8);
  });
});

describe('effortBudgetPatch', () => {
  test('projects onto RunBudget-shaped fields (compile-time assignability)', () => {
    // A rename of a RunBudget field would break this assignment.
    const patch: Partial<RunBudget> = effortBudgetPatch('high');
    expect(patch.maxSteps).toBe(EFFORT_PROFILES.high.maxSteps);
    expect(patch.maxConcurrentSubagents).toBe(EFFORT_PROFILES.high.maxConcurrentSubagents);
    expect(patch.maxToolErrors).toBe(EFFORT_PROFILES.high.maxToolErrors);
  });

  test('merges over a partial budget without touching unrelated caps', () => {
    const merged: Partial<RunBudget> = { maxCostUsd: 7, ...effortBudgetPatch('low') };
    expect(merged.maxCostUsd).toBe(7);
    expect(merged.maxSteps).toBe(EFFORT_PROFILES.low.maxSteps);
  });
});

describe('effectiveBudget layering (defaults < effort preset < explicit)', () => {
  test('no effort, no overrides → defaults verbatim', () => {
    expect(effectiveBudget(undefined, undefined)).toEqual(DEFAULT_BUDGET);
  });

  test('effort preset fills its caps; effort-agnostic caps fall back to defaults', () => {
    const r = effectiveBudget(undefined, 'low');
    expect(r.maxSteps).toBe(EFFORT_PROFILES.low.maxSteps);
    expect(r.maxConcurrentSubagents).toBe(EFFORT_PROFILES.low.maxConcurrentSubagents);
    expect(r.maxToolErrors).toBe(EFFORT_PROFILES.low.maxToolErrors);
    expect(r.maxWallClockMs).toBe(DEFAULT_BUDGET.maxWallClockMs);
  });

  test('explicit override beats the effort preset; preset fills the rest (order-independent)', () => {
    const r = effectiveBudget({ maxSteps: 50 }, 'max');
    expect(r.maxSteps).toBe(50); // explicit wins over the max preset (400)
    expect(r.maxConcurrentSubagents).toBe(EFFORT_PROFILES.max.maxConcurrentSubagents);
  });

  test('explicit maxCostUsd opt-out (undefined) propagates through the layering', () => {
    const r = effectiveBudget({ maxCostUsd: undefined }, 'high');
    expect(r.maxCostUsd).toBeUndefined();
  });
});

describe('resolveProviderEffort (subagent inheritance rule)', () => {
  test('explicit providerEffort wins — the inherited-subagent path', () => {
    // A child carries providerEffort (reasoning axis) but no `effort`
    // level (so it gets no operational-cap preset).
    expect(resolveProviderEffort({ providerEffort: 'high', effort: 'low' })).toBe('high');
    expect(resolveProviderEffort({ providerEffort: 'max' })).toBe('max');
  });

  test('derives from the effort level when providerEffort is unset — the main session', () => {
    expect(resolveProviderEffort({ effort: 'medium' })).toBe('medium');
  });

  test('undefined when neither is set (provider default)', () => {
    expect(resolveProviderEffort({})).toBeUndefined();
  });
});
