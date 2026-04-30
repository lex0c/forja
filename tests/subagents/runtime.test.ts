import { beforeEach, describe, expect, test } from 'bun:test';
import type { CollectedStep } from '../../src/harness/collect.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { Policy } from '../../src/permissions/index.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { createSession, getSession, listChildSessions } from '../../src/storage/index.ts';
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
  yield {
    kind: 'stop',
    reason: step.stop_reason ?? (step.tool_uses?.length ? 'tool_use' : 'end_turn'),
  };
};

interface MockOptions {
  recordRequests?: { messages: unknown[]; system: unknown }[];
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
      cost_per_1k_input: 0,
      cost_per_1k_output: 0,
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
    // Direct unit test on the runtime: passing depth>=MAX throws.
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
