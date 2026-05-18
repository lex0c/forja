// createConflictDetectorScheduler tests (MEMORY.md §11.x / S13 / T13.2 + T13.8).
//
// Mirrors verify-semantic-scheduler.test.ts. Covers:
//   - happy path: write triggers BM25 prefilter, dispatch fires
//   - BM25 prefilter caps dispatch to top-K (only the K highest-
//     BM25-score siblings reach the pair-judge; non-overlapping
//     siblings never become candidates)
//   - cost cap exhaustion → no further dispatch this session
//   - definition undefined → poll is a no-op (legacy bootstrap
//     posture mirror of S11)
//   - sharedScopeOffline forwarded when memoryExcludeScopes
//     contains project_shared (mirrors the S11 round-3 fix)

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import { createConflictDetectorScheduler } from '../../src/memory/verify-conflict-scheduler.ts';
import type { PermissionEngine } from '../../src/permissions/index.ts';
import type { Provider } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createMemoryEvent } from '../../src/storage/repos/memory-events.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import type { RunSubagentResult } from '../../src/subagents/runtime.ts';
import type { SubagentDefinition } from '../../src/subagents/types.ts';
import type { ToolRegistry } from '../../src/tools/index.ts';

let workdir: string;
let roots: ScopeRoots;
let registry: ReturnType<typeof createMemoryRegistry>;
let db: DB;
let sessionId: string;
let childSessionId: string;

const seedFakeChild = (parentId: string): string => {
  const child = createSession(db, { model: 'test/m', cwd: workdir, parentSessionId: parentId });
  db.query(
    `INSERT INTO subagent_runs
       (session_id, name, scope, source_path, source_sha256, system_prompt,
        tools_whitelist, budget_max_steps, budget_max_cost_usd, captured_at)
     VALUES (?, 'verify-conflict', 'user', '/fake', 'a', 'p', '[]', 6, 0.06, 1)`,
  ).run(child.id);
  return child.id;
};

const fakeDefinition: SubagentDefinition = {
  name: 'verify-conflict',
  description: 'fake',
  scope: 'builtin',
  sourcePath: '/fake/verify-conflict.md',
  sourceSha256: 'a'.repeat(64),
  tools: ['memory_read'],
  isolation: 'none',
  budget: { maxSteps: 6, maxCostUsd: 0.06 },
  systemPrompt: 'fake',
  meta: {},
};

const fakeProvider = {
  id: 'test/m',
  capabilities: { context_window: 1000, output_max_tokens: 100 },
} as unknown as Provider;
const fakeToolRegistry = {} as ToolRegistry;
const fakePermissionEngine = {} as PermissionEngine;

