import { beforeEach, describe, expect, test } from 'bun:test';
import { CostAccountant, type CostAccountantDeps } from '../../src/harness/cost-accountant.ts';
import type { HarnessEvent } from '../../src/harness/types.ts';
import type { UsageInfo } from '../../src/providers/types.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { createSession, getSession } from '../../src/storage/index.ts';
import { migrate } from '../../src/storage/migrate.ts';

const usage = (input: number, output = 0, cacheRead = 0, cacheCreation = 0): UsageInfo => ({
  input,
  output,
  cache_read: cacheRead,
  cache_creation: cacheCreation,
});

let db: DB;
let sessionId: string;
let events: HarnessEvent[];

const make = (overrides: Partial<CostAccountantDeps> = {}): CostAccountant =>
  new CostAccountant({
    db,
    onEvent: (e) => events.push(e),
    getSessionId: () => sessionId,
    maxCostUsd: undefined,
    softCostUsd: undefined,
    getReservedChildCostUsd: () => 0,
    ...overrides,
  });

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  events = [];
});

describe('CostAccountant.recordUsage', () => {
  test('accumulates usage and cost across turns', () => {
    const acct = make();
    acct.recordUsage(usage(10, 5), 0.01, true);
    acct.recordUsage(usage(20, 7, 3), 0.02, true);
    expect(acct.runUsage).toEqual(usage(30, 12, 3));
    expect(acct.runCostUsd).toBeCloseTo(0.03, 10);
    expect(acct.runUsageComplete).toBe(true);
  });

  test('usageSeen=false marks the aggregate incomplete and never un-sets it', () => {
    const acct = make();
    acct.recordUsage(usage(10), 0.01, false);
    expect(acct.runUsageComplete).toBe(false);
    // A later measured turn must NOT flip completeness back to true.
    acct.recordUsage(usage(10), 0.01, true);
    expect(acct.runUsageComplete).toBe(false);
  });

  test('markUsageIncomplete flips the flag without charging cost', () => {
    const acct = make();
    acct.markUsageIncomplete();
    expect(acct.runUsageComplete).toBe(false);
    expect(acct.runCostUsd).toBe(0);
    expect(acct.runUsage).toEqual(usage(0));
  });
});

describe('CostAccountant child + prior cost', () => {
  test('addChildCost accumulates and ignores non-finite deltas', () => {
    const acct = make();
    acct.addChildCost(0.5);
    acct.addChildCost(Number.NaN);
    acct.addChildCost(Number.POSITIVE_INFINITY);
    acct.addChildCost(0.25);
    expect(acct.cumulativeChildCostUsd).toBeCloseTo(0.75, 10);
  });

  test('seedFromResume + setRehydratedChildCost feed cumulativeSpend', () => {
    const acct = make();
    acct.seedFromResume(1.0, false);
    acct.setRehydratedChildCost(0.5);
    acct.recordUsage(usage(1), 0.1, true);
    acct.addChildCost(0.2);
    expect(acct.priorCostUsd).toBe(1.0);
    expect(acct.priorUsageComplete).toBe(false);
    // prior 1.0 + run 0.1 + thisRunChild 0.2 + rehydratedChild 0.5 + reserved 0.3
    expect(acct.cumulativeSpend(0.3)).toBeCloseTo(2.1, 10);
  });
});

