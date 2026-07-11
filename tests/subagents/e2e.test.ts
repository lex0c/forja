import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSubagentChild } from '../../src/cli/subagent-child.ts';
import type { HarnessEvent } from '../../src/harness/index.ts';
import type { Policy } from '../../src/permissions/index.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';
import { openDb } from '../../src/storage/db.ts';
import { createSession, migrate } from '../../src/storage/index.ts';
import { createChannel, fakeTransportPair } from '../../src/subagents/ipc.ts';
import { runSubagent, type SpawnChildProcess } from '../../src/subagents/runtime.ts';
import type { SubagentDefinition } from '../../src/subagents/types.ts';
import { readFileTool } from '../../src/tools/builtin/read-file.ts';
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

  test('permission proxy: child confirm verdict round-trips through parent operator hook', async () => {
    // Costura as três slices do permission proxy em um único caminho:
    //   child engine returns confirm
    //     → bridge sends permission:ask via IPC
    //     → parent runtime observer routes to onPermissionAsk hook
    //     → hook (test stub) returns 'allow'
    //     → runtime sends permission:answer
    //     → bridge resolves invoke-tool's confirmPermission to true
    //     → invoke-tool records `confirm_yes` / decided_by='user'
    //     → tool actually executes
    //
    // No subprocess: `runSubagentChild` runs in-process via the same
    // pattern the other e2e tests above use. Every layer is
    // production code except the transport leaf (fakeTransportPair
    // substitutes for processTransport).
    //
    // Tool choice: read_file. Has writes:false (so the subagent
    // definition doesn't need worktree isolation), exercises the
    // fs.read engine path (distinct from bash but same confirm
    // surface), and Bun.file's "missing path" error path is
    // graceful — when the operator allows, the tool body runs
    // and either returns content or a clean error; either way the
    // approval row is what we're asserting on.
    const parentDb = openDb(dbPath);
    migrate(parentDb);
    const parent = createSession(parentDb, { model: 'mock/m', cwd: '/p' });

    // Engine in strict mode with an fs.read confirm rule. The
    // child inherits this policy via policy_snapshot when the
    // parent stamps the audit row, so the engine inside the
    // child returns the same confirm verdict the parent's engine
    // would. `**` matches every relative path; `/**` would match
    // every absolute path. Combined we cover both shapes the
    // model might emit.
    const enginePolicy = policy({
      defaults: { mode: 'strict' },
      tools: { read_file: { confirm_paths: ['**', '/**'] } },
    });
    const engine = createPermissionEngine(enginePolicy, { cwd: '/p' });

    // Parent's tool registry must include `read_file` — runtime
    // validates the subagent's whitelist against the parent's
    // registry before spawning (assertWhitelistValidForSubagent).
    // The parent never executes the tool itself; the registration
    // is purely a contract gate.
    const parentRegistry = createToolRegistry();
    parentRegistry.register(readFileTool as unknown as Tool);

    // Child provider: emit a single read_file tool_use, then
    // end_turn after the tool_result lands. Stateful via a
    // closure counter. The path is fictional — read_file's
    // execute will surface a clean ENOENT error which the model
    // sees as a tool result; the audit row was already written
    // before the body ran.
    let providerCall = 0;
    const childProvider: Provider = {
      id: 'mock/m',
      family: 'anthropic',
      capabilities: stubProvider('').capabilities,
      async *generate(): AsyncGenerator<StreamEvent> {
        providerCall += 1;
        yield { kind: 'start', message_id: `mock-msg-${providerCall}` };
        if (providerCall === 1) {
          yield { kind: 'tool_use_start', id: 'tu-1', name: 'read_file' };
          yield {
            kind: 'tool_use_stop',
            id: 'tu-1',
            final_args: { path: '/p/permission-proxy-smoke.txt' },
          };
          yield { kind: 'stop', reason: 'tool_use' };
        } else {
          yield { kind: 'text_delta', text: 'tool ran, all done' };
          yield { kind: 'stop', reason: 'end_turn' };
        }
      },
      generateConstrained: () => Promise.reject(new Error('n/a')),
      countTokens: () => Promise.resolve(0),
    };

    // Operator stand-in: record what the runtime delivered, answer
    // 'allow'. Spec §7's mandate ("child NEVER receives auto-approve
    // via IPC") is honored — the hook is a TEST simulating an
    // operator at the modal, not an automated allow path inside
    // the runtime.
    interface RecordedAsk {
      toolName: string;
      args: Record<string, unknown>;
      cwd: string;
      prompt: string;
      subagent: { sessionId: string; name: string };
    }
    const askedRequests: RecordedAsk[] = [];
    const onPermissionAsk = async (req: RecordedAsk): Promise<'allow' | 'deny'> => {
      askedRequests.push(req);
      return 'allow';
    };

    const spawn: SpawnChildProcess = (opts) => {
      const { a, b } = fakeTransportPair();
      const parentChannel = createChannel(a);
      const exited = runSubagentChild({
        sessionId: opts.sessionId,
        dbPath,
        providerOverride: childProvider,
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
      definition: definition({ name: 'explore', tools: ['read_file'] }),
      prompt: 'read the file',
      parentSessionId: parent.id,
      provider: stubProvider(''),
      parentToolRegistry: parentRegistry,
      permissionEngine: engine,
      db: parentDb,
      cwd: '/p',
      onPermissionAsk,
      spawnChildProcess: spawn,
    });

    // Hook fired exactly once with the right shape and the runtime
    // baked-in attribution.
    expect(askedRequests).toHaveLength(1);
    const ask = askedRequests[0];
    expect(ask).toBeDefined();
    if (ask !== undefined) {
      expect(ask.toolName).toBe('read_file');
      expect(ask.args).toEqual({ path: '/p/permission-proxy-smoke.txt' });
      expect(ask.cwd).toBe('/p');
      expect(ask.subagent.name).toBe('explore');
      expect(ask.subagent.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      // The engine builds the prompt from the matched rule —
      // fs.read's confirm path uses `Read from <path>?`.
      expect(ask.prompt).toContain('Read from /p/permission-proxy-smoke.txt');
    }

    // Child completed cleanly. The operator allowed; whether the
    // tool body succeeded (file exists) or surfaced an error
    // (ENOENT) is irrelevant — the integration we're testing
    // ends at the approval row.
    expect(result.status).toBe('done');
    expect(result.reason).toBe('done');

    // Audit chain: query the approvals table joined back to
    // tool_calls + messages so the assertion mirrors what an
    // operator running `forja --list-sessions <child> --audit`
    // would see — proves the chain "operator approved X for child Y
    // for tool Z" is reconstructable through the existing schema
    // (no migration needed, per BACKLOG decision).
    if (ask !== undefined) {
      const approvals = parentDb
        .query(
          `SELECT a.decision, a.decided_by
             FROM approvals a
             JOIN tool_calls tc ON a.tool_call_id = tc.id
             JOIN messages m ON tc.message_id = m.id
             WHERE m.session_id = ?
             ORDER BY a.decided_at ASC`,
        )
        .all(ask.subagent.sessionId) as { decision: string; decided_by: string }[];
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.decision).toBe('confirm_yes');
      expect(approvals[0]?.decided_by).toBe('user');
    }

    parentDb.close();
  });

  test('permission proxy: operator deny blocks the tool and records confirm_no', async () => {
    // Mirror image of the test above. Same setup; hook returns
    // 'deny' instead of 'allow'. Child's invoke-tool records
    // `confirm_no` / `decided_by='user'`, the read_file tool
    // body never runs, and the child's harness sees `denied by
    // user` as the tool result. The child still completes
    // cleanly (denial is a tool-result-level error, not a
    // session-level one) — the model just gets the negative
    // outcome and decides what to do.
    const parentDb = openDb(dbPath);
    migrate(parentDb);
    const parent = createSession(parentDb, { model: 'mock/m', cwd: '/p' });

    const enginePolicy = policy({
      defaults: { mode: 'strict' },
      tools: { read_file: { confirm_paths: ['**', '/**'] } },
    });
    const engine = createPermissionEngine(enginePolicy, { cwd: '/p' });
    const parentRegistry = createToolRegistry();
    parentRegistry.register(readFileTool as unknown as Tool);

    let providerCall = 0;
    const childProvider: Provider = {
      id: 'mock/m',
      family: 'anthropic',
      capabilities: stubProvider('').capabilities,
      async *generate(): AsyncGenerator<StreamEvent> {
        providerCall += 1;
        yield { kind: 'start', message_id: `mock-msg-${providerCall}` };
        if (providerCall === 1) {
          yield { kind: 'tool_use_start', id: 'tu-deny', name: 'read_file' };
          yield {
            kind: 'tool_use_stop',
            id: 'tu-deny',
            final_args: { path: '/p/blocked.txt' },
          };
          yield { kind: 'stop', reason: 'tool_use' };
        } else {
          yield { kind: 'text_delta', text: 'gave up after denial' };
          yield { kind: 'stop', reason: 'end_turn' };
        }
      },
      generateConstrained: () => Promise.reject(new Error('n/a')),
      countTokens: () => Promise.resolve(0),
    };

    let askCount = 0;
    let recordedSubagentSessionId = '';
    const onPermissionAsk = async (req: {
      subagent: { sessionId: string; name: string };
    }): Promise<'allow' | 'deny'> => {
      askCount += 1;
      recordedSubagentSessionId = req.subagent.sessionId;
      return 'deny';
    };

    const spawn: SpawnChildProcess = (opts) => {
      const { a, b } = fakeTransportPair();
      const parentChannel = createChannel(a);
      const exited = runSubagentChild({
        sessionId: opts.sessionId,
        dbPath,
        providerOverride: childProvider,
        userAgentsDir: null,
        projectAgentsDir: null,
        errSink: () => undefined,
        ipcVersion: 1,
        ipcTransportFactory: () => b,
      }).then((exitCode) => ({ exitCode }));
      return { exited, kill: () => undefined, ipc: parentChannel };
    };

    const result = await runSubagent({
      definition: definition({ name: 'explore', tools: ['read_file'] }),
      prompt: 'try to read',
      parentSessionId: parent.id,
      provider: stubProvider(''),
      parentToolRegistry: parentRegistry,
      permissionEngine: engine,
      db: parentDb,
      cwd: '/p',
      onPermissionAsk,
      spawnChildProcess: spawn,
    });

    expect(askCount).toBe(1);
    expect(result.status).toBe('done');

    // Audit row reflects user denial, not policy denial.
    const approvals = parentDb
      .query(
        `SELECT a.decision, a.decided_by
           FROM approvals a
           JOIN tool_calls tc ON a.tool_call_id = tc.id
           JOIN messages m ON tc.message_id = m.id
           WHERE m.session_id = ?
           ORDER BY a.decided_at ASC`,
      )
      .all(recordedSubagentSessionId) as { decision: string; decided_by: string }[];
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.decision).toBe('confirm_no');
    expect(approvals[0]?.decided_by).toBe('user');

    parentDb.close();
  });

  test('T3: child inherits parent sharedScopeOffline → no project_shared in systemPrompt', async () => {
    // Pins the CRIT/H3 wiring end-to-end. Parent's
    // `memoryExcludeScopes: ['project_shared']` becomes
    // `sharedScopeOffline: true` at the boolean serialization
    // boundary (per N1 docs), flows via runSubagent → spawn factory
    // → runSubagentChild → assembleMemorySection's excludeScopes.
    // We assert by capturing the child's HarnessConfig and reading
    // its systemPrompt; the shared memory body MUST be excluded.
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const parentCwd = mkdtempSync(join(tmpdir(), 'forja-subagent-h3-'));
    const sharedDir = join(parentCwd, '.forja', 'memory', 'shared');
    mkdirSync(sharedDir, { recursive: true });
    writeFileSync(join(sharedDir, 'MEMORY.md'), '- [Sensitive](sensitive.md) — h\n');
    writeFileSync(
      join(sharedDir, 'sensitive.md'),
      '---\nname: sensitive\ndescription: h\ntype: feedback\nsource: user_explicit\n---\n\nINHERITED_BODY\n',
    );

    const parentDb = openDb(dbPath);
    migrate(parentDb);
    const parent = createSession(parentDb, { model: 'mock/m', cwd: parentCwd });
    const parentRegistry = createToolRegistry();
    parentRegistry.register(echoTool);
    const engine = createPermissionEngine(policy(), { cwd: parentCwd });

    // Capture the systemPrompt the child's harness was built with.
    // The stubProvider doesn't need to inspect it; we read the
    // value off the child's HarnessConfig before the run starts.
    let capturedChildPrompt: string | undefined;
    const captureProvider = (text: string): Provider => {
      const base = stubProvider(text);
      return {
        ...base,
        generate(req: Parameters<Provider['generate']>[0]) {
          capturedChildPrompt = (req as unknown as { system?: string }).system;
          return base.generate(req);
        },
      } as Provider;
    };

    const spawn: SpawnChildProcess = (opts) => {
      const { a, b } = fakeTransportPair();
      const parentChannel = createChannel(a);
      const exited = runSubagentChild({
        sessionId: opts.sessionId,
        dbPath,
        providerOverride: captureProvider(''),
        userAgentsDir: null,
        projectAgentsDir: null,
        errSink: () => undefined,
        ipcVersion: 1,
        ipcTransportFactory: () => b,
        memoryCwd: parentCwd, // child resolves memory roots from here
        cwdTrusted: true, // need trust so memory section flows
        // CRIT/H3 forwarded flag:
        sharedScopeOffline: opts.sharedScopeOffline === true,
      }).then((exitCode) => ({ exitCode }));
      return { exited, kill: () => undefined, ipc: parentChannel };
    };

    await runSubagent({
      definition: definition(),
      prompt: 'noop',
      parentSessionId: parent.id,
      provider: stubProvider(''),
      parentToolRegistry: parentRegistry,
      permissionEngine: engine,
      db: parentDb,
      cwd: parentCwd,
      onChildEvent: () => {},
      spawnChildProcess: spawn,
      cwdTrusted: true,
      sharedScopeOffline: true, // parent's verdict; expected at child
    });

    // The captured systemPrompt MUST NOT contain the shared body.
    // (The provider stub records `req.system` on `generate`, which
    // the harness loop populates from HarnessConfig.systemPrompt
    // assembled in subagent-child.)
    expect(capturedChildPrompt ?? '').not.toContain('INHERITED_BODY');
    expect(capturedChildPrompt ?? '').not.toContain('sensitive');

    parentDb.close();
    rmSync(parentCwd, { recursive: true, force: true });
  });
});
