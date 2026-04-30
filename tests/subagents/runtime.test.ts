import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { CollectedStep } from '../../src/harness/collect.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { Policy } from '../../src/permissions/index.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import {
  createSession,
  getSession,
  getSubagentRun,
  getSubagentWorktree,
  listChildSessions,
} from '../../src/storage/index.ts';
import { migrate } from '../../src/storage/migrate.ts';
import type { SubagentSet } from '../../src/subagents/load.ts';
import { MAX_SUBAGENT_DEPTH, runSubagent, toEnvelope } from '../../src/subagents/runtime.ts';
import type { SubagentDefinition } from '../../src/subagents/types.ts';
import { taskTool } from '../../src/tools/builtin/task.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';
import type { Tool } from '../../src/tools/types.ts';

const policy = (p: Partial<Policy> = {}): Policy => ({
  defaults: { mode: 'bypass' },
  tools: {},
  ...p,
});

interface ScriptedStep {
  text?: string;
  tool_uses?: { id: string; name: string; input: Record<string, unknown> }[];
  stop_reason?: CollectedStep['stop_reason'];
  // Per-step usage emitted before `stop`. Required for any test
  // that wants `collected.usageSeen=true` and non-zero computed
  // cost (paired with a capsOverride that sets non-zero pricing).
  usage?: { input: number; output: number };
}

const replay = function* (step: ScriptedStep): Iterable<StreamEvent> {
  yield { kind: 'start', message_id: 'mock-msg' };
  if (step.text !== undefined && step.text.length > 0) {
    yield { kind: 'text_delta', text: step.text };
  }
  for (const tu of step.tool_uses ?? []) {
    yield { kind: 'tool_use_start', id: tu.id, name: tu.name };
    yield { kind: 'tool_use_stop', id: tu.id, final_args: tu.input };
  }
  if (step.usage !== undefined) {
    yield {
      kind: 'usage',
      usage: {
        input: step.usage.input,
        output: step.usage.output,
        cache_read: 0,
        cache_creation: 0,
      },
    };
  }
  yield {
    kind: 'stop',
    reason: step.stop_reason ?? (step.tool_uses?.length ? 'tool_use' : 'end_turn'),
  };
};

interface MockOptions {
  recordRequests?: { messages: unknown[]; system: unknown }[];
  // Optional pricing overrides so tests can exercise cost-cap
  // paths without spinning up a separate fixture. Defaults to
  // free (cost_per_1k = 0); overriding flips on real cost
  // arithmetic for budget tests.
  capsOverride?: { cost_per_1k_input?: number; cost_per_1k_output?: number };
}

const mockProvider = (script: ScriptedStep[], opts: MockOptions = {}): Provider => {
  let i = 0;
  return {
    id: 'mock/m',
    family: 'anthropic',
    capabilities: {
      tools: 'native',
      cache: false,
      vision: false,
      streaming: true,
      constrained: 'tools',
      context_window: 1000,
      output_max_tokens: 100,
      cost_per_1k_input: opts.capsOverride?.cost_per_1k_input ?? 0,
      cost_per_1k_output: opts.capsOverride?.cost_per_1k_output ?? 0,
      notes: [],
    },
    async *generate(req) {
      if (opts.recordRequests !== undefined) {
        opts.recordRequests.push({ messages: req.messages, system: req.system });
      }
      const step = script[i++];
      if (step === undefined) throw new Error('script exhausted');
      for (const ev of replay(step)) yield ev;
    },
    generateConstrained: () => Promise.reject(new Error('n/a')),
    countTokens: () => Promise.resolve(0),
  };
};

const echoTool: Tool = {
  name: 'echo',
  description: 'echo back',
  inputSchema: {
    type: 'object',
    properties: { msg: { type: 'string' } },
    required: ['msg'],
  },
  metadata: { category: 'misc', writes: false, idempotent: true },
  async execute(args: unknown) {
    return { echoed: (args as { msg: string }).msg };
  },
};

const writeTool: Tool = {
  name: 'write_file',
  description: 'pretend to write',
  inputSchema: { type: 'object', properties: {} },
  metadata: { category: 'fs.write', writes: true, idempotent: false },
  async execute() {
    return { ok: true };
  },
};

