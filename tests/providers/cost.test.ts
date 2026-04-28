import { describe, expect, test } from 'bun:test';
import { addUsage, computeCost, emptyUsage } from '../../src/providers/cost.ts';
import type { ProviderCapabilities } from '../../src/providers/types.ts';

const baseCaps = (overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  tools: 'native',
  cache: 'server_5min',
  vision: false,
  streaming: true,
  constrained: false,
  context_window: 100_000,
  output_max_tokens: 4096,
  cost_per_1k_input: 3.0,
  cost_per_1k_output: 15.0,
  cost_per_1k_cached_input: 0.3,
  notes: [],
  ...overrides,
});

describe('computeCost', () => {
  test('returns 0 when usage is empty', () => {
    expect(computeCost(baseCaps(), emptyUsage())).toBe(0);
  });

  test('charges input/output at the declared per-1k rate', () => {
    // 1000 input × $3/1k = $3.00; 100 output × $15/1k = $1.50; total $4.50
    const cost = computeCost(baseCaps(), {
      input: 1000,
      output: 100,
      cache_read: 0,
      cache_creation: 0,
    });
    expect(cost).toBeCloseTo(4.5, 6);
  });

  test('uses cached_input rate for cache_read tokens when declared', () => {
    // 1000 cache_read × $0.30/1k = $0.30 (vs $3.00 at full rate)
    const cost = computeCost(baseCaps(), {
      input: 0,
      output: 0,
      cache_read: 1000,
      cache_creation: 0,
    });
    expect(cost).toBeCloseTo(0.3, 6);
  });

  test('falls back to input rate when cached_input is undeclared', () => {
    // No cache discount declared → cache reads cost like raw input.
    // Surfaces missing capability data instead of silently zeroing the
    // line item.
    const noCacheRate = baseCaps();
    const { cost_per_1k_cached_input: _drop, ...rest } = noCacheRate;
    const cost = computeCost(rest as ProviderCapabilities, {
      input: 0,
      output: 0,
      cache_read: 1000,
      cache_creation: 0,
    });
    expect(cost).toBeCloseTo(3.0, 6);
  });

  test('uses cache_write rate for cache_creation when declared', () => {
    const caps = baseCaps({ cost_per_1k_cache_write: 3.75 });
    const cost = computeCost(caps, {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_creation: 1000,
    });
    expect(cost).toBeCloseTo(3.75, 6);
  });

  test('falls back to input rate for cache_creation when cache_write undeclared', () => {
    // Anthropic charges 1.25× input for cache writes; if a model entry
    // omits the rate, we charge the input rate (overcounts slightly,
    // beats undercounting silently).
    const cost = computeCost(baseCaps(), {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_creation: 1000,
    });
    expect(cost).toBeCloseTo(3.0, 6);
  });

  test('composes all four token classes', () => {
    const caps = baseCaps({ cost_per_1k_cache_write: 3.75 });
    const cost = computeCost(caps, {
      input: 1000,
      output: 200,
      cache_read: 1000,
      cache_creation: 1000,
    });
    // 3 + 3 + 0.30 + 3.75 = $10.05
    expect(cost).toBeCloseTo(10.05, 6);
  });
});

describe('addUsage', () => {
  test('sums each field independently', () => {
    expect(
      addUsage(
        { input: 10, output: 5, cache_read: 100, cache_creation: 50 },
        { input: 1, output: 2, cache_read: 3, cache_creation: 4 },
      ),
    ).toEqual({ input: 11, output: 7, cache_read: 103, cache_creation: 54 });
  });

  test('emptyUsage is the additive identity', () => {
    const u = { input: 7, output: 3, cache_read: 1, cache_creation: 0 };
    expect(addUsage(u, emptyUsage())).toEqual(u);
    expect(addUsage(emptyUsage(), u)).toEqual(u);
  });
});
