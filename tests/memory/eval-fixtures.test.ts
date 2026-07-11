import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { fixture as f01 } from '../../evals/memory/fixtures/01-s11-contradicted-approve-quarantine.ts';
import { fixture as f02 } from '../../evals/memory/fixtures/02-s11-contradicted-low-conf-auto-reject.ts';
import { fixture as f03 } from '../../evals/memory/fixtures/03-s13-conflict-approve-quarantine-loser.ts';
import { fixture as f04 } from '../../evals/memory/fixtures/04-s3-override-approve-quarantine.ts';
import { fixture as f05 } from '../../evals/memory/fixtures/05-s11-operator-reject.ts';
import { fixture as f06 } from '../../evals/memory/fixtures/06-s11-operator-defer.ts';
import { fixture as f11 } from '../../evals/memory/fixtures/11-s11-hallucination-guard.ts';
import { fixture as f12 } from '../../evals/memory/fixtures/12-s11-stale-snapshot-toctou.ts';
import type { FixtureMemory, MemoryGovernanceFixture } from '../../evals/memory/fixtures/types.ts';
import { parseMemoryFile } from '../../src/memory/frontmatter.ts';
import { applyProposal } from '../../src/memory/governance.ts';
import { rootForScope, type ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import { dispatchConflictVerify } from '../../src/memory/verify-conflict-dispatcher.ts';
import { dispatchOverrideVerify } from '../../src/memory/verify-override-dispatcher.ts';
import { dispatchSemanticVerify } from '../../src/memory/verify-semantic-dispatcher.ts';
import type { PermissionEngine } from '../../src/permissions/index.ts';
import type { Provider } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listRecentConflictAttempts } from '../../src/storage/repos/memory-conflict-attempts.ts';
import {
  decideProposal,
  deferProposal,
  listProposals,
} from '../../src/storage/repos/memory-governance.ts';
import {
  listRecentOverridesForMemory,
  recordOverrideEvent,
} from '../../src/storage/repos/memory-override-events.ts';
import { listRecentAttempts } from '../../src/storage/repos/memory-verify-attempts.ts';
import { listRecentOverrideAttempts } from '../../src/storage/repos/memory-verify-override-attempts.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import type { RunSubagentResult, runSubagent } from '../../src/subagents/runtime.ts';
import type { SubagentDefinition } from '../../src/subagents/types.ts';
import type { ToolRegistry } from '../../src/tools/index.ts';

const FIXTURES: readonly MemoryGovernanceFixture[] = [f01, f02, f03, f04, f05, f06, f11, f12];

const fakeDefinition: SubagentDefinition = {
  name: 'verify-semantic',
  description: 'fake',
  scope: 'builtin',
  sourcePath: '/fake/verify-semantic.md',
  sourceSha256: 'a'.repeat(64),
  tools: ['read_file', 'grep'],
  isolation: 'none',
  budget: { maxSteps: 15, maxCostUsd: 0.1 },
  systemPrompt: 'fake system prompt',
  meta: {},
};

const fakeProvider = {
  id: 'test/model',
  capabilities: { context_window: 1000, output_max_tokens: 100 },
} as unknown as Provider;

const fakeToolRegistry = {} as ToolRegistry;
const fakePermissionEngine = {} as PermissionEngine;

const setupCwd = (): { workdir: string; userRoot: string; roots: ScopeRoots } => {
  const workdir = mkdtempSync(join(tmpdir(), 'forja-mem-eval-'));
  const userRoot = mkdtempSync(join(tmpdir(), 'forja-mem-eval-user-'));
  const roots: ScopeRoots = {
    user: userRoot,
    projectShared: join(workdir, '.forja', 'memory', 'shared'),
    projectLocal: join(workdir, '.forja', 'memory', 'local'),
  };
  mkdirSync(roots.projectShared, { recursive: true });
  mkdirSync(roots.projectLocal, { recursive: true });
  return { workdir, userRoot, roots };
};

