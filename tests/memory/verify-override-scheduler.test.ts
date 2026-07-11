// createOverrideVerifyScheduler tests (MEMORY.md §11.x, S3.4).
//
// Pins for the gate sequence (mirror of verify-semantic-scheduler
// shape, override-specific):
//   - definition undefined / shutdown → no-op
//   - no events / under-threshold → no dispatch
//   - threshold tripped → dispatch fires
//   - type / trust / state gates (defense in depth)
//   - pending governance proposal short-circuits
//   - cap latches (dispatch + cost) + per-dispatch headroom
//   - one dispatch per poll
//   - S5 fail-closed: excluded scope events filtered out
//   - lastPolledAt advances each call

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import {
  MEMORY_VERIFY_OVERRIDE_MAX_COST_USD,
  MEMORY_VERIFY_OVERRIDE_MAX_DISPATCHES_PER_SESSION,
  SEMANTIC_OVERRIDE_SUBAGENT_MAX_COST_USD,
} from '../../src/memory/verify-override.ts';
import { createOverrideVerifyScheduler } from '../../src/memory/verify-override-scheduler.ts';
import type { PermissionEngine } from '../../src/permissions/index.ts';
import type { Provider } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { recordProposal } from '../../src/storage/repos/memory-governance.ts';
import {
  MEMORY_OVERRIDE_THRESHOLD_COUNT,
  MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS,
  recordOverrideEvent,
} from '../../src/storage/repos/memory-override-events.ts';
import { listRecentOverrideAttempts } from '../../src/storage/repos/memory-verify-override-attempts.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import type { RunSubagentResult } from '../../src/subagents/runtime.ts';
import type { SubagentDefinition } from '../../src/subagents/types.ts';
import type { ToolRegistry } from '../../src/tools/index.ts';

let workdir: string;
let db: DB;
let sessionId: string;
let childSessionId: string;
let roots: ScopeRoots;
let registry: ReturnType<typeof createMemoryRegistry>;

const fakeDefinition: SubagentDefinition = {
  name: 'verify-override',
  description: 'fake',
  scope: 'builtin',
  sourcePath: '/fake.md',
  sourceSha256: 'a'.repeat(64),
  tools: [],
  isolation: 'none',
  budget: { maxSteps: 8, maxCostUsd: 0.08 },
  systemPrompt: 'fake',
  meta: {},
};

const fakeProvider = { id: 'test/m', capabilities: {} } as unknown as Provider;
const fakeToolRegistry = {} as ToolRegistry;
const fakePermissionEngine = {} as PermissionEngine;

const seedFakeChild = (parentId: string): string => {
  const child = createSession(db, {
    model: 'test/m',
    cwd: workdir,
    parentSessionId: parentId,
  });
  db.query(
    `INSERT INTO subagent_runs
       (session_id, name, scope, source_path, source_sha256, system_prompt,
        tools_whitelist, budget_max_steps, budget_max_cost_usd, captured_at)
     VALUES (?, 'verify-override', 'user', '/fake', 'a', 'p', '[]', 8, 0.08, 1)`,
  ).run(child.id);
  return child.id;
};

const seedMemoryFile = (
  scopeDir: string,
  name: string,
  type: 'project' | 'reference' | 'feedback' | 'user' = 'project',
  body = `body of ${name}`,
  extraFrontmatter = '',
): void => {
  mkdirSync(scopeDir, { recursive: true });
  writeFileSync(
    join(scopeDir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} hook\ntype: ${type}\nsource: user_explicit\n${extraFrontmatter}---\n\n${body}\n`,
  );
  // Append to MEMORY.md so multiple seeds in the same scope all
  // land in the index (overwriting would drop earlier seeds and
  // the registry's findListing would return unknown for them).
  const idxPath = join(scopeDir, 'MEMORY.md');
  const existingFs = (() => {
    try {
      return require('node:fs').readFileSync(idxPath, 'utf8');
    } catch {
      return '';
    }
  })();
  const idxLine = `- [${name}](${name}.md) — ${name} hook\n`;
  if (existingFs.length === 0) {
    writeFileSync(idxPath, `# Memory index\n\n${idxLine}`);
  } else if (!existingFs.includes(idxLine)) {
    writeFileSync(idxPath, `${existingFs.replace(/\n+$/, '')}\n${idxLine}`);
  }
};

