import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../../src/harness/loop.ts';
import type { BgManagerHolder, HarnessConfig, HarnessEvent } from '../../src/harness/types.ts';
import { initBashParser } from '../../src/permissions/bash-parser.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { GenerateRequest, Provider, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listBgProcessesBySession } from '../../src/storage/repos/bg-processes.ts';
import { bashBackgroundTool } from '../../src/tools/builtin/bash-background.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';

interface ScriptedStep {
  text?: string;
  tool_uses?: { id: string; name: string; input: Record<string, unknown> }[];
  stop_reason?: 'end_turn' | 'tool_use';
}

const replayStep = function* (step: ScriptedStep): Iterable<StreamEvent> {
  yield { kind: 'start', message_id: `mock_${crypto.randomUUID()}` };
  if (step.text !== undefined) yield { kind: 'text_delta', text: step.text };
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
  const requests: GenerateRequest[] = [];
  let i = 0;
  return {
    id: 'mock/bg',
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
    async *generate(req) {
      requests.push(req);
      const step = script[i++];
      if (step === undefined) throw new Error('mock script exhausted');
      for (const ev of replayStep(step)) yield ev;
    },
    generateConstrained: () => Promise.reject(new Error('not implemented')),
    countTokens: () => Promise.resolve(0),
  };
};

let db: DB;
let logDir: string;
const tempRoots: string[] = [];

const buildConfig = (script: ScriptedStep[], opts: { bgLogDir?: string } = {}): HarnessConfig => {
  const registry = createToolRegistry();
  registry.register(bashBackgroundTool);
  const policy = {
    // bypass keeps the permission engine out of the way — this test is
    // about the cleanup hook, not policy.
    defaults: { mode: 'bypass' as const },
    tools: {},
  };
  return {
    provider: mockProvider(script),
    toolRegistry: registry,
    permissionEngine: createPermissionEngine(policy, { cwd: '/p' }),
    db,
    cwd: process.cwd(),
    userPrompt: 'spawn',
    ...(opts.bgLogDir !== undefined ? { bgLogDir: opts.bgLogDir } : {}),
  };
};

beforeEach(async () => {
  // The permission engine's bash resolver refuses every bash /
  // bash_background command until the bash parser is initialized
  // (production does this in bootstrap()). These tests build the
  // HarnessConfig by hand, so without an explicit init the resolver
  // DENIES the spawn and no bg row is written — `procs.length` is 0.
  // It only passed in the full suite because some earlier test
  // happened to init the parser first (it's global module state);
  // run isolated, or with a different file order on CI, it failed.
  // Init here so the test is order-independent.
  await initBashParser();
  db = openMemoryDb();
  migrate(db);
  logDir = mkdtempSync(join(tmpdir(), 'forja-harness-bg-'));
  tempRoots.push(logDir);
});

afterEach(() => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  tempRoots.length = 0;
});

