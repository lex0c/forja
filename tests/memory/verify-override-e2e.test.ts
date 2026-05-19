// End-to-end pin for the S3 verify-override detector chain
// (post-Phase-2 review #1).
//
// Each layer has unit coverage in its own test file
// (recordOverrideSignal in registry.test.ts; dispatcher in
// verify-override-dispatcher.test.ts; scheduler in verify-override-
// scheduler.test.ts; trigger mapping in governance.test.ts). This
// suite exercises the FULL CHAIN — operator action → memory_override
// _events → threshold trip → scheduler poll → dispatcher → governance
// proposal pending → /memory governance approve → transitionMemoryState
// → eviction_events.applied with trigger=user_override_repeated.
//
// Catches wiring regressions between layers that test isolation
// cannot see (e.g., the dispatcher's recordProposal `targetPayload.
// motivo` not being honored by applyProposal, or the scheduler not
// passing the right snapshot to the dispatcher).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyProposal } from '../../src/memory/governance.ts';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import { createOverrideVerifyScheduler } from '../../src/memory/verify-override-scheduler.ts';
import type { PermissionEngine } from '../../src/permissions/index.ts';
import type { Provider } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listMemoryEventsByName } from '../../src/storage/repos/memory-events.ts';
import {
  getProposalById,
  listPendingProposals,
} from '../../src/storage/repos/memory-governance.ts';
import {
  listRecentOverridesForMemory,
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

const seedFactualMemory = (scope: string, name: string, body = `Body of ${name}.`): void => {
  mkdirSync(scope, { recursive: true });
  writeFileSync(
    join(scope, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} hook\ntype: project\nsource: user_explicit\n---\n\n${body}\n`,
  );
  writeFileSync(
    join(scope, 'MEMORY.md'),
    `# Memory index\n\n- [${name}](${name}.md) — ${name} hook\n`,
  );
};

const misguidingResult = (): RunSubagentResult => ({
  output:
    'misguiding: true\nconfidence: 0.85\nrule_extracted: "always use --no-verify on commits"\noverride_pattern_observed: "operator rejected 3 inferred memos that imply the rule"\nsuggested_motivo: conflict\n',
  sessionId: childSessionId,
  status: 'done',
  reason: 'done',
  costUsd: 0.05,
  steps: 1,
  durationMs: 100,
});

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-verify-override-e2e-'));
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

describe('verify-override end-to-end (signal → scheduler → dispatcher → proposal → approve → quarantine)', () => {
  test('full chain: 3 overrides on a factual memory → quarantine via operator approval', async () => {
    // 1. Seed an active factual memory.
    seedFactualMemory(roots.projectLocal, 'foo', 'always use --no-verify when committing.');
    const registry = createMemoryRegistry({ roots, db, sessionId, cwd: workdir });

    // 2. Three operator overrides hit the SAME memory directly.
    //    (In production these land via recordOverrideSignal which
    //    attributes via memory_provenance. We bypass attribution
    //    here to keep the test focused on the scheduler → dispatcher
    //    → governance chain; the attribution path is covered by
    //    `tests/memory/registry.test.ts:recordOverrideSignal`.)
    const now = 5_000_000_000_000;
    for (let i = 0; i < 3; i++) {
      recordOverrideEvent(db, {
        sessionId,
        memoryScope: 'project_local',
        memoryName: 'foo',
        signal: 'memory_write_rejected',
        details: { stage: 'modal', round: i },
        createdAt: now - i * 1000,
      });
    }
    expect(listRecentOverridesForMemory(db, 'project_local', 'foo').length).toBe(3);

    // 3. Scheduler poll. Stubs the LLM dispatch with a high-confidence
    //    misguiding=true verdict so a pending proposal lands.
    const scheduler = createOverrideVerifyScheduler({
      db,
      registry,
      definition: fakeDefinition,
      parentSessionId: sessionId,
      cwd: workdir,
      provider: fakeProvider,
      parentToolRegistry: fakeToolRegistry,
      permissionEngine: fakePermissionEngine,
      spawnSubagentFn: (async () => misguidingResult()) as never,
      stderr: () => {},
      now: () => now,
    });
    await scheduler.poll();

    // 4. Confirm dispatch fired + attempt cached + proposal pending.
    expect(scheduler.getCounters().dispatched).toBe(1);
    expect(scheduler.getCounters().capExhausted).toBeNull();
    expect(listRecentOverrideAttempts(db).length).toBe(1);
    const pending = listPendingProposals(db);
    expect(pending.length).toBe(1);
    const proposal = pending[0];
    if (proposal === undefined) throw new Error('unreachable');
    expect(proposal.kind).toBe('quarantine');
    expect(proposal.proposedBy).toBe('subagent:verify-override');
    expect(proposal.confidence).toBeCloseTo(0.85);
    expect(proposal.sourceMemoryKeys).toEqual([{ scope: 'project_local', name: 'foo' }]);

    // 5. Operator approves via applyProposal (the slash command's
    //    /memory governance approve path).
    const result = await applyProposal({
      db,
      registry,
      proposalId: proposal.id,
      decidedBy: 'operator:slash',
    });
    expect(result.outcome).toBe('applied');
    if (result.outcome === 'applied') {
      expect(result.transitions.length).toBe(1);
      expect(result.transitions[0]?.fromState).toBe('active');
      expect(result.transitions[0]?.toState).toBe('quarantined');
    }

    // 6. Disk: frontmatter state mutated to quarantined.
    const rawAfter = readFileSync(join(roots.projectLocal, 'foo.md'), 'utf-8');
    expect(rawAfter).toContain('state: quarantined');

    // 7. Proposal: status flipped + decided_by/at recorded.
    const reread = getProposalById(db, proposal.id);
    expect(reread?.status).toBe('applied');
    expect(reread?.decidedBy).toBe('operator:slash');
    expect(reread?.decidedAt).not.toBeNull();

    // 8. Memory_events: quarantined row landed via the apply path.
    const events = listMemoryEventsByName(db, 'foo');
    const quarantineEvent = events.find((e) => e.action === 'quarantined');
    expect(quarantineEvent).toBeDefined();
    expect(quarantineEvent?.scope).toBe('project_local');

    // 9. Eviction_events: the audit row carries trigger derived from
    //    proposed_by ('subagent:verify-override' → 'user_override_
    //    repeated' per spec §6.5.2), motivo from subagent's
    //    suggested_motivo, plus the cross-link trace fields back to
    //    the proposal.
    const ev = db
      .query<
        {
          trigger: string;
          motivo: string;
          to_state: string;
          actor: string;
          evidence_json: string;
        },
        [string]
      >(
        `SELECT trigger, motivo, to_state, actor, evidence_json
           FROM eviction_events
          WHERE substrate = 'memory'
            AND object_id = ?
            AND object_scope = 'project_local'
            AND outcome = 'applied'
          ORDER BY recorded_at DESC LIMIT 1`,
      )
      .get('foo');
    expect(ev).toBeDefined();
    if (ev === null) throw new Error('unreachable');
    expect(ev.trigger).toBe('user_override_repeated');
    expect(ev.motivo).toBe('conflict');
    expect(ev.to_state).toBe('quarantined');
    expect(ev.actor).toBe('user');
    const evJson = JSON.parse(ev.evidence_json);
    expect(evJson.proposed_by).toBe('subagent:verify-override');
    expect(evJson.proposal_id).toBe(proposal.id);
    expect(evJson._operator_driven).toBe(true);
    expect(evJson.detector_evidence?.misguiding).toBe(true);
    expect(evJson.detector_evidence?.rule_extracted).toBe('always use --no-verify on commits');
  });

  test('below-threshold (2 events) → no dispatch, no proposal, registry unchanged', async () => {
    seedFactualMemory(roots.projectLocal, 'foo');
    const registry = createMemoryRegistry({ roots, db, sessionId, cwd: workdir });
    const now = 5_000_000_000_000;
    // Only 2 events — below the spec threshold of 3.
    for (let i = 0; i < 2; i++) {
      recordOverrideEvent(db, {
        sessionId,
        memoryScope: 'project_local',
        memoryName: 'foo',
        signal: 'memory_write_rejected',
        createdAt: now - i * 1000,
      });
    }
    const scheduler = createOverrideVerifyScheduler({
      db,
      registry,
      definition: fakeDefinition,
      parentSessionId: sessionId,
      cwd: workdir,
      provider: fakeProvider,
      parentToolRegistry: fakeToolRegistry,
      permissionEngine: fakePermissionEngine,
      spawnSubagentFn: (async () => misguidingResult()) as never,
      stderr: () => {},
      now: () => now,
    });
    await scheduler.poll();
    expect(scheduler.getCounters().dispatched).toBe(0);
    expect(listPendingProposals(db).length).toBe(0);
    expect(listRecentOverrideAttempts(db).length).toBe(0);
    // Memory stays active.
    const rawAfter = readFileSync(join(roots.projectLocal, 'foo.md'), 'utf-8');
    expect(rawAfter).not.toContain('state: quarantined');
  });

  test('cooldown prevents re-dispatch within window even with new event', async () => {
    seedFactualMemory(roots.projectLocal, 'foo');
    const registry = createMemoryRegistry({ roots, db, sessionId, cwd: workdir });
    const now = 5_000_000_000_000;
    for (let i = 0; i < 3; i++) {
      recordOverrideEvent(db, {
        sessionId,
        memoryScope: 'project_local',
        memoryName: 'foo',
        signal: 'memory_write_rejected',
        createdAt: now - i * 1000,
      });
    }
    const noiseResult = (): RunSubagentResult => ({
      output:
        'misguiding: false\nconfidence: 0.9\nrule_extracted: ""\noverride_pattern_observed: "noise"\nsuggested_motivo: conflict\n',
      sessionId: childSessionId,
      status: 'done',
      reason: 'done',
      costUsd: 0.05,
      steps: 1,
      durationMs: 100,
    });
    let spawnCount = 0;
    const scheduler = createOverrideVerifyScheduler({
      db,
      registry,
      definition: fakeDefinition,
      parentSessionId: sessionId,
      cwd: workdir,
      provider: fakeProvider,
      parentToolRegistry: fakeToolRegistry,
      permissionEngine: fakePermissionEngine,
      spawnSubagentFn: (async () => {
        spawnCount++;
        return noiseResult();
      }) as never,
      stderr: () => {},
      now: () => now,
    });
    await scheduler.poll();
    expect(spawnCount).toBe(1);
    // No proposal (misguiding=false), but attempt cached.
    expect(listRecentOverrideAttempts(db).length).toBe(1);
    expect(listPendingProposals(db).length).toBe(0);

    // A new override lands; threshold still satisfied. Re-poll —
    // cooldown should suppress re-dispatch.
    recordOverrideEvent(db, {
      sessionId,
      memoryScope: 'project_local',
      memoryName: 'foo',
      signal: 'memory_write_rejected',
      createdAt: now + 1000,
    });
    await scheduler.poll();
    // Still 1 — cooldown hit prevented the second spawn.
    expect(spawnCount).toBe(1);
    expect(scheduler.getCounters().dispatched).toBe(1);
  });

  test('pending proposal short-circuits subsequent polls', async () => {
    // After a proposal lands pending, the next poll's pending-
    // proposal gate skips the candidate — no LLM cost, no duplicate
    // proposal.
    seedFactualMemory(roots.projectLocal, 'foo');
    const registry = createMemoryRegistry({ roots, db, sessionId, cwd: workdir });
    const now = 5_000_000_000_000;
    for (let i = 0; i < 3; i++) {
      recordOverrideEvent(db, {
        sessionId,
        memoryScope: 'project_local',
        memoryName: 'foo',
        signal: 'permission_denied',
        createdAt: now - i * 1000,
      });
    }
    let spawnCount = 0;
    const scheduler = createOverrideVerifyScheduler({
      db,
      registry,
      definition: fakeDefinition,
      parentSessionId: sessionId,
      cwd: workdir,
      provider: fakeProvider,
      parentToolRegistry: fakeToolRegistry,
      permissionEngine: fakePermissionEngine,
      spawnSubagentFn: (async () => {
        spawnCount++;
        return misguidingResult();
      }) as never,
      stderr: () => {},
      now: () => now,
    });
    await scheduler.poll();
    expect(spawnCount).toBe(1);
    expect(listPendingProposals(db).length).toBe(1);

    // New override lands; threshold still satisfied; pending
    // proposal still pending. Re-poll: pending-proposal gate
    // short-circuits BEFORE the cooldown check.
    recordOverrideEvent(db, {
      sessionId,
      memoryScope: 'project_local',
      memoryName: 'foo',
      signal: 'permission_denied',
      createdAt: now + 1000,
    });
    await scheduler.poll();
    expect(spawnCount).toBe(1); // gate prevented re-dispatch
    expect(listPendingProposals(db).length).toBe(1); // still one
  });
});