// Seed `count` override events for one memory at the given times.
const seedOverrides = (
  scope: 'user' | 'project_shared' | 'project_local',
  name: string,
  times: number[],
  signal: 'memory_write_rejected' | 'permission_denied' | 'edit_reverted' = 'memory_write_rejected',
): void => {
  for (const t of times) {
    recordOverrideEvent(db, {
      sessionId,
      memoryScope: scope,
      memoryName: name,
      signal,
      createdAt: t,
    });
  }
};

const misguidingFalseResult = (): RunSubagentResult => ({
  output:
    'misguiding: false\nconfidence: 0.9\nrule_extracted: ""\noverride_pattern_observed: "noise"\nsuggested_motivo: conflict\n',
  sessionId: childSessionId,
  status: 'done',
  reason: 'done',
  costUsd: 0.05,
  steps: 1,
  durationMs: 100,
});

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-verify-override-sched-'));
  roots = {
    user: join(workdir, 'user'),
    projectShared: join(workdir, 'shared'),
    projectLocal: join(workdir, 'local'),
  };
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'test/m', cwd: workdir }).id;
  childSessionId = seedFakeChild(sessionId);
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

const buildScheduler = (
  overrides: Partial<Parameters<typeof createOverrideVerifyScheduler>[0]> = {},
) => {
  registry = createMemoryRegistry({ roots, db, sessionId, cwd: workdir });
  return createOverrideVerifyScheduler({
    db,
    registry,
    definition: fakeDefinition,
    parentSessionId: sessionId,
    cwd: workdir,
    provider: fakeProvider,
    parentToolRegistry: fakeToolRegistry,
    permissionEngine: fakePermissionEngine,
    spawnSubagentFn: (async () => misguidingFalseResult()) as never,
    stderr: () => {},
    ...overrides,
  });
};

describe('scheduler — no-op gates', () => {
  test('undefined definition: poll is a no-op', async () => {
    const now = 5_000_000_000_000;
    seedMemoryFile(roots.projectLocal, 'foo');
    seedOverrides('project_local', 'foo', [now, now - 1000, now - 2000]);
    const sched = buildScheduler({ definition: undefined, now: () => now });
    await sched.poll();
    expect(listRecentOverrideAttempts(db)).toHaveLength(0);
    expect(sched.getCounters().dispatched).toBe(0);
  });

  test('shutdown silently no-ops subsequent polls', async () => {
    const now = 5_000_000_000_000;
    seedMemoryFile(roots.projectLocal, 'foo');
    seedOverrides('project_local', 'foo', [now, now - 1000, now - 2000]);
    let spawnCalled = false;
    const sched = buildScheduler({
      spawnSubagentFn: (async () => {
        spawnCalled = true;
        return misguidingFalseResult();
      }) as never,
      now: () => now,
    });
    sched.shutdown();
    await sched.poll();
    expect(spawnCalled).toBe(false);
  });

  test('no events → no dispatch, lastPolledAt advances', async () => {
    const now = 5_000_000_000_000;
    const sched = buildScheduler({ now: () => now });
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(0);
    expect(sched.getCounters().lastPolledAt).toBe(now);
  });
});