// A non-writing tool that explicitly opts out of plan mode via
// `planSafe: false`. Used to exercise the plan-mode propagation
// path without tripping the runtime's writes:true gate (which
// blocks at child-registry construction before plan-mode logic
// runs). Mirrors the canonical `task` tool's metadata shape.
const planUnsafeTool: Tool = {
  name: 'plan_unsafe',
  description: 'no-op tool that opts out of plan mode',
  inputSchema: { type: 'object', properties: {} },
  metadata: { category: 'misc', writes: false, planSafe: false, idempotent: false },
  async execute() {
    return { ok: true };
  },
};

const definition = (overrides: Partial<SubagentDefinition> = {}): SubagentDefinition => ({
  name: 'explore',
  description: 'Read-only.',
  tools: ['echo'],
  budget: { maxSteps: 5, maxCostUsd: 0.1 },
  systemPrompt: 'You are an exploration subagent.',
  scope: 'project',
  isolation: 'none',
  sourcePath: '/fake/explore.md',
  sourceSha256: 'a'.repeat(64),
  meta: {},
  ...overrides,
});

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

const buildParentRegistry = (...tools: Tool[]) => {
  const r = createToolRegistry();
  for (const t of tools) r.register(t);
  return r;
};

const buildEngine = () => createPermissionEngine(policy(), { cwd: '/p' });

