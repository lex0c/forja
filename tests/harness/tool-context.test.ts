import { describe, expect, test } from 'bun:test';
import type { CollectedToolUse } from '../../src/harness/collect.ts';
import type { CostAccountant } from '../../src/harness/cost-accountant.ts';
import { type BuildToolContextDeps, buildToolContext } from '../../src/harness/tool-context.ts';
import type { HarnessConfig, HarnessEvent, RunBudget } from '../../src/harness/types.ts';
import type { MemoryRegistry } from '../../src/memory/registry.ts';
import type { ContextPinsStore } from '../../src/storage/repos/context-pins.ts';
import type { SubagentHandleStore } from '../../src/subagents/handle-store.ts';
import type { TodoStore } from '../../src/todo/index.ts';
import type { SearchToolsResult, SpawnSubagentResult } from '../../src/tools/types.ts';
import type { WorkingStateStore } from '../../src/working-state/index.ts';

// buildToolContext is a pure (tu, deps) -> ToolContext assembly. A cast-based
// deps object exercises the field wiring + the conditional surfaces; the full
// tool-execution path is covered by the harness / tools integration suites.
const cfg = (over: Record<string, unknown> = {}): HarnessConfig =>
  ({
    cwd: '/p',
    permissionEngine: { view: () => ({}), check: () => ({}) },
    subagentDepth: 0,
    subagentRegistry: undefined,
    isCwdTrusted: false,
    onEvent: undefined,
    memoryRegistry: undefined,
    ...over,
  }) as unknown as HarnessConfig;

const baseDeps = (over: Partial<BuildToolContextDeps> = {}): BuildToolContextDeps => ({
  signal: new AbortController().signal,
  config: cfg(),
  sessionId: 's',
  assistantMsgId: 'msg-1',
  searchTools: () => ({}) as unknown as SearchToolsResult,
  todoStore: {} as unknown as TodoStore,
  workingStateStore: { currentStep: () => 5 } as unknown as WorkingStateStore,
  bgManager: undefined,
  spawnSubagentClosure: undefined,
  subagentHandleStore: undefined,
  acct: {} as unknown as CostAccountant,
  budget: {} as unknown as RunBudget,
  effectiveMemoryRegistry: undefined,
  contextPinsStore: {} as unknown as ContextPinsStore,
  dispatchHooks: async () => null,
  ...over,
});

const tu = { id: 'tu-1', name: 'read_file', input: {} } as unknown as CollectedToolUse;

describe('buildToolContext', () => {
  test('wires cwd / sessionId / stepId / depth and fail-closed trust default', () => {
    const ctx = buildToolContext(tu, baseDeps({ config: cfg({ isCwdTrusted: undefined }) }));
    expect(ctx.cwd).toBe('/p');
    expect(ctx.sessionId).toBe('s');
    expect(ctx.stepId).toBe('msg-1');
    expect(ctx.subagentDepth).toBe(0);
    expect(ctx.isCwdTrusted).toBe(false); // `config.isCwdTrusted ?? false`
  });

  test('emitWarn emits tool_warning attributed to the current tool use', () => {
    const events: HarnessEvent[] = [];
    const ctx = buildToolContext(
      tu,
      baseDeps({ config: cfg({ onEvent: (e: HarnessEvent) => events.push(e) }) }),
    );
    ctx.emitWarn?.('careful');
    expect(events).toContainEqual({
      type: 'tool_warning',
      toolUseId: 'tu-1',
      toolName: 'read_file',
      message: 'careful',
    });
  });

  test('searchTools is revealed at the top level and hidden inside a subagent', () => {
    expect(buildToolContext(tu, baseDeps()).searchTools).toBeDefined();
    const child = buildToolContext(tu, baseDeps({ config: cfg({ subagentDepth: 1 }) }));
    expect(child.searchTools).toBeUndefined();
  });

  test('subagent surfaces appear only when the closure / store are wired', () => {
    const without = buildToolContext(tu, baseDeps());
    expect(without.spawnSubagent).toBeUndefined();
    expect(without.subagentHandleStore).toBeUndefined();

    const spawn = async () => ({}) as unknown as SpawnSubagentResult;
    const store = {} as unknown as SubagentHandleStore;
    const withSub = buildToolContext(
      tu,
      baseDeps({ spawnSubagentClosure: spawn, subagentHandleStore: store }),
    );
    expect(withSub.spawnSubagent).toBe(spawn);
    expect(withSub.subagentHandleStore).toBe(store);
  });

  test('getKnownSubagentNames returns the registry names sorted', () => {
    const ctx = buildToolContext(
      tu,
      baseDeps({
        config: cfg({
          subagentRegistry: {
            byName: new Map([
              ['beta', {}],
              ['alpha', {}],
            ]),
          },
        }),
      }),
    );
    expect(ctx.getKnownSubagentNames?.()).toEqual(['alpha', 'beta']);
  });

  test('getCostBudget reads acct.cumulativeSpend(reserved) and budget.maxCostUsd', () => {
    const ctx = buildToolContext(
      tu,
      baseDeps({
        acct: { cumulativeSpend: (r: number) => r + 10 } as unknown as CostAccountant,
        budget: { maxCostUsd: 5 } as unknown as RunBudget,
        subagentHandleStore: {
          getReservedChildCostUsd: () => 2,
        } as unknown as SubagentHandleStore,
      }),
    );
    expect(ctx.getCostBudget?.()).toEqual({ spent: 12, cap: 5 });
  });

  test('getCostBudget falls back to reserved=0 when no handle store is wired', () => {
    const ctx = buildToolContext(
      tu,
      baseDeps({
        acct: { cumulativeSpend: (r: number) => r + 1 } as unknown as CostAccountant,
        budget: { maxCostUsd: 9 } as unknown as RunBudget,
        subagentHandleStore: undefined,
      }),
    );
    expect(ctx.getCostBudget?.()).toEqual({ spent: 1, cap: 9 });
  });

  test('memoryRegistry + retrieveContext toggle together on effectiveMemoryRegistry (trust parity)', () => {
    const off = buildToolContext(tu, baseDeps({ effectiveMemoryRegistry: undefined }));
    expect(off.memoryRegistry).toBeUndefined();
    expect(off.retrieveContext).toBeUndefined();

    const registry = {} as unknown as MemoryRegistry;
    const on = buildToolContext(
      tu,
      baseDeps({ effectiveMemoryRegistry: registry, config: cfg({ db: {} }) }),
    );
    expect(on.memoryRegistry).toBe(registry);
    expect(on.retrieveContext).toBeDefined();
  });

  test('getSubagentBudgetEstimate: null when unknown, finite-positive cost otherwise (never coalesced)', () => {
    const ctx = buildToolContext(
      tu,
      baseDeps({
        config: cfg({
          subagentRegistry: {
            byName: new Map<string, unknown>([
              ['ok', { budget: { maxCostUsd: 0.5 } }],
              ['zero', { budget: { maxCostUsd: 0 } }],
              ['bad', { budget: { maxCostUsd: Number.POSITIVE_INFINITY } }],
            ]),
          },
        }),
      }),
    );
    expect(ctx.getSubagentBudgetEstimate?.('missing')).toBeNull(); // unregistered ≠ 0
    expect(ctx.getSubagentBudgetEstimate?.('ok')).toBe(0.5);
    expect(ctx.getSubagentBudgetEstimate?.('zero')).toBe(0); // registered zero-cost
    expect(ctx.getSubagentBudgetEstimate?.('bad')).toBe(0); // non-finite clamps to 0
  });
});