describe('scheduler — threshold gate', () => {
  test('below threshold (2 events in 24h) → no dispatch', async () => {
    const now = 5_000_000_000_000;
    seedMemoryFile(roots.projectLocal, 'foo', 'project');
    seedOverrides('project_local', 'foo', [now, now - 1000]); // 2 events
    const sched = buildScheduler({ now: () => now });
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(0);
  });

  test('at threshold (3 events in 24h) → dispatch fires', async () => {
    const now = 5_000_000_000_000;
    seedMemoryFile(roots.projectLocal, 'foo', 'project');
    seedOverrides('project_local', 'foo', [now, now - 1000, now - 2000]);
    const sched = buildScheduler({ now: () => now });
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(1);
    expect(listRecentOverrideAttempts(db)).toHaveLength(1);
  });

  test("events past the 24h window don't count toward threshold", async () => {
    const now = 5_000_000_000_000;
    seedMemoryFile(roots.projectLocal, 'foo', 'project');
    // 2 within window + 1 outside → effective count is 2.
    seedOverrides('project_local', 'foo', [
      now,
      now - 1000,
      now - MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS - 1,
    ]);
    const sched = buildScheduler({ now: () => now });
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(0);
  });

  test('custom thresholdCount via test seam', async () => {
    const now = 5_000_000_000_000;
    seedMemoryFile(roots.projectLocal, 'foo', 'project');
    seedOverrides('project_local', 'foo', [now, now - 1000]); // 2 events
    const sched = buildScheduler({ now: () => now, thresholdCount: 2 });
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(1);
  });

  test('cursor inits at window cutoff so 90d-retained noise does NOT delay fresh threshold trips (post-review)', async () => {
    // Pre-fix: cursor=(0,'') made the first poll fetch the
    // OLDEST retained events first (LIMIT 50). With 90d retention
    // + maxEventsPerPoll=50, a session with >50 retained-but-out-
    // of-window events would drain irrelevant historical batches
    // for many step boundaries before reaching the fresh events
    // that actually crossed the 24h threshold. Short sessions
    // never ran verify-override at all.
    //
    // Post-fix: lazy-init cursor to `nowFn() - thresholdWindowMs`.
    // First poll's source query skips everything older than the
    // window — events that wouldn't count via
    // `countOverridesInWindow` anyway. Fresh threshold-tripping
    // events surface on the first poll.
    const now = 5_000_000_000_000;
    const window = MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS;
    seedMemoryFile(roots.projectLocal, 'foo', 'project');
    // 60 ancient retained events (older than the threshold
    // window, but inside the 90d retention) on a memory that
    // never crossed threshold this session. Pre-fix: they
    // occupy the first 50-row batch, draining poll budget.
    const ancientTimes: number[] = [];
    for (let i = 0; i < 60; i++) {
      ancientTimes.push(now - window - i * 1000 - 1);
    }
    seedOverrides('project_local', 'old-noise', ancientTimes);
    // 3 fresh events on the actual target memory — inside the
    // window, threshold trips.
    seedOverrides('project_local', 'foo', [now - 1000, now - 500, now]);
    const sched = buildScheduler({ now: () => now });
    await sched.poll();
    // First poll dispatched against the threshold-tripping memory,
    // not the old noise. Pre-fix this assertion fails: dispatched=0.
    expect(sched.getCounters().dispatched).toBe(1);
  });

  test('dispatcher receives only in-window override events as evidence (post-review)', async () => {
    // Pre-fix: `listRecentOverridesForMemory(db, scope, name, 10)`
    // had no time bound — the LLM judge received up to 10 most-
    // recent events regardless of age, even though the threshold
    // gate above evaluated only events within the 24h window. The
    // judge could quarantine a memory based partly on stale
    // operator behavior the threshold gate had already discarded;
    // the persisted proposal's `evidence.override_event_ids`
    // carried the same stale rows. Post-fix: fetch passes
    // `sinceMs = nowFn() - window`, matching the cutoff
    // `countOverridesInWindow` used.
    //
    // We pin via the persisted proposal's
    // evidence.override_event_ids — the dispatcher writes this
    // verbatim from the fetched event list, so we get a clean
    // assertion surface without spying on internal prompt
    // composition.
    const now = 5_000_000_000_000;
    const window = MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS;
    seedMemoryFile(roots.projectLocal, 'foo', 'project');
    // 3 fresh (threshold trips) + 4 stale (outside window).
    const freshTimes = [now - 1000, now - 500, now];
    const staleTimes = [
      now - window - 1000,
      now - window - 5000,
      now - window - 10_000,
      now - window - 20_000,
    ];
    seedOverrides('project_local', 'foo', [...freshTimes, ...staleTimes]);
    // Capture which event ids belong to which window for the
    // post-dispatch assertion.
    const { listRecentOverridesForMemory } = await import(
      '../../src/storage/repos/memory-override-events.ts'
    );
    const allEvents = listRecentOverridesForMemory(db, 'project_local', 'foo', 50);
    const freshIds = new Set(allEvents.filter((e) => e.createdAt >= now - window).map((e) => e.id));
    const staleIds = new Set(allEvents.filter((e) => e.createdAt < now - window).map((e) => e.id));

    // misguiding=true verdict so the dispatcher lands a proposal.
    const misguidingTrueSpawn = (async (): Promise<RunSubagentResult> => ({
      output:
        'misguiding: true\nconfidence: 0.9\nrule_extracted: "the rule"\noverride_pattern_observed: "pattern observed"\nsuggested_motivo: conflict\n',
      sessionId: childSessionId,
      status: 'done',
      reason: 'done',
      costUsd: 0.05,
      steps: 1,
      durationMs: 100,
    })) as never;
    const sched = buildScheduler({ now: () => now, spawnSubagentFn: misguidingTrueSpawn });
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(1);

    const { listProposals } = await import('../../src/storage/repos/memory-governance.ts');
    const proposals = listProposals(db);
    expect(proposals).toHaveLength(1);
    const evidenceIds = (proposals[0]?.evidence as { override_event_ids?: string[] })
      ?.override_event_ids;
    expect(evidenceIds).toBeDefined();
    if (evidenceIds === undefined) return;
    // Post-fix: only fresh events feed the judge + persist on the
    // proposal's evidence. Pre-fix this would include staleIds.
    for (const id of evidenceIds) {
      expect(staleIds.has(id)).toBe(false);
      expect(freshIds.has(id)).toBe(true);
    }
    expect(evidenceIds.length).toBe(freshIds.size);
  });
});

