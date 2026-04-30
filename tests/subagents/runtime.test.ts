import { beforeEach, describe, expect, test } from 'bun:test';
import type { CollectedStep } from '../../src/harness/collect.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { Policy } from '../../src/permissions/index.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import {
  createSession,
  getSession,
  getSubagentRun,
  listChildSessions,
} from '../../src/storage/index.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { MAX_SUBAGENT_DEPTH, runSubagent, toEnvelope } from '../../src/subagents/runtime.ts';
import type { SubagentDefinition } from '../../src/subagents/types.ts';
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

const definition = (overrides: Partial<SubagentDefinition> = {}): SubagentDefinition => ({
  name: 'explore',
  description: 'Read-only.',
  tools: ['echo'],
  budget: { maxSteps: 5, maxCostUsd: 0.1 },
  systemPrompt: 'You are an exploration subagent.',
  scope: 'project',
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
    // Parent runs in plan mode → child harness must also block
    // writes, otherwise a subagent with `write_file` whitelisted
    // could mutate the tree under `--plan` via task().
    //
    // Setup: child whitelist contains write_file (legal in tests
    // because the loader's worktree refusal only fires through the
    // parser, not when constructing definitions directly), the
    // model's first turn calls write_file, and we assert the
    // tool_calls row landed with status='denied'.
    const parent = createSession(db, { model: 'mock/m', cwd: '/p' });
    const result = await runSubagent({
      definition: definition({ tools: ['write_file'] }),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: mockProvider([
        {
          text: '',
          tool_uses: [{ id: 'tu1', name: 'write_file', input: {} }],
          stop_reason: 'tool_use',
        },
        { text: 'after the deny', stop_reason: 'end_turn' },
      ]),
      parentToolRegistry: buildParentRegistry(echoTool, writeTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      planMode: true,
    });
    // Run completes (the harness writes a tool_result for the
    // denial and the model emits a closing turn). The audit row
    // for write_file in the CHILD session must be 'denied', NOT
    // 'done'.
    const writeCalls = db
      .query<{ status: string; session_id: string }, []>(
        `SELECT tc.status AS status, m.session_id AS session_id
         FROM tool_calls tc
         JOIN messages m ON tc.message_id = m.id
         WHERE tc.tool_name = 'write_file'`,
      )
      .all() as { status: string; session_id: string }[];
    const childCalls = writeCalls.filter((r) => r.session_id === result.sessionId);
    expect(childCalls.length).toBeGreaterThan(0);
    for (const row of childCalls) {
      expect(row.status).toBe('denied');
    }
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