const seedMemoryFile = (roots: ScopeRoots, mem: FixtureMemory): string => {
  const stateLine = mem.state !== undefined ? `state: ${mem.state}\n` : '';
  const raw = `---\nname: ${mem.name}\ndescription: ${mem.description}\ntype: ${mem.type}\nsource: ${mem.source}\n${stateLine}---\n\n${mem.body}\n`;
  const scopeRoot = rootForScope(roots, mem.scope);
  writeFileSync(join(scopeRoot, `${mem.name}.md`), raw);
  // Also append a MEMORY.md index entry — the registry's reload()
  // only surfaces entries listed in the per-scope MEMORY.md (the
  // orphan walker is exposed by the loader but unused by registry).
  // Without the index line, `peek()` returns kind='unknown' and the
  // governance apply path refuses with `stale_evidence`. Append so
  // multi-memory fixtures (verify-conflict pairs) don't lose siblings.
  const indexPath = join(scopeRoot, 'MEMORY.md');
  const indexLine = `- [${mem.description}](${mem.name}.md) — ${mem.description}\n`;
  if (existsSync(indexPath)) {
    const current = readFileSync(indexPath, 'utf8');
    writeFileSync(indexPath, current + indexLine);
  } else {
    writeFileSync(indexPath, `# Memory index\n\n${indexLine}`);
  }
  return raw;
};

const seedFakeChild = (db: DB, parentId: string, cwd: string): string => {
  const child = createSession(db, {
    model: 'test/model',
    cwd,
    parentSessionId: parentId,
  });
  db.query(
    `INSERT INTO subagent_runs
       (session_id, name, scope, source_path, source_sha256, system_prompt,
        tools_whitelist, budget_max_steps, budget_max_cost_usd, captured_at)
     VALUES (?, 'verify-semantic', 'user', '/fake', 'a', 'p', '[]', 15, 0.1, 1)`,
  ).run(child.id);
  return child.id;
};

const makeSpawnFn = (output: string, childSessionId: string): typeof runSubagent =>
  (async () =>
    ({
      output,
      sessionId: childSessionId,
      status: 'done',
      reason: 'done',
      costUsd: 0.02,
      steps: 1,
      durationMs: 100,
    }) satisfies RunSubagentResult) as never;

interface FixtureContext {
  db: DB;
  workdir: string;
  userRoot: string;
  roots: ScopeRoots;
  sessionId: string;
  childSessionId: string;
}

const setupContext = (): FixtureContext => {
  const { workdir, userRoot, roots } = setupCwd();
  const db = openMemoryDb();
  migrate(db);
  const sessionId = createSession(db, { model: 'test/model', cwd: workdir }).id;
  const childSessionId = seedFakeChild(db, sessionId, workdir);
  return { db, workdir, userRoot, roots, sessionId, childSessionId };
};

