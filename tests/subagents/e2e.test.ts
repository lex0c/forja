import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSubagentChild } from '../../src/cli/subagent-child.ts';
import type { HarnessEvent } from '../../src/harness/index.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { Policy } from '../../src/permissions/index.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';
import { openDb } from '../../src/storage/db.ts';
import { createSession, migrate } from '../../src/storage/index.ts';
import { createChannel, fakeTransportPair } from '../../src/subagents/ipc.ts';
import { type SpawnChildProcess, runSubagent } from '../../src/subagents/runtime.ts';
import type { SubagentDefinition } from '../../src/subagents/types.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';
import type { Tool } from '../../src/tools/types.ts';

// End-to-end IPC sanity (S4). The runtime tests in runtime.test.ts
// inject an `event` IPC message stream from the test side directly;
// here we exercise the full producer chain by running the REAL
// `runSubagentChild` (via an in-process invocation) and verifying
// the events the child's harness fires actually arrive on the
// parent's `onChildEvent` observer through the IPC channel.
//
// "In-process" e2e because spawning the real binary requires the
// child to talk to the same on-disk DB the parent prepared, plus
// the production provider registry. Threading those through CLI
// flags (or building a release binary inside the test) buys us
// nothing the in-process variant doesn't already exercise — the
// IPC code path is byte-for-byte identical (same `processTransport`
// vs `fakeTransportPair` only in the transport leaf, every other
// layer runs production code).

const policy = (p: Partial<Policy> = {}): Policy => ({
  defaults: { mode: 'bypass' },
  tools: {},
  ...p,
});

let dbDir: string;
let dbPath: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'forja-subagent-e2e-'));
  dbPath = join(dbDir, 'agent.sqlite');
});

afterEach(() => {
  try {
    unlinkSync(dbPath);
  } catch {}
  try {
    rmSync(dbDir, { recursive: true, force: true });
  } catch {}
});

const stubProvider = (text: string): Provider => ({
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
  async *generate(): AsyncGenerator<StreamEvent> {
    yield { kind: 'start', message_id: 'mock-msg' };
    if (text.length > 0) yield { kind: 'text_delta', text };
    yield { kind: 'stop', reason: 'end_turn' };
  },
  generateConstrained: () => Promise.reject(new Error('n/a')),
  countTokens: () => Promise.resolve(0),
});

