import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_BUDGET,
  effectiveBudget,
  resolveMaxOutputTokens,
} from '../../src/harness/types.ts';

// Resolver semantics:
//   - undefined override → return capability ceiling (closes silent
//     4096 truncation on Claude 4.x and similarly large windows).
//   - explicit override → clamp to capability ceiling so an
//     over-declared playbook can't bypass the provider hard limit.
// `DEFAULT_BUDGET.maxOutputTokensPerCall` is intentionally undefined
// — these tests pin that contract.
describe('resolveMaxOutputTokens', () => {
  test('returns capability ceiling when override absent', () => {
    expect(resolveMaxOutputTokens({}, { output_max_tokens: 64_000 })).toBe(64_000);
    expect(resolveMaxOutputTokens({}, { output_max_tokens: 16_384 })).toBe(16_384);
    expect(resolveMaxOutputTokens({}, { output_max_tokens: 4_096 })).toBe(4_096);
  });

  test('returns override when override below capability', () => {
    expect(
      resolveMaxOutputTokens({ maxOutputTokensPerCall: 8_192 }, { output_max_tokens: 64_000 }),
    ).toBe(8_192);
  });

  test('clamps override to capability when override exceeds capability', () => {
    // Playbook declares max_tokens=200_000 against gpt-4o cap 16_384.
    // Resolver picks the cap (provider would 400 otherwise).
    expect(
      resolveMaxOutputTokens({ maxOutputTokensPerCall: 200_000 }, { output_max_tokens: 16_384 }),
    ).toBe(16_384);
  });

  test('returns 0 when override is 0 — disables output (operator opt-in)', () => {
    // Edge case: 0 means "no output budget". Provider will reject;
    // resolver doesn't hide the operator's intent. Keeps the
    // resolver pure and predictable.
    expect(
      resolveMaxOutputTokens({ maxOutputTokensPerCall: 0 }, { output_max_tokens: 64_000 }),
    ).toBe(0);
  });

  test('DEFAULT_BUDGET leaves override unset so resolver picks capability', () => {
    expect(DEFAULT_BUDGET.maxOutputTokensPerCall).toBeUndefined();
    expect(resolveMaxOutputTokens(DEFAULT_BUDGET, { output_max_tokens: 64_000 })).toBe(64_000);
  });
});

describe('effectiveBudget (unifies banner / loop / future surfaces)', () => {
  test('absent partial returns a full DEFAULT_BUDGET clone', () => {
    expect(effectiveBudget()).toEqual(DEFAULT_BUDGET);
    expect(effectiveBudget(undefined)).toEqual(DEFAULT_BUDGET);
  });

  test('partial overlays only the supplied fields', () => {
    const out = effectiveBudget({ maxSteps: 10 });
    expect(out.maxSteps).toBe(10);
    expect(out.maxCostUsd).toBe(DEFAULT_BUDGET.maxCostUsd);
    expect(out.maxConcurrentToolCalls).toBe(DEFAULT_BUDGET.maxConcurrentToolCalls);
  });

  test('explicit maxCostUsd undefined survives the merge (operator opt-out)', () => {
    // `/budget cost off` writes `maxCostUsd: undefined`. The
    // helper must propagate that undefined instead of restoring
    // the 5 USD default — otherwise the operator's deliberate
    // opt-out gets silently overridden.
    const out = effectiveBudget({ maxCostUsd: undefined });
    expect(out.maxCostUsd).toBeUndefined();
  });

  test('returns a fresh object (callers can mutate without aliasing DEFAULT_BUDGET)', () => {
    // DEFAULT_BUDGET is exported as a module-level constant; if
    // effectiveBudget returned it directly, a caller mutating the
    // result would corrupt the default for every subsequent call.
    // Spread guarantees a fresh top-level object.
    const a = effectiveBudget();
    const b = effectiveBudget();
    expect(a).not.toBe(b);
    expect(a).not.toBe(DEFAULT_BUDGET);
  });
});