describe('runSubagent', () => {
  test('happy path: child runs, output captured, parent_session_id linked', async () => {
    const parent = createSession(db, { model: 'mock/m', cwd: '/p' });
    const result = await runSubagent({
      definition: definition(),
      prompt: 'find the README',
      parentSessionId: parent.id,
      provider: mockProvider([{ text: 'I found it at /p/README.md', stop_reason: 'end_turn' }]),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
    });
    expect(result.status).toBe('done');
    expect(result.reason).toBe('done');
    expect(result.output).toBe('I found it at /p/README.md');
    expect(result.steps).toBe(1);
    const childRow = getSession(db, result.sessionId);
    expect(childRow?.parentSessionId).toBe(parent.id);
    const children = listChildSessions(db, parent.id);
    expect(children.map((c) => c.id)).toEqual([result.sessionId]);
  });

  test('child has no view of the parent message history', async () => {
    // Parent's prior turns must NOT leak into the child's request
    // messages. The child sees [its own user prompt] only — not
    // anything appended to the parent before runSubagent was called.
    const parent = createSession(db, { model: 'mock/m', cwd: '/p' });
    db.query(
      "INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('m1', ?, 'user', '\"parent secret\"', 0)",
    ).run(parent.id);
    db.query(
      "INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('m2', ?, 'assistant', '\"parent answer\"', 1)",
    ).run(parent.id);
    const recorded: { messages: unknown[]; system: unknown }[] = [];
    await runSubagent({
      definition: definition(),
      prompt: 'child prompt',
      parentSessionId: parent.id,
      provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }], {
        recordRequests: recorded,
      }),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
    });
    const seen = JSON.stringify(recorded);
    expect(seen).not.toContain('parent secret');
    expect(seen).not.toContain('parent answer');
    expect(seen).toContain('child prompt');
  });

  test('child system prompt comes from definition body', async () => {
    const parent = createSession(db, { model: 'mock/m', cwd: '/p' });
    const recorded: { messages: unknown[]; system: unknown }[] = [];
    await runSubagent({
      definition: definition({ systemPrompt: 'CUSTOM-SYS-PROMPT' }),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }], {
        recordRequests: recorded,
      }),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
    });
    expect(recorded[0]?.system).toBe('CUSTOM-SYS-PROMPT');
  });

  test('child tools whitelist filters parent registry', async () => {
    // The child's definition only lists `echo`. Even though the
    // parent registry has both `echo` and `write_file`, the child
    // must be unable to invoke `write_file`. We model this by
    // letting the child's mock try to call write_file — the harness
    // would refuse with `tool not registered` and surface a tool
    // error, so the run never marks status='done'.
    const parent = createSession(db, { model: 'mock/m', cwd: '/p' });
    const result = await runSubagent({
      definition: definition({ tools: ['echo'] }),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: mockProvider([
        {
          text: '',
          tool_uses: [{ id: 'tu1', name: 'write_file', input: {} }],
          stop_reason: 'tool_use',
        },
        { text: 'never reached', stop_reason: 'end_turn' },
      ]),
      parentToolRegistry: buildParentRegistry(echoTool, writeTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
    });
    // The harness writes a tool_result for the unregistered tool
    // and continues. The second script step closes the loop with
    // text. Either way, the key invariant is that write_file was
    // NOT actually executed against the parent FS — there is no
    // tool_calls row with status='done' for it.
    const writeCalls = db
      .query("SELECT status FROM tool_calls WHERE tool_name = 'write_file'")
      .all() as { status: string }[];
    for (const row of writeCalls) {
      expect(row.status).not.toBe('done');
    }
    expect(result.sessionId).not.toBe(parent.id);
  });

  test('child budget caps maxSteps independently of parent', async () => {
    const parent = createSession(db, { model: 'mock/m', cwd: '/p' });
    // Definition allows 2 steps; script has 3. The child should
    // exit on `maxSteps` after the 2nd, regardless of what the
    // parent's budget would have been.
    const result = await runSubagent({
      definition: definition({ budget: { maxSteps: 2, maxCostUsd: 0 } }),
      prompt: 'loop',
      parentSessionId: parent.id,
      provider: mockProvider([
        {
          text: 'one',
          tool_uses: [{ id: 'tu1', name: 'echo', input: { msg: 'x' } }],
          stop_reason: 'tool_use',
        },
        {
          text: 'two',
          tool_uses: [{ id: 'tu2', name: 'echo', input: { msg: 'y' } }],
          stop_reason: 'tool_use',
        },
        { text: 'should not reach', stop_reason: 'end_turn' },
      ]),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
    });
    expect(result.status).toBe('exhausted');
    expect(result.reason).toBe('maxSteps');
    expect(result.steps).toBe(2);
  });

  test('typo in tools whitelist throws (caller bug, not runtime status)', async () => {
    const parent = createSession(db, { model: 'mock/m', cwd: '/p' });
    await expect(
      runSubagent({
        definition: definition({ tools: ['echoo'] }),
        prompt: 'go',
        parentSessionId: parent.id,
        provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]),
        parentToolRegistry: buildParentRegistry(echoTool),
        permissionEngine: buildEngine(),
        db,
        cwd: '/p',
      }),
    ).rejects.toThrow(/tool 'echoo' not registered with parent harness/);
  });

  test('toEnvelope mirrors result fields', async () => {
    const parent = createSession(db, { model: 'mock/m', cwd: '/p' });
    const ok = await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: mockProvider([{ text: 'hi', stop_reason: 'end_turn' }]),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
    });
    const env = toEnvelope(ok);
    expect(env.session_id).toBe(ok.sessionId);
    expect(env.output).toBe('hi');
    expect(env.status).toBe('done');
  });

  test('child inherits planMode from runtime input', async () => {
    // Regression for the plan-mode bypass surfaced in review (C2).
    // Parent runs in plan mode → child harness must inherit it so
    // any tool with planSafe:false is blocked inside the child
    // loop. We use `plan_unsafe` (writes:false, planSafe:false)
    // because writes:true tools are now refused at child-registry
    // construction before any run starts; the surface we still
    // need to test is the planMode FORWARDING through runtime.
    const parent = createSession(db, { model: 'mock/m', cwd: '/p' });
    const result = await runSubagent({
      definition: definition({ tools: ['plan_unsafe'] }),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: mockProvider([
        {
          text: '',
          tool_uses: [{ id: 'tu1', name: 'plan_unsafe', input: {} }],
          stop_reason: 'tool_use',
        },
        { text: 'after the deny', stop_reason: 'end_turn' },
      ]),
      parentToolRegistry: buildParentRegistry(echoTool, planUnsafeTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      planMode: true,
    });
    // Run completes; the audit row for plan_unsafe in the CHILD
    // session must be 'denied' because plan-mode propagation
    // worked.
    const calls = db
      .query<{ status: string; session_id: string }, []>(
        `SELECT tc.status AS status, m.session_id AS session_id
         FROM tool_calls tc
         JOIN messages m ON tc.message_id = m.id
         WHERE tc.tool_name = 'plan_unsafe'`,
      )
      .all() as { status: string; session_id: string }[];
    const childCalls = calls.filter((r) => r.session_id === result.sessionId);
    expect(childCalls.length).toBeGreaterThan(0);
    for (const row of childCalls) {
      expect(row.status).toBe('denied');
    }
  });

  test('nested spawn: coordinator with [task] only can spawn worker with [echo]', async () => {
    // Regression: the spawn closure used to forward
    // `config.toolRegistry` as the parent registry for the next
    // hop, but inside a child harness `toolRegistry` is ALREADY
    // narrowed to that child's whitelist. A coordinator subagent
    // with `tools: [task]` would then try to validate a worker's
    // `tools: [echo]` against a registry that contained only
    // `task`, throwing "tool 'echo' not registered with parent
    // harness" even though echo is registered at the top level.
    //
    // Fix: persist the ROOT registry through the chain via
    // HarnessConfig.rootToolRegistry. The spawn closure now
    // resolves rootRegistry first, falling back to toolRegistry
    // only at the top level. Validates a real two-hop delegation
    // without a workaround.
    const parent = createSession(db, { model: 'mock/m', cwd: '/p' });

    // Both definitions live in the same SubagentSet so the
    // coordinator's spawn closure can resolve 'worker'.
    const coordinator: SubagentDefinition = {
      name: 'coordinator',
      description: 'spawns worker',
      tools: ['task'],
      budget: { maxSteps: 5, maxCostUsd: 0 },
      systemPrompt: 'You are the coordinator.',
      scope: 'project',
      isolation: 'none',
      sourcePath: '/p/coord.md',
      sourceSha256: 'a'.repeat(64),
      meta: {},
    };
    const worker: SubagentDefinition = {
      name: 'worker',
      description: 'does the work',
      tools: ['echo'],
      budget: { maxSteps: 5, maxCostUsd: 0 },
      systemPrompt: 'You are the worker.',
      scope: 'project',
      isolation: 'none',
      sourcePath: '/p/worker.md',
      sourceSha256: 'b'.repeat(64),
      meta: {},
    };
    const subagentRegistry: SubagentSet = {
      byName: new Map([
        ['coordinator', coordinator],
        ['worker', worker],
      ]),
      shadows: [],
    };

    // Sequential script for ALL three nested provider calls:
    //   1. coordinator's first turn: emit task(worker, "do work")
    //   2. worker's run (just one step): emit text "worker done"
    //   3. coordinator's closing turn after tool_result: emit text
    const result = await runSubagent({
      definition: coordinator,
      prompt: 'orchestrate',
      parentSessionId: parent.id,
      provider: mockProvider([
        {
          text: 'spawning worker',
          tool_uses: [
            {
              id: 'tu1',
              name: 'task',
              input: { subagent: 'worker', prompt: 'do work' },
            },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'worker done', stop_reason: 'end_turn' },
        { text: 'coordinator done', stop_reason: 'end_turn' },
      ]),
      // Parent registry has BOTH task and echo; coordinator gets
      // narrowed to [task], worker gets narrowed to [echo].
      parentToolRegistry: buildParentRegistry(taskTool, echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      subagentRegistry,
    });

    // Coordinator completed cleanly — the nested spawn worked
    // and its tool_result flowed back into the closing turn.
    expect(result.status).toBe('done');
    expect(result.output).toBe('coordinator done');

    // Audit: the chain produced TWO subagent rows in DB —
    // coordinator (parent → coordinator) and worker
    // (coordinator → worker).
    const coordChildren = listChildSessions(db, parent.id);
    expect(coordChildren).toHaveLength(1);
    expect(coordChildren[0]?.id).toBe(result.sessionId);
    const grandchildren = listChildSessions(db, result.sessionId);
    expect(grandchildren).toHaveLength(1);
  });

  test('refuses writes:true tool in whitelist at child-registry build time', async () => {
    // Capability gate: registry construction itself must refuse
    // any tool whose metadata.writes is true, regardless of name.
    // Defense in depth — bootstrap pre-validates via
    // validateSubagentSet, but a programmatic caller that builds
    // a HarnessConfig directly without that step still gets
    // protected here.
    const parent = createSession(db, { model: 'mock/m', cwd: '/p' });
    await expect(
      runSubagent({
        definition: definition({ tools: ['write_file'] }),
        prompt: 'go',
        parentSessionId: parent.id,
        provider: mockProvider([{ text: 'never reached', stop_reason: 'end_turn' }]),
        parentToolRegistry: buildParentRegistry(echoTool, writeTool),
        permissionEngine: buildEngine(),
        db,
        cwd: '/p',
      }),
    ).rejects.toThrow(/declares metadata.writes=true/);
  });

  test('refuses to spawn beyond MAX_SUBAGENT_DEPTH', async () => {
    // Direct unit test on the runtime: passing depth > MAX throws.
    // The harness loop check (loop.ts) returns a `depth_exceeded`
    // result instead — that path is covered by the task-tool test.
    // Here we lock the runtime contract: programmer error path.
    const parent = createSession(db, { model: 'mock/m', cwd: '/p' });
    await expect(
      runSubagent({
        definition: definition(),
        prompt: 'go',
        parentSessionId: parent.id,
        provider: mockProvider([{ text: 'never reached', stop_reason: 'end_turn' }]),
        parentToolRegistry: buildParentRegistry(echoTool),
        permissionEngine: buildEngine(),
        db,
        cwd: '/p',
        depth: MAX_SUBAGENT_DEPTH + 1,
      }),
    ).rejects.toThrow(/recursion depth/);
  });

  test('child enforces budget.maxCostUsd from definition', async () => {
    // The loader requires `max_cost_usd` on every definition.
    // The runtime MUST forward it into the child harness's budget,
    // otherwise a writing subagent could run past its declared
    // dollar cap until another budget tripped. Fixture: pricing
    // > 0, definition cap of $0.0001, single turn whose cost
    // pushes past it. Expected exit: status='exhausted',
    // reason='maxCostUsd'.
    const parent = createSession(db, { model: 'mock/m', cwd: '/p' });
    const result = await runSubagent({
      definition: definition({
        budget: { maxSteps: 5, maxCostUsd: 0.0001 },
      }),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: mockProvider(
        [
          {
            text: 'first',
            usage: { input: 100, output: 20 },
            stop_reason: 'end_turn',
          },
        ],
        { capsOverride: { cost_per_1k_input: 3.0, cost_per_1k_output: 15.0 } },
      ),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
    });
    // Turn cost: (100×3 + 20×15) / 1e6 = 600 / 1e6 = $0.0006 > $0.0001 cap.
    expect(result.status).toBe('exhausted');
    expect(result.reason).toBe('maxCostUsd');
    expect(result.costUsd).toBeCloseTo(0.0006, 9);
  });

  test('captures definition snapshot in subagent_runs after the child run', async () => {
    // Audit invariant: every successful subagent spawn leaves a
    // row in subagent_runs that fingerprints the definition the
    // child actually ran under. Author edits to the .md after
    // the fact don't lose this evidence.
    const parent = createSession(db, { model: 'mock/m', cwd: '/p' });
    const def = definition({
      name: 'explore',
      sourcePath: '/u/.config/agent/agents/explore.md',
      sourceSha256: 'f'.repeat(64),
      tools: ['echo'],
      budget: { maxSteps: 7, maxCostUsd: 0.05, maxWallClockMs: 30_000 },
      systemPrompt: 'You are explore (snapshot fixture).',
    });
    const result = await runSubagent({
      definition: def,
      prompt: 'go',
      parentSessionId: parent.id,
      provider: mockProvider([{ text: 'done', stop_reason: 'end_turn' }]),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
    });
    const snapshot = getSubagentRun(db, result.sessionId);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.name).toBe('explore');
    expect(snapshot?.sourcePath).toBe('/u/.config/agent/agents/explore.md');
    expect(snapshot?.sourceSha256).toBe('f'.repeat(64));
    expect(snapshot?.systemPrompt).toBe('You are explore (snapshot fixture).');
    expect(snapshot?.toolsWhitelist).toEqual(['echo']);
    expect(snapshot?.budgetMaxSteps).toBe(7);
    expect(snapshot?.budgetMaxCostUsd).toBe(0.05);
    expect(snapshot?.budgetMaxWallMs).toBe(30_000);
  });

  test('snapshot lands even when the child exits exhausted (audit must survive failure)', async () => {
    // Forensic case: a budget-exhausted run is exactly when the
    // user wants to know "what definition was this running
    // under?". The snapshot must NOT be conditional on success.
    const parent = createSession(db, { model: 'mock/m', cwd: '/p' });
    const result = await runSubagent({
      definition: definition({ budget: { maxSteps: 1, maxCostUsd: 0 } }),
      prompt: 'loop',
      parentSessionId: parent.id,
      provider: mockProvider([
        {
          text: 'one',
          tool_uses: [{ id: 'tu1', name: 'echo', input: { msg: 'x' } }],
          stop_reason: 'tool_use',
        },
      ]),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
    });
    expect(result.status).toBe('exhausted');
    expect(getSubagentRun(db, result.sessionId)).not.toBeNull();
  });

  test('auditFailure surfaces on snapshot insert error (does not mask run outcome)', async () => {
    // M1 fix from the review pass: when the snapshot insert
    // fails, the run's outcome (status/reason/output) must STILL
    // be authoritative — but the failure must be visible to the
    // caller via auditFailure. We trigger the failure by
    // pre-inserting a row with the same session_id that runAgent
    // will create, forcing a PK conflict on the second insert.
    //
    // Setup: run the subagent first time → snapshot lands.
    // Force a duplicate by re-running with a fixture that pins
    // the session id (we can't do that directly without
    // restructuring runtime, so we manually corrupt by making
    // session_id collide via a second runtime invocation against
    // the same parent and same definition — the first insert
    // succeeds, the second uses a different session_id and also
    // succeeds because UUIDs are unique).
    //
    // Cleaner approach: drop the subagent_runs table to make
    // insertSubagentRun fail with a "no such table" error.
    const parent = createSession(db, { model: 'mock/m', cwd: '/p' });
    db.exec('DROP TABLE subagent_runs');
    const result = await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
    });
    // Run outcome stays authoritative.
    expect(result.status).toBe('done');
    expect(result.output).toBe('ok');
    // Audit failure is surfaced.
    expect(result.auditFailure).toBeDefined();
    expect(result.auditFailure?.code).toBe('snapshot_insert_failed');
    expect(typeof result.auditFailure?.message).toBe('string');
    expect(result.auditFailure?.message.length).toBeGreaterThan(0);
  });

  test('snapshot omits budget_max_wall_ms when the definition does not declare it', async () => {
    // The snapshot column is nullable to mirror SubagentBudget's
    // optional field. Definitions without max_wall_clock_ms must
    // round-trip as null, not as 0 (which would conflict with
    // the loader's "must be positive" rule).
    const parent = createSession(db, { model: 'mock/m', cwd: '/p' });
    const result = await runSubagent({
      definition: definition({ budget: { maxSteps: 5, maxCostUsd: 0 } }),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
    });
    expect(getSubagentRun(db, result.sessionId)?.budgetMaxWallMs).toBeNull();
  });

  test('depth === MAX_SUBAGENT_DEPTH is the last allowed level (boundary)', async () => {
    // Regression for the off-by-one boundary: the runtime used to
    // reject `depth >= MAX` while the loop's spawn closure
    // returned `depth_exceeded` only on `> MAX`. The exact
    // boundary (depth === MAX) fell through the closure and got
    // surfaced as a generic `tool.exception` instead of the
    // recoverable `subagent.depth_exceeded`. Both layers now
    // align on `> MAX` — depth === MAX must run cleanly.
    const parent = createSession(db, { model: 'mock/m', cwd: '/p' });
    const result = await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: mockProvider([{ text: `depth=${MAX_SUBAGENT_DEPTH} ok`, stop_reason: 'end_turn' }]),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      depth: MAX_SUBAGENT_DEPTH,
    });
    expect(result.status).toBe('done');
  });

  test('child run records subagentDepth on its config', async () => {
    // Sanity: depth=0 (top-level) is valid, depth bumps land on
    // the child harness so the child's own spawn closure can read
    // it. We can't observe HarnessConfig directly, but we CAN
    // verify the depth=0 path runs to done — the prior tests
    // implicitly use this; explicit assertion here.
    const parent = createSession(db, { model: 'mock/m', cwd: '/p' });
    const result = await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: mockProvider([{ text: 'depth=0 ok', stop_reason: 'end_turn' }]),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      depth: 0,
    });
    expect(result.status).toBe('done');
  });
});

