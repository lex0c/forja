import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { Policy } from '../../src/permissions/index.ts';
import type { Provider } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import {
  getSession,
  getSubagentOutput,
  getSubagentRun,
  getSubagentWorktree,
  insertSubagentOutput,
  listChildSessions,
  setSubagentPayload,
} from '../../src/storage/index.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  MAX_SUBAGENT_DEPTH,
  type SpawnChildProcess,
  resolveChildBinaryCmd,
  runSubagent,
  toEnvelope,
} from '../../src/subagents/runtime.ts';
import type { SubagentDefinition } from '../../src/subagents/types.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';
import type { Tool } from '../../src/tools/types.ts';

// Subprocess-shaped runtime tests. The 4.2b.ii.a rewrite moved
// runSubagent off the in-process harness call and onto Bun.spawn
// of the same binary in subagent-child mode. The fakes below
// inject a `spawnChildProcess` that simulates the child writing
// its terminal payload to `subagent_outputs` and exiting — same
// IPC contract the real binary upholds, just collapsed to one
// process so the unit tests don't need to spawn anything.

const policy = (p: Partial<Policy> = {}): Policy => ({
  defaults: { mode: 'bypass' },
  tools: {},
  ...p,
});

// Bare-bones provider so the subagent runtime has SOMETHING to
// reference for `provider.id` (the parent records this on the
// child session row as `model`). The real subprocess spawn
// reads this field, looks up the model in the registry, and
// instantiates a fresh adapter — none of that runs in unit
// tests because the fake spawn writes the payload directly.
const stubProvider = (): Provider => ({
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
  // biome-ignore lint/correctness/useYield: stub never reached in unit tests
  async *generate() {
    throw new Error('stubProvider.generate should never be invoked in unit tests');
  },
  generateConstrained: () => Promise.reject(new Error('n/a')),
  countTokens: () => Promise.resolve(0),
});