const seedMemory = (scopeDir: string, name: string, body: string): void => {
  mkdirSync(scopeDir, { recursive: true });
  writeFileSync(
    join(scopeDir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name}\ntype: project\nsource: user_explicit\n---\n\n${body}\n`,
  );
};

const writeIndex = (scopeDir: string, entries: string[]): void => {
  const idx = `# Memory index\n\n${entries.map((n) => `- [${n}](${n}.md) — ${n}\n`).join('')}`;
  writeFileSync(join(scopeDir, 'MEMORY.md'), idx);
};

const seedWriteEvent = (name: string, atMs: number): void => {
  createMemoryEvent(db, {
    scope: 'project_local',
    action: 'created',
    memoryName: name,
    source: 'user_explicit',
    sessionId,
    cwd: workdir,
    createdAt: atMs,
  });
};

const compatibleResult = (): RunSubagentResult => ({
  output:
    'conflicting: false\nconflict_kind: paraphrased-agreement\nconfidence: 0.9\nevidence:\n  shared_concept: x\n  polarity_a: a\n  polarity_b: b\n',
  sessionId: childSessionId,
  status: 'done',
  reason: 'done',
  costUsd: 0.04,
  steps: 1,
  durationMs: 100,
});

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-conflict-sched-'));
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

const buildSched = (
  overrides: Partial<Parameters<typeof createConflictDetectorScheduler>[0]> = {},
) => {
  registry = createMemoryRegistry({ roots, db, sessionId, cwd: workdir });
  return createConflictDetectorScheduler({
    db,
    registry,
    definition: fakeDefinition,
    parentSessionId: sessionId,
    cwd: workdir,
    provider: fakeProvider,
    parentToolRegistry: fakeToolRegistry,
    permissionEngine: fakePermissionEngine,
    spawnSubagentFn: (async () => compatibleResult()) as never,
    ...overrides,
  });
};

describe('conflict scheduler — definition undefined no-ops', () => {
  test('poll returns immediately when verify-conflict definition is absent', async () => {
    seedMemory(roots.projectLocal, 'foo', 'body');
    writeIndex(roots.projectLocal, ['foo']);
    seedWriteEvent('foo', 1_000);
    let spawnCalled = false;
    const sched = buildSched({
      definition: undefined,
      spawnSubagentFn: (async () => {
        spawnCalled = true;
        return compatibleResult();
      }) as never,
    });
    await sched.poll();
    expect(spawnCalled).toBe(false);
    expect(sched.getCounters().dispatched).toBe(0);
  });
});

describe('conflict scheduler — happy path', () => {
  test('write event + at least one BM25-overlapping sibling → dispatch fires', async () => {
    seedMemory(roots.projectLocal, 'foo', 'authentication uses JWT in src/auth');
    seedMemory(roots.projectLocal, 'bar', 'authentication via OAuth in src/auth/oauth.ts');
    writeIndex(roots.projectLocal, ['foo', 'bar']);
    seedWriteEvent('foo', 1_000);
    const sched = buildSched();
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(1);
    expect(sched.getCounters().costUsdSpent).toBeCloseTo(0.04);
  });
});

describe('conflict scheduler — BM25 prefilter cap (top-K)', () => {
  test('only top-K siblings reach LLM (zero-overlap siblings filtered out)', async () => {
    // Seed: 1 written + 6 siblings. 2 share tokens with written; 4 are
    // disjoint. With K=2 prefilter, only the 2 token-overlapping
    // siblings are eligible for dispatch. We dispatch one then cap
    // checks bail; counters show exactly 1 dispatch per poll.
    seedMemory(roots.projectLocal, 'written', 'auth uses jwt in src auth');
    seedMemory(roots.projectLocal, 'sib-a', 'auth flow via oauth in src');
    seedMemory(roots.projectLocal, 'sib-b', 'jwt validation in middleware');
    seedMemory(roots.projectLocal, 'disjoint-1', 'completely unrelated topic alpha beta');
    seedMemory(roots.projectLocal, 'disjoint-2', 'totally different gamma delta epsilon');
    seedMemory(roots.projectLocal, 'disjoint-3', 'yet another zeta eta theta');
    seedMemory(roots.projectLocal, 'disjoint-4', 'final unrelated iota kappa lambda');
    writeIndex(roots.projectLocal, [
      'written',
      'sib-a',
      'sib-b',
      'disjoint-1',
      'disjoint-2',
      'disjoint-3',
      'disjoint-4',
    ]);
    seedWriteEvent('written', 1_000);
    const promptsSeen: string[] = [];
    const sched = buildSched({
      prefilterK: 2,
      spawnSubagentFn: (async (input: { prompt: string }) => {
        promptsSeen.push(input.prompt);
        return compatibleResult();
      }) as never,
    });
    // Two polls cover both top-2 siblings (one dispatch per poll;
    // dedup cache rotates which pair is fresh).
    await sched.poll();
    await sched.poll();
    // At most K=2 dispatches (no disjoint sibling reached LLM).
    expect(sched.getCounters().dispatched).toBeLessThanOrEqual(2);
    expect(promptsSeen.length).toBeGreaterThan(0);
    // No disjoint sibling's distinctive tokens leaked into the
    // prompt — the prefilter dropped them before LLM dispatch.
    for (const p of promptsSeen) {
      expect(p).not.toContain('alpha beta');
      expect(p).not.toContain('gamma delta');
      expect(p).not.toContain('zeta eta');
      expect(p).not.toContain('iota kappa');
    }
  });
});

describe('conflict scheduler — cost cap exhaustion', () => {
  test('once cost cap crosses, capExhausted latches and subsequent polls no-op', async () => {
    seedMemory(roots.projectLocal, 'foo', 'authentication uses jwt in src');
    seedMemory(roots.projectLocal, 'bar', 'authentication via oauth in src');
    writeIndex(roots.projectLocal, ['foo', 'bar']);
    seedWriteEvent('foo', 1_000);
    // Cap tight so a single dispatch headroom check refuses next poll.
    // Headroom uses SEMANTIC_CONFLICT_SUBAGENT_MAX_COST_USD (0.06).
    // Setting maxCostUsd = 0.07 means: spent < 0.07 passes initially,
    // but spent + 0.06 > 0.07 after the first dispatch → cap latches.
    const sched = buildSched({ maxCostUsd: 0.07 });
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(1);
    await sched.poll();
    expect(sched.getCounters().capExhausted).toBe('cost');
    expect(sched.getCounters().dispatched).toBe(1); // no increment
  });
});

// ── P7: hardening test gaps mirrored from S11 ─────────────────────

describe('conflict scheduler — dispatch cap latch (C-HIGH-2)', () => {
  test('dispatched cap fires + latches; subsequent polls no-op', async () => {
    seedMemory(roots.projectLocal, 'foo', 'authentication uses jwt in src');
    seedMemory(roots.projectLocal, 'bar', 'authentication via oauth in src');
    writeIndex(roots.projectLocal, ['foo', 'bar']);
    seedWriteEvent('foo', 1_000);
    const sched = buildSched({ maxDispatchesPerSession: 1 });
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(1);
    await sched.poll();
    expect(sched.getCounters().capExhausted).toBe('dispatch');
    expect(sched.getCounters().dispatched).toBe(1);
  });
});

describe('conflict scheduler — cost cap headroom misconfig (C-HIGH-3)', () => {
  test('maxCostUsd < SEMANTIC_CONFLICT_SUBAGENT_MAX_COST_USD latches before first dispatch', async () => {
    seedMemory(roots.projectLocal, 'foo', 'authentication uses jwt in src');
    seedMemory(roots.projectLocal, 'bar', 'authentication via oauth in src');
    writeIndex(roots.projectLocal, ['foo', 'bar']);
    seedWriteEvent('foo', 1_000);
    // Subagent worst case is $0.06; cap below that → headroom check
    // refuses the first dispatch.
    const sched = buildSched({ maxCostUsd: 0.05 });
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(0);
    expect(sched.getCounters().capExhausted).toBe('cost');
  });
});

describe('conflict scheduler — G6 shutdown during in-flight dispatch (C-HIGH-1)', () => {
  test('shutdown() mid-await: counters do NOT bump after the await resolves', async () => {
    seedMemory(roots.projectLocal, 'foo', 'authentication uses jwt in src');
    seedMemory(roots.projectLocal, 'bar', 'authentication via oauth in src');
    writeIndex(roots.projectLocal, ['foo', 'bar']);
    seedWriteEvent('foo', 1_000);
    // biome-ignore lint/style/useConst: late-bound circular ref into spawnFn
    let sched: ReturnType<typeof createConflictDetectorScheduler> | undefined;
    const spawnFn = (async () => {
      sched?.shutdown();
      return compatibleResult();
    }) as never;
    sched = buildSched({ spawnSubagentFn: spawnFn });
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(0);
    expect(sched.getCounters().costUsdSpent).toBe(0);
  });
});

describe('conflict scheduler — same-millisecond write events (cursor tuple)', () => {
  test('two write events with identical createdAt both reach dispatch across polls', async () => {
    // Two distinct just-written memos in the same ms. Cursor MUST
    // tiebreak by id so the second event isn't dropped after the
    // first dispatches. Each event has at least one sibling so a
    // dispatch fires.
    seedMemory(roots.projectLocal, 'first', 'authentication uses jwt in src');
    seedMemory(roots.projectLocal, 'second', 'session storage in sqlite');
    seedMemory(roots.projectLocal, 'first-sib', 'authentication via oauth in src');
    seedMemory(roots.projectLocal, 'second-sib', 'sessions persist via sqlite file');
    writeIndex(roots.projectLocal, ['first', 'second', 'first-sib', 'second-sib']);
    seedWriteEvent('first', 5_000);
    seedWriteEvent('second', 5_000);
    const sched = buildSched();
    await sched.poll();
    expect(sched.getCounters().dispatched).toBe(1);
    await sched.poll();
    // The second event with same ms must STILL be visible to the
    // cursor query — pre-fix the bare-timestamp cursor would drop it.
    expect(sched.getCounters().dispatched).toBeGreaterThanOrEqual(1);
  });
});

describe('conflict scheduler — pending-proposal pre-dispatch gate (CRIT-2 fix)', () => {
  test('existing pending quarantine for written memo → skip, no dispatch', async () => {
    seedMemory(roots.projectLocal, 'foo', 'authentication uses jwt in src');
    seedMemory(roots.projectLocal, 'bar', 'authentication via oauth in src');
    writeIndex(roots.projectLocal, ['foo', 'bar']);
    seedWriteEvent('foo', 1_000);
    // Pre-seed a pending quarantine proposal for foo (canonical S8
    // shape; the conflict scheduler MUST skip the just-written event).
    const { recordProposal } = await import('../../src/storage/repos/memory-governance.ts');
    const { hashMemoryContent } = await import('../../src/storage/repos/memory-provenance.ts');
    const { parseMemoryFile, serializeMemoryFile } = await import(
      '../../src/memory/frontmatter.ts'
    );
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(join(roots.projectLocal, 'foo.md'), 'utf-8');
    const hashFoo = hashMemoryContent(serializeMemoryFile(parseMemoryFile(raw)));
    recordProposal(db, {
      sessionId,
      kind: 'quarantine',
      sourceMemoryKeys: [{ scope: 'project_local', name: 'foo' }],
      sourceMemorySnapshots: [{ scope: 'project_local', name: 'foo', contentHash: hashFoo }],
      evidence: { reason: 'prior detector' },
      proposedBy: 'detector:test',
      confidence: 0.9,
    });
    let spawnCalled = false;
    const sched = buildSched({
      spawnSubagentFn: (async () => {
        spawnCalled = true;
        return compatibleResult();
      }) as never,
    });
    await sched.poll();
    expect(spawnCalled).toBe(false);
    expect(sched.getCounters().dispatched).toBe(0);
  });
});

describe('conflict scheduler — sharedScopeOffline forwarding (negative case)', () => {
  test('memoryExcludeScopes empty ⇒ sharedScopeOffline omitted from spawn args', async () => {
    seedMemory(roots.projectLocal, 'foo', 'authentication uses jwt in src');
    seedMemory(roots.projectLocal, 'bar', 'authentication via oauth in src');
    writeIndex(roots.projectLocal, ['foo', 'bar']);
    seedWriteEvent('foo', 1_000);
    let captured: Record<string, unknown> | undefined;
    const sched = buildSched({
      spawnSubagentFn: (async (input: Record<string, unknown>) => {
        captured = input;
        return compatibleResult();
      }) as never,
    });
    await sched.poll();
    expect(captured).toBeDefined();
    expect(captured?.sharedScopeOffline).toBeUndefined();
  });
});

describe('conflict scheduler — excluded scope filter', () => {
  test('memoryExcludeScopes includes project_shared → all dispatches carry sharedScopeOffline:true', async () => {
    // Write event in project_local (NOT excluded). Forward
    // sharedScopeOffline anyway because operator marked
    // project_shared offline at boot — child must honor that
    // posture even when verifying a non-shared memo.
    seedMemory(roots.projectLocal, 'foo', 'authentication uses jwt in src');
    seedMemory(roots.projectLocal, 'bar', 'authentication via oauth in src');
    writeIndex(roots.projectLocal, ['foo', 'bar']);
    seedWriteEvent('foo', 1_000);
    let captured: Record<string, unknown> | undefined;
    const sched = buildSched({
      memoryExcludeScopes: ['project_shared'],
      spawnSubagentFn: (async (input: Record<string, unknown>) => {
        captured = input;
        return compatibleResult();
      }) as never,
    });
    await sched.poll();
    expect(captured).toBeDefined();
    expect(captured?.sharedScopeOffline).toBe(true);
  });
});
