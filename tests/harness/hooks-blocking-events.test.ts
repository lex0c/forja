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
import { listHookRunsBySession } from '../../src/storage/repos/hook-runs.ts';
import { listMessagesBySession } from '../../src/storage/repos/messages.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';

// Slice 4: UserPromptSubmit + PreCompact (driven via runAgent)
// + MemoryWrite (covered by tests/tools/memory-write-hook.test.ts).

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

const mockProvider = (script: ScriptedStep[], contextWindow = 200_000): Provider => {
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
      context_window: contextWindow,
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
  entryIndex: 0,
  ...overrides,
});

let scratch: string;
let db: DB;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'forja-hooks-block-'));
  db = openMemoryDb();
  migrate(db);
});

afterEach(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  db.close();
});

describe('hooks Slice 4 — UserPromptSubmit', () => {
  test('allow → harness runs the turn normally', async () => {
    const marker = join(scratch, 'ups.txt');
    const hooks: HookSpec[] = [baseSpec({ event: 'UserPromptSubmit', command: `cat > ${marker}` })];
    const config: HarnessConfig = {
      provider: mockProvider([{ text: 'ok', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'please summarize',
      hooks,
    };
    const result = await runAgent(config);
    expect(result.status).toBe('done');

    const parsed = JSON.parse(await readFile(marker, 'utf8'));
    expect(parsed.event).toBe('UserPromptSubmit');
    expect(parsed.sessionId).toBe(result.sessionId);
    expect(parsed.data.prompt).toBe('please summarize');

    const runs = listHookRunsBySession(db, result.sessionId);
    const ups = runs.filter((r) => r.event === 'UserPromptSubmit');
    expect(ups).toHaveLength(1);
    expect(ups[0]?.outcome).toBe('allow');
  });

  test('block_silent → harness exits with userPromptBlocked, no provider call', async () => {
    let providerCalls = 0;
    const provider: Provider = {
      ...mockProvider([{ text: 'never', stop_reason: 'end_turn' }]),
      async *generate(_req: GenerateRequest) {
        providerCalls += 1;
        yield { kind: 'start', message_id: 'm' };
        yield { kind: 'stop', reason: 'end_turn' };
      },
    };
    const hooks: HookSpec[] = [baseSpec({ event: 'UserPromptSubmit', command: 'exit 1' })];
    const config: HarnessConfig = {
      provider,
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'tell me a secret',
      hooks,
    };
    const result = await runAgent(config);
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('userPromptBlocked');
    // Provider was NEVER called — the hook short-circuits the run
    // before any LLM message goes out.
    expect(providerCalls).toBe(0);

    // The user message was persisted before the block (audit captures
    // what was attempted).
    const messages = listMessagesBySession(db, result.sessionId);
    const userMsg = messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();

    const runs = listHookRunsBySession(db, result.sessionId);
    expect(runs.filter((r) => r.event === 'UserPromptSubmit')).toHaveLength(1);
  });

  test('block_message → operator stdout becomes the result detail', async () => {
    const hooks: HookSpec[] = [
      baseSpec({
        event: 'UserPromptSubmit',
        command: 'echo "secret detected in prompt"; exit 2',
      }),
    ];
    const config: HarnessConfig = {
      provider: mockProvider([{ text: 'never', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'send credentials',
      hooks,
    };
    const result = await runAgent(config);
    expect(result.reason).toBe('userPromptBlocked');
    expect(result.detail).toContain('secret detected in prompt');
  });

  test('empty userPrompt (resume re-execute) → hook NOT fired', async () => {
    const hooks: HookSpec[] = [baseSpec({ event: 'UserPromptSubmit', command: 'exit 1' })];
    // First run — establish a session with one assistant message.
    const first: HarnessConfig = {
      provider: mockProvider([{ text: 'first', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'kick off',
    };
    const r1 = await runAgent(first);
    expect(r1.status).toBe('done');

    // Resume re-execute — empty prompt. Hook would block if it fired,
    // but it shouldn't (no fresh user content).
    const second: HarnessConfig = {
      provider: mockProvider([{ text: 'second', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: '',
      resumeFromSessionId: r1.sessionId,
      hooks,
    };
    const r2 = await runAgent(second);
    // Run completed normally — hook never fired.
    expect(r2.status).toBe('done');
    expect(r2.reason).toBe('done');
    const runs = listHookRunsBySession(db, r2.sessionId);
    expect(runs.filter((r) => r.event === 'UserPromptSubmit')).toEqual([]);
  });

  test('Stop hook still fires on block (lifecycle bracket honored)', async () => {
    const stopMarker = join(scratch, 'stop.txt');
    const hooks: HookSpec[] = [
      baseSpec({ event: 'UserPromptSubmit', command: 'exit 1' }),
      baseSpec({ event: 'Stop', command: `cat > ${stopMarker}` }),
    ];
    const config: HarnessConfig = {
      provider: mockProvider([{ text: 'never', stop_reason: 'end_turn' }]),
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
      db,
      cwd: scratch,
      userPrompt: 'blocked one',
      hooks,
    };
    const result = await runAgent(config);
    expect(result.reason).toBe('userPromptBlocked');

    const parsed = JSON.parse(await readFile(stopMarker, 'utf8'));
    expect(parsed.event).toBe('Stop');
    expect(parsed.sessionId).toBe(result.sessionId);
  });
});

describe('hooks Slice 4 — PreCompact', () => {
  // Drive the harness past the compaction threshold and verify the
  // hook fires (allow path) OR the compaction is skipped (block).
  // The compaction check fires at the END of a tool-using step (not
  // after end_turn); we need the post-tool message list to satisfy
  // BOTH `promptTokens > triggerAt` AND `messages.length >=
  // preserveTail + 3`. We tune budget.compactionPreserveTail=0 so
  // the latter becomes `>= 3` (matches step 1's [user, assistant,
  // tool_result] history). Tiny context_window forces the prompt-
  // token threshold to be trivially exceeded.
  const buildConfig = (
    hooks: HookSpec[],
    userPrompt: string,
    contextWindow: number,
  ): HarnessConfig => ({
    provider: mockProvider(
      [
        {
          tool_uses: [{ id: 'tu1', name: 'noop', input: {} }],
          stop_reason: 'tool_use',
        },
        { text: 'finished', stop_reason: 'end_turn' },
      ],
      contextWindow,
    ),
    toolRegistry: (() => {
      const reg = createToolRegistry();
      reg.register({
        name: 'noop',
        description: 'returns ok',
        inputSchema: { type: 'object' },
        metadata: { category: 'misc', writes: false, idempotent: true },
        async execute() {
          return { ok: true };
        },
      });
      return reg;
    })(),
    permissionEngine: createPermissionEngine(policy(), { cwd: scratch }),
    db,
    cwd: scratch,
    userPrompt,
    hooks,
    budget: {
      // preserveTail=0 → guard becomes messages.length >= 3
      compactionPreserveTail: 0,
      // Low threshold so any non-empty history exceeds it.
      compactionThreshold: 0.01,
    },
  });

  test('allow → compaction proceeds; hook_runs has PreCompact + compaction event seen', async () => {
    // Tiny context window so the pad-payload pushes past threshold.
    // Long userPrompt to ensure estimatePromptTokens is well over.
    const longPrompt = 'lorem '.repeat(500); // ~3000 chars ≈ 750 tokens
    const events: { type: string }[] = [];
    const cfg = buildConfig(
      [baseSpec({ event: 'PreCompact', command: 'true' })],
      longPrompt,
      // context_window so 0.7× <= prompt tokens; promptTokens ~= 750
      // (chars/4) plus tool overhead. Use 100 to definitely cross.
      100,
    );
    cfg.onEvent = (e) => events.push({ type: e.type });
    const result = await runAgent(cfg);
    expect(result.status).toBe('done');

    const compactionStarted = events.filter((e) => e.type === 'compaction_started');
    expect(compactionStarted.length).toBeGreaterThanOrEqual(1);

    const runs = listHookRunsBySession(db, result.sessionId);
    const pc = runs.filter((r) => r.event === 'PreCompact');
    expect(pc.length).toBeGreaterThanOrEqual(1);
    expect(pc[0]?.outcome).toBe('allow');
  });

  test('block_silent → compaction skipped; no compaction_started event', async () => {
    const longPrompt = 'lorem '.repeat(500);
    const events: { type: string }[] = [];
    const cfg = buildConfig(
      [baseSpec({ event: 'PreCompact', command: 'exit 1' })],
      longPrompt,
      100,
    );
    cfg.onEvent = (e) => events.push({ type: e.type });
    const result = await runAgent(cfg);
    expect(result.status).toBe('done');

    // PreCompact ran; compaction_started/finished did NOT
    const runs = listHookRunsBySession(db, result.sessionId);
    const pc = runs.filter((r) => r.event === 'PreCompact');
    expect(pc.length).toBeGreaterThanOrEqual(1);
    expect(pc[0]?.outcome).toBe('block_silent');

    expect(events.filter((e) => e.type === 'compaction_started')).toEqual([]);
    expect(events.filter((e) => e.type === 'compaction_finished')).toEqual([]);
    // The `status === 'done'` assertion above IS the regression guard for the
    // top-of-loop trigger: re-introducing a `continue` on a blocked PreCompact
    // at the top would infinite-loop (steps never increments, so maxSteps never
    // trips), the run would never reach 'done', and this test would hang. A
    // separate step_start assert adds nothing — step_start already fires in
    // iteration 1, before a block is even possible in iteration 2.
  });

  test('payload includes promptTokens + threshold', async () => {
    const marker = join(scratch, 'pc.txt');
    const longPrompt = 'lorem '.repeat(500);
    const cfg = buildConfig(
      [baseSpec({ event: 'PreCompact', command: `cat > ${marker}` })],
      longPrompt,
      100,
    );
    await runAgent(cfg);
    const parsed = JSON.parse(await readFile(marker, 'utf8'));
    expect(parsed.event).toBe('PreCompact');
    expect(typeof parsed.data.promptTokens).toBe('number');
    expect(typeof parsed.data.threshold).toBe('number');
    expect(parsed.data.promptTokens).toBeGreaterThan(parsed.data.threshold);
  });
});
