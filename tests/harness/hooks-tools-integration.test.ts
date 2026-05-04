import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollectedStep } from '../../src/harness/collect.ts';
import { runAgent } from '../../src/harness/loop.ts';
import type { HarnessConfig } from '../../src/harness/types.ts';
import { DEFAULT_HOOK_TIMEOUT_MS, type HookSpec } from '../../src/hooks/index.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { Policy } from '../../src/permissions/index.ts';
import type { GenerateRequest, Provider, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listApprovalsByToolCall } from '../../src/storage/repos/approvals.ts';
import { listHookRunsBySession } from '../../src/storage/repos/hook-runs.ts';
import { listMessagesBySession } from '../../src/storage/repos/messages.ts';
import { listToolCallsByMessage } from '../../src/storage/repos/tool-calls.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';
import type { Tool } from '../../src/tools/types.ts';

// End-to-end Slice 3: PreToolUse + PostToolUse. Drives runAgent
// with a real hook chain and asserts:
//   - PreToolUse can BLOCK a tool call (first-block-wins)
//   - PostToolUse fires AFTER tool completes with full output
//   - Audit trail records both decisions (policy allow + hook deny)
//   - Matcher (`tool = "name"` / `"name*"`) gates which hook fires

interface ScriptedStep {
  text?: string;
  tool_uses?: { id: string; name: string; input: Record<string, unknown> }[];
  stop_reason?: CollectedStep['stop_reason'];
}

const replayStep = function* (step: ScriptedStep): Iterable<StreamEvent> {
  yield { kind: 'start', message_id: `mock_${crypto.randomUUID()}` };
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

const mockProvider = (script: ScriptedStep[]): Provider => {
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
      context_window: 200_000,
      output_max_tokens: 4096,
      cost_per_1k_input: 0,
      cost_per_1k_output: 0,
      notes: [],
    },
    async *generate(_req: GenerateRequest) {
      const step = script[i++];
      if (step === undefined) throw new Error('mock script exhausted');
      for (const ev of replayStep(step)) yield ev;
    },
    generateConstrained: () => Promise.reject(new Error('not implemented')),
    countTokens: () => Promise.resolve(0),
  };
};

const policy = (p: Partial<Policy> = {}): Policy => ({
  defaults: { mode: 'bypass' },
  tools: {},
  ...p,
});

const baseSpec = (
  overrides: Partial<HookSpec> & Pick<HookSpec, 'event' | 'command'>,
): HookSpec => ({
  layer: 'project',
  sourcePath: '/tmp/test-hooks.toml',
  matcher: {},
  timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
  failClosed: false,
  locked: false,
  ...overrides,
});

// Tool that records its calls and returns a fixed payload. Used
// across tests so we can assert "did the body actually run?"
// independently of the tool_call audit row.
const makeRecordingTool = (calls: { args: Record<string, unknown> }[]): Tool => ({
  name: 'echo',
  description: 'records its call',
  inputSchema: { type: 'object' },
  metadata: { category: 'misc', writes: false, idempotent: true },
  async execute(args) {
    calls.push({ args: args as Record<string, unknown> });
    return { ran: true };
  },
});

let scratch: string;
let db: DB;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'forja-hooks-tools-'));
  db = openMemoryDb();
  migrate(db);
});

afterEach(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  db.close();
});

