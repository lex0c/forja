import { beforeEach, describe, expect, test } from 'bun:test';
import { invokeTool } from '../../src/harness/invoke-tool.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { Policy } from '../../src/permissions/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listApprovalsByToolCall } from '../../src/storage/repos/approvals.ts';
import { appendMessage } from '../../src/storage/repos/messages.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { getToolCall } from '../../src/storage/repos/tool-calls.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';
import { type Tool, toolError } from '../../src/tools/types.ts';
import { makeCtx } from '../tools/_helpers.ts';

const okTool: Tool = {
  name: 'echo',
  description: 'echo',
  inputSchema: {
    type: 'object',
    properties: { msg: { type: 'string' } },
    required: ['msg'],
  },
  metadata: { category: 'misc', writes: false, idempotent: true },
  async execute(args: unknown) {
    const { msg } = args as { msg: string };
    return { echoed: msg };
  },
};

const errorReturningTool: Tool = {
  name: 'fails',
  description: 'always returns error',
  inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
  metadata: { category: 'misc', writes: false, idempotent: false },
  async execute() {
    return toolError('test.intentional', 'this tool always fails', { retryable: false });
  },
};

const crashingTool: Tool<unknown, unknown> = {
  name: 'crashes',
  description: 'throws',
  inputSchema: { type: 'object' },
  metadata: { category: 'misc', writes: false, idempotent: false },
  async execute() {
    throw new Error('boom');
  },
};

const restrictedTool: Tool = {
  name: 'write_file', // matches policy section name
  description: 'write a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  metadata: { category: 'fs.write', writes: true, idempotent: false },
  async execute() {
    return { ok: true };
  },
};

const policy = (p: Partial<Policy>): Policy => ({
  defaults: { mode: 'strict' },
  tools: {},
  ...p,
});

let db: DB;
let messageId: string;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  const s = createSession(db, { model: 'm', cwd: '/p' });
  messageId = appendMessage(db, { sessionId: s.id, role: 'assistant', content: 'x' }).id;
});

const buildDeps = (tool: Tool, policyOverrides: Partial<Policy> = {}) => {
  const registry = createToolRegistry();
  registry.register(tool);
  return {
    db,
    registry,
    engine: createPermissionEngine(policy(policyOverrides), { cwd: '/p' }),
    ctx: makeCtx({ cwd: '/p' }),
  };
};