const echoTool: Tool = {
  name: 'echo',
  description: 'echo back',
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

const writeTool: Tool = {
  name: 'write_file',
  description: 'pretend to write',
  inputSchema: { type: 'object', properties: {} },
  metadata: { category: 'fs.write', writes: true, idempotent: false },
  async execute() {
    return { ok: true };
  },
};

const bgTool: Tool = {
  name: 'bash_background',
  description: 'fake bg tool',
  inputSchema: { type: 'object', properties: {} },
  metadata: { category: 'misc', writes: true, requiresBgManager: true, idempotent: false },
  async execute() {
    return { ok: true };
  },
};

const definition = (overrides: Partial<SubagentDefinition> = {}): SubagentDefinition => ({
  name: 'explore',
  description: 'Read-only.',
  tools: ['echo'],
  budget: { maxSteps: 5, maxCostUsd: 0.1 },
  systemPrompt: 'You are an exploration subagent.',
  scope: 'project',
  isolation: 'none',
  sourcePath: '/fake/explore.md',
  sourceSha256: 'a'.repeat(64),
  meta: {},
  ...overrides,
});

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

const buildParentRegistry = (...tools: Tool[]) => {
  const r = createToolRegistry();
  for (const t of tools) r.register(t);
  return r;
};

const buildEngine = () => createPermissionEngine(policy(), { cwd: '/p' });

// Fake that publishes a clean 'done' payload and exits 0.
// Mimics the canonical happy-path child run without needing the
// harness to actually execute. The real child does
// `insertSubagentOutput` at startup followed by
// `setSubagentPayload` at exit; we collapse to one call here
// since unit tests don't need the intermediate "row exists,
// payload still null" state.
const fakeSpawnDone = (payload: Partial<Record<string, unknown>> = {}): SpawnChildProcess => {
  return (opts) => {
    insertSubagentOutput(db, { sessionId: opts.sessionId });
    setSubagentPayload(db, opts.sessionId, {
      status: 'done',
      reason: 'done',
      output: 'child output',
      cost_usd: 0.001,
      steps: 1,
      duration_ms: 50,
      ...payload,
    });
    return {
      exited: Promise.resolve({ exitCode: 0 }),
      kill: () => undefined,
    };
  };
};

// Fake that exits non-zero WITHOUT publishing a payload — the
// canonical "child crashed before publishing" case. The
// runtime's wait loop should map this to status='error' /
// reason='subprocess_crashed'.
const fakeSpawnCrash =
  (exitCode = 1): SpawnChildProcess =>
  () => ({
    exited: Promise.resolve({ exitCode }),
    kill: () => undefined,
  });

// Fake that never resolves and never publishes — the canonical
// "child hung" case. Tests pair it with a small wallClockMs to
// exercise the timeout path quickly.
const fakeSpawnHang = (): { spawn: SpawnChildProcess; killed: { signal: string }[] } => {
  const killed: { signal: string }[] = [];
  let resolveExit: ((v: { exitCode: number }) => void) | undefined;
  const exited = new Promise<{ exitCode: number }>((resolve) => {
    resolveExit = resolve;
  });
  return {
    killed,
    spawn: () => ({
      exited,
      kill: (signal) => {
        killed.push({ signal });
        // SIGKILL terminates immediately for our purposes; SIGTERM
        // is recorded but doesn't end the process unless the test
        // explicitly resolves.
        if (signal === 'SIGKILL' && resolveExit !== undefined) {
          resolveExit({ exitCode: 137 });
          resolveExit = undefined;
        }
      },
    }),
  };
};

describe('runSubagent — orchestration', () => {
  test('happy path: child session created, audit row + payload, parent_session_id linked', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const result = await runSubagent({
      definition: definition(),
      prompt: 'find the README',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      spawnChildProcess: fakeSpawnDone(),
    });
    expect(result.status).toBe('done');
    expect(result.reason).toBe('done');
    expect(result.output).toBe('child output');
    expect(result.steps).toBe(1);

    // Child session row exists with parent linkage.
    const childRow = getSession(db, result.sessionId);
    expect(childRow?.parentSessionId).toBe(parent.id);
    expect(childRow?.isSubagent).toBe(true);
    expect(listChildSessions(db, parent.id).map((c) => c.id)).toEqual([result.sessionId]);

    // Audit row landed BEFORE the spawn (4.2a inserted post-run;
    // .ii.a moved it pre-spawn so the FK target exists when the
    // child reads its own definition).
    const audit = getSubagentRun(db, result.sessionId);
    expect(audit).not.toBeNull();
    expect(audit?.name).toBe('explore');

    // Outputs row exists with the published payload.
    const out = getSubagentOutput(db, result.sessionId);
    expect(out?.payload?.status).toBe('done');
  });

  test("seeds the prompt as the child session's first user message (so the subprocess child sees it)", async () => {
    // The parent inserts the user prompt as a message on the
    // pre-created child session row. The harness's
    // preassignedSessionId path loads existing messages on init,
    // so the child sees the prompt without needing it on the
    // CLI args (avoids quoting / size limits).
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const result = await runSubagent({
      definition: definition(),
      prompt: 'specific seed text',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      spawnChildProcess: fakeSpawnDone(),
    });
    const messages = db
      .query<{ role: string; content: string }, [string]>(
        'SELECT role, content FROM messages WHERE session_id = ? ORDER BY seq ASC',
      )
      .all(result.sessionId);
    expect(messages.length).toBeGreaterThan(0);
    const first = messages[0];
    expect(first?.role).toBe('user');
    // content is JSON-serialized; the seed text is the string
    // payload of that JSON.
    expect(first?.content).toContain('specific seed text');
  });

  test('payload status forwards to result (exhausted)', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const result = await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      spawnChildProcess: fakeSpawnDone({
        status: 'exhausted',
        reason: 'maxSteps',
        cost_usd: 0.05,
        steps: 5,
      }),
    });
    expect(result.status).toBe('exhausted');
    expect(result.reason).toBe('maxSteps');
    expect(result.costUsd).toBe(0.05);
    expect(result.steps).toBe(5);
  });

  test('subprocess crash without payload → status=error, reason=subprocess_crashed', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const result = await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      spawnChildProcess: fakeSpawnCrash(2),
    });
    expect(result.status).toBe('error');
    expect(result.reason).toBe('subprocess_crashed');
    // Even on crash the child session row + audit row stay
    // intact for forensic queries — but the row MUST be
    // finalized to 'error', not left in 'running'. A child
    // that crashes before its harness's completeSession
    // would otherwise leak a phantom active session that
    // --list-sessions surfaces as live forever.
    const session = getSession(db, result.sessionId);
    expect(session).not.toBeNull();
    expect(session?.status).toBe('error');
    expect(getSubagentRun(db, result.sessionId)).not.toBeNull();
  });

  test('wall-clock timeout → status=interrupted, reason=maxWallClockMs, SIGTERM then SIGKILL', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const { spawn, killed } = fakeSpawnHang();
    const result = await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      spawnChildProcess: spawn,
      // Small wall-clock + grace so the test resolves quickly
      // inside bun's default 5s per-test timeout.
      wallClockMs: 100,
      graceMs: 50,
    });
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('maxWallClockMs');
    // SIGTERM should have been sent first, then SIGKILL after the
    // grace window. The exact count depends on poll cadence; we
    // assert at least one of each.
    const signals = killed.map((k) => k.signal);
    expect(signals).toContain('SIGTERM');
    expect(signals).toContain('SIGKILL');
    // Session row finalized to 'interrupted', not left in
    // 'running'. The child was killed before its harness could
    // call completeSession on its own.
    expect(getSession(db, result.sessionId)?.status).toBe('interrupted');
  });

  test('caller abort → status=interrupted, reason=aborted, SIGTERM/SIGKILL escalation', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const controller = new AbortController();
    const { spawn, killed } = fakeSpawnHang();
    const promise = runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      spawnChildProcess: spawn,
      signal: controller.signal,
      wallClockMs: 60_000, // big — abort must fire first
      graceMs: 50,
    });
    // Abort shortly after spawn so the polling loop sees signal.aborted.
    setTimeout(() => controller.abort(), 80);
    const result = await promise;
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('aborted');
    expect(killed.map((k) => k.signal)).toContain('SIGTERM');
    // Same finalization invariant as the wall-clock path:
    // session row terminal, not 'running'.
    expect(getSession(db, result.sessionId)?.status).toBe('interrupted');
  });

  test('whitelist typo throws (caller bug, not runtime status)', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    await expect(
      runSubagent({
        definition: definition({ tools: ['echoo'] }),
        prompt: 'go',
        parentSessionId: parent.id,
        provider: stubProvider(),
        parentToolRegistry: buildParentRegistry(echoTool),
        permissionEngine: buildEngine(),
        db,
        cwd: '/p',
        spawnChildProcess: fakeSpawnDone(),
      }),
    ).rejects.toThrow(/tool 'echoo' not registered with parent harness/);
  });

  test('writes:true tool refused without isolation:worktree (caller bug)', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    await expect(
      runSubagent({
        definition: definition({ tools: ['write_file'] }),
        prompt: 'go',
        parentSessionId: parent.id,
        provider: stubProvider(),
        parentToolRegistry: buildParentRegistry(echoTool, writeTool),
        permissionEngine: buildEngine(),
        db,
        cwd: '/p',
        spawnChildProcess: fakeSpawnDone(),
      }),
    ).rejects.toThrow(/declares metadata\.writes=true/);
  });

  test('requiresBgManager tool refused regardless of isolation', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    // Worktree lifts the writes:true gate but NOT the bgmanager
    // gate — the runtime still doesn't wire bgManager into the
    // child harness, so a whitelisted bash_background would fail
    // at runtime. Pulled forward to spawn-time as a refusal.
    await expect(
      runSubagent({
        definition: definition({
          tools: ['bash_background'],
          isolation: 'worktree',
        }),
        prompt: 'go',
        parentSessionId: parent.id,
        provider: stubProvider(),
        parentToolRegistry: buildParentRegistry(echoTool, bgTool),
        permissionEngine: buildEngine(),
        db,
        cwd: '/p',
        spawnChildProcess: fakeSpawnDone(),
      }),
    ).rejects.toThrow(/declares metadata\.requiresBgManager=true/);
  });

  test('refuses non-builtin tool when spawning real subprocess (parent/child registry alignment)', async () => {
    // Regression: the parent's `parentToolRegistry` could
    // contain custom tools (programmatic callers, evals) that
    // pass the parent-side validation but fail at the child
    // because the child rebuilds its registry from
    // `registerBuiltinTools()` only. Without this check, the
    // failure surfaced as `unknown_tool` mid-spawn — wasted
    // spawn cycle, confused diagnostics. The validator now
    // refuses at parent time when the call WILL spawn a real
    // subprocess. Tests with `spawnChildProcess` injected get
    // the relaxed check (test mode).
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    // No spawnChildProcess override → triggers strict builtin
    // alignment. The custom `echo` tool passes the parent
    // registry but is not in the builtin set.
    await expect(
      runSubagent({
        definition: definition({ tools: ['echo'] }),
        prompt: 'go',
        parentSessionId: parent.id,
        provider: stubProvider(),
        parentToolRegistry: buildParentRegistry(echoTool),
        permissionEngine: buildEngine(),
        db,
        cwd: '/p',
        // NO spawnChildProcess → strict path
      }),
    ).rejects.toThrow(/NOT in the builtin set/);
  });

  test('test-mode (spawnChildProcess injected) allows custom tools', async () => {
    // Counterpart to the above: when a test injects a fake
    // spawn, the alignment check is skipped because the fake
    // child doesn't use the builtin set. Every other test in
    // this file relies on this relaxed path — assertion here
    // locks it in so a future tightening doesn't break the
    // suite silently.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const result = await runSubagent({
      definition: definition({ tools: ['echo'] }),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      spawnChildProcess: fakeSpawnDone(),
    });
    expect(result.status).toBe('done');
  });

  test('refuses to spawn beyond MAX_SUBAGENT_DEPTH', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    await expect(
      runSubagent({
        definition: definition(),
        prompt: 'go',
        parentSessionId: parent.id,
        provider: stubProvider(),
        parentToolRegistry: buildParentRegistry(echoTool),
        permissionEngine: buildEngine(),
        db,
        cwd: '/p',
        depth: MAX_SUBAGENT_DEPTH + 1,
        spawnChildProcess: fakeSpawnDone(),
      }),
    ).rejects.toThrow(/recursion depth/);
  });

  test('depth === MAX_SUBAGENT_DEPTH is the last allowed level', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const result = await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      depth: MAX_SUBAGENT_DEPTH,
      spawnChildProcess: fakeSpawnDone(),
    });
    expect(result.status).toBe('done');
  });

  test('toEnvelope mirrors result fields', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const ok = await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      spawnChildProcess: fakeSpawnDone(),
    });
    const env = toEnvelope(ok);
    expect(env.session_id).toBe(ok.sessionId);
    expect(env.status).toBe('done');
    expect(env.output).toBe(ok.output);
  });

  test('Bun.spawn synchronous throw → status=error, reason=subprocess_spawn_failed', async () => {
    // C3 fix: Bun.spawn throws synchronously on ENOENT/EACCES/
    // out-of-fds. Without the catch, the exception escapes
    // runSubagent and the caller sees an unhandled error
    // instead of a recoverable RunSubagentResult. The runtime
    // converts the throw into status='error' /
    // reason='subprocess_spawn_failed' and cleans up any
    // pre-spawn state.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const result = await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      spawnChildProcess: () => {
        throw new Error('ENOENT: binary not found');
      },
    });
    expect(result.status).toBe('error');
    expect(result.reason).toBe('subprocess_spawn_failed');
    expect(result.worktreeError?.code).toBe('subprocess_spawn_failed');
    expect(result.worktreeError?.message).toMatch(/ENOENT/);
    // The session row + audit row stay (the spawn happened
    // logically, just couldn't physically launch); operator's
    // forensic queries can still resolve them.
    const session = getSession(db, result.sessionId);
    expect(session).not.toBeNull();
    expect(getSubagentRun(db, result.sessionId)).not.toBeNull();
    // Critical regression: the row MUST NOT stay in 'running'.
    // A spawn-throw without finalization would leak a phantom
    // active session into --list-sessions and any stale-row
    // sweeper would be misled.
    expect(session?.status).toBe('error');
  });

  test('appendMessage failure cleans up worktree, finalizes session, rethrows', async () => {
    // C2 fix: a throw between insertSubagentRun and spawn must
    // not leak the worktree on disk. Force the failure by
    // dropping the messages table mid-flight; the audit insert
    // runs against the intact subagent_runs table, then
    // appendMessage hits a missing-table error. The runtime
    // cleans up the worktree, finalizes the child session row
    // to status='error' (so it doesn't sit in 'running' as a
    // phantom active session), and rethrows.
    const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
    const parent = sessionsRepo.createSession(db, { model: 'mock/m', cwd: '/p' });
    db.exec('DROP TABLE messages');
    let threw = false;
    try {
      await runSubagent({
        definition: definition({ isolation: 'none' }),
        prompt: 'go',
        parentSessionId: parent.id,
        provider: stubProvider(),
        parentToolRegistry: buildParentRegistry(echoTool),
        permissionEngine: buildEngine(),
        db,
        cwd: '/p',
        spawnChildProcess: fakeSpawnDone(),
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // The child session row was created with parent_session_id
    // set; it must have been finalized to 'error' on the way
    // out of the failure path.
    const children = sessionsRepo.listChildSessions(db, parent.id);
    expect(children.length).toBe(1);
    expect(children[0]?.status).toBe('error');
  });

  test('audit insert failure finalizes session before rethrowing', async () => {
    // Same shape as the appendMessage path but earlier in the
    // sequence: drop subagent_runs after createSession runs
    // for the parent, BEFORE the runtime tries to insert. The
    // runtime's catch must still finalize the child session row
    // — the fact that the failure happens upstream of the
    // worktree audit doesn't change the contract.
    const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
    const parent = sessionsRepo.createSession(db, { model: 'mock/m', cwd: '/p' });
    db.exec('DROP TABLE subagent_runs');
    let threw = false;
    try {
      await runSubagent({
        definition: definition({ isolation: 'none' }),
        prompt: 'go',
        parentSessionId: parent.id,
        provider: stubProvider(),
        parentToolRegistry: buildParentRegistry(echoTool),
        permissionEngine: buildEngine(),
        db,
        cwd: '/p',
        spawnChildProcess: fakeSpawnDone(),
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const children = sessionsRepo.listChildSessions(db, parent.id);
    expect(children.length).toBe(1);
    expect(children[0]?.status).toBe('error');
  });

  test('signal aborted before exited resolves → reports aborted, not crashed', async () => {
    // M1 fix: SIGINT propagates to the whole process group, so
    // the child can exit before our wait loop ever sets
    // killed='aborted'. Without the explicit signal.aborted
    // check at the exited branch, the result reports 'crashed'
    // for what is plainly a user abort. Fixture: spawn returns
    // a handle that exits cleanly (no payload) RIGHT after the
    // controller aborts; the runtime should see signal.aborted
    // and report 'aborted'.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const controller = new AbortController();
    // Pre-abort the signal so the wait loop sees it on first
    // iteration, simultaneously with the child's resolved exit.
    controller.abort();
    const sigintLikeSpawn: SpawnChildProcess = () => {
      // The child caught SIGINT and exited fast without writing
      // payload. We DO NOT insertSubagentOutput either —
      // simulating a real SIGINT'd child that died before
      // its startup INSERT completed.
      return {
        exited: Promise.resolve({ exitCode: 130 }),
        kill: () => undefined,
      };
    };
    const result = await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      spawnChildProcess: sigintLikeSpawn,
      signal: controller.signal,
      graceMs: 50,
    });
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('aborted');
    // Session row finalized to 'interrupted'. Child exited
    // fast (SIGINT propagated via process group) before the
    // parent's wait loop could even send a signal — but the
    // post-wait finalization MUST still fire.
    expect(getSession(db, result.sessionId)?.status).toBe('interrupted');
  });
});

describe('resolveChildBinaryCmd', () => {
  test('compiled Bun binary: argv[0] is literal "bun", execPath is the compiled binary', () => {
    // Real production shape per Bun's compatibility-spoofing
    // behavior: in `bun build --compile` outputs, Bun.argv[0]
    // is the literal string 'bun' (NOT a path), while
    // process.execPath is the actual compiled binary on disk.
    // Earlier code used argv[0] as the cmd[0] and would have
    // spawned `bun --subagent-session-id ...` instead of
    // re-invoking the compiled agent — every subprocess
    // subagent spawn would fail in a compiled deployment.
    const cmd = resolveChildBinaryCmd({
      argv: ['bun', '--list-sessions'],
      execPath: '/usr/local/bin/agent',
      appendArgs: ['--subagent-session-id', 'abc'],
    });
    expect(cmd).toEqual(['/usr/local/bin/agent', '--subagent-session-id', 'abc']);
  });

  test('dev mode: execPath = bun interpreter, argv[1] = .ts entry script', () => {
    // `bun src/cli/index.ts --list-sessions` shape: argv[0] is
    // the resolved bun path (or 'bun' when called bare),
    // argv[1] is the entry script. We always use execPath as
    // the interpreter; the script comes from argv[1].
    const cmd = resolveChildBinaryCmd({
      argv: ['/usr/local/bin/bun', 'src/cli/index.ts', '--list-sessions'],
      execPath: '/usr/local/bin/bun',
      appendArgs: ['--subagent-session-id', 'xyz'],
    });
    expect(cmd).toEqual(['/usr/local/bin/bun', 'src/cli/index.ts', '--subagent-session-id', 'xyz']);
  });

  test('dev mode with execPath != argv[0] (resolved via PATH)', () => {
    // Some shells leave argv[0] as the literal token the user
    // typed ('bun') even when execPath resolves to the full
    // path. We must still use execPath for cmd[0].
    const cmd = resolveChildBinaryCmd({
      argv: ['bun', 'src/cli/index.ts'],
      execPath: '/opt/bun-1.3.13/bin/bun',
      appendArgs: ['--flag'],
    });
    expect(cmd).toEqual(['/opt/bun-1.3.13/bin/bun', 'src/cli/index.ts', '--flag']);
  });

  test('extended dev suffixes (.mts / .cts / .mjs / .js)', () => {
    // Future entry rename to .mts must not silently downgrade
    // to compiled-mode resolution.
    for (const suffix of ['.mts', '.cts', '.mjs', '.js']) {
      const cmd = resolveChildBinaryCmd({
        argv: ['/usr/local/bin/bun', `src/cli/index${suffix}`],
        execPath: '/usr/local/bin/bun',
        appendArgs: ['--flag'],
      });
      expect(cmd).toEqual(['/usr/local/bin/bun', `src/cli/index${suffix}`, '--flag']);
    }
  });

  test('argv missing or single-element → no script appended, uses execPath', () => {
    // Compiled invocation with no args (`./agent` alone), or
    // a degenerate empty-argv case (Bun should never produce
    // it, but the resolver stays well-defined regardless).
    for (const argv of [[], ['bun']]) {
      const cmd = resolveChildBinaryCmd({
        argv,
        execPath: '/usr/local/bin/agent',
        appendArgs: ['--flag'],
      });
      expect(cmd).toEqual(['/usr/local/bin/agent', '--flag']);
    }
  });

  test('compiled invocation where user passed a positional ending in .ts (false-positive defense)', () => {
    // If the user runs `./agent foo.ts` (compiled binary,
    // 'foo.ts' as a prompt fragment), argv[1] is 'foo.ts' which
    // matches DEV_SCRIPT_SUFFIXES. The resolver appends it to
    // cmd, producing `<binary> foo.ts --subagent-session-id <id>`.
    // Functionally harmless: the compiled binary's args parser
    // sees --subagent-session-id and short-circuits to child
    // mode before any prompt processing, ignoring 'foo.ts'.
    // Locking this behavior here so a future tightening doesn't
    // surprise the caller.
    const cmd = resolveChildBinaryCmd({
      argv: ['bun', 'foo.ts'],
      execPath: '/usr/local/bin/agent',
      appendArgs: ['--subagent-session-id', 'abc'],
    });
    expect(cmd).toEqual(['/usr/local/bin/agent', 'foo.ts', '--subagent-session-id', 'abc']);
  });
});

describe('runSubagent — worktree isolation', () => {
  let parentRepo: string;
  let worktreeRoot: string;

  const runGit = async (cwd: string, args: string[]): Promise<void> => {
    const proc = Bun.spawn({
      cmd: ['git', '-C', cwd, ...args],
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        LC_ALL: 'C',
        GIT_TERMINAL_PROMPT: '0',
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
      },
    });
    const [, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} (${exitCode}): ${stderr}`);
    }
  };

  beforeEach(async () => {
    parentRepo = mkdtempSync(join(tmpdir(), 'forja-rt-wt-parent-'));
    worktreeRoot = mkdtempSync(join(tmpdir(), 'forja-rt-wt-root-'));
    mkdirSync(parentRepo, { recursive: true });
    await runGit(parentRepo, ['init', '-b', 'main']);
    await runGit(parentRepo, ['config', 'user.email', 'test@example.com']);
    await runGit(parentRepo, ['config', 'user.name', 'Test']);
    writeFileSync(join(parentRepo, 'README.md'), '# parent\n');
    await runGit(parentRepo, ['add', '.']);
    await runGit(parentRepo, ['commit', '-m', 'init']);
  });

  afterEach(() => {
    try {
      rmSync(parentRepo, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(worktreeRoot, { recursive: true, force: true });
    } catch {}
  });

  test('clean child run → worktree removed, audit row=cleaned', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: parentRepo,
    });
    const result = await runSubagent({
      definition: definition({ tools: ['echo'], isolation: 'worktree' }),
      prompt: 'no-op task',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: parentRepo,
      worktreeRootDir: worktreeRoot,
      spawnChildProcess: fakeSpawnDone({ output: 'nothing to do' }),
    });
    expect(result.status).toBe('done');
    const wt = result.worktree;
    if (wt === undefined) throw new Error('expected worktree info on result');
    expect(wt.dirty).toBe(false);
    expect(wt.removed).toBe(true);
    expect(wt.preserved).toBe(false);
    expect(existsSync(wt.path)).toBe(false);
    const audit = getSubagentWorktree(db, result.sessionId);
    expect(audit?.status).toBe('cleaned');
  });

  test('child wrote → worktree preserved, audit row=preserved', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: parentRepo,
    });
    // Fake child writes to the worktree before publishing payload.
    const dirtyingSpawn: SpawnChildProcess = (opts) => {
      writeFileSync(join(opts.cwd, 'subagent-output.txt'), 'hello from child\n');
      insertSubagentOutput(db, { sessionId: opts.sessionId });
      setSubagentPayload(db, opts.sessionId, {
        status: 'done',
        reason: 'done',
        output: 'wrote it',
        cost_usd: 0,
        steps: 1,
        duration_ms: 1,
      });
      return { exited: Promise.resolve({ exitCode: 0 }), kill: () => undefined };
    };
    const result = await runSubagent({
      definition: definition({ tools: ['write_file'], isolation: 'worktree' }),
      prompt: 'create a file',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(writeTool),
      permissionEngine: buildEngine(),
      db,
      cwd: parentRepo,
      worktreeRootDir: worktreeRoot,
      spawnChildProcess: dirtyingSpawn,
    });
    expect(result.status).toBe('done');
    const wt = result.worktree;
    if (wt === undefined) throw new Error('expected worktree info on result');
    expect(wt.dirty).toBe(true);
    expect(wt.preserved).toBe(true);
    expect(existsSync(join(wt.path, 'subagent-output.txt'))).toBe(true);
    expect(existsSync(join(parentRepo, 'subagent-output.txt'))).toBe(false);
    expect(getSubagentWorktree(db, result.sessionId)?.status).toBe('preserved');
  });

  test('worktree create failure surfaces as run-failed, no session, no audit row', async () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'forja-rt-wt-notrepo-'));
    try {
      const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
        model: 'mock/m',
        cwd: notRepo,
      });
      const result = await runSubagent({
        definition: definition({ tools: ['echo'], isolation: 'worktree' }),
        prompt: 'go',
        parentSessionId: parent.id,
        provider: stubProvider(),
        parentToolRegistry: buildParentRegistry(echoTool),
        permissionEngine: buildEngine(),
        db,
        cwd: notRepo,
        worktreeRootDir: worktreeRoot,
        spawnChildProcess: fakeSpawnDone(),
      });
      expect(result.status).toBe('error');
      expect(result.reason).toBe('worktree_create_failed');
      expect(result.sessionId).toBe('');
      expect(result.worktreeError).toBeDefined();
      expect(listChildSessions(db, parent.id)).toEqual([]);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  test("isolation='none' keeps the worktree fields absent", async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: parentRepo,
    });
    const result = await runSubagent({
      definition: definition({ isolation: 'none' }),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: parentRepo,
      worktreeRootDir: worktreeRoot,
      spawnChildProcess: fakeSpawnDone(),
    });
    expect(result.status).toBe('done');
    expect(result.worktree).toBeUndefined();
    expect(result.worktreeError).toBeUndefined();
    expect(getSubagentWorktree(db, result.sessionId)).toBeNull();
    expect(readdirSync(worktreeRoot)).toEqual([]);
  });

  test('createSession throw after worktree create cleans up worktree, rethrows', async () => {
    // Regression: previously the worktree was created BEFORE
    // `createSession`, but `createSession` ran outside any
    // cleanup guard. A throw there (FK violation from a
    // concurrent parent delete, schema drift, disk full) would
    // leak the worktree directory + agent branch on disk with
    // no path to recovery. The fix wraps createSession in a
    // try/catch that runs `cleanupWorktree` before rethrowing.
    //
    // Force the throw by dropping the `sessions` table after
    // worktree create but before runSubagent calls
    // createSession. We hook this via a fake spawn that's
    // never reached — the test asserts the failure is BEFORE
    // spawn, so the spawn fake stays inert. Actually, dropping
    // the table is racy here because runSubagent is one
    // function call; we drop BEFORE runSubagent and let
    // createSession be the first SQL operation that hits the
    // missing table. The parent createSession in setup
    // succeeded; only the CHILD createSession (inside
    // runSubagent) fails.
    const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
    const parent = sessionsRepo.createSession(db, { model: 'mock/m', cwd: parentRepo });
    // Drop sessions table NOW — child createSession will throw,
    // the worktree will already exist on disk by that point.
    db.exec('DROP TABLE sessions');
    let threw = false;
    try {
      await runSubagent({
        definition: definition({ tools: ['echo'], isolation: 'worktree' }),
        prompt: 'go',
        parentSessionId: parent.id,
        provider: stubProvider(),
        parentToolRegistry: buildParentRegistry(echoTool),
        permissionEngine: buildEngine(),
        db,
        cwd: parentRepo,
        worktreeRootDir: worktreeRoot,
        spawnChildProcess: fakeSpawnDone(),
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // Critical regression assertion: worktreeRoot must be
    // empty. Without the cleanup guard, a created worktree dir
    // would remain.
    expect(readdirSync(worktreeRoot)).toEqual([]);
  });

  test.skip('symlink targeting outside the worktree is blocked at runtime', async () => {
    // 4.2b.iii expectation. Spec SECURITY §8.4 deny-list +
    // realpath validation; deferred per the slice scope of
    // 4.2b.ii.a (subprocess only).
  });
});