describe('hooks Slice 3 — PreToolUse', () => {
  test('allow (exit 0) → tool runs', async () => {
    const calls: { args: Record<string, unknown> }[] = [];
    const tool = makeRecordingTool(calls);
    const registry = createToolRegistry();
    registry.register(tool);

    const hooks: HookSpec[] = [baseSpec({ event: 'PreToolUse', command: 'true' })];
    const config: HarnessConfig = {
      provider: mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'echo', input: { x: 1 } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'go',
      hooks,
    };
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(calls).toHaveLength(1);

    const runs = listHookRunsBySession(db, result.sessionId);
    const pre = runs.filter((r) => r.event === 'PreToolUse');
    expect(pre).toHaveLength(1);
    expect(pre[0]?.outcome).toBe('allow');
    expect(pre[0]?.matchedTool).toBe('echo');
  });

  test('block_silent (exit 1) → tool denied without operator message', async () => {
    const calls: { args: Record<string, unknown> }[] = [];
    const tool = makeRecordingTool(calls);
    const registry = createToolRegistry();
    registry.register(tool);

    const hooks: HookSpec[] = [baseSpec({ event: 'PreToolUse', command: 'exit 1' })];
    const config: HarnessConfig = {
      provider: mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'echo', input: {} }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'go',
      hooks,
    };
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    // Tool body never ran.
    expect(calls).toEqual([]);

    // hook_runs row landed with outcome=block_silent, matchedTool=echo
    const runs = listHookRunsBySession(db, result.sessionId);
    const pre = runs.filter((r) => r.event === 'PreToolUse');
    expect(pre).toHaveLength(1);
    expect(pre[0]?.outcome).toBe('block_silent');
    expect(pre[0]?.matchedTool).toBe('echo');

    // approvals: TWO rows on the tool_call (policy allow + hook deny).
    // First find the assistant message that carried the tool_use.
    const messages = listMessagesBySession(db, result.sessionId);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    const toolCalls = listToolCallsByMessage(db, assistant?.id ?? '');
    expect(toolCalls).toHaveLength(1);
    const approvals = listApprovalsByToolCall(db, toolCalls[0]?.id ?? '');
    const decisions = approvals.map((a) => `${a.decidedBy}:${a.decision}`).sort();
    expect(decisions).toEqual(['hook:deny', 'policy:allow']);
    // tool_call status = denied
    expect(toolCalls[0]?.status).toBe('denied');
  });

  test('block_message (exit 2) → operator stdout becomes denial reason', async () => {
    const calls: { args: Record<string, unknown> }[] = [];
    const tool = makeRecordingTool(calls);
    const registry = createToolRegistry();
    registry.register(tool);

    const hooks: HookSpec[] = [
      baseSpec({
        event: 'PreToolUse',
        command: 'echo "blocked: dangerous arg detected"; exit 2',
      }),
    ];
    const config: HarnessConfig = {
      provider: mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'echo', input: {} }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'go',
      hooks,
    };
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(calls).toEqual([]);

    const runs = listHookRunsBySession(db, result.sessionId);
    const pre = runs.filter((r) => r.event === 'PreToolUse');
    expect(pre[0]?.outcome).toBe('block_message');
    // Operator message captured in audit
    expect(pre[0]?.stdout).toContain('blocked: dangerous arg detected');

    // Hook approval reason carries the operator's message
    const messages = listMessagesBySession(db, result.sessionId);
    const assistant = messages.find((m) => m.role === 'assistant');
    const toolCalls = listToolCallsByMessage(db, assistant?.id ?? '');
    const approvals = listApprovalsByToolCall(db, toolCalls[0]?.id ?? '');
    const hookApproval = approvals.find((a) => a.decidedBy === 'hook');
    expect(hookApproval?.reason).toContain('blocked: dangerous arg detected');
  });

  test('error + failClosed=true → blocks (treated as silent)', async () => {
    const calls: { args: Record<string, unknown> }[] = [];
    const tool = makeRecordingTool(calls);
    const registry = createToolRegistry();
    registry.register(tool);

    const hooks: HookSpec[] = [
      baseSpec({
        event: 'PreToolUse',
        command: 'exit 7', // >2 → error per dispatcher
        failClosed: true,
      }),
    ];
    const config: HarnessConfig = {
      provider: mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'echo', input: {} }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'go',
      hooks,
    };
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(calls).toEqual([]); // blocked

    const runs = listHookRunsBySession(db, result.sessionId);
    const pre = runs.filter((r) => r.event === 'PreToolUse');
    expect(pre[0]?.outcome).toBe('error');
    expect(pre[0]?.exitCode).toBe(7);
  });

  test('error + failClosed=false → does NOT block (log only)', async () => {
    const calls: { args: Record<string, unknown> }[] = [];
    const tool = makeRecordingTool(calls);
    const registry = createToolRegistry();
    registry.register(tool);

    const hooks: HookSpec[] = [
      baseSpec({
        event: 'PreToolUse',
        command: 'exit 7',
        failClosed: false, // default
      }),
    ];
    const config: HarnessConfig = {
      provider: mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'echo', input: {} }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'go',
      hooks,
    };
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(calls).toHaveLength(1); // tool ran despite hook error
  });

  test('first-block-wins: chain stops at first blocking hook', async () => {
    const calls: { args: Record<string, unknown> }[] = [];
    const tool = makeRecordingTool(calls);
    const registry = createToolRegistry();
    registry.register(tool);

    const hooks: HookSpec[] = [
      baseSpec({ event: 'PreToolUse', command: 'true' }), // allow
      baseSpec({ event: 'PreToolUse', command: 'exit 1' }), // block
      baseSpec({ event: 'PreToolUse', command: 'true' }), // would-allow
    ];
    const config: HarnessConfig = {
      provider: mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'echo', input: {} }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'go',
      hooks,
    };
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(calls).toEqual([]);

    // 2 rows: the allow + the block. Third hook should NOT have run.
    const runs = listHookRunsBySession(db, result.sessionId);
    const pre = runs.filter((r) => r.event === 'PreToolUse');
    expect(pre).toHaveLength(2);
    expect(pre.map((r) => r.outcome).sort()).toEqual(['allow', 'block_silent']);
  });

  test('matcher tool="exact" filters to only that tool', async () => {
    const calls: { args: Record<string, unknown> }[] = [];
    const tool = makeRecordingTool(calls);
    const registry = createToolRegistry();
    registry.register(tool);
    // Second tool — same category, different name
    registry.register({
      name: 'other',
      description: 'other tool',
      inputSchema: { type: 'object' },
      metadata: { category: 'misc', writes: false, idempotent: true },
      async execute() {
        return { ok: true };
      },
    });

    // Hook only matches "echo"; "other" should run unhindered.
    const hooks: HookSpec[] = [
      baseSpec({
        event: 'PreToolUse',
        command: 'exit 1',
        matcher: { tool: 'echo' },
      }),
    ];
    const config: HarnessConfig = {
      provider: mockProvider([
        {
          tool_uses: [
            { id: 'tu1', name: 'other', input: {} },
            { id: 'tu2', name: 'echo', input: {} },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'go',
      hooks,
    };
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    // echo was blocked; other ran
    expect(calls).toEqual([]);

    const runs = listHookRunsBySession(db, result.sessionId);
    const pre = runs.filter((r) => r.event === 'PreToolUse');
    // Single hook fired once — for `echo` only.
    expect(pre).toHaveLength(1);
    expect(pre[0]?.matchedTool).toBe('echo');
  });

  test('matcher tool="prefix*" wildcard matches by prefix', async () => {
    const calls: { args: Record<string, unknown> }[] = [];
    const tool: Tool = {
      name: 'bash_run',
      description: 'pseudo-bash run',
      inputSchema: { type: 'object' },
      metadata: { category: 'misc', writes: false, idempotent: true },
      async execute(args) {
        calls.push({ args: args as Record<string, unknown> });
        return { ok: true };
      },
    };
    const registry = createToolRegistry();
    registry.register(tool);

    const hooks: HookSpec[] = [
      baseSpec({
        event: 'PreToolUse',
        command: 'exit 1',
        matcher: { tool: 'bash*' }, // matches bash_run, bash_kill, bash, bash_background
      }),
    ];
    const config: HarnessConfig = {
      provider: mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'bash_run', input: {} }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'go',
      hooks,
    };
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(calls).toEqual([]); // wildcard caught it

    const runs = listHookRunsBySession(db, result.sessionId);
    const pre = runs.filter((r) => r.event === 'PreToolUse');
    expect(pre[0]?.matchedTool).toBe('bash_run');
  });

  test('payload.data.tool.input reaches stdin', async () => {
    const marker = join(scratch, 'input-arg.txt');
    const tool = makeRecordingTool([]);
    const registry = createToolRegistry();
    registry.register(tool);

    const hooks: HookSpec[] = [
      baseSpec({
        event: 'PreToolUse',
        command: `cat > ${marker}`,
      }),
    ];
    const config: HarnessConfig = {
      provider: mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'echo', input: { msg: 'hello' } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'go',
      hooks,
    };
    await runAgent(config);
    const parsed = JSON.parse(await readFile(marker, 'utf8'));
    expect(parsed.event).toBe('PreToolUse');
    expect(parsed.data.tool.name).toBe('echo');
    expect(parsed.data.tool.input).toEqual({ msg: 'hello' });
  });
});

describe('hooks Slice 3 — PostToolUse', () => {
  test('fires after tool runs successfully; payload includes output', async () => {
    const marker = join(scratch, 'post.txt');
    const tool = makeRecordingTool([]);
    const registry = createToolRegistry();
    registry.register(tool);

    const hooks: HookSpec[] = [
      baseSpec({
        event: 'PostToolUse',
        command: `cat > ${marker}`,
      }),
    ];
    const config: HarnessConfig = {
      provider: mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'echo', input: { msg: 'x' } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'go',
      hooks,
    };
    const result = await runAgent(config);
    expect(result.status).toBe('done');

    // Wait briefly for fire-and-forget hook to settle.
    await new Promise((r) => setTimeout(r, 200));

    const parsed = JSON.parse(await readFile(marker, 'utf8'));
    expect(parsed.event).toBe('PostToolUse');
    expect(parsed.data.tool.name).toBe('echo');
    expect(parsed.data.tool.input).toEqual({ msg: 'x' });
    expect(parsed.data.tool.output).toEqual({ ran: true });
    expect(parsed.data.tool.failed).toBe(false);

    const runs = listHookRunsBySession(db, result.sessionId);
    const post = runs.filter((r) => r.event === 'PostToolUse');
    expect(post).toHaveLength(1);
    expect(post[0]?.matchedTool).toBe('echo');
  });

  test('fires with failed=true when tool errors', async () => {
    const marker = join(scratch, 'post-fail.txt');
    const tool: Tool = {
      name: 'flaky',
      description: 'always errors',
      inputSchema: { type: 'object' },
      metadata: { category: 'misc', writes: false, idempotent: false },
      async execute() {
        return {
          is_error: true,
          error_code: 'test.fail',
          error_message: 'expected failure',
          retryable: false,
        };
      },
    };
    const registry = createToolRegistry();
    registry.register(tool);

    const hooks: HookSpec[] = [baseSpec({ event: 'PostToolUse', command: `cat > ${marker}` })];
    const config: HarnessConfig = {
      provider: mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'flaky', input: {} }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'go',
      hooks,
    };
    await runAgent(config);
    await new Promise((r) => setTimeout(r, 200));

    const parsed = JSON.parse(await readFile(marker, 'utf8'));
    expect(parsed.data.tool.failed).toBe(true);
    expect(parsed.data.tool.output.error_code).toBe('test.fail');
  });

  test('does NOT fire when PreToolUse blocked the call', async () => {
    const tool = makeRecordingTool([]);
    const registry = createToolRegistry();
    registry.register(tool);

    const hooks: HookSpec[] = [
      baseSpec({ event: 'PreToolUse', command: 'exit 1' }),
      baseSpec({ event: 'PostToolUse', command: 'true' }),
    ];
    const config: HarnessConfig = {
      provider: mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'echo', input: {} }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'go',
      hooks,
    };
    const result = await runAgent(config);

    // Wait for any fire-and-forget hooks to settle (so a stray
    // PostToolUse would land before we assert).
    await new Promise((r) => setTimeout(r, 200));

    const runs = listHookRunsBySession(db, result.sessionId);
    const pre = runs.filter((r) => r.event === 'PreToolUse');
    const post = runs.filter((r) => r.event === 'PostToolUse');
    expect(pre).toHaveLength(1);
    // PostToolUse never fires for blocked calls — the tool never ran,
    // there's no result to surface.
    expect(post).toEqual([]);
  });
});
