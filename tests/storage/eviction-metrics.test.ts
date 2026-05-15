// Eviction metrics aggregator tests (EVICTION §11).
//
// Each test sets up a fixture set of eviction_events rows via the
// repo's appendEvictionEvent (so validation + scrub run as in
// production), then queries the metric and asserts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { appendEvictionEvent } from '../../src/storage/repos/eviction-events.ts';
import {
  evictionMetricsSnapshot,
  hookEvictionBlocks,
  protectionBlocks,
  purgeIrreversibleCount,
  quarantineStats,
  rateByMotivo,
  restoreRate,
} from '../../src/storage/repos/eviction-metrics.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;
let sessionId: string;

// Stable evidence shapes per motivo so appendEvictionEvent's
// §6.1 validation passes.
const EV = {
  conflict: JSON.stringify({ failures: 3 }),
  low_roi: JSON.stringify({ tokens_consumed: 0, load_bearing_count: 0, ratio: 0 }),
  irrelevant: JSON.stringify({ usage_count: 0, sample_size: 20 }),
  user_purge: JSON.stringify({ _operator_driven: true }),
  expired: JSON.stringify({ expires: '2024-01-01' }),
  security: JSON.stringify({ trigger_source: 'hook' }),
} as const;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
});

afterEach(() => {
  db.close();
});

// Helper: insert a chain of events for one memory.
const insertEvent = (
  fromState: 'proposed' | 'active' | 'quarantined' | 'invalidated' | 'evicted' | 'shadow',
  toState: 'proposed' | 'active' | 'quarantined' | 'invalidated' | 'evicted' | 'purged' | 'shadow',
  motivo: keyof typeof EV,
  recordedAt: number,
  opts: {
    objectId?: string;
    actor?: 'user' | 'loop_cold' | 'compaction' | 'startup_probe' | 'hook';
    trigger?: string;
    outcome?: 'applied' | 'blocked_by_hook' | 'blocked_by_protection';
    blockedBy?: string | null;
    purgeAt?: number;
  } = {},
) => {
  appendEvictionEvent(db, {
    substrate: 'memory',
    objectId: opts.objectId ?? 'mem-1',
    objectScope: 'project_local',
    fromState,
    toState,
    trigger: opts.trigger ?? 'verify_failed',
    motivo,
    evidenceJson: EV[motivo],
    outcome: opts.outcome ?? 'applied',
    actor: opts.actor ?? 'loop_cold',
    blockedBy: opts.blockedBy ?? null,
    sessionId,
    recordedAt,
    ...(opts.purgeAt !== undefined ? { purgeAt: opts.purgeAt } : {}),
  });
};

describe('rateByMotivo', () => {
  test('groups applied evictions by motivo within window', () => {
    insertEvent('active', 'quarantined', 'low_roi', 1_000);
    insertEvent('active', 'quarantined', 'low_roi', 2_000, { objectId: 'mem-2' });
    insertEvent('active', 'quarantined', 'conflict', 3_000, { objectId: 'mem-3' });
    const result = rateByMotivo(db, 10_000, 10_000);
    expect(result).toHaveLength(2);
    expect(result[0]?.motivo).toBe('low_roi');
    expect(result[0]?.count).toBe(2);
    expect(result[1]?.motivo).toBe('conflict');
    expect(result[1]?.count).toBe(1);
  });

  test('respects window — events outside are excluded', () => {
    insertEvent('active', 'quarantined', 'low_roi', 1_000);
    insertEvent('active', 'quarantined', 'low_roi', 100_000, { objectId: 'mem-2' });
    // Window 10ms ending at 100_000 — only the second event lands.
    const result = rateByMotivo(db, 100_000, 10);
    expect(result).toHaveLength(1);
    expect(result[0]?.count).toBe(1);
  });

  test('excludes non-applied outcomes', () => {
    insertEvent('active', 'quarantined', 'low_roi', 1_000, {
      outcome: 'blocked_by_hook',
      blockedBy: 'spec:foo#0',
    });
    expect(rateByMotivo(db, 10_000, 10_000)).toEqual([]);
  });
});

describe('restoreRate', () => {
  test('counts evictions and restores, computes ratio', () => {
    // 4 evictions, 1 restore.
    for (let i = 0; i < 4; i++) {
      insertEvent('quarantined', 'evicted', 'low_roi', 1_000 + i, {
        objectId: `mem-${i}`,
        purgeAt: 1_000 + i + 30 * 86_400_000,
      });
    }
    insertEvent('evicted', 'active', 'irrelevant', 5_000, { objectId: 'mem-0' });
    const result = restoreRate(db, 10_000, 10_000);
    expect(result.evictedCount).toBe(4);
    expect(result.restoredCount).toBe(1);
    expect(result.ratio).toBeCloseTo(0.25, 5);
  });

  test('ratio is 0 when no evictions in window', () => {
    const result = restoreRate(db, 10_000, 10_000);
    expect(result).toEqual({ evictedCount: 0, restoredCount: 0, ratio: 0 });
  });
});

describe('purgeIrreversibleCount', () => {
  test('counts *→purged that bypass evicted', () => {
    // 2 bypasses with user_purge motivo.
    insertEvent('active', 'purged', 'user_purge', 1_000);
    insertEvent('quarantined', 'purged', 'user_purge', 2_000, { objectId: 'mem-2' });
    // 1 normal evicted→purged (not a bypass).
    insertEvent('evicted', 'purged', 'expired', 3_000, { objectId: 'mem-3' });

    const result = purgeIrreversibleCount(db, 10_000, 10_000);
    expect(result.totalCount).toBe(2);
    expect(result.breakdown).toContainEqual({ motivo: 'user_purge', count: 2 });
  });
});

