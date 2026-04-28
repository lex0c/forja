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

  test('confirm: M1 has no UI → records confirm_no, denied tool_result mentions prompt', async () => {
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
    expect(approvals[0]?.reason).toContain('no UI');
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