describe('CostAccountant.costCapDetail', () => {
  test('uncapped run never trips', () => {
    const acct = make({ maxCostUsd: undefined });
    acct.recordUsage(usage(1), 1000, true);
    expect(acct.costCapDetail()).toBeNull();
  });

  test('null while at/under cap, detail once over (strict >)', () => {
    const acct = make({ maxCostUsd: 1.0 });
    acct.recordUsage(usage(1), 1.0, true);
    expect(acct.costCapDetail()).toBeNull(); // exactly at cap: <= passes
    acct.recordUsage(usage(1), 0.0001, true);
    expect(acct.costCapDetail()).toContain('exceeded cap');
  });

  test('maxCostUsd: 0 trips only once a positive charge lands', () => {
    const acct = make({ maxCostUsd: 0 });
    expect(acct.costCapDetail()).toBeNull(); // zero spend, zero cap: 0 <= 0
    acct.recordUsage(usage(1), 0.000001, true);
    expect(acct.costCapDetail()).toContain('exceeded cap');
  });

  test('reserved in-flight child cost counts against the cap', () => {
    const acct = make({ maxCostUsd: 1.0, getReservedChildCostUsd: () => 1.5 });
    expect(acct.costCapDetail()).toContain('exceeded cap');
  });

  test('counts ALL reservations — calls getReservedChildCostUsd with no exclude', () => {
    // The turn-end cap gate must not exclude any in-flight handle (the
    // exclude arg is only for the pre-spawn gate). Pin that costCapDetail
    // passes `undefined`, so a regression that leaked a handle id — thereby
    // undercounting reserved spend below the cap — is caught.
    let called = false;
    let seenExclude: string | undefined;
    const acct = make({
      maxCostUsd: 10,
      getReservedChildCostUsd: (excludeHandleId) => {
        called = true;
        seenExclude = excludeHandleId;
        return 0;
      },
    });
    acct.costCapDetail();
    expect(called).toBe(true);
    expect(seenExclude).toBeUndefined();
  });
});

describe('CostAccountant.emitCostUpdate', () => {
  test('persists prior+run rollup and emits cost_update', () => {
    const acct = make();
    acct.seedFromResume(0.1, true);
    acct.recordUsage(usage(1), 0.4, true);
    acct.emitCostUpdate(0.4);
    // Persisted lifetime rollup = prior + run.
    expect(getSession(db, sessionId)?.totalCostUsd).toBeCloseTo(0.5, 10);
    const ev = events.find((e) => e.type === 'cost_update');
    expect(ev).toEqual({ type: 'cost_update', delta: 0.4, cumulative: 0.4 });
  });

  test('skips non-positive and non-finite deltas — no event, no persist', () => {
    const acct = make();
    acct.emitCostUpdate(0);
    acct.emitCostUpdate(-1);
    acct.emitCostUpdate(Number.NaN);
    expect(events).toHaveLength(0);
    expect(getSession(db, sessionId)?.totalCostUsd).toBe(0);
  });

  test('soft cap warn fires exactly once when run cost first crosses the threshold', () => {
    const acct = make({ softCostUsd: 0.5 });
    acct.recordUsage(usage(1), 0.6, true);
    acct.emitCostUpdate(0.6);
    acct.recordUsage(usage(1), 0.6, true);
    acct.emitCostUpdate(0.6); // still over, must NOT re-warn
    const warns = events.filter((e) => e.type === 'cost_soft_cap_warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toEqual({ type: 'cost_soft_cap_warn', threshold: 0.5, cumulative: 0.6 });
  });

  test('no soft warn when threshold is unset or zero', () => {
    const a = make({ softCostUsd: undefined });
    a.recordUsage(usage(1), 5, true);
    a.emitCostUpdate(5);
    const b = make({ softCostUsd: 0 });
    b.recordUsage(usage(1), 5, true);
    b.emitCostUpdate(5);
    expect(events.filter((e) => e.type === 'cost_soft_cap_warn')).toHaveLength(0);
  });

  test('persist is skipped (no throw) when the session id is empty', () => {
    sessionId = '';
    const acct = make();
    acct.recordUsage(usage(1), 0.2, true);
    expect(() => acct.emitCostUpdate(0.2)).not.toThrow();
    expect(events.find((e) => e.type === 'cost_update')).toBeDefined();
  });

  test('a DB failure during persist does not derail the billed step (best-effort)', () => {
    const acct = make();
    acct.recordUsage(usage(1), 0.2, true);
    // Force updateSessionCost to throw: a closed db rejects the query. The
    // persist is best-effort (finish() re-writes the canonical figure), so
    // emitCostUpdate must swallow it and still fire the billing signal.
    db.close();
    expect(() => acct.emitCostUpdate(0.2)).not.toThrow();
    expect(events.find((e) => e.type === 'cost_update')).toBeDefined();
  });
});