const seedRepoFiles = (workdir: string, files: Record<string, string>): void => {
  for (const [rel, body] of Object.entries(files)) {
    const target = join(workdir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
};

interface DispatcherOutcomeShape {
  kind: 'completed' | 'skipped' | 'malformed' | 'spawn_failed';
  reason?: string;
}

interface DispatchPhaseResult {
  outcome: DispatcherOutcomeShape;
  registry: ReturnType<typeof createMemoryRegistry>;
}

const runDispatcher = async (
  fx: MemoryGovernanceFixture,
  ctx: FixtureContext,
): Promise<DispatchPhaseResult> => {
  const mem = fx.setup.memory;
  const raw = seedMemoryFile(ctx.roots, mem);
  // Parse the in-memory snapshot BEFORE repoFiles potentially
  // overwrites the body file (fixture 12's TOCTOU narrative depends
  // on this ordering: snapshot = v1, on-disk body = v2).
  const file = parseMemoryFile(raw);
  if (fx.detector === 'verify-conflict') {
    const pair = fx.setup.pairWith;
    if (pair !== undefined) seedMemoryFile(ctx.roots, pair);
  }
  if (fx.setup.repoFiles !== undefined) {
    seedRepoFiles(ctx.workdir, fx.setup.repoFiles);
  }
  // Build the registry AFTER all seeds so peek() reads the latest
  // body off disk. For fixture 12, latest = v2 while snapshot = v1
  // — F11 detects the mismatch and refuses.
  const registry = createMemoryRegistry({
    roots: ctx.roots,
    db: ctx.db,
    sessionId: ctx.sessionId,
    cwd: ctx.workdir,
  });
  const spawnFn = makeSpawnFn(fx.subagentOutput, ctx.childSessionId);

  switch (fx.detector) {
    case 'verify-semantic': {
      const outcome = await dispatchSemanticVerify({
        db: ctx.db,
        definition: fakeDefinition,
        parentSessionId: ctx.sessionId,
        cwd: ctx.workdir,
        provider: fakeProvider,
        parentToolRegistry: fakeToolRegistry,
        permissionEngine: fakePermissionEngine,
        memory: { scope: mem.scope, name: mem.name, file },
        registry,
        spawnSubagentFn: spawnFn,
      });
      return { outcome: outcome as DispatcherOutcomeShape, registry };
    }
    case 'verify-conflict': {
      const pair = fx.setup.pairWith;
      if (pair === undefined) {
        throw new Error('verify-conflict fixture must provide setup.pairWith');
      }
      const pairFileResult = registry.peek(pair.name, { scope: pair.scope });
      if (pairFileResult.kind !== 'present') {
        throw new Error(`pairWith memory not present in registry: ${pair.name}`);
      }
      const now = Date.now();
      const outcome = await dispatchConflictVerify({
        db: ctx.db,
        definition: fakeDefinition,
        parentSessionId: ctx.sessionId,
        cwd: ctx.workdir,
        provider: fakeProvider,
        parentToolRegistry: fakeToolRegistry,
        permissionEngine: fakePermissionEngine,
        pair: {
          a: { scope: mem.scope, name: mem.name, file, source: mem.source, mtimeMs: now },
          b: {
            scope: pair.scope,
            name: pair.name,
            file: pairFileResult.file,
            source: pair.source,
            mtimeMs: now,
          },
        },
        spawnSubagentFn: spawnFn,
      });
      return { outcome: outcome as DispatcherOutcomeShape, registry };
    }
    case 'verify-override': {
      const count = fx.setup.overrideEventCount ?? 0;
      for (let i = 0; i < count; i++) {
        recordOverrideEvent(ctx.db, {
          sessionId: ctx.sessionId,
          memoryScope: mem.scope,
          memoryName: mem.name,
          signal: 'memory_write_rejected',
          createdAt: Date.now() - (count - i) * 1000,
        });
      }
      const events = listRecentOverridesForMemory(ctx.db, mem.scope, mem.name, 50);
      const outcome = await dispatchOverrideVerify({
        db: ctx.db,
        definition: fakeDefinition,
        parentSessionId: ctx.sessionId,
        cwd: ctx.workdir,
        provider: fakeProvider,
        parentToolRegistry: fakeToolRegistry,
        permissionEngine: fakePermissionEngine,
        memory: { scope: mem.scope, name: mem.name, file },
        overrideEvents: events,
        spawnSubagentFn: spawnFn,
      });
      return { outcome: outcome as DispatcherOutcomeShape, registry };
    }
  }
};

const detectorAttemptCount = (db: DB, detector: MemoryGovernanceFixture['detector']): number => {
  switch (detector) {
    case 'verify-semantic':
      return listRecentAttempts(db).length;
    case 'verify-conflict':
      return listRecentConflictAttempts(db).length;
    case 'verify-override':
      return listRecentOverrideAttempts(db).length;
  }
};

const evictionEventsFor = (db: DB, scope: string, name: string) =>
  db
    .query(
      `SELECT outcome, trigger FROM eviction_events
        WHERE substrate = 'memory' AND object_id = ? AND object_scope = ?
        ORDER BY recorded_at ASC, id ASC`,
    )
    .all(name, scope) as Array<{ outcome: string; trigger: string }>;

const memoryEventActionsFor = (db: DB, scope: string, name: string) =>
  (
    db
      .query(
        `SELECT action FROM memory_events
          WHERE scope = ? AND memory_name = ?
          ORDER BY created_at ASC, id ASC`,
      )
      .all(scope, name) as Array<{ action: string }>
  ).map((r) => r.action);

const cleanupContext = (ctx: FixtureContext): void => {
  ctx.db.close();
  rmSync(ctx.workdir, { recursive: true, force: true });
  rmSync(ctx.userRoot, { recursive: true, force: true });
};

let activeCtx: FixtureContext | undefined;

beforeEach(() => {
  activeCtx = undefined;
});

afterEach(() => {
  if (activeCtx !== undefined) cleanupContext(activeCtx);
});

describe('memory governance eval — fixture suite (evals/memory/)', () => {
  for (const fx of FIXTURES) {
    test(`${fx.name}: ${fx.description}`, async () => {
      const ctx = setupContext();
      activeCtx = ctx;
      const mem = fx.setup.memory;

      // Dispatch phase: real dispatcher + mocked subagent output.
      const { outcome: dispatchOutcome, registry } = await runDispatcher(fx, ctx);
      const expectedOutcome = fx.expected.dispatcherOutcome ?? 'completed';
      expect(dispatchOutcome.kind).toBe(expectedOutcome);
      if (fx.expected.dispatcherReasonContains !== undefined) {
        expect(dispatchOutcome.reason ?? '').toContain(fx.expected.dispatcherReasonContains);
      }

      // Dispatcher-phase assertions.
      expect(detectorAttemptCount(ctx.db, fx.detector)).toBe(fx.expected.attempts);
      const proposals = listProposals(ctx.db);
      expect(proposals).toHaveLength(fx.expected.proposalsAfterDispatch);
      if (fx.expected.proposalStatusAfterDispatch !== undefined) {
        expect(proposals[0]?.status).toBe(fx.expected.proposalStatusAfterDispatch);
      }

      // Operator-decision phase.
      if (fx.operator !== undefined) {
        const proposal = proposals[0];
        if (proposal === undefined) {
          throw new Error('fixture expects operator decision but no proposal landed');
        }
        if (fx.operator.decision === 'approve') {
          const result = await applyProposal({
            db: ctx.db,
            registry,
            proposalId: proposal.id,
            decidedBy: 'operator:test-eval',
            decidedReason: fx.operator.reason ?? null,
            sessionId: ctx.sessionId,
            cwd: ctx.workdir,
          });
          if (fx.expected.applyOutcome !== undefined) {
            expect(result.outcome).toBe(fx.expected.applyOutcome);
          }
        } else if (fx.operator.decision === 'reject') {
          decideProposal(ctx.db, proposal.id, {
            status: 'rejected',
            decidedBy: 'operator:test-eval',
            decidedReason: fx.operator.reason ?? null,
            decidedAt: Date.now(),
          });
        } else {
          // defer
          const days = fx.operator.deferDays;
          if (days === undefined) {
            throw new Error('defer decision requires operator.deferDays');
          }
          const result = deferProposal(ctx.db, proposal.id, {
            additionalDays: days,
            nowMs: Date.now(),
          });
          if (!result.ok) {
            throw new Error(`defer rejected: ${result.reason}`);
          }
        }

        // Final-state assertions (post-decision).
        if (fx.expected.finalMemoryState !== undefined) {
          const peeked = registry.peek(mem.name, { scope: mem.scope });
          expect(peeked.kind).toBe('present');
          if (peeked.kind === 'present') {
            expect(peeked.file.frontmatter.state ?? 'active').toBe(fx.expected.finalMemoryState);
          }
        }
        if (fx.expected.eventActions !== undefined) {
          expect(memoryEventActionsFor(ctx.db, mem.scope, mem.name)).toEqual([
            ...fx.expected.eventActions,
          ]);
        }
        if (fx.expected.evictionOutcome !== undefined) {
          const evictions = evictionEventsFor(ctx.db, mem.scope, mem.name);
          const last = evictions[evictions.length - 1];
          expect(last?.outcome).toBe(fx.expected.evictionOutcome);
          if (fx.expected.evictionTrigger !== undefined) {
            expect(last?.trigger).toBe(fx.expected.evictionTrigger);
          }
        }
      }
    });
  }
});
