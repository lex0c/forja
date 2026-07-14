import { describe, expect, test } from 'bun:test';
import {
  type RunMaybeCompactArgs,
  runMaybeCompact,
} from '../../src/harness/compaction-controller.ts';
import type { SessionContext } from '../../src/harness/session-context.ts';
import { effectiveBudget, type HarnessConfig, type RunBudget } from '../../src/harness/types.ts';
import type { WorkingStateStore } from '../../src/working-state/index.ts';

// The four early-return guards fire before any context assembly / hook / provider
// call, so a minimal cast-based args object is enough to pin them. The trigger /
// relevance / billed-fold paths are covered by the compaction + loop + relevance
// integration suites (they drive the real runAgent + SessionContext).
const baseArgs = (over: Partial<RunMaybeCompactArgs> = {}): RunMaybeCompactArgs => ({
  force: false,
  ctx: { getMessages: () => [], length: 0 } as unknown as SessionContext,
  signal: new AbortController().signal,
  steps: 0,
  budget: { maxSteps: 100 } as unknown as RunBudget,
  config: {
    provider: { capabilities: { context_window: 200_000 } },
  } as unknown as HarnessConfig,
  tools: [],
  workingStateStore: {} as unknown as WorkingStateStore,
  sessionId: 's',
  proactiveRecalled: [],
  dispatchHooks: async () => null,
  recordUsage: () => {},
  emitCostUpdate: () => {},
  costCapDetail: () => null,
  ...over,
});

describe('runMaybeCompact early-return guards', () => {
  test('returns null (no compaction) when ctx is undefined', async () => {
    let hookCalled = false;
    const r = await runMaybeCompact(
      baseArgs({
        ctx: undefined,
        dispatchHooks: async () => {
          hookCalled = true;
          return null;
        },
      }),
    );
    expect(r).toBeNull();
    expect(hookCalled).toBe(false);
  });

  test('returns null when the run signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    let hookCalled = false;
    const r = await runMaybeCompact(
      baseArgs({
        signal: ac.signal,
        dispatchHooks: async () => {
          hookCalled = true;
          return null;
        },
      }),
    );
    expect(r).toBeNull();
    expect(hookCalled).toBe(false);
  });

  test('returns null at steps >= maxSteps when not forced (loop is exiting)', async () => {
    let hookCalled = false;
    const r = await runMaybeCompact(
      baseArgs({
        steps: 100,
        budget: { maxSteps: 100 } as unknown as RunBudget,
        dispatchHooks: async () => {
          hookCalled = true;
          return null;
        },
      }),
    );
    expect(r).toBeNull();
    expect(hookCalled).toBe(false);
  });

  test('returns null when the context window is unknown (<= 0)', async () => {
    let hookCalled = false;
    const r = await runMaybeCompact(
      baseArgs({
        config: {
          provider: { capabilities: { context_window: 0 } },
        } as unknown as HarnessConfig,
        dispatchHooks: async () => {
          hookCalled = true;
          return null;
        },
      }),
    );
    expect(r).toBeNull();
    expect(hookCalled).toBe(false);
  });

  test('returns null without firing the PreCompact hook or a compaction_started emit when under the trigger', async () => {
    // The tail guard passes (length >= preserveTail + 3) but the estimated
    // prompt sits far under triggerAt, so the gate must bail BEFORE the
    // PreCompact hook or any compaction_started emit — the common per-iteration
    // path. `force: true` skips the context-injection shaping so the trigger
    // comparison is exercised in isolation (it is force-independent).
    let hookCalled = false;
    const emitted: string[] = [];
    const r = await runMaybeCompact(
      baseArgs({
        force: true,
        ctx: {
          getMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          length: 100,
        } as unknown as SessionContext,
        budget: effectiveBudget(),
        config: {
          provider: {
            capabilities: { context_window: 200_000, output_max_tokens: 4096 },
            replaysReasoning: false,
          },
          enableStaticGuidance: false,
          onEvent: (e: { type: string }) => emitted.push(e.type),
        } as unknown as HarnessConfig,
        dispatchHooks: async () => {
          hookCalled = true;
          return null;
        },
      }),
    );
    expect(r).toBeNull();
    expect(hookCalled).toBe(false);
    expect(emitted).not.toContain('compaction_started');
  });
});