describe('scheduler — type / trust / state gates (defense in depth)', () => {
  test('user-type memory NOT dispatched (only project/reference factual)', async () => {
    const now = 5_000_000_000_000;
    seedMemoryFile(roots.projectLocal, 'pref', 'user');
    seedOverrides('project_local', 'pref', [now, now - 1000, now - 2000]);
    const sched = buildScheduler({ now: () => now });
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(0);
  });

  test('untrusted memory NOT dispatched', async () => {
    const now = 5_000_000_000_000;
    seedMemoryFile(roots.projectLocal, 'foo', 'project', 'body', 'trust: untrusted\n');
    seedOverrides('project_local', 'foo', [now, now - 1000, now - 2000]);
    const sched = buildScheduler({ now: () => now });
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(0);
  });

  test('non-active state (quarantined) NOT dispatched', async () => {
    const now = 5_000_000_000_000;
    seedMemoryFile(roots.projectLocal, 'foo', 'project', 'body', 'state: quarantined\n');
    seedOverrides('project_local', 'foo', [now, now - 1000, now - 2000]);
    const sched = buildScheduler({ now: () => now });
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(0);
  });

  test('reference-type IS dispatched', async () => {
    const now = 5_000_000_000_000;
    seedMemoryFile(roots.projectLocal, 'ref', 'reference');
    seedOverrides('project_local', 'ref', [now, now - 1000, now - 2000]);
    const sched = buildScheduler({ now: () => now });
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(1);
  });
});

describe('scheduler — pending-proposal short-circuit', () => {
  test('memory with pending quarantine proposal skipped (no LLM cost wasted)', async () => {
    const now = 5_000_000_000_000;
    seedMemoryFile(roots.projectLocal, 'foo', 'project');
    seedOverrides('project_local', 'foo', [now, now - 1000, now - 2000]);
    recordProposal(db, {
      sessionId,
      kind: 'quarantine',
      sourceMemoryKeys: [{ scope: 'project_local', name: 'foo' }],
      sourceMemorySnapshots: [{ scope: 'project_local', name: 'foo', contentHash: 'h'.repeat(64) }],
      evidence: { reason: 'preseed' },
      proposedBy: 'subagent:test',
      confidence: 0.9,
    });
    const sched = buildScheduler({ now: () => now });
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(0);
  });
});

