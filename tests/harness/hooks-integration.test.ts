import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { listHookRunsBySession } from '../../src/storage/repos/hook-runs.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';
import type { Tool } from '../../src/tools/types.ts';

// End-to-end Slice 2 wiring: drives runAgent with a real hook
// chain in `config.hooks` and asserts the audit table records
// the right events at the right lifecycle moments. Hook commands
// are tiny `sh -c` snippets that touch a temp file or print a
// marker — production-shaped integration without depending on
// any operator-side software.

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
    id: 'anthropic/claude-sonnet-4-6',
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
  // Empty matcher = match every event of the configured type;
  // tool field is only meaningful for PreToolUse / PostToolUse.
  matcher: {},
  timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
  failClosed: false,
  locked: false,
  ...overrides,
});

let scratch: string;
let db: DB;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'forja-hooks-int-'));
  db = openMemoryDb();
  migrate(db);
});

afterEach(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  db.close();
});

describe('hooks Slice 2 — SessionStart', () => {
  test('fires after session_start emit; payload reaches stdin; audit row landed', async () => {
    // Operator's hook reads JSON from stdin, writes the `event`
    // and `data.cwd` fields to a marker file. Lets us assert
    // (a) the hook actually ran, (b) the payload shape matches.
    const marker = join(scratch, 'session-start.txt');
    const hooks: HookSpec[] = [
      baseSpec({
        event: 'SessionStart',
        // shell quotes mean `$marker` interpolates inside sh -c
        command: `cat > ${marker}`,
      }),
    ];
    const config: HarnessConfig = {
      provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'hi',
      hooks,
    };

    const result = await runAgent(config);
    expect(result.status).toBe('done');

    // File written by the hook contains the JSON payload
    const written = await readFile(marker, 'utf8');
    expect(written.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(written);
    expect(parsed.event).toBe('SessionStart');
    expect(parsed.schema).toBe('v1');
    expect(parsed.sessionId).toBe(result.sessionId);
    expect(parsed.data.cwd).toBe(scratch);
    expect(parsed.data.model).toBe('anthropic/claude-sonnet-4-6');
    expect(parsed.data.profile).toBe('default');

    // Audit row in hook_runs
    const runs = listHookRunsBySession(db, result.sessionId);
    const ss = runs.filter((r) => r.event === 'SessionStart');
    expect(ss).toHaveLength(1);
    expect(ss[0]?.outcome).toBe('allow');
    expect(ss[0]?.exitCode).toBe(0);
    expect(ss[0]?.layer).toBe('project');
  });

  test('plan profile threaded through payload', async () => {
    const marker = join(scratch, 'profile.txt');
    const hooks: HookSpec[] = [baseSpec({ event: 'SessionStart', command: `cat > ${marker}` })];
    const config: HarnessConfig = {
      provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'hi',
      planMode: true,
      hooks,
    };
    await runAgent(config);
    const parsed = JSON.parse(await readFile(marker, 'utf8'));
    expect(parsed.data.profile).toBe('plan');
  });
});

describe('hooks Slice 2 — Stop', () => {
  test('fires before session_finished emit; carries final result; audit row landed', async () => {
    const marker = join(scratch, 'stop.txt');
    const hooks: HookSpec[] = [baseSpec({ event: 'Stop', command: `cat > ${marker}` })];
    const events: { type: string; sessionId?: string }[] = [];
    const config: HarnessConfig = {
      provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'hi',
      hooks,
      onEvent: (e) => {
        // Capture only the lifecycle types we care about
        if (e.type === 'session_start' || e.type === 'session_finished') {
          events.push({ type: e.type });
        }
      },
    };

    const result = await runAgent(config);
    expect(result.status).toBe('done');

    // Hook ran with the final result baked into the payload
    const parsed = JSON.parse(await readFile(marker, 'utf8'));
    expect(parsed.event).toBe('Stop');
    expect(parsed.sessionId).toBe(result.sessionId);
    expect(typeof parsed.data.durationMs).toBe('number');
    expect(typeof parsed.data.costUsd).toBe('number');
    expect(parsed.data.steps).toBe(result.steps);

    // Audit row landed for Stop
    const runs = listHookRunsBySession(db, result.sessionId);
    const stops = runs.filter((r) => r.event === 'Stop');
    expect(stops).toHaveLength(1);
    expect(stops[0]?.outcome).toBe('allow');

    // Order check: session_start arrived before session_finished
    expect(events.map((e) => e.type)).toEqual(['session_start', 'session_finished']);
  });

  test('hook chain runs once even on error path (provider error → finish)', async () => {
    const marker = join(scratch, 'stop-on-error.txt');
    const hooks: HookSpec[] = [baseSpec({ event: 'Stop', command: `cat > ${marker}` })];
    // Provider that always throws — drives the harness through the
    // `providerError` finish() path; Stop must still fire.
    const provider: Provider = {
      ...mockProvider([]),
      // biome-ignore lint/correctness/useYield: synthetic failure path — async generator that throws on first iteration.
      async *generate() {
        throw new Error('synthetic provider failure');
      },
    };
    const config: HarnessConfig = {
      provider,
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'hi',
      hooks,
    };
    const result = await runAgent(config);
    expect(result.status).toBe('error');

    const parsed = JSON.parse(await readFile(marker, 'utf8'));
    expect(parsed.event).toBe('Stop');
  });

  test('no hooks → no rows, no error', async () => {
    const config: HarnessConfig = {
      provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'hi',
      // hooks deliberately omitted
    };
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(listHookRunsBySession(db, result.sessionId)).toEqual([]);
  });

  test('payload sessionId is always non-empty (contract)', async () => {
    // Spec contract on HookEventPayload: every variant carries
    // `sessionId: string`, meaning a non-empty session id. An
    // earlier cut fired Stop unconditionally inside finish() — on
    // an init-fail path that produces `sessionId === ''`, the
    // operator hook would receive an envelope violating the
    // contract. Sanity-revert: capture the payload sessionId
    // values across SessionStart and Stop on a real session and
    // assert non-empty.
    const ssMarker = join(scratch, 'ss-id.txt');
    const stopMarker = join(scratch, 'stop-id.txt');
    const hooks: HookSpec[] = [
      baseSpec({ event: 'SessionStart', command: `cat > ${ssMarker}` }),
      baseSpec({ event: 'Stop', command: `cat > ${stopMarker}` }),
    ];
    const config: HarnessConfig = {
      provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'hi',
      hooks,
    };
    const result = await runAgent(config);
    expect(result.status).toBe('done');

    const ss = JSON.parse(await readFile(ssMarker, 'utf8'));
    const stop = JSON.parse(await readFile(stopMarker, 'utf8'));
    expect(ss.sessionId).toBe(result.sessionId);
    expect(stop.sessionId).toBe(result.sessionId);
    expect(ss.sessionId.length).toBeGreaterThan(0);
    expect(stop.sessionId.length).toBeGreaterThan(0);
  });
});

describe('hooks Slice 2 — Notification', () => {
  // Uses a real fs.read tool + a confirm_paths policy rule —
  // that's the canonical way to drive the engine into a confirm
  // decision. The tool body is a no-op but the read decision
  // still runs through checkPath which fires confirm when the
  // path matches confirm_paths.
  const readTool: Tool = {
    name: 'read_file',
    description: 'reads a file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    metadata: { category: 'fs.read', writes: false, idempotent: true },
    async execute() {
      return { ok: true };
    },
  };

  test('fires when permission engine returns confirm; modal opens after', async () => {
    const marker = join(scratch, 'notify.txt');
    const hooks: HookSpec[] = [baseSpec({ event: 'Notification', command: `cat > ${marker}` })];
    const registry = createToolRegistry();
    registry.register(readTool);

    const confirmCalls: { toolName: string }[] = [];
    const config: HarnessConfig = {
      provider: mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'read_file', input: { path: 'a.txt' } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(
        // strict mode + confirm_paths: '**' → every read demands
        // confirmation.
        policy({
          defaults: { mode: 'strict' },
          tools: { read_file: { confirm_paths: ['**'] } },
        }),
        { cwd: scratch },
      ),
      db,
      cwd: scratch,
      userPrompt: 'go',
      hooks,
      confirmPermission: async (req) => {
        confirmCalls.push({ toolName: req.toolName });
        return true;
      },
    };

    const result = await runAgent(config);
    expect(result.status).toBe('done');
    expect(confirmCalls).toHaveLength(1);

    // Notification dispatch is fire-and-forget. The dispatcher
    // still awaits the spawned process internally; with sh -c
    // writing to a small file the wall clock is well under the
    // harness's run length, so the row lands by the time we
    // assert. Wait briefly to let the fire-and-forget promise
    // settle — we don't hold a handle to it (per spec).
    await new Promise((r) => setTimeout(r, 200));

    const parsed = JSON.parse(await readFile(marker, 'utf8'));
    expect(parsed.event).toBe('Notification');
    expect(parsed.sessionId).toBe(result.sessionId);
    expect(parsed.data.kind).toBe('permission_prompt');
    expect(parsed.data.message).toContain('read_file');

    const notifications = listHookRunsBySession(db, result.sessionId).filter(
      (r) => r.event === 'Notification',
    );
    expect(notifications).toHaveLength(1);
  });

  test('does not fire when policy decides allow without confirm', async () => {
    const hooks: HookSpec[] = [baseSpec({ event: 'Notification', command: 'true' })];
    const registry = createToolRegistry();
    registry.register(readTool);

    const config: HarnessConfig = {
      provider: mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'read_file', input: { path: 'a.txt' } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(
        // Bypass: allow everything; no confirm path is visited.
        policy({ defaults: { mode: 'bypass' } }),
        { cwd: scratch },
      ),
      db,
      cwd: scratch,
      userPrompt: 'go',
      hooks,
    };

    const result = await runAgent(config);
    expect(result.status).toBe('done');

    const notifications = listHookRunsBySession(db, result.sessionId).filter(
      (r) => r.event === 'Notification',
    );
    expect(notifications).toEqual([]);
  });
});

describe('hooks Slice 2 — PreCheckpoint', () => {
  // Real git repo so the checkpoint manager has something to
  // snapshot against. write_file's body produces a real diff so
  // the manager records the snapshot — and the harness fires
  // PreCheckpoint just before that.
  const initRepo = async (cwd: string): Promise<void> => {
    const proc = Bun.spawn({
      cmd: ['git', 'init', '-b', 'main'],
      cwd,
      env: {
        LC_ALL: 'C',
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
  };

  const writeTool: Tool = {
    name: 'write_file',
    description: 'write a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    metadata: { category: 'fs.write', writes: true, idempotent: false },
    async execute(args, ctx) {
      const { path, content } = args as { path: string; content: string };
      await writeFile(join(ctx.cwd, path), content);
      return { ok: true };
    },
  };

  test('fires before snapshot when write tool is about to run', async () => {
    await initRepo(scratch);
    const marker = join(scratch, '.precheckpoint.json');
    const hooks: HookSpec[] = [baseSpec({ event: 'PreCheckpoint', command: `cat > ${marker}` })];
    const registry = createToolRegistry();
    registry.register(writeTool);

    const config: HarnessConfig = {
      provider: mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'write_file', input: { path: 'a.txt', content: 'hi' } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'go',
      enableCheckpoints: true,
      hooks,
    };

    const result = await runAgent(config);
    expect(result.status).toBe('done');

    // Wait briefly for fire-and-forget hook to settle.
    await new Promise((r) => setTimeout(r, 200));

    const parsed = JSON.parse(await readFile(marker, 'utf8'));
    expect(parsed.event).toBe('PreCheckpoint');
    expect(parsed.sessionId).toBe(result.sessionId);
    expect(typeof parsed.data.stepN).toBe('number');

    const pcs = listHookRunsBySession(db, result.sessionId).filter(
      (r) => r.event === 'PreCheckpoint',
    );
    expect(pcs).toHaveLength(1);
  });

  test('does not fire when no write tool ran', async () => {
    await initRepo(scratch);
    const hooks: HookSpec[] = [baseSpec({ event: 'PreCheckpoint', command: 'true' })];
    // Read-only tool: no writes, no snapshot trigger, no hook.
    const readTool: Tool = {
      name: 'read_file',
      description: 'noop',
      inputSchema: { type: 'object' },
      metadata: { category: 'fs.read', writes: false, idempotent: true },
      async execute() {
        return { ok: true };
      },
    };
    const registry = createToolRegistry();
    registry.register(readTool);

    const config: HarnessConfig = {
      provider: mockProvider([
        {
          tool_uses: [{ id: 'tu1', name: 'read_file', input: {} }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'go',
      enableCheckpoints: true,
      hooks,
    };
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    const pcs = listHookRunsBySession(db, result.sessionId).filter(
      (r) => r.event === 'PreCheckpoint',
    );
    expect(pcs).toEqual([]);
  });
});

describe('hooks Slice 2 — error tolerance', () => {
  test('hook command failure does not crash the harness', async () => {
    const hooks: HookSpec[] = [baseSpec({ event: 'SessionStart', command: 'exit 7' })];
    const config: HarnessConfig = {
      provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'hi',
      hooks,
    };
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    const ss = listHookRunsBySession(db, result.sessionId).filter(
      (r) => r.event === 'SessionStart',
    );
    expect(ss).toHaveLength(1);
    // exit 7 is "error" outcome (>2). failClosed=false here, so
    // SessionStart isn't a blockable event anyway and the run
    // proceeds.
    expect(ss[0]?.outcome).toBe('error');
    expect(ss[0]?.exitCode).toBe(7);
  });

  test('hook timeout (chain stays under 15s)', async () => {
    const hooks: HookSpec[] = [
      // 100ms timeout with `sleep 5` → dispatcher kills it via
      // SIGTERM and records outcome=timeout, exit_code=124.
      baseSpec({
        event: 'SessionStart',
        command: 'sleep 5',
        timeoutMs: 100,
      }),
    ];
    const config: HarnessConfig = {
      provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'hi',
      hooks,
    };
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    const ss = listHookRunsBySession(db, result.sessionId).filter(
      (r) => r.event === 'SessionStart',
    );
    expect(ss).toHaveLength(1);
    expect(ss[0]?.outcome).toBe('timeout');
    expect(ss[0]?.exitCode).toBe(124);
  });
});