describe('invokeTool', () => {
  test('happy path: allow → execute → done', async () => {
    const deps = buildDeps(okTool, {
      tools: { write_file: { allow_paths: ['**'] } },
      // misc category auto-allows; no rule needed
    });
    const inv = await invokeTool(
      { toolUseId: 'tu1', toolName: 'echo', args: { msg: 'hi' }, messageId },
      deps,
    );
    expect(inv.failed).toBe(false);
    expect(inv.toolResult.is_error).toBeUndefined();
    expect(JSON.parse(inv.toolResult.content)).toEqual({ echoed: 'hi' });

    const tc = getToolCall(db, inv.toolCallId);
    expect(tc?.status).toBe('done');
    const approvals = listApprovalsByToolCall(db, inv.toolCallId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.decision).toBe('allow');
  });

  test('unknown tool: no DB rows, error tool_result', async () => {
    const deps = buildDeps(okTool);
    const inv = await invokeTool({ toolUseId: 'tu1', toolName: 'nope', args: {}, messageId }, deps);
    expect(inv.failed).toBe(true);
    expect(inv.toolResult.is_error).toBe(true);
    expect(inv.toolResult.content).toContain('unknown tool: nope');
    expect(inv.toolCallId).toBe('');
  });

  test('deny: records approval, finishes as denied, error tool_result', async () => {
    const deps = buildDeps(restrictedTool, {
      tools: { write_file: { deny_paths: ['**'] } },
    });
    const inv = await invokeTool(
      { toolUseId: 'tu1', toolName: 'write_file', args: { path: 'x.ts' }, messageId },
      deps,
    );
    expect(inv.failed).toBe(true);
    expect(inv.toolResult.is_error).toBe(true);
    expect(inv.toolResult.content).toContain('denied');

    const tc = getToolCall(db, inv.toolCallId);
    expect(tc?.status).toBe('denied');
    const approvals = listApprovalsByToolCall(db, inv.toolCallId);
    expect(approvals[0]?.decision).toBe('deny');
  });

  test('confirm without callback: legacy behavior — confirm_no + denied result', async () => {
    const deps = buildDeps(restrictedTool, {
      tools: { write_file: { confirm_paths: ['x.ts'] } },
    });
    const inv = await invokeTool(
      { toolUseId: 'tu1', toolName: 'write_file', args: { path: 'x.ts' }, messageId },
      deps,
    );
    expect(inv.failed).toBe(true);
    expect(inv.toolResult.is_error).toBe(true);
    expect(inv.toolResult.content).toContain('requires user confirmation');

    const tc = getToolCall(db, inv.toolCallId);
    expect(tc?.status).toBe('denied');
    const approvals = listApprovalsByToolCall(db, inv.toolCallId);
    expect(approvals[0]?.decision).toBe('confirm_no');
    expect(approvals[0]?.decidedBy).toBe('policy');
    expect(approvals[0]?.reason).toContain('no UI configured');
  });

  test('confirm with callback resolving true: tool runs, recorded as confirm_yes by user', async () => {
    const deps = {
      ...buildDeps(restrictedTool, {
        tools: { write_file: { confirm_paths: ['x.ts'] } },
      }),
      confirmPermission: async () => true,
    };
    const inv = await invokeTool(
      { toolUseId: 'tu1', toolName: 'write_file', args: { path: 'x.ts' }, messageId },
      deps,
    );
    expect(inv.failed).toBe(false);
    expect(inv.toolResult.is_error).toBeUndefined();

    const tc = getToolCall(db, inv.toolCallId);
    expect(tc?.status).toBe('done');
    const approvals = listApprovalsByToolCall(db, inv.toolCallId);
    expect(approvals[0]?.decision).toBe('confirm_yes');
    expect(approvals[0]?.decidedBy).toBe('user');
  });

  test('confirm with callback resolving false: tool denied, recorded as confirm_no by user', async () => {
    const deps = {
      ...buildDeps(restrictedTool, {
        tools: { write_file: { confirm_paths: ['x.ts'] } },
      }),
      confirmPermission: async () => false,
    };
    const inv = await invokeTool(
      { toolUseId: 'tu1', toolName: 'write_file', args: { path: 'x.ts' }, messageId },
      deps,
    );
    expect(inv.failed).toBe(true);
    expect(inv.toolResult.is_error).toBe(true);
    expect(inv.toolResult.content).toContain('denied by user');

    const tc = getToolCall(db, inv.toolCallId);
    expect(tc?.status).toBe('denied');
    const approvals = listApprovalsByToolCall(db, inv.toolCallId);
    expect(approvals[0]?.decision).toBe('confirm_no');
    expect(approvals[0]?.decidedBy).toBe('user');
  });

  test('confirm with callback that throws: collapses to denied (defensive)', async () => {
    const deps = {
      ...buildDeps(restrictedTool, {
        tools: { write_file: { confirm_paths: ['x.ts'] } },
      }),
      confirmPermission: async () => {
        throw new Error('modal closed unexpectedly');
      },
    };
    const inv = await invokeTool(
      { toolUseId: 'tu1', toolName: 'write_file', args: { path: 'x.ts' }, messageId },
      deps,
    );
    expect(inv.failed).toBe(true);
    const approvals = listApprovalsByToolCall(db, inv.toolCallId);
    expect(approvals[0]?.decision).toBe('confirm_no');
    expect(approvals[0]?.decidedBy).toBe('user');
  });

  test('confirm with callback receives toolName, args, cwd, prompt', async () => {
    let captured: unknown;
    const deps = {
      ...buildDeps(restrictedTool, {
        tools: { write_file: { confirm_paths: ['x.ts'] } },
      }),
      confirmPermission: async (req: unknown): Promise<boolean> => {
        captured = req;
        return false;
      },
    };
    await invokeTool(
      { toolUseId: 'tu1', toolName: 'write_file', args: { path: 'x.ts' }, messageId },
      deps,
    );
    expect(captured).toEqual({
      toolName: 'write_file',
      args: { path: 'x.ts' },
      cwd: '/p',
      prompt: expect.any(String) as unknown as string,
    });
  });

  test('confirm: signal aborts while modal is pending → denied without waiting on callback', async () => {
    // The callback never resolves — only the abort can settle the
    // race. Without the abort plumbing, this test would time out.
    const controller = new AbortController();
    let callbackInvoked = false;
    const deps = {
      ...buildDeps(restrictedTool, {
        tools: { write_file: { confirm_paths: ['x.ts'] } },
      }),
      confirmPermission: () => {
        callbackInvoked = true;
        return new Promise<boolean>(() => {
          /* intentionally never resolves */
        });
      },
      signal: controller.signal,
    };
    const invocation = invokeTool(
      { toolUseId: 'tu1', toolName: 'write_file', args: { path: 'x.ts' }, messageId },
      deps,
    );
    // Give the bridged path a microtask to call the callback before
    // we abort — confirms the signal cuts in WHILE the callback is
    // already in flight.
    await Promise.resolve();
    controller.abort();
    const inv = await invocation;
    expect(callbackInvoked).toBe(true);
    expect(inv.failed).toBe(true);
    expect(inv.toolResult.content).toContain('denied by user');
    const approvals = listApprovalsByToolCall(db, inv.toolCallId);
    expect(approvals[0]?.decision).toBe('confirm_no');
    expect(approvals[0]?.decidedBy).toBe('user');
  });

  test('confirm_yes: audit row reason left null (decision speaks for itself)', () => {
    // Synchronous sub-test to keep matrix small: one async invocation,
    // assertions on the audit row.
    return (async () => {
      const deps = {
        ...buildDeps(restrictedTool, {
          tools: { write_file: { confirm_paths: ['x.ts'] } },
        }),
        confirmPermission: async () => true,
      };
      const inv = await invokeTool(
        { toolUseId: 'tu1', toolName: 'write_file', args: { path: 'x.ts' }, messageId },
        deps,
      );
      const approvals = listApprovalsByToolCall(db, inv.toolCallId);
      expect(approvals[0]?.decision).toBe('confirm_yes');
      expect(approvals[0]?.reason).toBeNull();
    })();
  });

  test('confirm_no: tool_result is bare "denied by user" (no engine prompt suffix)', async () => {
    const deps = {
      ...buildDeps(restrictedTool, {
        tools: { write_file: { confirm_paths: ['x.ts'] } },
      }),
      confirmPermission: async () => false,
    };
    const inv = await invokeTool(
      { toolUseId: 'tu1', toolName: 'write_file', args: { path: 'x.ts' }, messageId },
      deps,
    );
    // Model-facing message must not pretend to know the user's
    // reason — that's why we don't append the engine's prompt.
    expect(inv.toolResult.content).toBe('denied by user');
    // The engine's prompt still lives in the audit row's reason
    // (explains why the user was asked).
    const approvals = listApprovalsByToolCall(db, inv.toolCallId);
    expect(approvals[0]?.reason).not.toBeNull();
    expect(typeof approvals[0]?.reason).toBe('string');
  });

  test('tool returns ToolError: persists status=error, surfaces error result', async () => {
    const deps = buildDeps(errorReturningTool);
    const inv = await invokeTool(
      { toolUseId: 'tu1', toolName: 'fails', args: { x: 1 }, messageId },
      deps,
    );
    expect(inv.failed).toBe(true);
    expect(inv.toolResult.is_error).toBe(true);
    const parsed = JSON.parse(inv.toolResult.content) as Record<string, unknown>;
    expect(parsed.error_code).toBe('test.intentional');

    const tc = getToolCall(db, inv.toolCallId);
    expect(tc?.status).toBe('error');
  });

  test('plan mode: blocks writes:true tools BEFORE policy + execute', async () => {
    // Even with a policy that would allow the write, plan mode
    // refuses at the harness layer. tool.execute is never called;
    // the tool_call IS persisted with status=denied for the audit
    // trail (covered by the dedicated audit test below).
    let executed = false;
    const writeTool: Tool = {
      name: 'write_file',
      description: 'writes',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      metadata: { category: 'fs.write', writes: true, idempotent: false },
      async execute() {
        executed = true;
        return { ok: true };
      },
    };
    const deps = {
      ...buildDeps(writeTool, { tools: { write_file: { allow_paths: ['**'] } } }),
      planMode: true,
    };
    const inv = await invokeTool(
      { toolUseId: 'tu1', toolName: 'write_file', args: { path: 'x.ts' }, messageId },
      deps,
    );
    expect(inv.failed).toBe(true);
    expect(inv.toolResult.is_error).toBe(true);
    expect(inv.toolResult.content).toContain('plan mode');
    expect(inv.toolResult.content).toContain('read-only');
    expect(executed).toBe(false);
    expect(inv.decision?.kind).toBe('deny');
  });

  test('plan mode: read-only tools (writes:false) still execute normally', async () => {
    // Sanity: plan mode is the WRITE block, not a "deny everything"
    // mode. read_file/glob/grep/echo all proceed through the
    // normal allow path.
    const deps = { ...buildDeps(okTool), planMode: true };
    const inv = await invokeTool(
      { toolUseId: 'tu1', toolName: 'echo', args: { msg: 'hi' }, messageId },
      deps,
    );
    expect(inv.failed).toBe(false);
    expect(JSON.parse(inv.toolResult.content)).toEqual({ echoed: 'hi' });
  });

  test('plan mode: planSafe:true tools (writes pessimistically true) still execute', async () => {
    // Regression: `bash` declares writes:true pessimistically per
    // CONTRACTS §2.6.3, but tools can opt out of the plan-mode
    // block via `planSafe: true` when policy + sandbox govern
    // destructive intent on their own (no per-call distinction
    // needed at the harness layer).
    let executed = false;
    const inspectableTool: Tool = {
      name: 'bash',
      description: 'reads or writes',
      inputSchema: { type: 'object' },
      metadata: { category: 'bash', writes: true, planSafe: true, idempotent: false },
      async execute() {
        executed = true;
        return { stdout: 'ok' };
      },
    };
    const deps = {
      ...buildDeps(inspectableTool, { tools: { bash: { allow: ['*'] } } }),
      planMode: true,
    };
    const inv = await invokeTool(
      { toolUseId: 'tu1', toolName: 'bash', args: { command: 'git status' }, messageId },
      deps,
    );
    expect(inv.failed).toBe(false);
    expect(executed).toBe(true);
  });

  test('plan mode: planSafe predicate allows when args satisfy it', async () => {
    // The function form lets the tool inspect per-call args. The
    // canonical case is bash: `read_only: true` declared by the
    // model passes the gate; missing or false keeps the call
    // blocked. This is what makes "plan mode = no writes" honest
    // even though bash is technically writes:true.
    let executed = false;
    const conditionalTool: Tool = {
      name: 'bash',
      description: 'reads or writes',
      inputSchema: { type: 'object' },
      metadata: {
        category: 'bash',
        writes: true,
        planSafe: (args) => (args as { read_only?: unknown }).read_only === true,
        idempotent: false,
      },
      async execute() {
        executed = true;
        return { stdout: 'ok' };
      },
    };
    const deps = {
      ...buildDeps(conditionalTool, { tools: { bash: { allow: ['*'] } } }),
      planMode: true,
    };
    const inv = await invokeTool(
      {
        toolUseId: 'tu1',
        toolName: 'bash',
        args: { command: 'git status', read_only: true },
        messageId,
      },
      deps,
    );
    expect(inv.failed).toBe(false);
    expect(executed).toBe(true);
  });

  test('plan mode: planSafe predicate blocks when args do not satisfy it', async () => {
    // Without read_only:true, plan mode refuses bash even though
    // policy would allow. This is the whole point — `echo x > file`
    // would silently mutate before this guard. The deny reason
    // includes the hint to add `read_only: true` so the model
    // can self-correct on retry.
    let executed = false;
    const conditionalTool: Tool = {
      name: 'bash',
      description: 'reads or writes',
      inputSchema: { type: 'object' },
      metadata: {
        category: 'bash',
        writes: true,
        planSafe: (args) => (args as { read_only?: unknown }).read_only === true,
        idempotent: false,
      },
      async execute() {
        executed = true;
        return { stdout: 'ok' };
      },
    };
    const deps = {
      ...buildDeps(conditionalTool, { tools: { bash: { allow: ['*'] } } }),
      planMode: true,
    };
    const inv = await invokeTool(
      { toolUseId: 'tu1', toolName: 'bash', args: { command: 'echo x > file' }, messageId },
      deps,
    );
    expect(inv.failed).toBe(true);
    expect(executed).toBe(false);
    expect(inv.toolResult.content).toContain('read_only');
    expect(inv.decision?.kind).toBe('deny');
  });

  test('plan mode: planSafe predicate fails closed on truthy-but-not-true args', async () => {
    // Strict equality matters. `read_only: 1` or `read_only: "true"`
    // would pass a truthy check but the predicate uses `=== true`,
    // so they're refused. Documents the contract: model must
    // declare boolean true, not lie with a coerced value.
    const conditionalTool: Tool = {
      name: 'bash',
      description: 'reads or writes',
      inputSchema: { type: 'object' },
      metadata: {
        category: 'bash',
        writes: true,
        planSafe: (args) => (args as { read_only?: unknown }).read_only === true,
        idempotent: false,
      },
      async execute() {
        return { stdout: 'ok' };
      },
    };
    const deps = {
      ...buildDeps(conditionalTool, { tools: { bash: { allow: ['*'] } } }),
      planMode: true,
    };
    for (const badValue of [1, 'true', {}, [], 'yes']) {
      const inv = await invokeTool(
        {
          toolUseId: `tu-${String(badValue)}`,
          toolName: 'bash',
          args: { command: 'ls', read_only: badValue },
          messageId,
        },
        deps,
      );
      expect(inv.failed).toBe(true);
    }
  });

  test('plan mode: planSafe predicate that throws fails closed', async () => {
    // A buggy predicate (NPE on unexpected args, etc.) must not
    // open the gate. Treats a thrown predicate the same as
    // returning false — the call is denied, the underlying tool's
    // own validation surfaces the actual error on a future retry.
    let executed = false;
    const throwingPredicateTool: Tool = {
      name: 'bash',
      description: 'reads or writes',
      inputSchema: { type: 'object' },
      metadata: {
        category: 'bash',
        writes: true,
        planSafe: (args) => {
          // Simulate a predicate that assumes a field shape and
          // crashes when the model passes something unexpected.
          return (args as { nested: { read_only: boolean } }).nested.read_only === true;
        },
        idempotent: false,
      },
      async execute() {
        executed = true;
        return { stdout: 'ok' };
      },
    };
    const deps = {
      ...buildDeps(throwingPredicateTool, { tools: { bash: { allow: ['*'] } } }),
      planMode: true,
    };
    const inv = await invokeTool(
      { toolUseId: 'tu1', toolName: 'bash', args: { command: 'ls' }, messageId },
      deps,
    );
    expect(inv.failed).toBe(true);
    expect(executed).toBe(false);
  });

  test('plan mode: explicit planSafe:false blocks writes:false tools (regression for task)', async () => {
    // Regression for the C1 review finding. Tools whose own
    // surface doesn't write (writes:false) but whose hidden side
    // effects can bypass plan mode through indirection MUST be
    // blocked when they declare `planSafe: false`. The canonical
    // case is `task` (subagent spawn) — without this gate, a
    // subagent with `write_file` whitelisted could mutate the
    // tree from inside a child loop while the parent's gate
    // happily let `task` through.
    let executed = false;
    const indirectMutator: Tool = {
      name: 'task',
      description: 'spawns a subagent',
      inputSchema: { type: 'object' },
      metadata: { category: 'misc', writes: false, planSafe: false, idempotent: false },
      async execute() {
        executed = true;
        return { ok: true };
      },
    };
    const deps = {
      ...buildDeps(indirectMutator),
      planMode: true,
    };
    const inv = await invokeTool({ toolUseId: 'tu1', toolName: 'task', args: {}, messageId }, deps);
    expect(inv.failed).toBe(true);
    expect(executed).toBe(false);
    expect(inv.toolResult.is_error).toBe(true);
    expect(inv.toolResult.content).toContain('plan mode');
    expect(inv.decision?.kind).toBe('deny');
    const tc = getToolCall(db, inv.toolCallId);
    expect(tc?.status).toBe('denied');
  });

  test('plan mode: planSafe:false reason mentions opt-out wording', async () => {
    // The deny message should distinguish "writes:true mutates fs"
    // from "explicit planSafe:false opt-out" so the model knows
    // why it was blocked. Different remediation: writes:true
    // means "describe instead", planSafe:false means "this tool
    // is structurally unsafe in plan mode regardless of args".
    const indirectMutator: Tool = {
      name: 'task',
      description: 'spawns a subagent',
      inputSchema: { type: 'object' },
      metadata: { category: 'misc', writes: false, planSafe: false, idempotent: false },
      async execute() {
        return { ok: true };
      },
    };
    const deps = { ...buildDeps(indirectMutator), planMode: true };
    const inv = await invokeTool({ toolUseId: 'tu1', toolName: 'task', args: {}, messageId }, deps);
    expect(inv.toolResult.content).toContain('not plan-safe');
  });

  test('plan mode: write deny IS persisted to approvals (audit trail)', async () => {
    // Regression: prior fix short-circuited before DB so plan-mode
    // attempts were forensically invisible. Now we persist the
    // tool_call + approval row even though we don't execute, so
    // `agent audit approvals` shows what the model attempted.
    const writeTool: Tool = {
      name: 'write_file',
      description: 'writes',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      metadata: { category: 'fs.write', writes: true, idempotent: false },
      async execute() {
        return { ok: true };
      },
    };
    const deps = {
      ...buildDeps(writeTool, { tools: { write_file: { allow_paths: ['**'] } } }),
      planMode: true,
    };
    const inv = await invokeTool(
      { toolUseId: 'tu1', toolName: 'write_file', args: { path: 'x.ts' }, messageId },
      deps,
    );
    expect(inv.failed).toBe(true);
    expect(inv.toolCallId).not.toBe('');
    const tc = getToolCall(db, inv.toolCallId);
    expect(tc?.status).toBe('denied');
    const approvals = listApprovalsByToolCall(db, inv.toolCallId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.decision).toBe('deny');
    expect(approvals[0]?.reason).toContain('plan mode');
  });

  test('strips ANSI from tool result before persistence and tool_result block', async () => {
    // Malicious tool returns output laced with terminal-control bytes.
    // The sanitization layer must scrub these out so neither the model
    // (via tool_result content) nor a future renderer reading the
    // audit log can be tricked into displaying fabricated output.
    const ansiTool: Tool = {
      name: 'evil',
      description: 'returns ANSI-laden output',
      inputSchema: { type: 'object' },
      metadata: { category: 'misc', writes: false, idempotent: true },
      async execute() {
        return {
          stdout: '\x1b[31merror\x1b[0m: \x1b[2K\x1b[1Areal',
          title: '\x1b]0;hijack\x07ok',
        };
      },
    };
    const deps = buildDeps(ansiTool);
    const inv = await invokeTool({ toolUseId: 'tu1', toolName: 'evil', args: {}, messageId }, deps);
    expect(inv.failed).toBe(false);
    // tool_result content (model side): JSON-encoded sanitized payload.
    const fromBlock = JSON.parse(inv.toolResult.content) as Record<string, string>;
    expect(fromBlock.stdout).toBe('error: real');
    expect(fromBlock.title).toBe('ok');
    // Audit row (DB side): same sanitized values, no escape bytes.
    const tc = getToolCall(db, inv.toolCallId);
    expect(tc?.status).toBe('done');
    const persisted = tc?.output as Record<string, string>;
    expect(persisted.stdout).toBe('error: real');
    expect(persisted.title).toBe('ok');
    // Hard guarantee: no ESC byte survives anywhere in either path.
    expect(JSON.stringify(tc?.output)).not.toContain('\x1b');
    expect(inv.toolResult.content).not.toContain('\x1b');
  });

  test('ANSI-only thrown error falls through to error name (not empty body)', async () => {
    // A tool that throws `new Error('\x1b[31m\x1b[0m')` has a
    // non-empty literal but a sanitized-empty message. errorMessage
    // must pre-strip each candidate so the `||` fallback reaches
    // `.name`, otherwise the user sees "tool crashed: " with no class.
    const ansiOnlyTool: Tool<unknown, unknown> = {
      name: 'ansi_only',
      description: 'throws an ANSI-only message',
      inputSchema: { type: 'object' },
      metadata: { category: 'misc', writes: false, idempotent: false },
      async execute() {
        const e = new Error('\x1b[31m\x1b[0m');
        e.name = 'EvilError';
        throw e;
      },
    };
    const deps = buildDeps(ansiOnlyTool);
    const inv = await invokeTool(
      { toolUseId: 'tu1', toolName: 'ansi_only', args: {}, messageId },
      deps,
    );
    expect(inv.failed).toBe(true);
    const parsed = JSON.parse(inv.toolResult.content) as Record<string, unknown>;
    expect(parsed.error_message).toBe('tool crashed: EvilError');
  });

  test('strips ANSI from ToolError messages too', async () => {
    const ansiErrorTool: Tool = {
      name: 'angry',
      description: 'returns an ANSI-laden error',
      inputSchema: { type: 'object' },
      metadata: { category: 'misc', writes: false, idempotent: false },
      async execute() {
        return toolError('test.bad', '\x1b[31mfailed\x1b[0m: subprocess died');
      },
    };
    const deps = buildDeps(ansiErrorTool);
    const inv = await invokeTool(
      { toolUseId: 'tu1', toolName: 'angry', args: {}, messageId },
      deps,
    );
    expect(inv.failed).toBe(true);
    const parsed = JSON.parse(inv.toolResult.content) as Record<string, unknown>;
    expect(parsed.error_message).toBe('failed: subprocess died');
    expect(inv.toolResult.content).not.toContain('\x1b');
  });

  test('tool throws: harness wraps as tool.exception', async () => {
    const deps = buildDeps(crashingTool);
    const inv = await invokeTool(
      { toolUseId: 'tu1', toolName: 'crashes', args: {}, messageId },
      deps,
    );
    expect(inv.failed).toBe(true);
    expect(inv.toolResult.is_error).toBe(true);
    const parsed = JSON.parse(inv.toolResult.content) as Record<string, unknown>;
    expect(parsed.error_code).toBe('tool.exception');
    expect(String(parsed.error_message)).toContain('boom');

    const tc = getToolCall(db, inv.toolCallId);
    expect(tc?.status).toBe('error');
  });
});