describe('scheduler — caps', () => {
  test('dispatch cap latches → capExhausted=dispatch, subsequent polls no-op', async () => {
    const now = 5_000_000_000_000;
    seedMemoryFile(roots.projectLocal, 'foo', 'project');
    seedOverrides('project_local', 'foo', [now, now - 1000, now - 2000]);
    const sched = buildScheduler({
      now: () => now,
      maxDispatchesPerSession: 1,
    });
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(1);

    // Seed another memory above threshold.
    seedMemoryFile(roots.projectLocal, 'bar', 'project');
    seedOverrides('project_local', 'bar', [now + 10, now + 9, now + 8]);
    await sched.poll();
    expect(sched.getCounters().capExhausted).toBe('dispatch');
    // Second poll didn't dispatch (cap latched).
    expect(sched.getCounters().dispatched).toBe(1);
  });

  test('cost cap with per-dispatch headroom blocks BEFORE blowing past cap', async () => {
    const now = 5_000_000_000_000;
    seedMemoryFile(roots.projectLocal, 'foo', 'project');
    seedOverrides('project_local', 'foo', [now, now - 1000, now - 2000]);
    // Headroom rule: refuse new dispatch when current+max-subagent-cost
    // > cap. With cap = 0.06 and SEMANTIC_OVERRIDE_SUBAGENT_MAX_COST_USD
    // = 0.08, the first dispatch is refused outright (0 + 0.08 > 0.06).
    const sched = buildScheduler({
      now: () => now,
      maxCostUsd: 0.06,
    });
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(0);
    expect(sched.getCounters().capExhausted).toBe('cost');
  });
});

describe('scheduler — one dispatch per poll', () => {
  test('two memories above threshold: first poll dispatches one, second poll dispatches other', async () => {
    const now = 5_000_000_000_000;
    seedMemoryFile(roots.projectLocal, 'foo', 'project');
    seedMemoryFile(roots.projectLocal, 'bar', 'project');
    seedOverrides('project_local', 'foo', [now - 100, now - 200, now - 300]);
    seedOverrides('project_local', 'bar', [now - 50, now - 60, now - 70]);
    const sched = buildScheduler({ now: () => now });
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(1);
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(2);
  });
});

describe('scheduler — S5 fail-closed scope exclusion', () => {
  test('events for an excluded scope are dropped from candidates', async () => {
    const now = 5_000_000_000_000;
    seedMemoryFile(roots.projectShared, 'sh', 'project');
    seedOverrides('project_shared', 'sh', [now, now - 1000, now - 2000]);
    const sched = buildScheduler({
      now: () => now,
      memoryExcludeScopes: ['project_shared'],
    });
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(0);
  });

  test('excluded scope does not block siblings in allowed scopes', async () => {
    const now = 5_000_000_000_000;
    seedMemoryFile(roots.projectShared, 'sh', 'project');
    seedMemoryFile(roots.projectLocal, 'lo', 'project');
    seedOverrides('project_shared', 'sh', [now - 100, now - 200, now - 300]);
    seedOverrides('project_local', 'lo', [now - 50, now - 60, now - 70]);
    const sched = buildScheduler({
      now: () => now,
      memoryExcludeScopes: ['project_shared'],
    });
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(1);
  });
});

describe('scheduler — counter constants', () => {
  test('default dispatch cap matches MEMORY_VERIFY_OVERRIDE_MAX_DISPATCHES_PER_SESSION', () => {
    // Sanity: a runtime regression that mutates the cap constant
    // surfaces here as well as in scheduler behavior.
    expect(MEMORY_VERIFY_OVERRIDE_MAX_DISPATCHES_PER_SESSION).toBe(10);
  });
  test('default cost cap matches MEMORY_VERIFY_OVERRIDE_MAX_COST_USD', () => {
    expect(MEMORY_VERIFY_OVERRIDE_MAX_COST_USD).toBe(0.5);
  });
  test('per-dispatch headroom uses subagent max cost', () => {
    expect(SEMANTIC_OVERRIDE_SUBAGENT_MAX_COST_USD).toBeGreaterThan(0);
    expect(SEMANTIC_OVERRIDE_SUBAGENT_MAX_COST_USD).toBeLessThanOrEqual(
      MEMORY_VERIFY_OVERRIDE_MAX_COST_USD,
    );
  });
  test('default threshold matches spec §6.5.2 (3 in 24h)', () => {
    expect(MEMORY_OVERRIDE_THRESHOLD_COUNT).toBe(3);
    expect(MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});
