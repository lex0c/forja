import { describe, expect, test } from 'bun:test';
import { DEFAULT_BUDGET } from '../../src/harness/types.ts';

// AGENTIC_CLI.md §5 declares cost as the engagement gate and step
// count as the runaway-loop backstop. The defaults pinned here
// encode that posture. Bumping them is a public contract change
// that should land with a BACKLOG entry and (when applicable) a
// spec PR — these assertions make the change explicit instead of
// surfacing as a soft regression in cost or session length.

describe('DEFAULT_BUDGET (slice C — cost-primary posture)', () => {
  test('maxCostUsd is 100 USD', () => {
    expect(DEFAULT_BUDGET.maxCostUsd).toBe(100);
  });

  test('maxSteps is the 200 backstop, not the old 50 engagement gate', () => {
    // Lifted from 50 → 200 when cost became the engagement gate.
    // 50 was tight enough to abort legitimate multi-file refactors
    // mid-flight; 200 leaves headroom while still bounding genuine
    // loop pathology (which the degenerate-loop hash tracker
    // catches much earlier anyway).
    expect(DEFAULT_BUDGET.maxSteps).toBe(200);
  });

  test('the cost cap merges through into a partial override', () => {
    // The cost cap must survive `{ ...DEFAULT_BUDGET, ...partial }`
    // — runtime config layering relies on it. A consumer that
    // overrides only `maxSteps` keeps the default cost cap in
    // force. Pinning here so a future refactor that splits the
    // budget across multiple objects doesn't silently drop the
    // default.
    const merged = { ...DEFAULT_BUDGET, maxSteps: 10 };
    expect(merged.maxCostUsd).toBe(100);
    expect(merged.maxSteps).toBe(10);
  });

  test('explicit `maxCostUsd: undefined` overrides the default through the merge', () => {
    // Operator opt-out path (`/budget cost off`). The spread merge
    // must propagate the explicit undefined so the loop's
    // `=== undefined` check skips the gate. If this regresses, an
    // operator who clears the cap silently still gets billed
    // against the default cap.
    const merged = { ...DEFAULT_BUDGET, maxCostUsd: undefined };
    expect(merged.maxCostUsd).toBeUndefined();
  });

  test('other backstops survive the cost-primary repositioning', () => {
    // Cost being the primary gate doesn't disable the runaway
    // safeguards — wall clock, tool errors, and the degenerate
    // loop hash window still defend against pathological runs.
    expect(DEFAULT_BUDGET.maxWallClockMs).toBe(60 * 60 * 1000);
    expect(DEFAULT_BUDGET.maxToolErrors).toBe(5);
    expect(DEFAULT_BUDGET.maxRepeatedToolHash).toBe(3);
  });
});
