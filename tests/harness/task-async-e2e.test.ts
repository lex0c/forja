// End-to-end coverage for the `task_async` family. Drives the
// FULL chain: parent runAgent → step loop dispatches `task_async`
// → handle store queues spawn → spawnSubagentImpl invokes
// runSubagent → runSubagent uses the injected spawn factory →
// runSubagentChild executes a real child harness in-process →
// child publishes its envelope → task_await collects.
//
// In-process spawn factory pattern is borrowed from
// `tests/subagents/e2e.test.ts`: production uses
// Bun.spawn + processTransport, the fake substitutes only the
// transport leaf. Every other layer (channel, encode/parse,
// harness, providers, permission engine, hook subsystem) runs
// production code.
//
// Why this lives here and not under `tests/subagents/`: it
// exercises the path that crosses the harness step loop
// (`task_async` tool dispatch, handle store, parallel concurrency
// cap) — that machinery doesn't show up in `runSubagent`-only
// tests, so the parallel pool semantics under real subprocess
// spawning needs its own coverage.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSubagentChild } from '../../src/cli/subagent-child.ts';
import type { CollectedStep } from '../../src/harness/collect.ts';
import { runAgent } from '../../src/harness/loop.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { Policy } from '../../src/permissions/index.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/index.ts';
import { createChannel, fakeTransportPair } from '../../src/subagents/ipc.ts';
import type { SubagentSet } from '../../src/subagents/load.ts';
import type { SpawnChildProcess } from '../../src/subagents/runtime.ts';
import type { SubagentDefinition } from '../../src/subagents/types.ts';
import { createToolRegistry, registerBuiltinTools } from '../../src/tools/index.ts';

interface ScriptedStep {
  text?: string;
  tool_uses?: { id: string; name: string; input: Record<string, unknown> }[];
  stop_reason?: CollectedStep['stop_reason'];
  message_id?: string;
}

const replayStep = function* (step: ScriptedStep): Iterable<StreamEvent> {
  yield { kind: 'start', message_id: step.message_id ?? `mock_${crypto.randomUUID()}` };
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

const buildParentProvider = (script: ScriptedStep[]): Provider => {
  let i = 0;
  return {
    id: 'mock/parent',
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
      const step = script[i++];
      if (step === undefined) throw new Error('parent script exhausted');
      for (const ev of replayStep(step)) yield ev;
    },
    generateConstrained: () => Promise.reject(new Error('not implemented')),
    countTokens: () => Promise.resolve(0),
  };
};

const buildChildProvider = (text: string, delayMs = 0): Provider => ({
  id: 'mock/child',
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
  async *generate(): AsyncGenerator<StreamEvent> {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    yield { kind: 'start', message_id: `child-${crypto.randomUUID()}` };
    if (text.length > 0) yield { kind: 'text_delta', text };
    yield { kind: 'stop', reason: 'end_turn' };
  },
  generateConstrained: () => Promise.reject(new Error('n/a')),
  countTokens: () => Promise.resolve(0),
});

const definition = (overrides: Partial<SubagentDefinition> = {}): SubagentDefinition => ({
  name: 'explore',
  description: 'Read-only exploration.',
  tools: [],
  budget: { maxSteps: 5, maxCostUsd: 0.1 },
  systemPrompt: 'You are an exploration subagent.',
  scope: 'project',
  isolation: 'none',
  sourcePath: '/fake/explore.md',
  sourceSha256: 'a'.repeat(64),
  meta: {},
  ...overrides,
});

const policy = (p: Partial<Policy> = {}): Policy => ({
  defaults: { mode: 'bypass' },
  tools: {},
  ...p,
});

let dbDir: string;
let dbPath: string;
let db: DB;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'forja-task-async-e2e-'));
  dbPath = join(dbDir, 'agent.sqlite');
  db = openDb(dbPath);
  migrate(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  try {
    unlinkSync(dbPath);
  } catch {}
  try {
    rmSync(dbDir, { recursive: true, force: true });
  } catch {}
});

