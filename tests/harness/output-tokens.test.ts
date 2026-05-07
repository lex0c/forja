import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_BUDGET,
  LOAD_TIME_OUTPUT_TOKENS_FLOOR,
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

  test('LOAD_TIME_OUTPUT_TOKENS_FLOOR is the conservative loader-side bound', () => {
    // The floor is intentionally smaller than typical runtime caps
    // — load.ts uses it for thinking_budget cross-checks where the
    // runtime model is not in scope. Pin the value so a future
    // bump goes through PR review (the floor controls a public
    // error message and a cross-field validation gate).
    expect(LOAD_TIME_OUTPUT_TOKENS_FLOOR).toBe(4096);
  });
});