const echoTool: Tool = {
  name: 'echo',
  description: 'echo',
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

const definition = (overrides: Partial<SubagentDefinition> = {}): SubagentDefinition => ({
  name: 'explore',
  description: 'Read-only.',
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

describe('subagent e2e — real child harness over IPC (S4)', () => {
  test('child HarnessEvents reach the parent observer through the IPC wire', async () => {
    // Real DB on disk so parent + child share state.
    const parentDb = openDb(dbPath);
    migrate(parentDb);
    const parent = createSession(parentDb, { model: 'mock/m', cwd: '/p' });

    const parentRegistry = createToolRegistry();
    parentRegistry.register(echoTool);
    const engine = createPermissionEngine(policy(), { cwd: '/p' });

    // Spawn factory that runs runSubagentChild in-process, wired
    // to a fake IPC transport pair. Production uses Bun.spawn +
    // processTransport; the fake substitutes the leaf without
    // changing any other layer (channel, encode/parse, harness,
    // providers, permission engine, hook subsystem all run
    // production code).
    const collected: HarnessEvent[] = [];
    const spawn: SpawnChildProcess = (opts) => {
      const { a, b } = fakeTransportPair();
      const parentChannel = createChannel(a);
      // The child harness exits cleanly with a stub provider that
      // yields end_turn after a single assistant text. The exit
      // promise is driven by runSubagentChild's resolution.
      const exited = runSubagentChild({
        sessionId: opts.sessionId,
        dbPath,
        providerOverride: stubProvider('hello e2e'),
        userAgentsDir: null,
        projectAgentsDir: null,
        errSink: () => undefined,
        ipcVersion: 1,
        ipcTransportFactory: () => b,
      }).then((exitCode) => ({ exitCode }));
      return {
        exited,
        kill: () => undefined,
        ipc: parentChannel,
      };
    };

    const result = await runSubagent({
      definition: definition(),
      prompt: 'say hello',
      parentSessionId: parent.id,
      provider: stubProvider(''),
      parentToolRegistry: parentRegistry,
      permissionEngine: engine,
      db: parentDb,
      cwd: '/p',
      onChildEvent: (e) => collected.push(e),
      spawnChildProcess: spawn,
    });

    expect(result.status).toBe('done');
    expect(result.reason).toBe('done');

    // The bracket invariant: the parent runtime fires
    // subagent_start before spawn and subagent_finished after
    // wait. Anything in between is a `subagent_progress` carrying
    // a child HarnessEvent that crossed the wire.
    expect(collected[0]?.type).toBe('subagent_start');
    expect(collected[collected.length - 1]?.type).toBe('subagent_finished');

    // The child's harness emits at minimum: session_start
    // (child's own), step_start (1), provider_event*,
    // session_finished (filtered at IPC boundary). So we expect
    // at least one subagent_progress whose lastEvent is
    // step_start.
    const progressTypes = collected
      .filter((e) => e.type === 'subagent_progress')
      .map((e) => (e.type === 'subagent_progress' ? e.lastEvent.type : 'never'));
    expect(progressTypes.includes('step_start')).toBe(true);
    // Also expect the provider stream to surface. Adapter doesn't
    // care about the specific provider_event variant; we just
    // verify the wire delivered them.
    expect(progressTypes.includes('provider_event')).toBe(true);

    parentDb.close();
  });

  test('hard interrupt over IPC reaches the real child harness and yields abortCause=hard', async () => {
    // E2E for the S3 interrupt wire: parent's hard signal triggers
    // an `interrupt:hard` IPC command, which the real child
    // harness routes into its signalController, which the harness
    // honors as a preemptive abort. The child's envelope then
    // carries `abort_cause: 'hard'` back to the parent. Closes
    // the gap the BACKLOG flagged on review (interrupt routing
    // not exercised end-to-end in S3).
    const parentDb = openDb(dbPath);
    migrate(parentDb);
    const parent = createSession(parentDb, { model: 'mock/m', cwd: '/p' });
    const parentRegistry = createToolRegistry();
    parentRegistry.register(echoTool);
    const engine = createPermissionEngine(policy(), { cwd: '/p' });

    // Provider with a slow `start` so the hard signal can race in
    // and abort the in-flight provider call. 200ms is comfortably
    // longer than the parent's initial poll cadence (50ms) so the
    // wait loop reaches its hard-trigger branch and forwards the
    // IPC command before the child's stream completes naturally.
    const slowProvider: Provider = {
      ...stubProvider('content'),
      async *generate(): AsyncGenerator<StreamEvent> {
        await new Promise((r) => setTimeout(r, 200));
        yield { kind: 'start', message_id: 'm1' };
        yield { kind: 'stop', reason: 'end_turn' };
      },
    };

    const collected: HarnessEvent[] = [];
    const hardCtl = new AbortController();
    const spawn: SpawnChildProcess = (opts) => {
      const { a, b } = fakeTransportPair();
      const parentChannel = createChannel(a);
      const exited = runSubagentChild({
        sessionId: opts.sessionId,
        dbPath,
        providerOverride: slowProvider,
        userAgentsDir: null,
        projectAgentsDir: null,
        errSink: () => undefined,
        ipcVersion: 1,
        ipcTransportFactory: () => b,
      }).then((exitCode) => ({ exitCode }));
      return { exited, kill: () => undefined, ipc: parentChannel };
    };
    queueMicrotask(() => hardCtl.abort());

    const result = await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(''),
      parentToolRegistry: parentRegistry,
      permissionEngine: engine,
      db: parentDb,
      cwd: '/p',
      signal: hardCtl.signal,
      onChildEvent: (e) => collected.push(e),
      spawnChildProcess: spawn,
      graceMs: 1000,
    });

    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('aborted');
    expect(result.abortCause).toBe('hard');
    // Bracket close fires from the parent's wait outcome
    // regardless of the child's bracket. Verify the parent saw a
    // matching subagent_finished with the same discriminator.
    const fin = collected[collected.length - 1];
    if (fin?.type === 'subagent_finished') {
      // The harness emits abortCause via its own session_finished
      // payload; runtime extracts and forwards. Status mapping:
      // 'interrupted' (HarnessResult.status) is preserved.
      expect(fin.status).toBe('interrupted');
    } else {
      throw new Error('expected last event to be subagent_finished');
    }
    parentDb.close();
  });

  test('child session_finished is filtered (parent never sees it as a progress event)', async () => {
    // Defense in depth: the IPC boundary drops session_finished
    // and subagent_* on both sides. This test asserts the
    // parent's observer never receives a `subagent_progress`
    // whose `lastEvent.type === 'session_finished'` — that would
    // collide with the parent runtime's own `subagent_finished`
    // bracket close.
    const parentDb = openDb(dbPath);
    migrate(parentDb);
    const parent = createSession(parentDb, { model: 'mock/m', cwd: '/p' });
    const parentRegistry = createToolRegistry();
    parentRegistry.register(echoTool);
    const engine = createPermissionEngine(policy(), { cwd: '/p' });
    const collected: HarnessEvent[] = [];
    const spawn: SpawnChildProcess = (opts) => {
      const { a, b } = fakeTransportPair();
      const parentChannel = createChannel(a);
      const exited = runSubagentChild({
        sessionId: opts.sessionId,
        dbPath,
        providerOverride: stubProvider('done'),
        userAgentsDir: null,
        projectAgentsDir: null,
        errSink: () => undefined,
        ipcVersion: 1,
        ipcTransportFactory: () => b,
      }).then((exitCode) => ({ exitCode }));
      return { exited, kill: () => undefined, ipc: parentChannel };
    };
    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(''),
      parentToolRegistry: parentRegistry,
      permissionEngine: engine,
      db: parentDb,
      cwd: '/p',
      onChildEvent: (e) => collected.push(e),
      spawnChildProcess: spawn,
    });
    // No progress event should carry the child's session_finished
    // (filter at the child's `onEvent`, parent's `onMessage`,
    // OR both — the test passes regardless of which layer
    // catches it).
    const leakedSessionFinished = collected.some(
      (e) => e.type === 'subagent_progress' && e.lastEvent.type === 'session_finished',
    );
    expect(leakedSessionFinished).toBe(false);
    parentDb.close();
  });
});
