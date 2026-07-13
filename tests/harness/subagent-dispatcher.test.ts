import { describe, expect, test } from 'bun:test';
import type { CostAccountant } from '../../src/harness/cost-accountant.ts';
import {
  dispatchSubagent,
  type SubagentDispatchDeps,
} from '../../src/harness/subagent-dispatcher.ts';
import type { HarnessConfig, RunBudget } from '../../src/harness/types.ts';
import { MAX_SUBAGENT_DEPTH } from '../../src/subagents/runtime.ts';
import type { SpawnSubagentArgs } from '../../src/tools/types.ts';

// The refusal gates (unknown / depth / budget) return a structured envelope
// BEFORE runSubagent, so a cast-based deps object is enough to pin them. The
// spawn / capability-intersection / watchdog / reconciliation paths drive real
// child processes and are covered by the subagents integration suite.
const baseDeps = (over: Partial<SubagentDispatchDeps> = {}): SubagentDispatchDeps => ({
  config: {
    subagentRegistry: { byName: new Map() },
    subagentDepth: 0,
    provider: { id: 'p/m' },
    modelRegistry: undefined,
  } as unknown as HarnessConfig,
  budget: {} as unknown as RunBudget,
  acct: {
    cumulativeSpend: () => 0,
    addChildCost: () => {},
  } as unknown as CostAccountant,
  signal: new AbortController().signal,
  sessionId: 's',
  getHandleStore: () => undefined,
  capWatchdog: { fired: false },
  ...over,
});

const spawn = (name: string): SpawnSubagentArgs => ({ name }) as unknown as SpawnSubagentArgs;

describe('dispatchSubagent refusal gates', () => {
  test('unknown name → unknown_subagent with the sorted available list', async () => {
    const r = await dispatchSubagent(spawn('missing'), undefined, undefined, {
      ...baseDeps(),
      config: {
        subagentRegistry: {
          byName: new Map([
            ['beta', {}],
            ['alpha', {}],
          ]),
        },
      } as unknown as HarnessConfig,
    });
    expect(r.kind).toBe('unknown_subagent');
    if (r.kind === 'unknown_subagent') expect(r.available).toEqual(['alpha', 'beta']);
  });

  test('depth beyond MAX_SUBAGENT_DEPTH → depth_exceeded (before any spawn)', async () => {
    const def = { budget: {}, tools: [] };
    const r = await dispatchSubagent(spawn('w'), undefined, undefined, {
      ...baseDeps(),
      config: {
        subagentRegistry: { byName: new Map([['w', def]]) },
        subagentDepth: MAX_SUBAGENT_DEPTH,
        provider: { id: 'p/m' },
      } as unknown as HarnessConfig,
    });
    expect(r.kind).toBe('depth_exceeded');
    if (r.kind === 'depth_exceeded') {
      expect(r.depth).toBe(MAX_SUBAGENT_DEPTH + 1);
      expect(r.maxDepth).toBe(MAX_SUBAGENT_DEPTH);
    }
  });

  test('projected cost over the cap → budget_exhausted (before any spawn)', async () => {
    const def = { budget: { maxCostUsd: 0.5 }, tools: [] }; // model undefined
    const r = await dispatchSubagent(spawn('w'), undefined, undefined, {
      ...baseDeps(),
      config: {
        subagentRegistry: { byName: new Map([['w', def]]) },
        subagentDepth: 0,
        provider: { id: 'p/m' },
        modelRegistry: undefined,
      } as unknown as HarnessConfig,
      budget: { maxCostUsd: 1 } as unknown as RunBudget,
      acct: {
        // parent already spent well past the cap
        cumulativeSpend: () => 1000,
        addChildCost: () => {},
      } as unknown as CostAccountant,
    });
    expect(r.kind).toBe('budget_exhausted');
    if (r.kind === 'budget_exhausted') {
      expect(r.projected).toBeCloseTo(1000.5, 10);
      expect(r.cap).toBe(1);
      expect(r.estimate).toBe(0.5);
    }
  });

  test('declared capability the parent lacks → subagent_escalation (§10.1 security gate)', async () => {
    // The child declares a capability the parent does not hold — the
    // intersection must refuse the spawn rather than let it escalate across the
    // boundary. maxCostUsd is unset so the cost gate is skipped and the
    // capability gate is reached; the spawn is refused before any child starts.
    const def = { budget: {}, tools: [] }; // model undefined
    const r = await dispatchSubagent(
      {
        name: 'w',
        parentCapabilities: ['read-fs:.'],
        declaredCapabilities: ['exec:arbitrary'],
      } as unknown as SpawnSubagentArgs,
      undefined,
      undefined,
      {
        ...baseDeps(),
        config: {
          subagentRegistry: { byName: new Map([['w', def]]) },
          subagentDepth: 0,
          provider: { id: 'p/m' },
          modelRegistry: undefined,
          // Root engine (no narrowed envelope) → caller-supplied parentCaps win.
          permissionEngine: { effectiveCapabilities: () => null, policy: () => ({}) },
        } as unknown as HarnessConfig,
        budget: {} as unknown as RunBudget, // maxCostUsd undefined → cost gate skipped
      },
    );
    expect(r.kind).toBe('subagent_escalation');
    if (r.kind === 'subagent_escalation') expect(r.excess).toEqual(['exec:arbitrary']);
  });

  test('def.model with no model catalog → playbook_model_unavailable (before spawn)', async () => {
    const def = { model: 'x/y', budget: {}, tools: [] };
    const r = await dispatchSubagent(spawn('w'), undefined, undefined, {
      ...baseDeps(),
      config: {
        subagentRegistry: { byName: new Map([['w', def]]) },
        subagentDepth: 0,
        provider: { id: 'p/m' },
        modelRegistry: undefined,
      } as unknown as HarnessConfig,
    });
    expect(r.kind).toBe('playbook_model_unavailable');
    if (r.kind === 'playbook_model_unavailable') {
      expect(r.model).toBe('x/y');
      expect(r.reason).toContain('no model catalog');
    }
  });
});