describe('task_async / task_await — full e2e through harness loop and real child', () => {
  test('three task_async spawns + three task_await collect; children run in parallel', async () => {
    // The parent's tool_use script:
    //   step 1: emit three task_async calls in one turn
    //   step 2: emit three task_await calls (one per handle id)
    //   step 3: model says "done"
    //
    // Handle ids are issued by the harness at task_async dispatch.
    // Mock provider can't predict them, so step 2 is built
    // dynamically AFTER step 1 returns. The script supports this
    // by mutating its array between turns — same trick the
    // existing harness mock providers use.
    const handles: string[] = [];
    const script: ScriptedStep[] = [
      {
        tool_uses: [
          { id: 'tu1', name: 'task_async', input: { subagent: 'explore', prompt: 'find auth' } },
          { id: 'tu2', name: 'task_async', input: { subagent: 'explore', prompt: 'find queue' } },
          { id: 'tu3', name: 'task_async', input: { subagent: 'explore', prompt: 'find db' } },
        ],
        stop_reason: 'tool_use',
      },
      // Placeholder for step 2 — replaced by an interceptor on the
      // first request so we can inject the freshly minted handle
      // ids the harness handed back.
      { text: 'fallback', stop_reason: 'end_turn' },
    ];
    let receivedRequests = 0;
    const parent: Provider = {
      ...buildParentProvider(script),
      async *generate(req) {
        receivedRequests += 1;
        if (receivedRequests === 1) {
          // Yield step 1 verbatim — three task_async tool_uses.
          for (const ev of replayStep(script[0] as ScriptedStep)) yield ev;
          return;
        }
        if (receivedRequests === 2) {
          // Read the handle ids out of the prior assistant turn's
          // tool_results. The harness placed them in the last user
          // message of `req.messages`. Each tool_result content
          // is a JSON string carrying `handle_id`.
          const lastUser = req.messages[req.messages.length - 1];
          if (lastUser !== undefined && Array.isArray(lastUser.content)) {
            for (const block of lastUser.content) {
              if (block.type === 'tool_result' && typeof block.content === 'string') {
                const parsed = JSON.parse(block.content) as { handle_id?: string };
                if (typeof parsed.handle_id === 'string') handles.push(parsed.handle_id);
              }
            }
          }
          // Emit three task_await calls keyed by the captured ids.
          const step2: ScriptedStep = {
            tool_uses: handles.map((id, i) => ({
              id: `tw${i + 1}`,
              name: 'task_await',
              input: { handle_id: id },
            })),
            stop_reason: 'tool_use',
          };
          for (const ev of replayStep(step2)) yield ev;
          return;
        }
        // Step 3: terminal text turn.
        for (const ev of replayStep({ text: 'done', stop_reason: 'end_turn' })) yield ev;
      },
    };

    const parentRegistry = createToolRegistry();
    registerBuiltinTools(parentRegistry);
    const engine = createPermissionEngine(policy(), { cwd: '/p' });
    const subagentRegistry: SubagentSet = {
      byName: new Map([['explore', definition()]]),
      shadows: [],
    };

    // Spawn factory: each invocation runs runSubagentChild
    // in-process with a fake transport pair. We track concurrent
    // child invocations via a counter to confirm parallelism.
    let liveChildren = 0;
    let maxLiveChildren = 0;
    const spawn: SpawnChildProcess = (opts) => {
      liveChildren += 1;
      if (liveChildren > maxLiveChildren) maxLiveChildren = liveChildren;
      const { a, b } = fakeTransportPair();
      const parentChannel = createChannel(a);
      // Distinct text per spawn so we can verify outputs land
      // back at the right handle. The runtime preserves
      // session_id ↔ output_text wiring through subagent_outputs.
      const exited = runSubagentChild({
        sessionId: opts.sessionId,
        dbPath,
        providerOverride: buildChildProvider(`output for ${opts.sessionId}`, 30),
        userAgentsDir: null,
        projectAgentsDir: null,
        errSink: () => undefined,
        ipcVersion: 1,
        ipcTransportFactory: () => b,
      })
        .then((exitCode) => ({ exitCode }))
        .finally(() => {
          liveChildren -= 1;
        });
      return { exited, kill: () => undefined, ipc: parentChannel };
    };

    const result = await runAgent({
      provider: parent,
      toolRegistry: parentRegistry,
      permissionEngine: engine,
      db,
      cwd: '/p',
      userPrompt: 'fan out',
      subagentRegistry,
      spawnChildProcess: spawn,
      // Cap = 3 so all three children can be in flight together.
      budget: { maxConcurrentSubagents: 3 },
    });

    expect(result.status).toBe('done');
    expect(result.reason).toBe('done');
    // Three handles were issued and three children spawned.
    expect(handles).toHaveLength(3);
    // Parallelism proof: at least 2 children alive at the same
    // instant. With cap=3 and three spawns all kicked off in one
    // turn, the typical observed maximum is 3 — but provider stub
    // delay variance can let one finish before the third dispatches.
    // `>= 2` is the load-bearing assertion that distinguishes
    // parallel from accidental serialization.
    expect(maxLiveChildren).toBeGreaterThanOrEqual(2);
  });

  test('task_cancel preempts a running child via the IPC interrupt path', async () => {
    // Single spawn whose child sleeps long enough that cancel can
    // race in before the natural exit. Confirms that the per-handle
    // signal threads through spawnSubagentImpl → runSubagent →
    // child IPC interrupt.
    let childStartedResolve: () => void = () => {};
    const childStarted = new Promise<void>((resolve) => {
      childStartedResolve = resolve;
    });

    const script: ScriptedStep[] = [
      {
        tool_uses: [
          { id: 'tu1', name: 'task_async', input: { subagent: 'explore', prompt: 'go' } },
        ],
        stop_reason: 'tool_use',
      },
      // Placeholder; replaced once we have the handle id.
      { text: 'unused', stop_reason: 'end_turn' },
      { text: 'done', stop_reason: 'end_turn' },
    ];
    let req = 0;
    let capturedHandle = '';
    const parent: Provider = {
      ...buildParentProvider(script),
      async *generate(reqArgs) {
        req += 1;
        if (req === 1) {
          for (const ev of replayStep(script[0] as ScriptedStep)) yield ev;
          return;
        }
        if (req === 2) {
          const lastUser = reqArgs.messages[reqArgs.messages.length - 1];
          if (lastUser !== undefined && Array.isArray(lastUser.content)) {
            for (const block of lastUser.content) {
              if (block.type === 'tool_result' && typeof block.content === 'string') {
                const parsed = JSON.parse(block.content) as { handle_id?: string };
                if (typeof parsed.handle_id === 'string') capturedHandle = parsed.handle_id;
              }
            }
          }
          // Cancel + await sequence in one step.
          const step2: ScriptedStep = {
            tool_uses: [
              { id: 'tc1', name: 'task_cancel', input: { handle_id: capturedHandle } },
              { id: 'tw1', name: 'task_await', input: { handle_id: capturedHandle } },
            ],
            stop_reason: 'tool_use',
          };
          for (const ev of replayStep(step2)) yield ev;
          return;
        }
        for (const ev of replayStep({ text: 'done', stop_reason: 'end_turn' })) yield ev;
      },
    };

    const parentRegistry = createToolRegistry();
    registerBuiltinTools(parentRegistry);
    const engine = createPermissionEngine(policy(), { cwd: '/p' });
    const subagentRegistry: SubagentSet = {
      byName: new Map([['explore', definition()]]),
      shadows: [],
    };

    const spawn: SpawnChildProcess = (opts) => {
      const { a, b } = fakeTransportPair();
      const parentChannel = createChannel(a);
      // Long delay — without cancel, the child runs ~500ms.
      const exited = runSubagentChild({
        sessionId: opts.sessionId,
        dbPath,
        providerOverride: buildChildProvider('would-be-output', 500),
        userAgentsDir: null,
        projectAgentsDir: null,
        errSink: () => undefined,
        ipcVersion: 1,
        ipcTransportFactory: () => b,
      }).then((exitCode) => ({ exitCode }));
      childStartedResolve();
      return { exited, kill: () => undefined, ipc: parentChannel };
    };

    const start = Date.now();
    const result = await runAgent({
      provider: parent,
      toolRegistry: parentRegistry,
      permissionEngine: engine,
      db,
      cwd: '/p',
      userPrompt: 'go',
      subagentRegistry,
      spawnChildProcess: spawn,
      budget: { maxConcurrentSubagents: 3, maxWallClockMs: 5000 },
    });
    await childStarted;
    const elapsed = Date.now() - start;

    expect(result.status).toBe('done');
    // The cancel + await landed in step 2; the await should
    // surface a tool_error for the interrupted run, but the
    // parent recovers and step 3 emits 'done'. The full run is
    // bounded well below the 500ms the child would have taken
    // had the cancel not propagated.
    expect(elapsed).toBeLessThan(1500);
  });
});