describe('quarantineStats', () => {
  test('computes avg dwell + escape rate excluding same-chain pairs', () => {
    // Memory A: quarantined @ 1000 by loop_cold/verify_failed
    //   → escaped to active @ 5000 by user/manual (different chain)
    // Memory B: quarantined @ 2000 by loop_cold/verify_failed
    //   → evicted @ 9000 by compaction/token_pressure (different chain)
    // Memory C: quarantined @ 100 by startup_probe/expired_at
    //   → evicted @ 200 by startup_probe/expired_at (SAME chain — ignored)
    insertEvent('active', 'quarantined', 'conflict', 1_000, { objectId: 'mem-A' });
    insertEvent('quarantined', 'active', 'irrelevant', 5_000, {
      objectId: 'mem-A',
      actor: 'user',
      trigger: 'manual',
    });
    insertEvent('active', 'quarantined', 'conflict', 2_000, { objectId: 'mem-B' });
    insertEvent('quarantined', 'evicted', 'low_roi', 9_000, {
      objectId: 'mem-B',
      actor: 'compaction',
      trigger: 'token_pressure',
      purgeAt: 100_000,
    });
    insertEvent('active', 'quarantined', 'low_roi', 100, {
      objectId: 'mem-C',
      actor: 'startup_probe',
      trigger: 'expired_at',
    });
    insertEvent('quarantined', 'evicted', 'low_roi', 200, {
      objectId: 'mem-C',
      actor: 'startup_probe',
      trigger: 'expired_at',
      purgeAt: 100_000,
    });

    const result = quarantineStats(db, 100_000, 100_000);
    // A (dwell 4000) + B (dwell 7000) = 2 exits, avg = 5500
    // C is same-chain → excluded
    expect(result.exitedCount).toBe(2);
    expect(result.escapedToActiveCount).toBe(1); // A escaped to active
    expect(result.avgDwellMs).toBe(5_500);
    expect(result.escapeRate).toBe(0.5);
  });

  test('null avgDwell + 0 stats when no exits in window', () => {
    insertEvent('active', 'quarantined', 'conflict', 1_000);
    const result = quarantineStats(db, 10_000, 10_000);
    expect(result).toEqual({
      exitedCount: 0,
      escapedToActiveCount: 0,
      avgDwellMs: null,
      escapeRate: 0,
    });
  });
});

describe('protectionBlocks', () => {
  test('counts blocked_by_protection rows by protection name', () => {
    insertEvent('active', 'active', 'low_roi', 1_000, {
      outcome: 'blocked_by_protection',
      blockedBy: 'user_explicit_cooldown',
    });
    insertEvent('active', 'active', 'low_roi', 2_000, {
      objectId: 'mem-2',
      outcome: 'blocked_by_protection',
      blockedBy: 'user_explicit_cooldown',
    });
    insertEvent('quarantined', 'quarantined', 'low_roi', 3_000, {
      objectId: 'mem-3',
      outcome: 'blocked_by_protection',
      blockedBy: 'quarantine_min_ttl',
    });

    const result = protectionBlocks(db, 10_000, 10_000);
    expect(result.totalCount).toBe(3);
    expect(result.byProtection).toContainEqual({ protection: 'user_explicit_cooldown', count: 2 });
    expect(result.byProtection).toContainEqual({ protection: 'quarantine_min_ttl', count: 1 });
  });
});

describe('hookEvictionBlocks', () => {
  test('counts blocked_by_hook rows by hook spec ref', () => {
    insertEvent('active', 'active', 'conflict', 1_000, {
      outcome: 'blocked_by_hook',
      blockedBy: 'enterprise:/etc/hooks.toml#0',
    });
    insertEvent('active', 'active', 'conflict', 2_000, {
      objectId: 'mem-2',
      outcome: 'blocked_by_hook',
      blockedBy: 'enterprise:/etc/hooks.toml#0',
    });
    const result = hookEvictionBlocks(db, 10_000, 10_000);
    expect(result.totalCount).toBe(2);
    expect(result.byHook[0]?.blockedBy).toBe('enterprise:/etc/hooks.toml#0');
    expect(result.byHook[0]?.count).toBe(2);
  });
});

describe('evictionMetricsSnapshot', () => {
  test('combines every metric in one call', () => {
    // Distinct (actor, trigger) on quarantine vs evict so the
    // same-chain bypass doesn't filter the dwell pair out.
    insertEvent('active', 'quarantined', 'low_roi', 1_000, {
      actor: 'loop_cold',
      trigger: 'roi_below_threshold',
    });
    insertEvent('quarantined', 'evicted', 'low_roi', 2_000, {
      actor: 'compaction',
      trigger: 'token_pressure',
      purgeAt: 1_000_000,
    });
    insertEvent('evicted', 'active', 'irrelevant', 3_000);
    const snap = evictionMetricsSnapshot(db, 10_000, 10_000);
    expect(snap.windowMs).toBe(10_000);
    expect(snap.rateByMotivo.length).toBeGreaterThan(0);
    expect(snap.restoreRate.evictedCount).toBe(1);
    expect(snap.restoreRate.restoredCount).toBe(1);
    expect(snap.quarantine.exitedCount).toBe(1);
  });
});
