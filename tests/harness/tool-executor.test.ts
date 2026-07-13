import { beforeEach, describe, expect, test } from 'bun:test';
import type { CollectedToolUse } from '../../src/harness/collect.ts';
import { type InvokeOneToolDeps, invokeOneTool } from '../../src/harness/tool-executor.ts';
import type { HarnessConfig, HarnessEvent } from '../../src/harness/types.ts';
import { createVerifyState } from '../../src/harness/verify-gate.ts';
import { createPermissionEngine, type Policy } from '../../src/permissions/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { appendMessage } from '../../src/storage/repos/messages.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';
import { type Tool, toolError } from '../../src/tools/types.ts';
import { makeCtx } from '../tools/_helpers.ts';

// invokeOneTool calls the real invokeTool (not injectable), so this is a light
// integration test with a real db / permission engine / registry. The full tool
// matrix is covered by the harness + tools suites; here we pin the executor's
// own contract — it runs one tool, brackets it with lifecycle events, and
// surfaces the failed flag.
const echoTool: Tool = {
  name: 'echo',
  description: 'echo',
  inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  metadata: { category: 'misc', writes: false, idempotent: true },
  async execute(args: unknown) {
    return { echoed: (args as { msg: string }).msg };
  },
};

const failTool: Tool = {
  name: 'fails',
  description: 'always fails',
  inputSchema: { type: 'object' },
  metadata: { category: 'misc', writes: false, idempotent: false },
  async execute() {
    return toolError('test.intentional', 'nope', { retryable: false });
  },
};

// Only the NAME matters for the verify-gate re-arm — recordToolForVerify keys
// off FILE_WRITER_TOOLS.has('write_file'), not the metadata. Keep it misc /
// writes:false so it invokes cleanly (no fs.write sandbox/path path), isolating
// the re-arm wiring from permission mechanics.
const writerTool: Tool = {
  name: 'write_file',
  description: 'synthetic writer (name-only, for the verify-gate re-arm)',
  inputSchema: { type: 'object' },
  metadata: { category: 'misc', writes: false, idempotent: true },
  async execute() {
    return { ok: true };
  },
};

const policy = (): Policy => ({ defaults: { mode: 'bypass' }, tools: {} });

let db: DB;
let sessionId: string;
let assistantMsgId: string;
let events: HarnessEvent[];

const deps = (over: Partial<InvokeOneToolDeps> = {}): InvokeOneToolDeps => {
  const registry = createToolRegistry();
  registry.register(echoTool);
  registry.register(failTool);
  registry.register(writerTool);
  return {
    config: {
      db,
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
      onEvent: (e: HarnessEvent) => events.push(e),
    } as unknown as HarnessConfig,
    sessionId,
    repoRoot: '/p',
    assistantMsgId,
    signal: new AbortController().signal,
    dispatchHooks: async () => null,
    buildCtx: () => makeCtx({ cwd: '/p' }),
    verifyState: createVerifyState(),
    verifyCommands: [],
    degradedBannerEmitter: {
      notifyToolCall: () => {},
    } as unknown as InvokeOneToolDeps['degradedBannerEmitter'],
    resetVerifyAttempts: () => {},
    ...over,
  };
};

const tu = (over: Partial<CollectedToolUse> = {}): CollectedToolUse =>
  ({ id: 'tu-1', name: 'echo', input: { msg: 'hi' }, ...over }) as unknown as CollectedToolUse;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  assistantMsgId = appendMessage(db, { sessionId, role: 'assistant', content: 'x' }).id;
  events = [];
});

describe('invokeOneTool', () => {
  test('runs an allowed tool, returns its result, bracketed by tool_invoking/tool_finished', async () => {
    const r = await invokeOneTool(tu(), deps());
    expect(r.failed).toBe(false);
    expect(r.toolResult).toBeDefined();
    const kinds = events.map((e) => e.type);
    expect(kinds).toContain('tool_invoking');
    expect(kinds).toContain('tool_finished');
    expect(events.find((e) => e.type === 'tool_invoking')).toMatchObject({
      toolUseId: 'tu-1',
      toolName: 'echo',
    });
  });

  test('surfaces failed=true and a tool_finished(failed) for a tool that errors', async () => {
    const r = await invokeOneTool(tu({ name: 'fails', input: {} }), deps());
    expect(r.failed).toBe(true);
    const finished = events.find((e) => e.type === 'tool_finished');
    expect(finished).toMatchObject({ toolUseId: 'tu-1', toolName: 'fails', failed: true });
  });

  test('re-arms the verify gate (resetVerifyAttempts) on a successful file-writer mutation', async () => {
    // recordToolForVerify returns true — firing the callback — only for a
    // successful FILE_WRITER_TOOLS mutation with the gate armed (non-empty
    // verifyCommands). This pins the one loop-owned state the worker writes back.
    let reset = false;
    const r = await invokeOneTool(
      tu({ name: 'write_file', input: {} }),
      deps({
        resetVerifyAttempts: () => {
          reset = true;
        },
        verifyCommands: ['bun test'],
      }),
    );
    expect(r.failed).toBe(false);
    expect(reset).toBe(true);
  });

  test('does NOT re-arm the verify gate for a non-writer tool', async () => {
    let reset = false;
    await invokeOneTool(
      tu(),
      deps({
        resetVerifyAttempts: () => {
          reset = true;
        },
        verifyCommands: ['bun test'],
      }),
    );
    expect(reset).toBe(false);
  });
});