describe('harness bg cleanup hook', () => {
  test('long-running bg process is killed when the loop exits naturally', async () => {
    // Step 1: model spawns `sleep 30`. Step 2: model says done.
    const config = buildConfig(
      [
        {
          tool_uses: [{ id: 'tu-1', name: 'bash_background', input: { command: 'sleep 30' } }],
          stop_reason: 'tool_use',
        },
        { text: 'spawned, finishing', stop_reason: 'end_turn' },
      ],
      { bgLogDir: logDir },
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');

    // After runAgent returns, the spawned process must be killed
    // (cleanup hook ran). DB is the source of truth.
    const procs = listBgProcessesBySession(db, result.sessionId);
    expect(procs.length).toBe(1);
    const proc = procs[0];
    expect(proc).toBeDefined();
    if (proc === undefined) return;
    expect(proc.status).toBe('killed');
    expect(proc.exitedAt).toBeGreaterThan(0);
  });

  test('cleanup also fires on internalError exit path', async () => {
    // Spawn one bg process, then have the mock provider throw on the
    // next request — simulates a SQLite/internal error after spawn.
    let calls = 0;
    const erroringProvider: Provider = {
      id: 'mock/bg-error',
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
      async *generate() {
        calls += 1;
        if (calls === 1) {
          yield* replayStep({
            tool_uses: [{ id: 'tu-1', name: 'bash_background', input: { command: 'sleep 30' } }],
            stop_reason: 'tool_use',
          });
          return;
        }
        throw new Error('boom');
      },
      generateConstrained: () => Promise.reject(new Error('not implemented')),
      countTokens: () => Promise.resolve(0),
    };

    const registry = createToolRegistry();
    registry.register(bashBackgroundTool);
    const config: HarnessConfig = {
      provider: erroringProvider,
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(
        { defaults: { mode: 'bypass' }, tools: {} },
        { cwd: '/p' },
      ),
      db,
      cwd: process.cwd(),
      userPrompt: 'spawn',
      bgLogDir: logDir,
      // Don't trip retry into making this case slow
      budget: { maxSteps: 5 },
    };
    const result = await runAgent(config);
    // Either status: error (provider error path) — cleanup should
    // STILL have fired regardless of which error reason wins.
    expect(['error', 'interrupted']).toContain(result.status);
    const procs = listBgProcessesBySession(db, result.sessionId);
    expect(procs.length).toBe(1);
    const proc = procs[0];
    if (proc === undefined) return;
    expect(proc.status).toBe('killed');
  });

  test('without bgLogDir the bash_background tool errors cleanly', async () => {
    const config = buildConfig(
      [
        {
          tool_uses: [{ id: 'tu-1', name: 'bash_background', input: { command: 'sleep 30' } }],
          stop_reason: 'tool_use',
        },
        { text: 'tool errored as expected', stop_reason: 'end_turn' },
      ],
      // intentionally no bgLogDir
    );
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    // No bg row was written
    const procs = listBgProcessesBySession(db, result.sessionId);
    expect(procs.length).toBe(0);
  });
});

describe('harness bg session-scoped holder (spec ORCHESTRATION.md §3B)', () => {
  const spawnThenDone: ScriptedStep[] = [
    {
      tool_uses: [{ id: 'tu-1', name: 'bash_background', input: { command: 'sleep 30' } }],
      stop_reason: 'tool_use',
    },
    { text: 'spawned, finishing', stop_reason: 'end_turn' },
  ];

  test('with an injected holder the bg process SURVIVES the turn (not killed)', async () => {
    const holder: BgManagerHolder = { manager: undefined, onEvent: () => {} };
    const result = await runAgent({
      ...buildConfig(spawnThenDone, { bgLogDir: logDir }),
      bgManagerHolder: holder,
    });
    expect(result.status).toBe('done');

    // The per-turn cleanup must NOT have killed it — the holder owner
    // (the REPL) owns teardown at session exit.
    const procs = listBgProcessesBySession(db, result.sessionId);
    expect(procs.length).toBe(1);
    expect(procs[0]?.status).toBe('running');
    // The loop populated the holder with the session-scoped manager.
    expect(holder.manager).toBeDefined();

    // Teardown (what the REPL does on session exit): now it dies.
    await holder.manager?.cleanup();
    expect(listBgProcessesBySession(db, result.sessionId)[0]?.status).toBe('killed');
  });

  test('bg lifecycle events route through the holder onEvent sink, not config.onEvent', async () => {
    const holderEvents: HarnessEvent[] = [];
    const configEvents: HarnessEvent[] = [];
    const holder: BgManagerHolder = {
      manager: undefined,
      onEvent: (e) => holderEvents.push(e),
    };
    const result = await runAgent({
      ...buildConfig(spawnThenDone, { bgLogDir: logDir }),
      bgManagerHolder: holder,
      onEvent: (e) => configEvents.push(e),
    });
    expect(result.status).toBe('done');
    // bg_started routed to the cross-turn sink…
    expect(holderEvents.some((e) => e.type === 'bg_started')).toBe(true);
    // …and NOT to the per-turn config.onEvent (which would die with the turn).
    expect(configEvents.some((e) => e.type === 'bg_started')).toBe(false);
    await holder.manager?.cleanup();
  });

  test('a second turn with the same holder reuses the manager (not rebuilt)', async () => {
    const holder: BgManagerHolder = { manager: undefined, onEvent: () => {} };
    await runAgent({
      ...buildConfig(spawnThenDone, { bgLogDir: logDir }),
      bgManagerHolder: holder,
    });
    const firstManager = holder.manager;
    expect(firstManager).toBeDefined();

    // Second turn, same holder, no spawn — the reuse path must hand back
    // the SAME manager instance instead of building a fresh one.
    await runAgent({
      ...buildConfig([{ text: 'noop', stop_reason: 'end_turn' }], { bgLogDir: logDir }),
      bgManagerHolder: holder,
    });
    expect(holder.manager).toBe(firstManager);

    await holder.manager?.cleanup();
  });
});