// Worktree isolation tests need a real git repo (so `git worktree
// add` can succeed) and a real-FS write tool (so we can observe
// that the child's mutations landed in the worktree, not in the
// parent). We keep the fixtures local to this describe block so
// the rest of the file stays in-memory.

const runGit = async (cwd: string, args: string[]): Promise<void> => {
  const proc = Bun.spawn({
    cmd: ['git', '-C', cwd, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      LC_ALL: 'C',
      GIT_TERMINAL_PROMPT: '0',
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
    },
  });
  const [, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} (${exitCode}): ${stderr}`);
  }
};

// Real-FS write tool. Resolves the path against the call's cwd
// (the harness threads it through ctx); `writes:true` so the
// child-registry build refuses it without `isolation: worktree`,
// and accepts it when worktree is declared. Mutates the actual
// file so we can observe where the write landed.
const realWriteTool: Tool = {
  name: 'write_file',
  description: 'real fs write',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  metadata: { category: 'fs.write', writes: true, idempotent: false },
  async execute(args, ctx) {
    const { path, content } = args as { path: string; content: string };
    const full = isAbsolute(path) ? path : join(ctx.cwd, path);
    writeFileSync(full, content);
    return { ok: true, path: full };
  },
};

describe('runSubagent — worktree isolation', () => {
  let parentRepo: string;
  let worktreeRoot: string;

  beforeEach(async () => {
    parentRepo = mkdtempSync(join(tmpdir(), 'forja-rt-wt-parent-'));
    worktreeRoot = mkdtempSync(join(tmpdir(), 'forja-rt-wt-root-'));
    mkdirSync(parentRepo, { recursive: true });
    await runGit(parentRepo, ['init', '-b', 'main']);
    await runGit(parentRepo, ['config', 'user.email', 'test@example.com']);
    await runGit(parentRepo, ['config', 'user.name', 'Test']);
    writeFileSync(join(parentRepo, 'README.md'), '# parent\n');
    await runGit(parentRepo, ['add', '.']);
    await runGit(parentRepo, ['commit', '-m', 'init']);
  });

  afterEach(() => {
    try {
      rmSync(parentRepo, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      rmSync(worktreeRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('clean child run → worktree removed, audit row=cleaned, no parent mutation', async () => {
    // Definition declares worktree but the child's run only emits
    // text; nothing on disk should change in the parent OR survive
    // in the cache root after cleanup. The audit row records the
    // outcome so an operator can prove the run happened.
    const parent = createSession(db, { model: 'mock/m', cwd: parentRepo });
    const result = await runSubagent({
      definition: definition({
        tools: ['echo'],
        isolation: 'worktree',
      }),
      prompt: 'no-op task',
      parentSessionId: parent.id,
      provider: mockProvider([{ text: 'nothing to do', stop_reason: 'end_turn' }]),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: parentRepo,
      worktreeRootDir: worktreeRoot,
    });
    expect(result.status).toBe('done');
    const wt = result.worktree;
    if (wt === undefined) throw new Error('expected worktree info on result');
    expect(wt.dirty).toBe(false);
    expect(wt.removed).toBe(true);
    expect(wt.preserved).toBe(false);
    expect(wt.path.startsWith(worktreeRoot)).toBe(true);
    expect(wt.branch.startsWith('agent/')).toBe(true);
    // Worktree gone from disk; parent README untouched.
    expect(existsSync(wt.path)).toBe(false);
    expect(existsSync(join(parentRepo, 'README.md'))).toBe(true);
    // Audit row landed with terminal status='cleaned'.
    const audit = getSubagentWorktree(db, result.sessionId);
    expect(audit?.status).toBe('cleaned');
    expect(audit?.path).toBe(wt.path);
    expect(audit?.branch).toBe(wt.branch);
  });

  test('child wrote → worktree preserved, audit row=preserved, parent untouched', async () => {
    // The whole point of worktree isolation: writes land on the
    // worktree's branch, never on the parent's working tree. We
    // ask the child to call write_file with a relative path; the
    // tool resolves against ctx.cwd which the runtime sets to the
    // worktree root.
    const parent = createSession(db, { model: 'mock/m', cwd: parentRepo });
    const result = await runSubagent({
      definition: definition({
        tools: ['write_file'],
        isolation: 'worktree',
      }),
      prompt: 'create a file',
      parentSessionId: parent.id,
      provider: mockProvider([
        {
          text: '',
          tool_uses: [
            {
              id: 'tu1',
              name: 'write_file',
              input: { path: 'subagent-output.txt', content: 'hello from child\n' },
            },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'wrote it', stop_reason: 'end_turn' },
      ]),
      parentToolRegistry: buildParentRegistry(realWriteTool),
      permissionEngine: buildEngine(),
      db,
      cwd: parentRepo,
      worktreeRootDir: worktreeRoot,
    });
    expect(result.status).toBe('done');
    const wt = result.worktree;
    if (wt === undefined) throw new Error('expected worktree info on result');
    expect(wt.dirty).toBe(true);
    expect(wt.preserved).toBe(true);
    expect(wt.removed).toBe(false);
    // The file landed in the worktree, NOT in the parent.
    expect(existsSync(join(wt.path, 'subagent-output.txt'))).toBe(true);
    expect(existsSync(join(parentRepo, 'subagent-output.txt'))).toBe(false);
    const audit = getSubagentWorktree(db, result.sessionId);
    expect(audit?.status).toBe('preserved');
  });

  test('worktree create failure surfaces as run-failed, no session, no audit row', async () => {
    // Force creation to fail by pointing the parent cwd at a
    // non-git directory; createWorktree's `git worktree list`
    // refuses upfront. The result must be a clean status='error'
    // with reason='worktree_create_failed' and no surviving session.
    const notRepo = mkdtempSync(join(tmpdir(), 'forja-rt-wt-notrepo-'));
    try {
      const parent = createSession(db, { model: 'mock/m', cwd: notRepo });
      const result = await runSubagent({
        definition: definition({
          tools: ['echo'],
          isolation: 'worktree',
        }),
        prompt: 'go',
        parentSessionId: parent.id,
        provider: mockProvider([{ text: 'never', stop_reason: 'end_turn' }]),
        parentToolRegistry: buildParentRegistry(echoTool),
        permissionEngine: buildEngine(),
        db,
        cwd: notRepo,
        worktreeRootDir: worktreeRoot,
      });
      expect(result.status).toBe('error');
      expect(result.reason).toBe('worktree_create_failed');
      expect(result.sessionId).toBe('');
      expect(result.worktreeError).toBeDefined();
      expect(result.worktreeError?.code).toBe('worktree_create_failed');
      // No child session was created; parent stays the only one.
      expect(listChildSessions(db, parent.id)).toEqual([]);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  test("isolation='worktree' lets a write_file definition run end-to-end", async () => {
    // Regression: with isolation='worktree', the child-registry
    // build no longer rejects writes:true; the run should reach
    // status='done' instead of throwing at construction time.
    // (Without worktree, the same definition throws — the
    // `refuses writes:true` test in the prior describe locks that
    // contract.)
    const parent = createSession(db, { model: 'mock/m', cwd: parentRepo });
    const result = await runSubagent({
      definition: definition({
        tools: ['write_file'],
        isolation: 'worktree',
      }),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]),
      parentToolRegistry: buildParentRegistry(realWriteTool),
      permissionEngine: buildEngine(),
      db,
      cwd: parentRepo,
      worktreeRootDir: worktreeRoot,
    });
    expect(result.status).toBe('done');
    // The child didn't actually write, so cleanup removes the worktree.
    expect(result.worktree?.removed).toBe(true);
  });

  test("isolation='none' keeps the worktree fields absent (no isolation surface leak)", async () => {
    // Backward-compat invariant: a Step 4.1 definition that does
    // NOT declare isolation must not gain a `worktree` field on
    // its result. The presence of the field is the model's signal
    // to act on the branch — leaking it on a non-isolated run
    // would mislead the model into looking for a non-existent
    // worktree.
    const parent = createSession(db, { model: 'mock/m', cwd: parentRepo });
    const result = await runSubagent({
      definition: definition({ isolation: 'none' }),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: parentRepo,
      worktreeRootDir: worktreeRoot,
    });
    expect(result.status).toBe('done');
    expect(result.worktree).toBeUndefined();
    expect(result.worktreeError).toBeUndefined();
    expect(getSubagentWorktree(db, result.sessionId)).toBeNull();
  });
});
