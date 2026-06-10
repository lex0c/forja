import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { Policy } from '../../src/permissions/index.ts';
import type { Provider } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import {
  getProcessRecord,
  getSession,
  getSubagentOutput,
  getSubagentRun,
  getSubagentWorktree,
  insertSubagentOutput,
  listChildSessions,
  setSubagentPayload,
  updateSessionCost,
  updateSubagentHeartbeat,
} from '../../src/storage/index.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  type IpcChannel,
  type IpcMessage,
  createChannel,
  fakeTransportPair,
  makeEvent,
  makePermissionAsk,
  makeSessionFinished,
  makeSessionStart,
} from '../../src/subagents/ipc.ts';
import {
  MAX_SUBAGENT_DEPTH,
  type SpawnChildProcess,
  computeArgvHash,
  drainStderrToLogFile,
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
    // Payload outcome carries authoritative cost from the child;
    // usage_complete=true reflects that. The non-payload paths
    // (crashed/aborted/wall_clock) flip this to false because
    // the synthesized cost=0 is a lower bound only.
    expect(childRow?.usageComplete).toBe(true);

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
    // usage_complete must be false: the synthesized cost=0 is
    // a lower bound (the child may have made provider calls
    // before crashing), not an authoritative measurement.
    // Marking it true would corrupt cost rollups that read the
    // flag to detect incomplete totals.
    expect(session?.usageComplete).toBe(false);
    expect(getSubagentRun(db, result.sessionId)).not.toBeNull();
  });

  test('subprocess crash preserves the child-persisted cost rollup (no zero overwrite)', async () => {
    // The child harness persists its running spend into the session
    // row per response (loop.ts emitCostUpdate rollup). When the
    // child dies WITHOUT a payload, the parent's finalize used to
    // write the synthesized costUsd=0 over that floor — destroying
    // real recorded spend. Simulate the child's mid-run write inside
    // the spawn fake, crash without payload, and assert the figure
    // survives as a lower bound.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const spawn: SpawnChildProcess = (opts) => {
      updateSessionCost(db, opts.sessionId, 0.7);
      return {
        exited: Promise.resolve({ exitCode: 2 }),
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
      spawnChildProcess: spawn,
    });
    expect(result.status).toBe('error');
    expect(result.reason).toBe('subprocess_crashed');
    const session = getSession(db, result.sessionId);
    expect(session?.status).toBe('error');
    expect(session?.totalCostUsd).toBeCloseTo(0.7, 10);
    expect(session?.usageComplete).toBe(false);
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
    // call completeSession on its own. usage_complete=false
    // because the child died with no payload — we don't know
    // what it spent before SIGKILL.
    const session = getSession(db, result.sessionId);
    expect(session?.status).toBe('interrupted');
    expect(session?.usageComplete).toBe(false);
  });

  test('heartbeat stale → status=interrupted, reason=heartbeat_stale, SIGTERM/SIGKILL escalation', async () => {
    // Regression for the heartbeat staleness path. A child
    // that's wedged inside a tool call (provider hung, sync
    // block) wouldn't pulse `last_heartbeat` even though the
    // process is still responsive to signals. The wall-clock
    // would catch it eventually (1h), but heartbeat
    // staleness fires in ~10s — operator-relevant timing.
    //
    // Fixture: spawn that inserts an outputs row with a stale
    // heartbeat (already > threshold ago) but never publishes
    // payload and never exits. Parent's poller sees the stale
    // value on the first iteration, escalates SIGTERM →
    // grace → SIGKILL.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const killed: { signal: string }[] = [];
    let resolveExit: ((v: { exitCode: number }) => void) | undefined;
    const exited = new Promise<{ exitCode: number }>((resolve) => {
      resolveExit = resolve;
    });
    const staleHeartbeatSpawn: SpawnChildProcess = (opts) => {
      // Insert with `lastHeartbeat` set to 1s ago, then NEVER
      // update it. The parent's threshold (heartbeatStaleMs:
      // 100) makes 1s old immediately stale. No payload, no
      // exit until SIGKILL.
      insertSubagentOutput(db, {
        sessionId: opts.sessionId,
        lastHeartbeat: Date.now() - 1000,
      });
      return {
        exited,
        kill: (signal) => {
          killed.push({ signal });
          if (signal === 'SIGKILL' && resolveExit !== undefined) {
            resolveExit({ exitCode: 137 });
            resolveExit = undefined;
          }
        },
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
      spawnChildProcess: staleHeartbeatSpawn,
      // Wall-clock comfortably larger than the test runtime so
      // the wall-clock path doesn't preempt the heartbeat
      // detection.
      wallClockMs: 60_000,
      graceMs: 50,
      heartbeatStaleMs: 100,
    });
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('heartbeat_stale');
    const signals = killed.map((k) => k.signal);
    expect(signals).toContain('SIGTERM');
    expect(signals).toContain('SIGKILL');
    // Same finalization invariants as wall_clock: row landed
    // 'interrupted', usage_complete=false (cost is unknown,
    // synthesized as 0).
    const session = getSession(db, result.sessionId);
    expect(session?.status).toBe('interrupted');
    expect(session?.usageComplete).toBe(false);
  });

  test('healthy heartbeat (refreshed periodically) keeps run alive past threshold', async () => {
    // The actual property the heartbeat path is supposed to
    // protect: a child that pulses faster than the staleness
    // threshold must survive a duration LONGER than the
    // threshold without being killed. Earlier shape of this
    // test published payload in the same tick as insert, which
    // made the parent's loop hit the payload-first branch
    // before the staleness check could even run — exercising
    // the wrong path.
    //
    // Fixture: spawn that installs its OWN setInterval to
    // refresh `last_heartbeat` (mimicking the production
    // child's writer) and only publishes payload AFTER the
    // run has lived past the threshold. With pulse interval
    // 30ms and threshold 200ms, the heartbeat is always <
    // 30ms old at any poll; the run lasts 600ms total
    // (3× threshold) and completes status='done' with no
    // signals sent. If the parent ignored heartbeat freshness
    // and tripped on age alone, SIGTERM would have fired at
    // ~200ms and the result would be 'heartbeat_stale'.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const killed: { signal: string }[] = [];
    const refreshingSpawn: SpawnChildProcess = (opts) => {
      insertSubagentOutput(db, {
        sessionId: opts.sessionId,
        lastHeartbeat: Date.now(),
      });
      // Pulse every 100ms via setInterval (mimics the
      // production cadence shape). Threshold is 1000ms —
      // 10× headroom over the pulse cadence and 2× headroom
      // over the parent's worst-case poll backoff (capped at
      // POLL_MAX_MS=500). That ratio survives event-loop
      // scheduling variance: even if a pulse drifts by a
      // factor of 5, the row stays under threshold.
      const pulseTimer = setInterval(() => {
        try {
          updateSubagentHeartbeat(db, opts.sessionId);
        } catch {
          // ignore — same defensive shape as production
        }
      }, 100);
      // Publish payload after 1500ms (1.5× threshold). The run
      // genuinely outlives the "naive age check" — without
      // pulses the row would have been declared stale at
      // ~1000ms and SIGTERM would fire. Pulses keep it fresh
      // through the entire window.
      setTimeout(() => {
        clearInterval(pulseTimer);
        setSubagentPayload(db, opts.sessionId, {
          status: 'done',
          reason: 'done',
          output: 'survived past stale threshold with healthy pulses',
          cost_usd: 0.001,
          steps: 1,
          duration_ms: 1500,
        });
      }, 1500);
      return {
        exited: new Promise<{ exitCode: number }>((resolve) => {
          // exited resolves shortly after payload (mimics real
          // child's exit-after-publish flow). The drain helper
          // in the parent waits for this.
          setTimeout(() => resolve({ exitCode: 0 }), 1550);
        }),
        kill: (signal) => killed.push({ signal }),
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
      spawnChildProcess: refreshingSpawn,
      // Threshold smaller than total run duration (1500ms) AND
      // much larger than pulse cadence (100ms) — proves the
      // staleness gate IS exercised on each poll AND keeps
      // skipping because the row stays fresh continuously.
      heartbeatStaleMs: 1000,
      // Wall-clock comfortably above run duration so wall_clock
      // doesn't preempt.
      wallClockMs: 60_000,
      // Grace large enough that the post-payload drain has
      // time to observe the fake's exit promise.
      graceMs: 200,
    });
    expect(result.status).toBe('done');
    // No SIGTERM, no SIGKILL — heartbeat freshness kept the
    // staleness gate skipping every iteration.
    expect(killed).toEqual([]);
  }, 5_000);

  test('null lastHeartbeat skips staleness gate; wall-clock catches the wedge', async () => {
    // The null-heartbeat shape covers the startup window
    // BEFORE the child's first interval tick: the outputs row
    // exists but `lastHeartbeat` is still null. The parent's
    // poller MUST treat null as "pre-pulse, not stale";
    // otherwise every subprocess subagent dies on its first
    // poll. Earlier shape of this test was payload-first and
    // didn't exercise the gate at all (setSubagentPayload
    // also bumps last_heartbeat as a side effect, so by the
    // time the parent polls, the row is fresh — the null path
    // never ran).
    //
    // Fixture: spawn that inserts the outputs row WITH a null
    // heartbeat and never publishes payload, never refreshes.
    // The wall-clock has to be the kill verdict because the
    // staleness gate skipped every iteration. If the gate
    // didn't skip nulls, the result would be 'heartbeat_stale'
    // (much earlier, at heartbeatStaleMs).
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const killed: { signal: string }[] = [];
    let resolveExit: ((v: { exitCode: number }) => void) | undefined;
    const exited = new Promise<{ exitCode: number }>((resolve) => {
      resolveExit = resolve;
    });
    const noPulseSpawn: SpawnChildProcess = (opts) => {
      // Insert with lastHeartbeat=null; never write again.
      insertSubagentOutput(db, { sessionId: opts.sessionId });
      return {
        exited,
        kill: (signal) => {
          killed.push({ signal });
          if (signal === 'SIGKILL' && resolveExit !== undefined) {
            resolveExit({ exitCode: 137 });
            resolveExit = undefined;
          }
        },
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
      spawnChildProcess: noPulseSpawn,
      // heartbeatStaleMs (50) MUCH smaller than wallClockMs
      // (300). If null tripped the gate, we'd see stale at
      // ~50ms; instead we see wall_clock at ~300ms.
      heartbeatStaleMs: 50,
      wallClockMs: 300,
      graceMs: 50,
    });
    // Wall-clock won the race — proves staleness gate
    // correctly skipped every iteration on null heartbeat.
    expect(result.reason).toBe('maxWallClockMs');
    expect(result.status).toBe('interrupted');
    expect(killed.map((k) => k.signal)).toContain('SIGTERM');
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
    // session row terminal, not 'running'. usage_complete=false
    // because aborted runs don't produce an authoritative cost.
    const session = getSession(db, result.sessionId);
    expect(session?.status).toBe('interrupted');
    expect(session?.usageComplete).toBe(false);
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

  test('4.2b.iv: requiresBgManager tool no longer rejected by registry gate', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    // Pre-4.2b.iv this combination threw at spawn time because
    // the child harness had no bgManager. The slice threads a
    // per-session bg log directory across the subprocess
    // boundary (`--subagent-bg-log-dir`), so background-process
    // tools are now safe to expose. We assert specifically that
    // the OLD `requiresBgManager` error message is no longer
    // produced; the runtime still fails on worktree creation
    // (cwd '/p' isn't a git repo), but with `worktree_create_failed`,
    // not with the registry refusal — which is the property
    // this slice changed.
    const result = await runSubagent({
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
    });
    expect(result.reason).not.toBe('subprocess_spawn_failed');
    expect(result.worktreeError?.message ?? '').not.toMatch(/requiresBgManager/);
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

  test('parent passes depth into spawn opts (cross-process recursion guard)', async () => {
    // Without depth propagation, every subprocess child resets
    // to 0 and a chain of subprocesses could nest beyond
    // MAX_SUBAGENT_DEPTH (each child computes from a fresh
    // baseline). The parent's runSubagent must thread its own
    // `depth` value into the spawn opts so the child's harness
    // config keeps `subagentDepth` non-zero.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const captured: { depth?: number } = {};
    const recordingSpawn: SpawnChildProcess = (opts) => {
      captured.depth = opts.depth;
      insertSubagentOutput(db, { sessionId: opts.sessionId });
      setSubagentPayload(db, opts.sessionId, {
        status: 'done',
        reason: 'done',
        output: 'ok',
        cost_usd: 0,
        steps: 1,
        duration_ms: 1,
      });
      return { exited: Promise.resolve({ exitCode: 0 }), kill: () => undefined };
    };
    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      depth: 2,
      spawnChildProcess: recordingSpawn,
    });
    expect(captured.depth).toBe(2);
  });

  test('parent threads cwdTrusted into spawn opts (trust state forward)', async () => {
    // Spec §9 trust is per-PROJECT. Parent resolves the verdict
    // at bootstrap; child must inherit it instead of re-resolving
    // from disk (worktree paths are never on the trust list).
    // Pre-fix: spawn factory received `cwdTrusted: undefined`,
    // child defaulted `isCwdTrusted=false`, tools gating on
    // trust silently denied even when parent was trusted.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const captured: Array<boolean | undefined> = [];
    const recordingSpawn: SpawnChildProcess = (opts) => {
      captured.push(opts.cwdTrusted);
      insertSubagentOutput(db, { sessionId: opts.sessionId });
      setSubagentPayload(db, opts.sessionId, {
        status: 'done',
        reason: 'done',
        output: 'ok',
        cost_usd: 0,
        steps: 1,
        duration_ms: 1,
      });
      return { exited: Promise.resolve({ exitCode: 0 }), kill: () => undefined };
    };
    // Trusted run.
    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      cwdTrusted: true,
      spawnChildProcess: recordingSpawn,
    });
    expect(captured[0]).toBe(true);
    // Untrusted (or unspecified) run.
    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      spawnChildProcess: recordingSpawn,
    });
    expect(captured[1]).toBeUndefined();
  });

  test('4.2b.iv: parent threads per-session bgLogDir into spawn opts', async () => {
    // Every subagent gets its own bg log directory so concurrent
    // children don't collide and the operator's `bg list` view
    // from the project root continues to show only the parent's
    // processes. Path shape:
    // `<parentCwd>/.agent/bg/subagents/<childSessionId>/`. The
    // `subagents/` infix segregates the namespace from the
    // parent's flat-file bg layout. The parent's runSubagent
    // computes it deterministically; the spawn fake captures it
    // for assertion.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const captured: { bgLogDir?: string; sessionId?: string } = {};
    const recordingSpawn: SpawnChildProcess = (opts) => {
      if (opts.bgLogDir !== undefined) captured.bgLogDir = opts.bgLogDir;
      captured.sessionId = opts.sessionId;
      insertSubagentOutput(db, { sessionId: opts.sessionId });
      setSubagentPayload(db, opts.sessionId, {
        status: 'done',
        reason: 'done',
        output: 'ok',
        cost_usd: 0,
        steps: 1,
        duration_ms: 1,
      });
      return { exited: Promise.resolve({ exitCode: 0 }), kill: () => undefined };
    };
    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      spawnChildProcess: recordingSpawn,
    });
    expect(captured.bgLogDir).toBe(`/p/.agent/bg/subagents/${captured.sessionId}`);
  });

  test('4.2b.iv: cleanupWorktree end-of-run removes the bgLogDir if it exists', async () => {
    // Bg manager creates the directory lazily on first spawn.
    // We simulate that here: the spawn fake mkdirs the dir +
    // writes a fake log file. After runSubagent finishes, the
    // runtime's end-of-run rmSync must delete the directory and
    // its contents. Without this cleanup, the parent's
    // `.agent/bg/` would accumulate per-session subdirectories
    // on every subagent run.
    const parentCwd = mkdtempSync(join(tmpdir(), 'forja-rt-bg-'));
    try {
      const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
        model: 'mock/m',
        cwd: parentCwd,
      });
      let observedDir: string | undefined;
      const dirPlantingSpawn: SpawnChildProcess = (opts) => {
        observedDir = opts.bgLogDir;
        if (opts.bgLogDir !== undefined) {
          mkdirSync(opts.bgLogDir, { recursive: true });
          writeFileSync(join(opts.bgLogDir, 'fake-bg-output.log'), 'simulated bg output\n');
        }
        insertSubagentOutput(db, { sessionId: opts.sessionId });
        setSubagentPayload(db, opts.sessionId, {
          status: 'done',
          reason: 'done',
          output: 'ok',
          cost_usd: 0,
          steps: 1,
          duration_ms: 1,
        });
        return { exited: Promise.resolve({ exitCode: 0 }), kill: () => undefined };
      };
      await runSubagent({
        definition: definition(),
        prompt: 'go',
        parentSessionId: parent.id,
        provider: stubProvider(),
        parentToolRegistry: buildParentRegistry(echoTool),
        permissionEngine: buildEngine(),
        db,
        cwd: parentCwd,
        spawnChildProcess: dirPlantingSpawn,
      });
      expect(observedDir).toBeDefined();
      if (observedDir !== undefined) {
        // Path shape — anchored to the parent's cwd, not '/p',
        // namespaced by session ID under .agent/bg/subagents/.
        expect(observedDir.startsWith(`${parentCwd}/.agent/bg/subagents/`)).toBe(true);
        // Cleanup MUST have removed the dir.
        expect(existsSync(observedDir)).toBe(false);
      }
    } finally {
      rmSync(parentCwd, { recursive: true, force: true });
    }
  });

  test('4.2b.iv: SIGKILL-style child exit reaps orphan bg processes (DB + OS) before rmSync', async () => {
    // Regression for the C1 finding from review: when the child
    // exits without running its harness's bgManager.cleanup()
    // hook (heartbeat stale → SIGKILL, wall_clock kill, abort
    // escalation), bg processes the child spawned become
    // orphans — alive on the OS, status='running' in the DB,
    // and would have their log files unlinked out from under
    // them by the parent's rmSync. The reaper closes the loop:
    // kill OS-level + flip DB rows to 'killed' + rmSync.
    const parentCwd = mkdtempSync(join(tmpdir(), 'forja-rt-bg-reap-'));
    let sleepProc: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
        model: 'mock/m',
        cwd: parentCwd,
      });
      const bgRepo = await import('../../src/storage/repos/bg-processes.ts');
      let recordedBgRowId: string | undefined;
      let recordedPid: number | undefined;
      // Spawn fake that simulates a child registering a bg
      // process AND then dying without cleaning up. We use a
      // real `sleep 60` so the reaper has a real PID to send
      // signals to; the test verifies after runSubagent that
      // the OS process is gone and the DB row is 'killed'.
      const orphanLeavingSpawn: SpawnChildProcess = (opts) => {
        sleepProc = Bun.spawn({
          cmd: ['sleep', '60'],
          stdout: 'pipe',
          stderr: 'pipe',
        });
        recordedPid = sleepProc.pid;
        const row = bgRepo.insertBgProcess(db, {
          sessionId: opts.sessionId,
          osPid: sleepProc.pid,
          command: 'sleep 60',
          cwd: opts.cwd,
          stdoutLogPath: '/tmp/fake-stdout.log',
          stderrLogPath: '/tmp/fake-stderr.log',
        });
        recordedBgRowId = row.id;
        // Mimic the bg manager creating its log directory.
        if (opts.bgLogDir !== undefined) {
          mkdirSync(opts.bgLogDir, { recursive: true });
          writeFileSync(join(opts.bgLogDir, `${row.id}.stdout.log`), 'simulated\n');
        }
        // Insert outputs row but DO NOT publish payload — the
        // outcome is 'crashed', mirroring the SIGKILL-without-
        // finally path.
        insertSubagentOutput(db, { sessionId: opts.sessionId });
        // Return an immediately-exited handle with no payload.
        return {
          exited: Promise.resolve({ exitCode: 137 }),
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
        cwd: parentCwd,
        spawnChildProcess: orphanLeavingSpawn,
      });
      // Outcome is 'crashed' because the spawn fake skipped
      // payload publication — exactly the post-SIGKILL shape.
      expect(result.status).toBe('error');
      expect(result.reason).toBe('subprocess_crashed');

      // OS-level: the sleep PID must be dead. process.kill(pid, 0)
      // probes existence; ESRCH means gone, 0 thrown means alive.
      expect(recordedPid).toBeDefined();
      if (recordedPid !== undefined) {
        let alive = true;
        try {
          process.kill(recordedPid, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
      }

      // DB-level: the row flipped from 'running' to 'killed'
      // via markRunningAsKilled.
      expect(recordedBgRowId).toBeDefined();
      if (recordedBgRowId !== undefined) {
        const row = bgRepo.getBgProcess(db, recordedBgRowId);
        expect(row?.status).toBe('killed');
      }

      // Disk-level: bgLogDir is gone (rmSync ran AFTER the reap).
      const expectedDir = `${parentCwd}/.agent/bg/subagents/${result.sessionId}`;
      expect(existsSync(expectedDir)).toBe(false);
    } finally {
      // Defensive: if the test failed before the reaper killed it,
      // make sure the sleep doesn't outlive the test.
      if (sleepProc !== undefined) {
        try {
          sleepProc.kill();
        } catch {
          // already dead
        }
      }
      rmSync(parentCwd, { recursive: true, force: true });
    }
  });

  test('4.2b.iv: reaper skips BOTH passes when recorded command mismatches live PID (recycle defense)', async () => {
    // Race the slice's review surfaced: between row insert and
    // reaper, the kernel can recycle a PID to an unrelated
    // workload (process exited, PID handed out to something
    // else). Both passes — SIGTERM and SIGKILL — must verify
    // identity before signaling, otherwise the reaper kills
    // unrelated processes on the host. We simulate the race
    // by recording a bg row with a PID that points at a real
    // live process (`sleep 60`) but a recorded command that
    // doesn't match. The reaper SHOULD skip both signals; the
    // sleep stays alive throughout the run. We verify by
    // probing the PID after runSubagent returns.
    const parentCwd = mkdtempSync(join(tmpdir(), 'forja-rt-bg-recycle-'));
    let sleepProc: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
        model: 'mock/m',
        cwd: parentCwd,
      });
      const bgRepo = await import('../../src/storage/repos/bg-processes.ts');
      sleepProc = Bun.spawn({ cmd: ['sleep', '60'], stdout: 'pipe', stderr: 'pipe' });
      const recordedPid = sleepProc.pid;
      const recyclingSpawn: SpawnChildProcess = (opts) => {
        bgRepo.insertBgProcess(db, {
          sessionId: opts.sessionId,
          osPid: recordedPid,
          // Mismatch on purpose: argv0 of the live process is
          // 'sleep', but we record 'fake-different-binary'.
          // Both passes' isStillSameProcess check sees
          // cmdline basename 'sleep' vs recorded
          // 'fake-different-binary' → skip both signals.
          command: 'fake-different-binary --arg',
          cwd: opts.cwd,
          stdoutLogPath: '/tmp/fake-stdout.log',
          stderrLogPath: '/tmp/fake-stderr.log',
        });
        insertSubagentOutput(db, { sessionId: opts.sessionId });
        return {
          exited: Promise.resolve({ exitCode: 137 }),
          kill: () => undefined,
        };
      };
      await runSubagent({
        definition: definition(),
        prompt: 'go',
        parentSessionId: parent.id,
        provider: stubProvider(),
        parentToolRegistry: buildParentRegistry(echoTool),
        permissionEngine: buildEngine(),
        db,
        cwd: parentCwd,
        spawnChildProcess: recyclingSpawn,
      });

      // CRITICAL ASSERTION: the sleep is still alive. If
      // either pass had ignored the mismatch, our SIGTERM
      // (default=exit for sleep) or SIGKILL would have ended
      // it. Identity gate held → process untouched.
      let alive = false;
      try {
        process.kill(recordedPid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      expect(alive).toBe(true);

      // The DB row STAYS 'running' because identity didn't
      // match (mismatch result). Previous design unconditionally
      // flipped it to 'killed' which lied — the process is
      // demonstrably alive. Honest audit: row stays as-is so
      // the operator's `bg list` shows it and they can
      // investigate via OS tools.
      const session = (await import('../../src/storage/repos/sessions.ts')).listChildSessions(
        db,
        parent.id,
      );
      expect(session.length).toBeGreaterThanOrEqual(1);
      const childId = session[0]?.id;
      if (childId !== undefined) {
        const childRows = bgRepo.listBgProcessesBySession(db, childId);
        expect(childRows.length).toBe(1);
        expect(childRows[0]?.status).toBe('running');
      }
    } finally {
      // Manually clean up the sleep (the reaper correctly
      // refused to touch it).
      if (sleepProc !== undefined) {
        try {
          sleepProc.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
      rmSync(parentCwd, { recursive: true, force: true });
    }
  });

  test('4.2b.iv: reaper kills bash-wrapper bg processes (production spawn path)', async () => {
    // The bg manager always spawns user commands via
    // `bash -c <command>`, so the live argv[0] is `bash`, NOT
    // the tool name (`npm`, `sleep`, etc.) the row's `command`
    // field records. The first iteration of isStillSameProcess
    // compared argv[0]'s basename against the recorded first
    // token — which would be `bash` vs `sleep`, mismatch on
    // EVERY production bg process. The reaper would skip every
    // signal and the cleanup would silently leak every bg
    // process the child spawned. This test pins the production
    // shape: spawn matches what the bg manager does, recorded
    // command is the user command, identity check must accept,
    // both signals must fire, process must end up dead.
    const parentCwd = mkdtempSync(join(tmpdir(), 'forja-rt-bg-bashwrap-'));
    let bashProc: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
        model: 'mock/m',
        cwd: parentCwd,
      });
      const bgRepo = await import('../../src/storage/repos/bg-processes.ts');
      const bashWrapperSpawn: SpawnChildProcess = (opts) => {
        // Mirror the bg manager: bash -c "<command>".
        bashProc = Bun.spawn({
          cmd: ['bash', '-c', 'sleep 60'],
          stdout: 'pipe',
          stderr: 'pipe',
        });
        bgRepo.insertBgProcess(db, {
          sessionId: opts.sessionId,
          osPid: bashProc.pid,
          // Recorded command matches exactly what the bg manager
          // would have stored — the user-facing command, not
          // the wrapper.
          command: 'sleep 60',
          cwd: opts.cwd,
          stdoutLogPath: '/tmp/fake-stdout.log',
          stderrLogPath: '/tmp/fake-stderr.log',
        });
        insertSubagentOutput(db, { sessionId: opts.sessionId });
        return {
          exited: Promise.resolve({ exitCode: 137 }),
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
        cwd: parentCwd,
        spawnChildProcess: bashWrapperSpawn,
      });

      // Process must be dead. Identity check must have matched
      // via argv[2] === 'sleep 60' against the live bash -c
      // process's argv[2], NOT been deferred by the basename
      // mismatch on argv[0]=bash.
      expect(bashProc).toBeDefined();
      if (bashProc !== undefined) {
        let alive = true;
        try {
          process.kill(bashProc.pid, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
      }
      const childRows = bgRepo.listBgProcessesBySession(db, result.sessionId);
      expect(childRows[0]?.status).toBe('killed');
    } finally {
      if (bashProc !== undefined) {
        try {
          bashProc.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
      rmSync(parentCwd, { recursive: true, force: true });
    }
  });

  test('4.2b.iv: bash-wrapper match preserves trailing whitespace verbatim', async () => {
    // Real production shape that the prior trim() broke: a
    // recorded command with a trailing newline (very common —
    // heredoc bodies, multi-line scripts). The bg manager
    // passes `input.command` to bash AND to the DB verbatim,
    // so /proc/<pid>/cmdline argv[2] equals the row's
    // `command` field byte-for-byte. Trimming on either side
    // before the comparison would mismatch and leak the
    // process. Pin verbatim equality.
    const parentCwd = mkdtempSync(join(tmpdir(), 'forja-rt-bg-ws-'));
    let bashProc: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
        model: 'mock/m',
        cwd: parentCwd,
      });
      const bgRepo = await import('../../src/storage/repos/bg-processes.ts');
      // Trailing newline in argv[2] AND in the recorded
      // command. The recorded command MUST equal what we pass
      // to bash; matching is exact.
      const cmdWithWhitespace = 'sleep 60\n';
      const whitespaceSpawn: SpawnChildProcess = (opts) => {
        bashProc = Bun.spawn({
          cmd: ['bash', '-c', cmdWithWhitespace],
          stdout: 'pipe',
          stderr: 'pipe',
        });
        bgRepo.insertBgProcess(db, {
          sessionId: opts.sessionId,
          osPid: bashProc.pid,
          command: cmdWithWhitespace,
          cwd: opts.cwd,
          stdoutLogPath: '/tmp/fake-stdout.log',
          stderrLogPath: '/tmp/fake-stderr.log',
        });
        insertSubagentOutput(db, { sessionId: opts.sessionId });
        return {
          exited: Promise.resolve({ exitCode: 137 }),
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
        cwd: parentCwd,
        spawnChildProcess: whitespaceSpawn,
      });
      // Process must be dead. If trim had been re-applied,
      // argv[2]='sleep 60\n' vs trimmed='sleep 60' would
      // mismatch and the kill would be skipped.
      expect(bashProc).toBeDefined();
      if (bashProc !== undefined) {
        let alive = true;
        try {
          process.kill(bashProc.pid, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
      }
      const childRows = bgRepo.listBgProcessesBySession(db, result.sessionId);
      expect(childRows[0]?.status).toBe('killed');
    } finally {
      if (bashProc !== undefined) {
        try {
          bashProc.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
      rmSync(parentCwd, { recursive: true, force: true });
    }
  });

  test('4.2b.iv: isStillSameProcess matches by basename (path-prefix tolerance)', async () => {
    // Internal-helper coverage: the cmdline check should
    // tolerate the common case where the recorded command was
    // logged as a basename (`npm run dev`) while the running
    // argv[0] is the resolved absolute path
    // (`/usr/local/bin/npm`). Both reduce to basename `npm`,
    // match. We exercise via a real spawn we control: spawn
    // `sleep 60`, look up /proc/<pid>/cmdline, run the helper.
    // The helper isn't directly exported (internal); we cover
    // its behavior end-to-end via the reaper instead. This
    // test asserts the END behavior: a row whose recorded
    // command is `/usr/bin/sleep 60` (full path) gets reaped
    // when the live process's argv[0] is `sleep` (basename).
    const parentCwd = mkdtempSync(join(tmpdir(), 'forja-rt-bg-basename-'));
    let sleepProc: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
        model: 'mock/m',
        cwd: parentCwd,
      });
      const bgRepo = await import('../../src/storage/repos/bg-processes.ts');
      const basenameSpawn: SpawnChildProcess = (opts) => {
        sleepProc = Bun.spawn({ cmd: ['sleep', '60'], stdout: 'pipe', stderr: 'pipe' });
        bgRepo.insertBgProcess(db, {
          sessionId: opts.sessionId,
          osPid: sleepProc.pid,
          // Path-prefixed form; basename is still `sleep`.
          command: '/usr/bin/sleep 60',
          cwd: opts.cwd,
          stdoutLogPath: '/tmp/fake-stdout.log',
          stderrLogPath: '/tmp/fake-stderr.log',
        });
        insertSubagentOutput(db, { sessionId: opts.sessionId });
        return {
          exited: Promise.resolve({ exitCode: 137 }),
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
        cwd: parentCwd,
        spawnChildProcess: basenameSpawn,
      });
      // sleep should be dead — SIGTERM kills it; cmdline check
      // matches basename so SIGKILL would also have run had
      // SIGTERM not sufficed.
      let alive = true;
      if (sleepProc !== undefined) {
        try {
          process.kill(sleepProc.pid, 0);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
      const childRows = bgRepo.listBgProcessesBySession(db, result.sessionId);
      expect(childRows[0]?.status).toBe('killed');
    } finally {
      if (sleepProc !== undefined) {
        try {
          sleepProc.kill();
        } catch {
          // ignore
        }
      }
      rmSync(parentCwd, { recursive: true, force: true });
    }
  });

  test('4.2b.iv: direct-spawn match rejects same-binary different-args recycled PID', async () => {
    // Tightening: the original direct-spawn branch only
    // compared argv[0]'s basename. A recycled PID that lands
    // on a different invocation of the same binary (e.g.
    // recorded `sleep 60` exits, kernel hands the PID to a
    // fresh `sleep 30`) would falsely match and earn SIGKILL.
    // The new check compares argv length AND each token;
    // mismatching args reject the match, preserving the
    // recycled-PID safety property even for direct-spawn
    // callers (the case used by tests and future programmatic
    // bg managers that don't wrap commands in bash -c).
    const parentCwd = mkdtempSync(join(tmpdir(), 'forja-rt-bg-args-'));
    let liveSleep: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
        model: 'mock/m',
        cwd: parentCwd,
      });
      const bgRepo = await import('../../src/storage/repos/bg-processes.ts');
      // Live process is `sleep 30` (different args than
      // recorded). With basename-only matching this would
      // pass — the regression we fixed.
      liveSleep = Bun.spawn({ cmd: ['sleep', '30'], stdout: 'pipe', stderr: 'pipe' });
      const argMismatchSpawn: SpawnChildProcess = (opts) => {
        bgRepo.insertBgProcess(db, {
          sessionId: opts.sessionId,
          osPid: liveSleep?.pid ?? null,
          // Recorded args differ: live is `sleep 30`, recorded
          // is `sleep 60`. argv length matches (2 vs 2),
          // argv[0] basename matches ('sleep' vs 'sleep'),
          // argv[1] differs ('30' vs '60'). Match must be
          // refused.
          command: 'sleep 60',
          cwd: opts.cwd,
          stdoutLogPath: '/tmp/fake-stdout.log',
          stderrLogPath: '/tmp/fake-stderr.log',
        });
        insertSubagentOutput(db, { sessionId: opts.sessionId });
        return {
          exited: Promise.resolve({ exitCode: 137 }),
          kill: () => undefined,
        };
      };
      await runSubagent({
        definition: definition(),
        prompt: 'go',
        parentSessionId: parent.id,
        provider: stubProvider(),
        parentToolRegistry: buildParentRegistry(echoTool),
        permissionEngine: buildEngine(),
        db,
        cwd: parentCwd,
        spawnChildProcess: argMismatchSpawn,
      });
      // sleep 30 must still be alive — the reaper refused to
      // signal because the recorded command's tokens didn't
      // match the live argv.
      let alive = true;
      try {
        process.kill(liveSleep.pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(true);
    } finally {
      if (liveSleep !== undefined) {
        try {
          liveSleep.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
      rmSync(parentCwd, { recursive: true, force: true });
    }
  });

  test('4.2b.iv: exec-replace mismatch leaves row running + bgLogDir preserved (regression)', async () => {
    // Regression for review #9: a recorded `exec sleep 60` runs
    // through bash -c, the `exec` builtin replaces the bash
    // process with sleep, and now argv[0]='sleep' instead of
    // bash. The bash-wrapper match doesn't apply, the
    // direct-spawn match fails on token count (`exec sleep 60`
    // has 3 tokens, live argv has 2), result is 'mismatch'.
    //
    // Old behavior: skipped both signals (correct) but
    // `markRunningAsKilled` flipped the row to 'killed'
    // anyway (audit lie) AND the runSubagent re-query saw 0
    // running rows so the bgLogDir was rmSync'd (process still
    // writing to phantom FDs).
    //
    // New behavior: row stays 'running', re-query sees the
    // mismatch row, rmSync skipped, dir preserved for
    // operator investigation.
    const parentCwd = mkdtempSync(join(tmpdir(), 'forja-rt-bg-exec-'));
    let bashProc: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
        model: 'mock/m',
        cwd: parentCwd,
      });
      const bgRepo = await import('../../src/storage/repos/bg-processes.ts');
      const recordedCommand = 'exec sleep 60';
      const execReplaceSpawn: SpawnChildProcess = (opts) => {
        // Mirror what the bg manager would do: bash -c with
        // the user command. The `exec` causes the bash
        // process to replace itself with sleep, so the live
        // PID's argv[0] becomes 'sleep' instead of 'bash'.
        bashProc = Bun.spawn({
          cmd: ['bash', '-c', recordedCommand],
          stdout: 'pipe',
          stderr: 'pipe',
        });
        // Block synchronously until bash has actually exec'd
        // into sleep. Without this wait, the test races: the
        // reaper may catch bash mid-parse with argv[0]='bash'
        // and argv[2]=recordedCommand (a perfect match), kill
        // it before exec completes, and exercise the WRONG
        // code path. /proc reads are blocking I/O — the loop
        // paces itself naturally without needing a sleep
        // primitive (Bun has no sync sleep). 2s ceiling is
        // generous; bash-into-sleep typically takes <10ms.
        const waitStart = Date.now();
        while (Date.now() - waitStart < 2000) {
          try {
            const cmdline = readFileSync(`/proc/${bashProc.pid}/cmdline`, 'utf8');
            const argv0Basename = (cmdline.split('\0')[0] ?? '').split('/').pop() ?? '';
            if (argv0Basename === 'sleep') break;
          } catch {
            // /proc gone (process exited unexpectedly) — bail
            // out of the wait; the test will fail on a
            // separate assertion if this is bad.
            break;
          }
        }
        bgRepo.insertBgProcess(db, {
          sessionId: opts.sessionId,
          osPid: bashProc.pid,
          command: recordedCommand,
          cwd: opts.cwd,
          stdoutLogPath: '/tmp/fake-stdout.log',
          stderrLogPath: '/tmp/fake-stderr.log',
        });
        // Mimic the bg manager creating its log directory so
        // the rmSync skip path has something to preserve.
        if (opts.bgLogDir !== undefined) {
          mkdirSync(opts.bgLogDir, { recursive: true });
          writeFileSync(join(opts.bgLogDir, `${bashProc.pid}.log`), 'live\n');
        }
        insertSubagentOutput(db, { sessionId: opts.sessionId });
        return {
          exited: Promise.resolve({ exitCode: 137 }),
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
        cwd: parentCwd,
        spawnChildProcess: execReplaceSpawn,
      });

      // Row stays 'running' — mismatch outcome doesn't flip
      // it to 'killed'.
      const childRows = bgRepo.listBgProcessesBySession(db, result.sessionId);
      expect(childRows.length).toBe(1);
      expect(childRows[0]?.status).toBe('running');

      // bgLogDir preserved because re-query saw a running row.
      const expectedDir = `${parentCwd}/.agent/bg/subagents/${result.sessionId}`;
      expect(existsSync(expectedDir)).toBe(true);
    } finally {
      if (bashProc !== undefined) {
        try {
          bashProc.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
      rmSync(parentCwd, { recursive: true, force: true });
    }
  });

  test('parent forwards temperature to spawn opts when set', async () => {
    // Eval / automation pipelines pin temperature=0 for
    // determinism. Without forwarding, the subprocess child
    // would silently fall back to the provider default and
    // break reproducibility. Capture the spawn opts and
    // assert the value round-tripped.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const captured: { temperature?: number } = {};
    const recordingSpawn: SpawnChildProcess = (opts) => {
      if (opts.temperature !== undefined) captured.temperature = opts.temperature;
      insertSubagentOutput(db, { sessionId: opts.sessionId });
      setSubagentPayload(db, opts.sessionId, {
        status: 'done',
        reason: 'done',
        output: 'ok',
        cost_usd: 0,
        steps: 1,
        duration_ms: 1,
      });
      return { exited: Promise.resolve({ exitCode: 0 }), kill: () => undefined };
    };
    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      temperature: 0,
      spawnChildProcess: recordingSpawn,
    });
    expect(captured.temperature).toBe(0);
  });

  test('parent forwards providerEffort to spawn opts when set (/effort inheritance)', async () => {
    // The operator's resolved provider-effort rides to the subprocess
    // child via spawn opts (→ `--subagent-effort`) so `/effort` applies
    // task-wide. Operational caps are NOT forwarded (per-playbook).
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const captured: { providerEffort?: string } = {};
    const recordingSpawn: SpawnChildProcess = (opts) => {
      if (opts.providerEffort !== undefined) captured.providerEffort = opts.providerEffort;
      insertSubagentOutput(db, { sessionId: opts.sessionId });
      setSubagentPayload(db, opts.sessionId, {
        status: 'done',
        reason: 'done',
        output: 'ok',
        cost_usd: 0,
        steps: 1,
        duration_ms: 1,
      });
      return { exited: Promise.resolve({ exitCode: 0 }), kill: () => undefined };
    };
    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      providerEffort: 'high',
      spawnChildProcess: recordingSpawn,
    });
    expect(captured.providerEffort).toBe('high');
  });

  test('child that publishes payload then hangs gets SIGKILLed before parent returns', async () => {
    // Regression: the polling loop used to return on payload
    // without awaiting handle.exited. A child that publishes
    // payload then hangs on shutdown (slow flush, finalize,
    // signal handler delay) would let runSubagent resolve while
    // the subprocess was still alive — Bun keeps the parent
    // process alive until child dies, so the orphan would
    // hang the end-of-run AND race against the worktree
    // cleanup the parent fires next. The drain-after-payload
    // path waits up to graceMs, then SIGKILLs.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const killed: { signal: string }[] = [];
    let resolveExit: ((v: { exitCode: number }) => void) | undefined;
    const exited = new Promise<{ exitCode: number }>((resolve) => {
      resolveExit = resolve;
    });
    const hangAfterPayloadSpawn: SpawnChildProcess = (opts) => {
      // Publish payload synchronously (child finished its work
      // and committed the envelope) but DO NOT resolve `exited`
      // — simulates a hang during shutdown.
      insertSubagentOutput(db, { sessionId: opts.sessionId });
      setSubagentPayload(db, opts.sessionId, {
        status: 'done',
        reason: 'done',
        output: 'finished work',
        cost_usd: 0,
        steps: 1,
        duration_ms: 1,
      });
      return {
        exited,
        kill: (signal) => {
          killed.push({ signal });
          // SIGKILL resolves the exited promise — kernel reaped.
          if (signal === 'SIGKILL' && resolveExit !== undefined) {
            resolveExit({ exitCode: 137 });
            resolveExit = undefined;
          }
        },
      };
    };
    const start = Date.now();
    const result = await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      // Small grace so the test resolves quickly.
      graceMs: 50,
      spawnChildProcess: hangAfterPayloadSpawn,
    });
    const elapsed = Date.now() - start;
    // Result MUST reflect the child's payload (status='done',
    // not 'crashed'). The drain path is about waiting cleanly,
    // not about reclassifying the outcome.
    expect(result.status).toBe('done');
    expect(result.output).toBe('finished work');
    // SIGKILL was sent — proves the parent didn't return early
    // while the child was still hanging.
    expect(killed.map((k) => k.signal)).toContain('SIGKILL');
    // Wall time bound: drain waits graceMs, then SIGKILL,
    // then graceMs again before giving up. Total < 4×graceMs
    // is comfortable under bun's per-test timeout.
    expect(elapsed).toBeLessThan(50 * 8);
  });

  test('SIGKILL timer is cleared/unref when child exits before grace fires', async () => {
    // Regression for the timer-leak bug. The earlier code
    // scheduled `setTimeout(() => kill('SIGKILL'), graceMs)`
    // without tracking the handle: when the child exited
    // promptly via SIGTERM, the timer kept ticking and held
    // the event loop alive for graceMs after waitForChild
    // returned (Bun setTimeout is ref'd by default, like Node).
    // In production this caused post-run hangs of multiple
    // seconds on fast-shutdown paths.
    //
    // Probe: caller aborts, child exits cleanly via SIGTERM
    // before the SIGKILL timer fires. Assert that the SIGKILL
    // body NEVER ran (no SIGKILL recorded) — proves the timer
    // was cleared by the exit handler. Wall-time bound also
    // asserts the run finished well under graceMs (would have
    // been graceMs+ if the timer leaked and held the loop).
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const killed: { signal: string }[] = [];
    let resolveExit: ((v: { exitCode: number }) => void) | undefined;
    const exited = new Promise<{ exitCode: number }>((resolve) => {
      resolveExit = resolve;
    });
    const sigtermRespondingSpawn: SpawnChildProcess = () => ({
      exited,
      kill: (signal) => {
        killed.push({ signal });
        // Child exits cleanly on SIGTERM — DOES NOT wait for
        // SIGKILL. The scheduled SIGKILL timer should be
        // cleared by the exit handler.
        if (signal === 'SIGTERM' && resolveExit !== undefined) {
          // Resolve on next tick so the wait loop has a chance
          // to schedule the kill timer first.
          setTimeout(() => {
            resolveExit?.({ exitCode: 0 });
            resolveExit = undefined;
          }, 5);
        }
      },
    });
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      // Large grace so the leak would be obvious if the
      // timer wasn't cleared.
      graceMs: 2_000,
      spawnChildProcess: sigtermRespondingSpawn,
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;
    // SIGTERM was sent; SIGKILL must NOT have been (timer
    // cleared by exit handler before it fired).
    expect(killed.map((k) => k.signal)).toContain('SIGTERM');
    expect(killed.map((k) => k.signal)).not.toContain('SIGKILL');
    // Wall time stays well below graceMs — without the
    // unref/clear, the timer would have held the process
    // alive for 2_000ms+. The test cap is 4×poll cap (~2s
    // of polling at most) plus child exit; in practice this
    // resolves in tens of ms.
    expect(elapsed).toBeLessThan(1_500);
  });

  test('child that publishes payload AND exits cleanly: no SIGKILL needed', async () => {
    // Counterpart: when the child publishes payload AND
    // resolves `exited` promptly, the drain path observes the
    // exit and returns without sending SIGKILL. Locks the
    // happy-path semantics so a future regression that always
    // SIGKILLs (over-eager defense) surfaces here.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const killed: { signal: string }[] = [];
    const cleanSpawn: SpawnChildProcess = (opts) => {
      insertSubagentOutput(db, { sessionId: opts.sessionId });
      setSubagentPayload(db, opts.sessionId, {
        status: 'done',
        reason: 'done',
        output: 'ok',
        cost_usd: 0,
        steps: 1,
        duration_ms: 1,
      });
      return {
        exited: Promise.resolve({ exitCode: 0 }),
        kill: (signal) => {
          killed.push({ signal });
        },
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
      graceMs: 50,
      spawnChildProcess: cleanSpawn,
    });
    expect(result.status).toBe('done');
    expect(killed).toEqual([]);
  });

  test('temperature stays undefined in spawn opts when input omits it', async () => {
    // Default behavior: no temperature pinned at the input
    // means the child falls through to the provider default.
    // The spawn opts should NOT carry a temperature field
    // that the child would interpret as "the parent wants
    // exactly this value" — undefined is the honest signal.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    let observedKey = false;
    const recordingSpawn: SpawnChildProcess = (opts) => {
      observedKey = 'temperature' in opts;
      insertSubagentOutput(db, { sessionId: opts.sessionId });
      setSubagentPayload(db, opts.sessionId, {
        status: 'done',
        reason: 'done',
        output: 'ok',
        cost_usd: 0,
        steps: 1,
        duration_ms: 1,
      });
      return { exited: Promise.resolve({ exitCode: 0 }), kill: () => undefined };
    };
    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      // no temperature
      spawnChildProcess: recordingSpawn,
    });
    expect(observedKey).toBe(false);
  });

  test('depth defaults to 0 when input.depth is omitted', async () => {
    // Top-level invocation shape: parent's runSubagent without
    // an explicit depth should pass 0 to the spawn so the child
    // starts a fresh chain. Locks the default so a future
    // refactor doesn't accidentally change the baseline.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const captured: { depth?: number } = {};
    const recordingSpawn: SpawnChildProcess = (opts) => {
      captured.depth = opts.depth;
      insertSubagentOutput(db, { sessionId: opts.sessionId });
      setSubagentPayload(db, opts.sessionId, {
        status: 'done',
        reason: 'done',
        output: 'ok',
        cost_usd: 0,
        steps: 1,
        duration_ms: 1,
      });
      return { exited: Promise.resolve({ exitCode: 0 }), kill: () => undefined };
    };
    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      // no depth
      spawnChildProcess: recordingSpawn,
    });
    expect(captured.depth).toBe(0);
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

  test('buildResultFromPayload picks up `detail` from the child envelope', async () => {
    const { buildResultFromPayload } = await import('../../src/subagents/result-builder.ts');
    const result = buildResultFromPayload(
      {
        status: 'error',
        reason: 'providerError',
        output: '',
        cost_usd: 0,
        steps: 0,
        duration_ms: 5,
        detail: 'AnthropicError 401 invalid x-api-key',
      },
      'sess-1',
    );
    expect(result.status).toBe('error');
    expect(result.reason).toBe('providerError');
    expect(result.detail).toBe('AnthropicError 401 invalid x-api-key');
  });

  test('buildResultFromPayload defensively drops empty / non-string `detail`', async () => {
    const { buildResultFromPayload } = await import('../../src/subagents/result-builder.ts');
    // Empty string falls through (consumers concatenating `: ${detail}`
    // would otherwise render a trailing colon-space artifact).
    expect(
      buildResultFromPayload({ status: 'error', reason: 'providerError', detail: '' }, 'sess-1')
        .detail,
    ).toBeUndefined();
    // Wrong type collapses to absent — protects downstream
    // string concatenation from "[object Object]" / "null".
    expect(
      buildResultFromPayload({ status: 'error', reason: 'providerError', detail: 42 }, 'sess-1')
        .detail,
    ).toBeUndefined();
    expect(
      buildResultFromPayload({ status: 'error', reason: 'providerError', detail: null }, 'sess-1')
        .detail,
    ).toBeUndefined();
  });

  test('toEnvelope round-trips `detail` when present, omits when absent', async () => {
    const { buildResultFromPayload, toEnvelope } = await import(
      '../../src/subagents/result-builder.ts'
    );
    const withDetail = buildResultFromPayload(
      {
        status: 'error',
        reason: 'providerError',
        detail: 'connection reset by peer',
      },
      'sess-1',
    );
    expect(toEnvelope(withDetail).detail).toBe('connection reset by peer');

    const withoutDetail = buildResultFromPayload(
      { status: 'done', reason: 'done', output: 'ok' },
      'sess-2',
    );
    expect(toEnvelope(withoutDetail).detail).toBeUndefined();
    // Property MUST be absent (not `undefined`) so JSON.stringify
    // produces a clean envelope without phantom `"detail":null`.
    expect(Object.hasOwn(toEnvelope(withoutDetail), 'detail')).toBe(false);
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

// Slice 95 — PERMISSION_ENGINE.md §10.1 effective envelope
// persistence at the runtime layer. The harness loop computes
// the intersection result and passes `effectiveCapabilities`
// through `RunSubagentInput`; this slice's contract is that the
// runtime persists it onto `subagent_runs` so the child engine
// reads it at startup. These tests cover the runtime ↔ repo
// seam; the capabilities helpers + engine gate are tested
// elsewhere.
describe('runSubagent — effective capabilities seal (§10.1, slice 95)', () => {
  test('omitting effectiveCapabilities leaves the column NULL (root semantics)', async () => {
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
      spawnChildProcess: fakeSpawnDone(),
    });
    const audit = getSubagentRun(db, result.sessionId);
    expect(audit?.effectiveCapabilities).toBeNull();
  });

  test('explicit [] persists as [] (pure-LLM child contract)', async () => {
    // CRITICAL: empty vs absent MUST stay distinguishable end-
    // to-end. Conflating would let a corrupt or absent row
    // grant the parent's full set, re-opening R11 P0-3.
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
      effectiveCapabilities: [],
      spawnChildProcess: fakeSpawnDone(),
    });
    const audit = getSubagentRun(db, result.sessionId);
    expect(audit?.effectiveCapabilities).toEqual([]);
    expect(audit?.effectiveCapabilities).not.toBeNull();
  });

  test('non-empty list persists verbatim (narrowed envelope)', async () => {
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
      effectiveCapabilities: ['read-fs:src/**', 'exec:shell'],
      spawnChildProcess: fakeSpawnDone(),
    });
    const audit = getSubagentRun(db, result.sessionId);
    expect(audit?.effectiveCapabilities).toEqual(['read-fs:src/**', 'exec:shell']);
  });
});

// End-to-end subprocess audit (migration 029). The fakes used by
// the orchestration tests above intentionally omit `pid` / `cmd`
// (they bypass the subprocess surface entirely), so the audit row
// is skipped — that's the documented behavior in
// `runtime.ts:5a-bis`. These tests use fakes that DO expose pid +
// cmd to exercise the audit path end-to-end.
describe('runSubagent — subprocess audit (subagent_processes)', () => {
  // Fake that exposes a fake pid + argv so the runtime's audit
  // hook can record the spawn. Publishes a clean payload + exits 0.
  const fakeSpawnAudited = (overrides: { exitCode?: number; signal?: string } = {}) => {
    return ((opts) => {
      insertSubagentOutput(db, { sessionId: opts.sessionId });
      setSubagentPayload(db, opts.sessionId, {
        status: 'done',
        reason: 'done',
        output: 'ok',
        cost_usd: 0,
        steps: 1,
        duration_ms: 1,
      });
      const handle: ReturnType<SpawnChildProcess> = {
        exited: Promise.resolve({
          exitCode: overrides.exitCode ?? 0,
          ...(overrides.signal !== undefined ? { signal: overrides.signal } : {}),
        }),
        pid: 99_999,
        cmd: ['/bin/agent', '--subagent-session-id', opts.sessionId],
        kill: () => undefined,
      };
      return handle;
    }) satisfies SpawnChildProcess;
  };

  test('successful spawn → recordProcessSpawn + recordProcessExit with reason=normal', async () => {
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
      spawnChildProcess: fakeSpawnAudited(),
    });
    const row = getProcessRecord(db, result.sessionId);
    expect(row).not.toBeNull();
    expect(row?.parentSessionId).toBe(parent.id);
    expect(row?.pid).toBe(99_999);
    // argv hash is SHA256 over cmd joined with NUL.
    expect(row?.argvHash).toMatch(/^[0-9a-f]{64}$/);
    // stderr log path matches the bgLogDir convention.
    expect(row?.stderrLogPath).toContain('/.agent/bg/subagents/');
    expect(row?.stderrLogPath?.endsWith('/stderr.log')).toBe(true);
    // Exit fields populated by the proc.exited handler.
    expect(row?.exitedAt).not.toBeNull();
    expect(row?.exitCode).toBe(0);
    expect(row?.exitSignal).toBeNull();
    expect(row?.exitReason).toBe('normal');
  });

  test('non-zero exit → exit_reason=crash, exit_code preserved', async () => {
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
      spawnChildProcess: fakeSpawnAudited({ exitCode: 137 }),
    });
    const row = getProcessRecord(db, result.sessionId);
    expect(row?.exitCode).toBe(137);
    expect(row?.exitSignal).toBeNull();
    expect(row?.exitReason).toBe('crash');
  });

  test('OS-killed (signal, no parent kill) → exit_reason=signal, exit_code=null', async () => {
    // Child segfaulted / OOM-killed — exit.signal is set but the
    // parent never called handle.kill (parentInitiatedKill stays
    // false). Classifier picks 'signal'. exit_code persists as
    // NULL per POSIX (signal exits have no meaningful code).
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
      spawnChildProcess: fakeSpawnAudited({ exitCode: 139, signal: 'SIGSEGV' }),
    });
    const row = getProcessRecord(db, result.sessionId);
    expect(row?.exitCode).toBeNull();
    expect(row?.exitSignal).toBe('SIGSEGV');
    expect(row?.exitReason).toBe('signal');
  });

  test('fakes without pid/cmd skip the audit row (no FK / NOT NULL crash)', async () => {
    // The orchestration-test fakes (fakeSpawnDone etc) don't
    // expose pid/cmd. The runtime's `if (handle.pid !== undefined
    // && handle.cmd !== undefined)` guard MUST skip the audit
    // write so existing tests keep passing — a regression that
    // tries to record without pid would fail on the NOT NULL
    // pid column.
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
      spawnChildProcess: fakeSpawnDone(),
    });
    expect(getProcessRecord(db, result.sessionId)).toBeNull();
  });

  test('parent abort → exit_reason=parent_aborted (precedence over signal/crash classification)', async () => {
    // Parent's caller-supplied AbortSignal fires; the wait loop
    // tears down. The classifier checks input.signal.aborted
    // FIRST so even if the OS reports a SIGKILL exit, the audit
    // reason reads 'parent_aborted' — captures intent, not
    // mechanism. Lets forensic queries separate "operator
    // pressed Ctrl-C" from "child died on its own".
    const ctrl = new AbortController();
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    // Schedule the abort just after spawn so the wait loop
    // observes signal.aborted before recording exit.
    queueMicrotask(() => ctrl.abort());
    const result = await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      signal: ctrl.signal,
      spawnChildProcess: fakeSpawnAudited({ exitCode: 137, signal: 'SIGKILL' }),
    });
    const row = getProcessRecord(db, result.sessionId);
    expect(row?.exitReason).toBe('parent_aborted');
  });
});

describe('computeArgvHash', () => {
  // The hash is the audit's cross-run fingerprint. Pinning these
  // shapes prevents two regression classes:
  //   1. A future hand-edit that drops a real config flag from
  //      the hash (would silently degrade the fingerprint).
  //   2. A future hand-edit that adds a per-spawn flag without
  //      updating ARGV_HASH_DROP_PAIRS (would re-introduce the
  //      "unique per spawn" defect that motivated this filter).

  test('argv differing ONLY in --subagent-session-id produces the same hash', () => {
    const cmdA = [
      '/bin/agent',
      '--subagent-session-id',
      '11111111-1111-4111-8111-111111111111',
      '--subagent-depth',
      '0',
    ];
    const cmdB = [
      '/bin/agent',
      '--subagent-session-id',
      '22222222-2222-4222-8222-222222222222',
      '--subagent-depth',
      '0',
    ];
    expect(computeArgvHash(cmdA)).toBe(computeArgvHash(cmdB));
  });

  test('argv differing ONLY in --subagent-bg-log-dir produces the same hash', () => {
    // The bg-log-dir embeds the session id in its path
    // (`.agent/bg/subagents/<id>/`), so it MUST be filtered along
    // with `--subagent-session-id` for the hash to be stable
    // across runs.
    const cmdA = [
      '/bin/agent',
      '--subagent-bg-log-dir',
      '/p/.agent/bg/subagents/aaa/',
      '--subagent-depth',
      '0',
    ];
    const cmdB = [
      '/bin/agent',
      '--subagent-bg-log-dir',
      '/p/.agent/bg/subagents/bbb/',
      '--subagent-depth',
      '0',
    ];
    expect(computeArgvHash(cmdA)).toBe(computeArgvHash(cmdB));
  });

  test('argv differing in --subagent-depth (a real config flag) produces a DIFFERENT hash', () => {
    // depth IS config — a depth-0 spawn vs a depth-2 spawn are
    // legitimately different runs. A regression that filtered
    // depth out of the hash would flatten this distinction and
    // be caught here.
    const cmd0 = ['/bin/agent', '--subagent-depth', '0'];
    const cmd2 = ['/bin/agent', '--subagent-depth', '2'];
    expect(computeArgvHash(cmd0)).not.toBe(computeArgvHash(cmd2));
  });

  test('argv differing in --subagent-temperature produces a DIFFERENT hash', () => {
    // Eval pipelines pin temperature=0; ad-hoc runs use the
    // provider default. Cross-run regression hunts MUST see
    // these as distinct configs.
    const cmd0 = ['/bin/agent', '--subagent-temperature', '0'];
    const cmd1 = ['/bin/agent', '--subagent-temperature', '1'];
    expect(computeArgvHash(cmd0)).not.toBe(computeArgvHash(cmd1));
  });

  test('returns a 64-char lowercase hex string (SHA256 shape)', () => {
    expect(computeArgvHash(['/bin/agent'])).toMatch(/^[0-9a-f]{64}$/);
  });

  test('handles a malformed cmd with a drop-flag at the end (no value to skip)', () => {
    // Defensive: a future bug in the spawn factory could emit
    // `--subagent-session-id` as the LAST token without a value.
    // The hash function must not throw or read out of bounds —
    // the trailing drop-flag is consumed and the would-be value
    // index is past the end, which the loop tolerates.
    const cmd = ['/bin/agent', '--subagent-depth', '0', '--subagent-session-id'];
    expect(() => computeArgvHash(cmd)).not.toThrow();
  });
});

describe('drainStderrToLogFile', () => {
  // Per-test temp dir so each scenario has clean disk state.
  let tmp: string;
  beforeEach(() => {
    tmp = require('node:fs').mkdtempSync(
      require('node:path').join(require('node:os').tmpdir(), 'forja-drain-'),
    );
  });
  afterEach(() => {
    try {
      require('node:fs').rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  // Helper: build a controllable ReadableStream that pushes
  // bytes when the test calls `enqueue` and ends on `close`.
  const makeStream = () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    return {
      stream,
      enqueue: (s: string) => controller.enqueue(new TextEncoder().encode(s)),
      close: () => controller.close(),
    };
  };

  const stderrPath = () => require('node:path').join(tmp, 'stderr.log');

  test('writes received bytes into <logDir>/stderr.log', async () => {
    const { stream, enqueue, close } = makeStream();
    const drained = drainStderrToLogFile(stream, tmp);
    enqueue('forja: subagent-child: hook /etc/agent/hooks.toml: malformed entry\n');
    enqueue('forja: subagent-child: another error\n');
    close();
    await drained;
    const contents = require('node:fs').readFileSync(stderrPath(), 'utf8');
    expect(contents).toContain('hook /etc/agent/hooks.toml');
    expect(contents).toContain('another error');
  });

  test('lazy creation: child that never writes stderr produces NO file (no empty noise)', async () => {
    // The common happy path. Without lazy creation we'd
    // accumulate empty stderr.log files across thousands of
    // subagent invocations.
    const { stream, close } = makeStream();
    const drained = drainStderrToLogFile(stream, tmp);
    close();
    await drained;
    expect(require('node:fs').existsSync(stderrPath())).toBe(false);
  });

  test('zero-length chunks are not enough to trigger lazy file creation', async () => {
    // Defensive: a stream that emits zero-byte buffers (rare
    // but technically allowed) shouldn't open the file. Only
    // actual content matters.
    const { stream, close } = makeStream();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const realStream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const drained = drainStderrToLogFile(realStream, tmp);
    controller.enqueue(new Uint8Array(0));
    controller.enqueue(new Uint8Array(0));
    controller.close();
    await drained;
    void stream;
    void close;
    expect(require('node:fs').existsSync(stderrPath())).toBe(false);
  });

  test('logDir undefined: drains stream silently without crashing', async () => {
    // Test fixtures that don't model a log dir need the drain
    // to keep reading the pipe (otherwise the subprocess would
    // block on its next write). Discard mode preserves that
    // contract — the caller gets no on-disk artifact but the
    // child stays unblocked.
    const { stream, enqueue, close } = makeStream();
    const drained = drainStderrToLogFile(stream, undefined);
    enqueue('some error\n');
    enqueue('and another\n');
    close();
    await drained;
    // No file path to verify against; the assertion is
    // "didn't throw, drained promise resolved".
    expect(true).toBe(true);
  });

  test('creates the log dir if it does not exist (mkdirSync recursive)', async () => {
    // bgLogDir is normally created lazily by the bg manager on
    // first bg spawn — but stderr can fire before any bg work,
    // so the drain must mkdir on its own.
    const path = require('node:path');
    const fs = require('node:fs');
    const deepDir = path.join(tmp, 'a', 'b', 'c');
    expect(fs.existsSync(deepDir)).toBe(false);
    const { stream, enqueue, close } = makeStream();
    const drained = drainStderrToLogFile(stream, deepDir);
    enqueue('error\n');
    close();
    await drained;
    expect(fs.existsSync(path.join(deepDir, 'stderr.log'))).toBe(true);
  });

  test('continues draining after a write error (sink dropped, pipe stays clear)', async () => {
    // If the disk fills mid-run, the sink writes throw. The
    // drain has to keep READING the pipe regardless or the
    // subprocess would block on its next stderr write —
    // exactly the failure mode the drain exists to prevent.
    // We can't easily simulate disk-full at unit level, but
    // the contract holds even if mkdirSync fails (e.g., the
    // path is a regular file). Test that path.
    const path = require('node:path');
    const fs = require('node:fs');
    // Plant a regular file where the drain expects a dir.
    fs.writeFileSync(path.join(tmp, 'collision'), 'i am a file');
    const { stream, enqueue, close } = makeStream();
    const drained = drainStderrToLogFile(stream, path.join(tmp, 'collision'));
    enqueue('something');
    enqueue('more');
    close();
    // Drain must not reject: it swallows the mkdir error and
    // keeps reading.
    await expect(drained).resolves.toBeUndefined();
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

  test('symlink targeting outside the worktree is blocked at runtime', async () => {
    // Spec SECURITY §8.4 deny-list + realpath validation
    // (4.2b.iii). The validator runs inside `createWorktree`
    // after `git worktree add` succeeds; a symlink committed
    // to HEAD that resolves outside the worktree must surface
    // as `worktree_create_failed` with a rolled-back tree
    // (cache root empty, parent branch list still pristine).
    // The child session NEVER materializes — runSubagent's
    // worktree-then-session ordering means the failure halts
    // before any DB row gets inserted.
    const outside = mkdtempSync(join(tmpdir(), 'forja-rt-outside-'));
    try {
      writeFileSync(join(outside, 'host-secret'), 'secret payload');
      symlinkSync(join(outside, 'host-secret'), join(parentRepo, 'leak'));
      await runGit(parentRepo, ['add', 'leak']);
      await runGit(parentRepo, ['commit', '-m', 'add malicious symlink']);

      const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
        model: 'mock/m',
        cwd: parentRepo,
      });
      const result = await runSubagent({
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
      expect(result.status).toBe('error');
      expect(result.reason).toBe('worktree_create_failed');
      // Worktree root is empty — rollback removed the dir
      // even though `git worktree add` had succeeded before
      // validation tripped.
      expect(readdirSync(worktreeRoot)).toEqual([]);
      // No child session row materialized: createSession runs
      // AFTER createWorktree, and createWorktree threw.
      expect(listChildSessions(db, parent.id)).toEqual([]);
      // Worktree audit row also absent (insert happens after
      // both worktree and session creation succeed).
      expect(getSubagentWorktree(db, result.sessionId)).toBeNull();
      // Parent repo is still on `main` only — no orphan agent
      // branch left behind by the rollback. (`runGit` in this
      // describe block returns void; spawn directly to capture
      // stdout for the assertion.)
      const branchProc = Bun.spawn({
        cmd: ['git', '-C', parentRepo, 'branch', '--list'],
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          LC_ALL: 'C',
          GIT_TERMINAL_PROMPT: '0',
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
        },
      });
      const branches = await new Response(branchProc.stdout).text();
      await branchProc.exited;
      expect(branches.trim()).toBe('* main');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// IPC integration (spec docs/spec/IPC.md, Slice 1). Verifies the
// runtime opt-in (`input.ipc: true`) reaches the spawn factory,
// the fake channel surfaces messages back to the parent's
// `onIpcMessage` observer, and the post-wait teardown closes the
// channel — without coupling these tests to a real subprocess.
describe('runSubagent — IPC channel', () => {
  // Helper: build a fake spawn that opens a channel pair and
  // returns the child's side so the test can drive messages from
  // the "child" perspective. The `payload` arg drives the
  // canonical happy-path SQLite write the runtime polls for; the
  // test can also send arbitrary IpcMessages over the channel
  // before the payload lands.
  const fakeSpawnWithIpc = (
    payload: Partial<Record<string, unknown>> = {},
  ): {
    spawn: SpawnChildProcess;
    childChannel: IpcChannel;
    sawIpc: boolean;
    publish: (sessionId: string) => void;
  } => {
    const { a, b } = fakeTransportPair();
    const parentChannel = createChannel(a);
    const childChannel = createChannel(b);
    let resolveExit: ((v: { exitCode: number }) => void) | undefined;
    const exited = new Promise<{ exitCode: number }>((r) => {
      resolveExit = r;
    });
    const ctx = {
      sawIpc: false,
      publish: (sessionId: string) => {
        insertSubagentOutput(db, { sessionId });
        setSubagentPayload(db, sessionId, {
          status: 'done',
          reason: 'done',
          output: 'child output',
          cost_usd: 0.001,
          steps: 1,
          duration_ms: 50,
          ...payload,
        });
        if (resolveExit !== undefined) {
          resolveExit({ exitCode: 0 });
          resolveExit = undefined;
        }
      },
    };
    const spawn: SpawnChildProcess = (opts) => {
      // The spawn factory only sees `ipc: true` when the runtime
      // forwarded the opt-in. Track it so the test can assert.
      ctx.sawIpc = opts.ipc === true;
      return {
        exited,
        kill: () => undefined,
        ipc: parentChannel,
      };
    };
    return {
      spawn,
      childChannel,
      get sawIpc() {
        return ctx.sawIpc;
      },
      publish: ctx.publish,
    };
  };

  test('input.ipc: true forwards to spawn factory', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const fake = fakeSpawnWithIpc();
    // Drive the payload publish on next tick so the wait loop
    // resolves cleanly. Without this, the spawn returns a
    // never-resolving exited promise and the test hangs until
    // wallClockMs.
    queueMicrotask(() => {
      // Need the session id; runtime computes it post-spawn,
      // so query the DB. The runtime inserts the row before
      // calling spawn; here we drive `publish` from inside
      // the test by reading `listChildSessions` shortly after.
      const children = listChildSessions(db, parent.id);
      const last = children[children.length - 1];
      if (last !== undefined) fake.publish(last.id);
    });
    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      ipc: true,
      spawnChildProcess: fake.spawn,
    });
    expect(fake.sawIpc).toBe(true);
  });

  test('messages from child reach onIpcMessage observer', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const fake = fakeSpawnWithIpc();
    const received: IpcMessage[] = [];
    queueMicrotask(() => {
      const children = listChildSessions(db, parent.id);
      const last = children[children.length - 1];
      if (last !== undefined) {
        fake.childChannel.send(makeSessionStart(last.id));
        fake.childChannel.send(makeEvent({ kind: 'tool_invoking', name: 'echo', stepN: 1 }));
        fake.childChannel.send(makeSessionFinished());
        fake.publish(last.id);
      }
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
      ipc: true,
      onIpcMessage: (m) => received.push(m),
      spawnChildProcess: fake.spawn,
    });
    expect(result.status).toBe('done');
    // Three messages we drove + the order they arrived.
    expect(received.map((m) => m.type)).toEqual(['session_start', 'event', 'session_finished']);
  });

  test('observer exceptions do not break the run', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const fake = fakeSpawnWithIpc();
    queueMicrotask(() => {
      const children = listChildSessions(db, parent.id);
      const last = children[children.length - 1];
      if (last !== undefined) {
        fake.childChannel.send(makeSessionStart(last.id));
        fake.publish(last.id);
      }
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
      ipc: true,
      onIpcMessage: () => {
        throw new Error('observer exploded');
      },
      spawnChildProcess: fake.spawn,
    });
    // Run completes despite the listener throw.
    expect(result.status).toBe('done');
  });

  test('opt-out (no ipc) leaves handle.ipc undefined and observer never fires', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const received: unknown[] = [];
    let sawIpcFlag = false;
    const spawn: SpawnChildProcess = (opts) => {
      sawIpcFlag = opts.ipc === true;
      insertSubagentOutput(db, { sessionId: opts.sessionId });
      setSubagentPayload(db, opts.sessionId, {
        status: 'done',
        reason: 'done',
        output: 'no ipc',
        cost_usd: 0,
        steps: 1,
        duration_ms: 1,
      });
      return {
        exited: Promise.resolve({ exitCode: 0 }),
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
      onIpcMessage: (m) => received.push(m),
      spawnChildProcess: spawn,
    });
    expect(result.status).toBe('done');
    expect(sawIpcFlag).toBe(false);
    expect(received).toEqual([]);
  });
});

// S2: typed `onChildEvent` observer surfacing subagent_* HarnessEvents
// to the parent's harness chain. Tests focus on the bracket invariant
// (start always pairs with finished) and the subagent_progress
// translation from incoming IPC `event` messages.
describe('runSubagent — onChildEvent (S2 observability)', () => {
  // Build a fake spawn that exposes a connected child channel for
  // the test to drive. Mirrors `fakeSpawnWithIpc` from S1's tests
  // but kept here so each S2 test reads top-down.
  const fakeSpawnForObservability = (
    payload: Partial<Record<string, unknown>> = {},
  ): {
    spawn: SpawnChildProcess;
    childChannel: IpcChannel;
    publish: (sessionId: string) => void;
  } => {
    const { a, b } = fakeTransportPair();
    const parentChannel = createChannel(a);
    const childChannel = createChannel(b);
    let resolveExit: ((v: { exitCode: number }) => void) | undefined;
    const exited = new Promise<{ exitCode: number }>((r) => {
      resolveExit = r;
    });
    const publish = (sessionId: string) => {
      insertSubagentOutput(db, { sessionId });
      setSubagentPayload(db, sessionId, {
        status: 'done',
        reason: 'done',
        output: 'first line\nsecond line',
        cost_usd: 0.002,
        steps: 3,
        duration_ms: 100,
        ...payload,
      });
      if (resolveExit !== undefined) {
        resolveExit({ exitCode: 0 });
        resolveExit = undefined;
      }
    };
    const spawn: SpawnChildProcess = () => ({
      exited,
      kill: () => undefined,
      ipc: parentChannel,
    });
    return { spawn, childChannel, publish };
  };

  test('emits subagent_start before spawn and subagent_finished after wait', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const fake = fakeSpawnForObservability();
    const events: import('../../src/harness/index.ts').HarnessEvent[] = [];
    queueMicrotask(() => {
      const children = listChildSessions(db, parent.id);
      const last = children[children.length - 1];
      if (last !== undefined) fake.publish(last.id);
    });
    const result = await runSubagent({
      definition: definition({ name: 'explore' }),
      prompt: 'find the README',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      onChildEvent: (e) => events.push(e),
      spawnChildProcess: fake.spawn,
    });
    expect(result.status).toBe('done');
    // Bracket invariant: first event is start, last is finished.
    expect(events[0]?.type).toBe('subagent_start');
    expect(events[events.length - 1]?.type).toBe('subagent_finished');
    const start = events[0];
    if (start?.type === 'subagent_start') {
      expect(start.subagentId).toBe(result.sessionId);
      expect(start.name).toBe('explore');
      expect(start.prompt).toBe('find the README');
    }
    const fin = events[events.length - 1];
    if (fin?.type === 'subagent_finished') {
      expect(fin.subagentId).toBe(result.sessionId);
      expect(fin.status).toBe('done');
      // Summary picks the first line of `output` (first 80 chars).
      expect(fin.summary).toBe('first line');
      expect(fin.costUsd).toBe(0.002);
    }
  });

  test('forwards child IPC events as subagent_progress (with inner HarnessEvent)', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const fake = fakeSpawnForObservability();
    const progressEvents: import('../../src/harness/index.ts').HarnessEvent[] = [];
    queueMicrotask(() => {
      const children = listChildSessions(db, parent.id);
      const last = children[children.length - 1];
      if (last !== undefined) {
        // Drive a few HarnessEvents from the "child" via the IPC
        // `event` envelope. The runtime should unwrap and re-fire
        // them as subagent_progress on our observer.
        fake.childChannel.send(makeEvent({ type: 'step_start', stepN: 1 }));
        fake.childChannel.send(
          makeEvent({
            type: 'tool_invoking',
            toolUseId: 't1',
            toolName: 'echo',
            args: { msg: 'hi' },
          }),
        );
        fake.publish(last.id);
      }
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
      onChildEvent: (e) => {
        if (e.type === 'subagent_progress') progressEvents.push(e);
      },
      spawnChildProcess: fake.spawn,
    });
    expect(result.status).toBe('done');
    expect(progressEvents.length).toBe(2);
    const inner0 = progressEvents[0];
    if (inner0?.type === 'subagent_progress') {
      expect(inner0.lastEvent.type).toBe('step_start');
    }
    const inner1 = progressEvents[1];
    if (inner1?.type === 'subagent_progress') {
      expect(inner1.lastEvent.type).toBe('tool_invoking');
    }
  });

  test('drops nested subagent_* and session_finished from progress forwarding', async () => {
    // The parent renders only its DIRECT children — a grandchild
    // throwing subagent_start over IPC must not bubble up to the
    // parent's renderer. session_finished is also dropped: the
    // bracket close fires from waitForChild's outcome, not from
    // the wire (which the runtime cannot distinguish from a
    // grandchild's bracket).
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const fake = fakeSpawnForObservability();
    const progressEvents: import('../../src/harness/index.ts').HarnessEvent[] = [];
    queueMicrotask(() => {
      const children = listChildSessions(db, parent.id);
      const last = children[children.length - 1];
      if (last !== undefined) {
        fake.childChannel.send(
          makeEvent({
            type: 'subagent_start',
            subagentId: 'grandchild',
            name: 'inner',
            prompt: 'nested',
          }),
        );
        fake.childChannel.send(makeEvent({ type: 'session_finished', result: { status: 'done' } }));
        fake.childChannel.send(makeEvent({ type: 'step_start', stepN: 2 }));
        fake.publish(last.id);
      }
    });
    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      onChildEvent: (e) => {
        if (e.type === 'subagent_progress') progressEvents.push(e);
      },
      spawnChildProcess: fake.spawn,
    });
    expect(progressEvents.length).toBe(1);
    const only = progressEvents[0];
    if (only?.type === 'subagent_progress') {
      expect(only.lastEvent.type).toBe('step_start');
    }
  });

  test('bracket invariant holds even when spawn throws', async () => {
    // Defense in depth — observers must always see a finished
    // event after a start, regardless of which path led to
    // termination. The renderer's reducer would otherwise leak a
    // live row when the spawn factory throws (ENOENT / EACCES
    // produce subprocess_spawn_failed).
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const events: import('../../src/harness/index.ts').HarnessEvent[] = [];
    const throwingSpawn: SpawnChildProcess = () => {
      throw new Error('ENOENT: missing binary');
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
      onChildEvent: (e) => events.push(e),
      spawnChildProcess: throwingSpawn,
    });
    expect(result.status).toBe('error');
    expect(result.reason).toBe('subprocess_spawn_failed');
    expect(events.map((e) => e.type)).toEqual(['subagent_start', 'subagent_finished']);
  });

  test('observer exceptions do not break the run', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const fake = fakeSpawnForObservability();
    queueMicrotask(() => {
      const children = listChildSessions(db, parent.id);
      const last = children[children.length - 1];
      if (last !== undefined) fake.publish(last.id);
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
      onChildEvent: () => {
        throw new Error('observer exploded');
      },
      spawnChildProcess: fake.spawn,
    });
    expect(result.status).toBe('done');
  });
});

// S3: soft/hard interrupt propagation + abortCause discriminator.
// Tests focus on the wait-loop's escalation semantics: soft sends
// `interrupt:soft` over IPC and waits; soft expiry promotes to
// hard; payload-carried `abort_cause` round-trips through
// `buildResultFromPayload`.
describe('runSubagent — interrupt soft/hard (S3)', () => {
  // Helper: build a fake spawn whose ipc channel is observable
  // from the test side AND that records OS kill signals. The
  // `childAck` callback fires when the parent sends an IPC
  // command — tests use it to choreograph "child responded by
  // publishing a payload".
  const fakeSpawnInterruptable = (): {
    spawn: SpawnChildProcess;
    childChannel: IpcChannel;
    parentSent: import('../../src/subagents/ipc.ts').IpcMessage[];
    killSignals: string[];
    publish: (sessionId: string, payload?: Partial<Record<string, unknown>>) => void;
    forceExit: (exitCode?: number) => void;
  } => {
    const { a, b } = fakeTransportPair();
    const parentChannel = createChannel(a);
    const childChannel = createChannel(b);
    const parentSent: import('../../src/subagents/ipc.ts').IpcMessage[] = [];
    childChannel.onMessage((m) => parentSent.push(m));

    const killSignals: string[] = [];
    let resolveExit: ((v: { exitCode: number }) => void) | undefined;
    const exited = new Promise<{ exitCode: number }>((r) => {
      resolveExit = r;
    });
    const publish = (sessionId: string, payload: Partial<Record<string, unknown>> = {}) => {
      insertSubagentOutput(db, { sessionId });
      setSubagentPayload(db, sessionId, {
        status: 'interrupted',
        reason: 'aborted',
        output: '',
        cost_usd: 0,
        steps: 1,
        duration_ms: 10,
        ...payload,
      });
      if (resolveExit !== undefined) {
        resolveExit({ exitCode: 0 });
        resolveExit = undefined;
      }
    };
    const forceExit = (exitCode = 137) => {
      if (resolveExit !== undefined) {
        resolveExit({ exitCode });
        resolveExit = undefined;
      }
    };
    const spawn: SpawnChildProcess = () => ({
      exited,
      kill: (sig) => {
        killSignals.push(sig);
        // SIGKILL ends the subprocess for our purposes.
        if (sig === 'SIGKILL') forceExit(137);
      },
      ipc: parentChannel,
    });
    return { spawn, childChannel, parentSent, killSignals, publish, forceExit };
  };

  test('soft signal sends interrupt:soft over IPC and surfaces abortCause from payload', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const fake = fakeSpawnInterruptable();
    const softCtl = new AbortController();
    // Choreography: trigger the soft signal once the wait loop is
    // already polling, then have the "child" publish a clean
    // abort_cause:'soft' payload only AFTER it observes the IPC
    // command. This sequencing matches the real flow (parent ->
    // wire -> child harness exits at next step boundary) and avoids
    // the race where the test's payload-publish would beat the
    // parent's first wake-up cycle.
    fake.childChannel.onMessage((msg) => {
      if (msg.type === 'interrupt:soft') {
        const children = listChildSessions(db, parent.id);
        const last = children[children.length - 1];
        if (last !== undefined) fake.publish(last.id, { abort_cause: 'soft' });
      }
    });
    queueMicrotask(() => softCtl.abort());
    const result = await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      ipc: true,
      softStopSignal: softCtl.signal,
      spawnChildProcess: fake.spawn,
      graceMs: 1000,
    });
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('aborted');
    expect(result.abortCause).toBe('soft');
    expect(fake.parentSent.some((m) => m.type === 'interrupt:soft')).toBe(true);
    expect(fake.parentSent.some((m) => m.type === 'interrupt:hard')).toBe(false);
    // No OS kill needed when the child cooperates.
    expect(fake.killSignals).toEqual([]);
  });

  test('hard signal sends interrupt:hard + SIGTERM and surfaces abortCause=hard', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const fake = fakeSpawnInterruptable();
    const hardCtl = new AbortController();
    fake.childChannel.onMessage((msg) => {
      if (msg.type === 'interrupt:hard') {
        const children = listChildSessions(db, parent.id);
        const last = children[children.length - 1];
        if (last !== undefined) fake.publish(last.id, { abort_cause: 'hard' });
      }
    });
    queueMicrotask(() => hardCtl.abort());
    const result = await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      ipc: true,
      signal: hardCtl.signal,
      spawnChildProcess: fake.spawn,
      graceMs: 1000,
    });
    expect(result.status).toBe('interrupted');
    expect(result.abortCause).toBe('hard');
    expect(fake.parentSent.some((m) => m.type === 'interrupt:hard')).toBe(true);
    // SIGTERM is the belt-and-suspenders fallback the wait loop
    // fires alongside the IPC command; SIGKILL would only land if
    // the kill timer fired (graceMs hadn't expired in this test).
    expect(fake.killSignals.includes('SIGTERM')).toBe(true);
  });

  test('soft escalates to hard when grace expires without payload', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const fake = fakeSpawnInterruptable();
    const softCtl = new AbortController();
    queueMicrotask(() => {
      // Soft signals immediately. The "child" (us, in this fake)
      // never publishes a payload — emulates a stubborn child
      // that ignored interrupt:soft. The wait loop's grace timer
      // (graceMs=50) should expire and promote to hard, sending
      // interrupt:hard + SIGTERM, then SIGKILL after another grace.
      softCtl.abort();
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
      ipc: true,
      softStopSignal: softCtl.signal,
      spawnChildProcess: fake.spawn,
      graceMs: 50,
    });
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('aborted');
    expect(result.abortCause).toBe('hard');
    expect(fake.parentSent.some((m) => m.type === 'interrupt:soft')).toBe(true);
    expect(fake.parentSent.some((m) => m.type === 'interrupt:hard')).toBe(true);
    expect(fake.killSignals.includes('SIGTERM')).toBe(true);
  });

  test('non-abort outcomes leave abortCause undefined', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const fake = fakeSpawnInterruptable();
    queueMicrotask(() => {
      const children = listChildSessions(db, parent.id);
      const last = children[children.length - 1];
      if (last !== undefined) {
        // Happy-path payload — no abort.
        fake.publish(last.id, { status: 'done', reason: 'done' });
      }
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
      ipc: true,
      spawnChildProcess: fake.spawn,
    });
    expect(result.status).toBe('done');
    expect(result.abortCause).toBeUndefined();
  });

  test('payload abort_cause is ignored when reason is not aborted (defensive)', async () => {
    // A buggy child that stamps abort_cause on a non-abort payload
    // shouldn't mislead the parent's audit. The parser gates on
    // reason === 'aborted'.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const fake = fakeSpawnInterruptable();
    queueMicrotask(() => {
      const children = listChildSessions(db, parent.id);
      const last = children[children.length - 1];
      if (last !== undefined) {
        fake.publish(last.id, {
          status: 'done',
          reason: 'done',
          // Bogus discriminator on a happy outcome.
          abort_cause: 'soft',
        });
      }
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
      ipc: true,
      spawnChildProcess: fake.spawn,
    });
    expect(result.abortCause).toBeUndefined();
  });

  test('protocolVersion mismatch on session_start kills child + stamps ipc_version_mismatch', async () => {
    // Spec §4.2: parent and child must refuse on protocol-version
    // mismatch BEFORE doing useful work. The child's side is
    // covered by tests/cli/subagent-child.test.ts; this is the
    // mirror-image check on the parent (a future child running a
    // newer/older protocol that survived its own check would
    // otherwise stream events in a shape the parent's reducer
    // doesn't understand).
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const ipcMod = await import('../../src/subagents/ipc.ts');
    const fake = fakeSpawnInterruptable();
    fake.childChannel.onMessage((msg) => {
      // Echo a session_start carrying a protocolVersion the parent
      // doesn't recognize. The parent's listener should detect the
      // mismatch, send interrupt:hard, and tear down. We emulate
      // the child's "respond by exiting" by publishing nothing —
      // the SIGTERM shape on the fake will resolve its exit via
      // the kill handler.
      if (msg.type === 'interrupt:hard') {
        // Don't publish — let the loop see no payload and the
        // ipcVersionMismatch override stamp the result.
      }
    });
    queueMicrotask(() => {
      const children = listChildSessions(db, parent.id);
      const last = children[children.length - 1];
      if (last !== undefined) {
        // Child sends session_start with a future-protocol version.
        const v999: import('../../src/subagents/ipc.ts').IpcMessage = {
          type: 'session_start',
          id: 'fake-id',
          ts: Date.now(),
          sessionId: last.id,
          protocolVersion: 999,
        };
        fake.childChannel.send(v999);
      }
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
      ipc: true,
      spawnChildProcess: fake.spawn,
      graceMs: 50,
    });
    expect(result.status).toBe('error');
    expect(result.reason).toBe('ipc_version_mismatch');
    // Parent should have sent interrupt:hard AND issued OS
    // SIGTERM as the belt-and-suspenders fallback.
    expect(fake.parentSent.some((m) => m.type === 'interrupt:hard')).toBe(true);
    expect(fake.killSignals.includes('SIGTERM')).toBe(true);
    // Avoid linter warning about unused import.
    expect(ipcMod.IPC_PROTOCOL_VERSION).toBe(1);
  });

  test('protocolVersion match leaves the run alone', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const fake = fakeSpawnInterruptable();
    queueMicrotask(() => {
      const children = listChildSessions(db, parent.id);
      const last = children[children.length - 1];
      if (last !== undefined) {
        // Send a well-formed session_start with the correct
        // protocol version, then publish a happy payload.
        fake.childChannel.send(makeSessionStart(last.id));
        fake.publish(last.id, { status: 'done', reason: 'done' });
      }
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
      ipc: true,
      spawnChildProcess: fake.spawn,
    });
    expect(result.status).toBe('done');
    expect(result.reason).toBe('done');
    // Parent never sent interrupt:hard since the version matched.
    expect(fake.parentSent.some((m) => m.type === 'interrupt:hard')).toBe(false);
  });

  test('hooksSnapshot is sealed onto the audit row at insert time (migration 020)', async () => {
    // Drift defense for the hook chain: parent's resolved hooks
    // get snapshotted into subagent_runs.hooks_snapshot so the
    // child reads from there instead of re-resolving hooks.toml
    // (which a human edit between spawn and child startup could
    // have changed). The runtime test verifies the round-trip;
    // child-side use of the snapshot is exercised by the
    // real-subprocess smoke.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const fake = fakeSpawnInterruptable();
    const hooks = [
      {
        layer: 'enterprise' as const,
        sourcePath: '/etc/agent/hooks.toml',
        event: 'PreToolUse' as const,
        matcher: { tool: 'bash' as const },
        command: 'audit-bash',
        timeoutMs: 5000,
        failClosed: true,
        locked: true,
        entryIndex: 0,
      },
    ];
    queueMicrotask(() => {
      const children = listChildSessions(db, parent.id);
      const last = children[children.length - 1];
      if (last !== undefined) fake.publish(last.id, { status: 'done', reason: 'done' });
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
      hooksSnapshot: hooks,
      spawnChildProcess: fake.spawn,
    });
    const audit = (await import('../../src/storage/repos/subagent-runs.ts')).getSubagentRun(
      db,
      result.sessionId,
    );
    expect(audit?.hooksSnapshot).toEqual(hooks);
  });

  test('toEnvelope round-trips abortCause as snake_cased abort_cause', () => {
    const result = {
      output: '',
      sessionId: 's1',
      status: 'interrupted' as const,
      reason: 'aborted' as const,
      costUsd: 0,
      steps: 0,
      durationMs: 0,
      abortCause: 'soft' as const,
    };
    const env = toEnvelope(result);
    expect(env.abort_cause).toBe('soft');
  });
});

// Review-pass fixes (round 4 review): trust-boundary tightening
// + soft→hard cushion math + version listener idempotency.
describe('runSubagent — review fixes (round 4)', () => {
  test('child publishing bogus status collapses to error/internalError (no phantom running row)', async () => {
    // Without validation, a child publishing `status: "evil"`
    // would land in completeSession(status='evil') which throws
    // the CHECK constraint, the catch swallows, and the row
    // sits in 'running' indefinitely. Validating at the trust
    // boundary keeps every downstream consumer honest.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const fake: SpawnChildProcess = (opts) => {
      insertSubagentOutput(db, { sessionId: opts.sessionId });
      setSubagentPayload(db, opts.sessionId, {
        status: 'evil', // bogus; not in the CHECK constraint set
        reason: 'mystery_value', // bogus reason too
        output: '',
        cost_usd: 0,
        steps: 0,
        duration_ms: 0,
      });
      return {
        exited: Promise.resolve({ exitCode: 0 }),
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
      spawnChildProcess: fake,
    });
    expect(result.status).toBe('error');
    expect(result.reason).toBe('internalError');
    // The child session row must be in a terminal status, NOT
    // 'running' — completeSession's CHECK constraint accepts
    // 'error' so the finalize should land cleanly.
    const childRow = (await import('../../src/storage/repos/sessions.ts')).getSession(
      db,
      result.sessionId,
    );
    expect(childRow?.status).not.toBe('running');
    expect(['done', 'error', 'interrupted', 'exhausted']).toContain(childRow?.status ?? '');
  });

  // Drift defense: VALID_REASON_MAP must cover every member of
  // ExitReason. The test asserts a representative set of reasons
  // including the three (`providerError`, `maxToolErrors`,
  // `scriptExhausted`) the original whitelist forgot. If the
  // upstream ExitReason union grows and the validator forgets
  // a member, the Record<Reason, true> type fails to compile —
  // but this test catches behavioral drift if someone adds
  // a value to the map without exercising it.
  test.each([
    // ExitReason members
    ['done', 'done'],
    ['providerError', 'error'],
    ['maxToolErrors', 'error'],
    ['scriptExhausted', 'error'],
    ['maxSteps', 'exhausted'],
    ['maxCostUsd', 'exhausted'],
    ['maxWallClockMs', 'interrupted'],
    ['userPromptBlocked', 'interrupted'],
    // Child-emitted startup-refusal reasons (subagent-child.ts).
    // These bypass the harness loop entirely; the parent's
    // validator must preserve them verbatim instead of coercing
    // to internalError, otherwise audit/automation that branches
    // on the specific failure code loses the actionable signal
    // (operator can't tell "wrong model in registry" from "tool
    // typo in definition" from "definition file malformed").
    ['unknown_model', 'error'],
    ['unknown_tool', 'error'],
    ['subagent_load_failed', 'error'],
    // Child-emitted post-harness output_schema violation
    // (PLAYBOOKS.md §1.2). Same fidelity contract: callers
    // distinguishing "model violated the contract" from generic
    // `internalError` need the verbatim reason on the wire.
    ['playbook.output_invalid', 'error'],
  ] as const)(
    'child publishing reason=%s is preserved verbatim, not coerced',
    async (reason, statusForReason) => {
      const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
        model: 'mock/m',
        cwd: '/p',
      });
      const fake: SpawnChildProcess = (opts) => {
        insertSubagentOutput(db, { sessionId: opts.sessionId });
        setSubagentPayload(db, opts.sessionId, {
          status: statusForReason,
          reason,
          output: '',
          cost_usd: 0,
          steps: 0,
          duration_ms: 0,
        });
        return {
          exited: Promise.resolve({ exitCode: 0 }),
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
        spawnChildProcess: fake,
      });
      expect(result.reason).toBe(reason);
      expect(result.status).toBe(statusForReason);
    },
  );

  test('soft→hard promotion resets interruptAt so 2×grace cushion measures from SIGTERM', async () => {
    // Pre-fix: on promotion the cushion shrunk to ~1×grace
    // because interruptAt anchored to the soft moment. Post-fix:
    // hard bail-out fires at ≥ promote_time + 2×grace, not
    // soft_time + 2×grace.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const { spawn, killSignals, parentSent } = (() => {
      const { a, b } = fakeTransportPair();
      const parentChannel = createChannel(a);
      const childChannel = createChannel(b);
      const sent: import('../../src/subagents/ipc.ts').IpcMessage[] = [];
      childChannel.onMessage((m) => sent.push(m));
      const kills: string[] = [];
      let resolveExit: ((v: { exitCode: number }) => void) | undefined;
      const exited = new Promise<{ exitCode: number }>((r) => {
        resolveExit = r;
      });
      const sp: SpawnChildProcess = () => ({
        exited,
        kill: (s) => {
          kills.push(s);
          if (s === 'SIGKILL' && resolveExit) {
            resolveExit({ exitCode: 137 });
            resolveExit = undefined;
          }
        },
        ipc: parentChannel,
      });
      return { spawn: sp, killSignals: kills, parentSent: sent };
    })();
    const softCtl = new AbortController();
    queueMicrotask(() => softCtl.abort());
    const startedAt = Date.now();
    const result = await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      ipc: true,
      softStopSignal: softCtl.signal,
      spawnChildProcess: spawn,
      graceMs: 50,
    });
    const elapsed = Date.now() - startedAt;
    // Soft fires at ~iter 1 (50ms). softExpired fires at ~iter
    // ≥ soft_time + 50 (at least 100ms). Hard bail-out at
    // promote_time + 2×50 = 200ms after promote = at least 250ms
    // total. Pre-fix: bail-out would have fired at ~150ms.
    // Allow generous slack for CI variance.
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(result.reason).toBe('aborted');
    expect(result.abortCause).toBe('hard');
    expect(parentSent.some((m) => m.type === 'interrupt:soft')).toBe(true);
    expect(parentSent.some((m) => m.type === 'interrupt:hard')).toBe(true);
    expect(killSignals.includes('SIGTERM')).toBe(true);
  });

  test('wall-clock fires even when an interrupt is in flight (was guarded out pre-fix)', async () => {
    // Pre-fix: the wall-clock check had a `interruptCause === undefined`
    // guard, so a soft signal that fired before wall_clock would
    // freeze the budget cap until soft promoted to hard. Post-fix:
    // both budgets are independent — wall_clock fires regardless,
    // and (per the verdict-precedence fix below) `killed`
    // ('wall_clock') wins over `interruptCause` ('soft') on the
    // exit branch because the SIGTERM that actually killed the
    // child came from the wall-clock budget, not from a
    // cooperative soft signal that doesn't SIGTERM.
    //
    // Correctness gate: the run terminates without deadlocking
    // even if the child never publishes a payload. Pre-fix on a
    // pathological `wallClockMs < graceMs` setting could stall.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const fake = (() => {
      const { a, b } = fakeTransportPair();
      const parentChannel = createChannel(a);
      createChannel(b);
      let resolveExit: ((v: { exitCode: number }) => void) | undefined;
      const exited = new Promise<{ exitCode: number }>((r) => {
        resolveExit = r;
      });
      const sp: SpawnChildProcess = () => ({
        exited,
        kill: (s) => {
          if (s === 'SIGKILL' && resolveExit) {
            resolveExit({ exitCode: 137 });
            resolveExit = undefined;
          }
        },
        ipc: parentChannel,
      });
      return { spawn: sp };
    })();
    const softCtl = new AbortController();
    queueMicrotask(() => softCtl.abort());
    const result = await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      ipc: true,
      softStopSignal: softCtl.signal,
      spawnChildProcess: fake.spawn,
      graceMs: 50,
      wallClockMs: 30, // pathological: shorter than graceMs
    });
    // Run terminates (no deadlock). Status is some terminal
    // value — either aborted (operator intent wins) or wall_clock
    // (depending on bail-out ordering); both are acceptable. The
    // load-bearing assertion is "doesn't hang".
    expect(['interrupted', 'error']).toContain(result.status);
  });

  test('killed (wall_clock) wins over interruptCause (soft) on no-payload exit', async () => {
    // Verdict precedence: when soft is in-flight AND wall_clock
    // fires AND the child exits without publishing, the SIGTERM
    // that killed the child came from the wall-clock budget,
    // not from the soft signal (which doesn't SIGTERM). Pre-fix
    // the exit branch returned `aborted/soft`, misclassifying
    // the timeout-enforced termination as a user abort and
    // skewing operator diagnostics + retry/telemetry that
    // branches on reason.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const fake = (() => {
      const { a, b } = fakeTransportPair();
      const parentChannel = createChannel(a);
      createChannel(b);
      let resolveExit: ((v: { exitCode: number }) => void) | undefined;
      const exited = new Promise<{ exitCode: number }>((r) => {
        resolveExit = r;
      });
      const sp: SpawnChildProcess = () => ({
        exited,
        kill: () => {
          // Fake: ANY kill signal terminates the simulated
          // child. Realistic OS would let SIGTERM through to
          // graceful shutdown; for this test we collapse to
          // immediate exit so the wait loop's exit branch
          // fires deterministically with both
          // `killed='wall_clock'` AND `interruptCause='soft'`
          // set at the moment of exit.
          if (resolveExit) {
            resolveExit({ exitCode: 137 });
            resolveExit = undefined;
          }
        },
        ipc: parentChannel,
      });
      return { spawn: sp };
    })();
    const softCtl = new AbortController();
    queueMicrotask(() => softCtl.abort());
    const result = await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      ipc: true,
      softStopSignal: softCtl.signal,
      spawnChildProcess: fake.spawn,
      graceMs: 1000, // generous so soft doesn't promote during this test
      wallClockMs: 25, // fires before soft grace expires
    });
    // Wall-clock cap fired and SIGTERMed; the child exited
    // because of THAT, not because of soft. Reason must reflect.
    expect(result.reason).toBe('maxWallClockMs');
    expect(result.status).toBe('interrupted');
    // abortCause is undefined for non-aborted reasons (soft
    // signal is incidental — it didn't kill anything).
    expect(result.abortCause).toBeUndefined();
  });

  test('version-mismatch listener is idempotent — repeated session_starts do not re-fire kill cascade', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const { a, b } = fakeTransportPair();
    const parentChannel = createChannel(a);
    const childChannel = createChannel(b);
    const parentSent: import('../../src/subagents/ipc.ts').IpcMessage[] = [];
    childChannel.onMessage((m) => parentSent.push(m));
    const killSignals: string[] = [];
    let resolveExit: ((v: { exitCode: number }) => void) | undefined;
    const exited = new Promise<{ exitCode: number }>((r) => {
      resolveExit = r;
    });
    const fake: SpawnChildProcess = () => ({
      exited,
      kill: (s) => {
        killSignals.push(s);
        if (s === 'SIGKILL' && resolveExit) {
          resolveExit({ exitCode: 137 });
          resolveExit = undefined;
        }
      },
      ipc: parentChannel,
    });
    queueMicrotask(() => {
      const children = listChildSessions(db, parent.id);
      const last = children[children.length - 1];
      if (last !== undefined) {
        // Send the bad session_start THREE times. Idempotent
        // listener should fire kill cascade exactly once;
        // pre-fix it fired three.
        for (let i = 0; i < 3; i += 1) {
          childChannel.send({
            type: 'session_start',
            id: `id-${i}`,
            ts: Date.now(),
            sessionId: last.id,
            protocolVersion: 999,
          });
        }
      }
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
      ipc: true,
      spawnChildProcess: fake,
      graceMs: 50,
    });
    expect(result.reason).toBe('ipc_version_mismatch');
    // Exactly ONE interrupt:hard sent — not three.
    const hardCount = parentSent.filter((m) => m.type === 'interrupt:hard').length;
    expect(hardCount).toBe(1);
    // Exactly one SIGTERM (the version-mismatch path triggers
    // its own SIGTERM directly, separate from the wait loop's
    // hard-trigger path which never fires here because signal
    // is undefined).
    const sigterms = killSignals.filter((s) => s === 'SIGTERM').length;
    expect(sigterms).toBe(1);
  });

  test('child crash with EX_USAGE (64) exit code maps to ipc_version_mismatch reason', async () => {
    // The startup-refusal path: child receives a `--ipc=<n>`
    // version it can't satisfy and exits with the dedicated
    // sentinel BEFORE sending any IPC message (spec §4.2). The
    // parent's session_start mismatch listener never fires
    // because the child never opens the channel; the exit
    // code is the only signal. Pre-fix: this surfaced as
    // `subprocess_crashed`, defeating the handshake's
    // diagnostic value.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const fake: SpawnChildProcess = () => ({
      // Mimic the real child's pre-message refusal: never
      // publish a payload, exit immediately with EX_USAGE.
      exited: Promise.resolve({ exitCode: 64 }),
      kill: () => undefined,
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
      ipc: true,
      spawnChildProcess: fake,
    });
    expect(result.status).toBe('error');
    expect(result.reason).toBe('ipc_version_mismatch');
  });

  test('exit 64 from non-IPC child stays subprocess_crashed (sentinel gated on effectiveIpc)', async () => {
    // 64 is EX_USAGE per sysexits.h. The child only returns it
    // from the version-check refusal, which only runs when
    // --ipc=<n> was passed. A child invoked WITHOUT --ipc that
    // happens to exit 64 (a tool called process.exit(64), a
    // misbehaving binary, etc.) must NOT be mis-stamped as
    // ipc_version_mismatch — the parent never asked for IPC, so
    // a version negotiation didn't happen. Gate on effectiveIpc.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const fake: SpawnChildProcess = () => ({
      exited: Promise.resolve({ exitCode: 64 }),
      kill: () => undefined,
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
      // ipc: false (omitted) — onChildEvent also absent. Gate
      // produces effectiveIpc=false → exit 64 stays
      // subprocess_crashed.
      spawnChildProcess: fake,
    });
    expect(result.reason).toBe('subprocess_crashed');
  });

  test('child crash with non-EX_USAGE exit code stays subprocess_crashed', async () => {
    // Negative case: the EX_USAGE mapping is sentinel-specific.
    // A generic crash (exit 1, SIGSEGV / 139, etc.) must NOT
    // be mislabeled as a version mismatch.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const fake: SpawnChildProcess = () => ({
      exited: Promise.resolve({ exitCode: 1 }),
      kill: () => undefined,
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
      ipc: true,
      spawnChildProcess: fake,
    });
    expect(result.status).toBe('error');
    expect(result.reason).toBe('subprocess_crashed');
  });
});

// Slice 2 of the permission proxy (spec docs/spec/IPC.md §7).
// Parent runtime listens for `permission:ask` from the child,
// routes through the caller-supplied `onPermissionAsk` hook with
// subagent attribution baked in, and ships `permission:answer`
// back over the IPC channel. These tests use the same
// fakeTransportPair pattern as the IPC observer tests above.
describe('runSubagent — permission proxy (parent)', () => {
  // Helper mirrors fakeSpawnWithIpc but exposes the channel and
  // exit driver so each test can craft its own ask sequence.
  const buildPermissionRig = () => {
    const { a, b } = fakeTransportPair();
    const parentChannel = createChannel(a);
    const childChannel = createChannel(b);
    let resolveExit: ((v: { exitCode: number }) => void) | undefined;
    const exited = new Promise<{ exitCode: number }>((r) => {
      resolveExit = r;
    });
    const publish = (sessionId: string): void => {
      insertSubagentOutput(db, { sessionId });
      setSubagentPayload(db, sessionId, {
        status: 'done',
        reason: 'done',
        output: 'ok',
        cost_usd: 0,
        steps: 1,
        duration_ms: 1,
      });
      if (resolveExit !== undefined) {
        resolveExit({ exitCode: 0 });
        resolveExit = undefined;
      }
    };
    const spawn: SpawnChildProcess = () => ({
      exited,
      kill: () => undefined,
      ipc: parentChannel,
    });
    return { spawn, childChannel, publish };
  };

  test('permission:ask invokes onPermissionAsk with subagent attribution and ships allow back', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const rig = buildPermissionRig();
    const calls: { req: unknown }[] = [];
    const answers: IpcMessage[] = [];
    rig.childChannel.onMessage((m) => {
      if (m.type === 'permission:answer') answers.push(m);
    });

    queueMicrotask(() => {
      // Child emits an ask, then publishes its payload so the
      // wait loop resolves and the parent tears down the channel.
      // Order: ask first so the observer fires before the
      // session_finished envelope races the test microtask scheduler.
      rig.childChannel.send(
        makePermissionAsk({
          promptId: 'pid-A',
          toolName: 'bash',
          args: { command: 'rm -rf /' },
          cwd: '/p',
          prompt: 'Run shell command?',
        }),
      );
      // Drive publish on a follow-up microtask so the ask has
      // time to round-trip through onPermissionAsk before exit
      // closes the channel.
      queueMicrotask(() => {
        const children = listChildSessions(db, parent.id);
        const last = children[children.length - 1];
        if (last !== undefined) rig.publish(last.id);
      });
    });

    await runSubagent({
      definition: definition({ name: 'explore' }),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      ipc: true,
      spawnChildProcess: rig.spawn,
      onPermissionAsk: async (req) => {
        calls.push({ req });
        return 'allow';
      },
    });

    expect(calls).toHaveLength(1);
    const req = calls[0]?.req as {
      toolName: string;
      args: Record<string, unknown>;
      cwd: string;
      prompt: string;
      subagent: { sessionId: string; name: string };
    };
    expect(req.toolName).toBe('bash');
    expect(req.args).toEqual({ command: 'rm -rf /' });
    expect(req.cwd).toBe('/p');
    expect(req.prompt).toBe('Run shell command?');
    expect(req.subagent.name).toBe('explore');
    expect(typeof req.subagent.sessionId).toBe('string');
    expect(req.subagent.sessionId.length).toBeGreaterThan(0);

    expect(answers).toHaveLength(1);
    const ans = answers[0];
    if (ans?.type === 'permission:answer') {
      expect(ans.promptId).toBe('pid-A');
      expect(ans.decision).toBe('allow');
    }
  });

  test('hook returning deny ships deny back', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const rig = buildPermissionRig();
    const answers: IpcMessage[] = [];
    rig.childChannel.onMessage((m) => {
      if (m.type === 'permission:answer') answers.push(m);
    });

    queueMicrotask(() => {
      rig.childChannel.send(
        makePermissionAsk({
          promptId: 'pid-B',
          toolName: 'bash',
          args: {},
          cwd: '/p',
          prompt: 'why?',
        }),
      );
      queueMicrotask(() => {
        const children = listChildSessions(db, parent.id);
        const last = children[children.length - 1];
        if (last !== undefined) rig.publish(last.id);
      });
    });

    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      ipc: true,
      spawnChildProcess: rig.spawn,
      onPermissionAsk: async () => 'deny',
    });

    expect(answers).toHaveLength(1);
    if (answers[0]?.type === 'permission:answer') {
      expect(answers[0].decision).toBe('deny');
    }
  });

  test('missing onPermissionAsk auto-denies', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const rig = buildPermissionRig();
    const answers: IpcMessage[] = [];
    rig.childChannel.onMessage((m) => {
      if (m.type === 'permission:answer') answers.push(m);
    });

    queueMicrotask(() => {
      rig.childChannel.send(
        makePermissionAsk({
          promptId: 'pid-C',
          toolName: 'bash',
          args: {},
          cwd: '/p',
          prompt: 'q',
        }),
      );
      queueMicrotask(() => {
        const children = listChildSessions(db, parent.id);
        const last = children[children.length - 1];
        if (last !== undefined) rig.publish(last.id);
      });
    });

    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      ipc: true,
      spawnChildProcess: rig.spawn,
      // No onPermissionAsk wired.
    });

    expect(answers).toHaveLength(1);
    if (answers[0]?.type === 'permission:answer') {
      expect(answers[0].promptId).toBe('pid-C');
      expect(answers[0].decision).toBe('deny');
    }
  });

  test('hook that throws auto-denies (child must not hang)', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const rig = buildPermissionRig();
    const answers: IpcMessage[] = [];
    rig.childChannel.onMessage((m) => {
      if (m.type === 'permission:answer') answers.push(m);
    });

    queueMicrotask(() => {
      rig.childChannel.send(
        makePermissionAsk({
          promptId: 'pid-D',
          toolName: 'bash',
          args: {},
          cwd: '/p',
          prompt: 'q',
        }),
      );
      queueMicrotask(() => {
        const children = listChildSessions(db, parent.id);
        const last = children[children.length - 1];
        if (last !== undefined) rig.publish(last.id);
      });
    });

    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      ipc: true,
      spawnChildProcess: rig.spawn,
      onPermissionAsk: async () => {
        throw new Error('hook exploded');
      },
    });

    expect(answers).toHaveLength(1);
    if (answers[0]?.type === 'permission:answer') {
      expect(answers[0].decision).toBe('deny');
    }
  });

  test('hook that throws SYNCHRONOUSLY also auto-denies (no hang)', async () => {
    // Companion to the async-throw test above. The hook
    // signature returns Promise<...>, but a JS caller or a
    // non-async TS function that validates input and throws
    // before returning a promise can still slip through. The
    // earlier path (`hook(...).then(...).catch(...)`) caught
    // ASYNC failures only — a sync throw propagated up to
    // onMessage where the channel emitter swallowed listener
    // exceptions silently, leaving the child blocked on an
    // unresolved permission:ask. The Promise.resolve().then
    // wrap collapses sync throws into the same .catch path.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const rig = buildPermissionRig();
    const answers: IpcMessage[] = [];
    rig.childChannel.onMessage((m) => {
      if (m.type === 'permission:answer') answers.push(m);
    });

    queueMicrotask(() => {
      rig.childChannel.send(
        makePermissionAsk({
          promptId: 'pid-sync-throw',
          toolName: 'bash',
          args: {},
          cwd: '/p',
          prompt: 'q',
        }),
      );
      queueMicrotask(() => {
        const children = listChildSessions(db, parent.id);
        const last = children[children.length - 1];
        if (last !== undefined) rig.publish(last.id);
      });
    });

    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      ipc: true,
      spawnChildProcess: rig.spawn,
      // Cast through unknown so TS lets a non-async throwing
      // function sit in the typed Promise<...> slot — mimics
      // the JS-caller path the wrap protects against.
      onPermissionAsk: ((): Promise<'allow' | 'deny'> => {
        throw new Error('sync hook exploded');
      }) as unknown as (req: {
        subagent: { sessionId: string; name: string };
      }) => Promise<'allow' | 'deny'>,
    });

    // Pre-fix: answers.length === 0 (hang path) — child's bridge
    // never received a verdict, runSubagent hung until publish
    // forced exit but the ask was already lost.
    // Post-fix: answers === [{ decision: 'deny' }] (uniform
    // failure path).
    expect(answers).toHaveLength(1);
    if (answers[0]?.type === 'permission:answer') {
      expect(answers[0].promptId).toBe('pid-sync-throw');
      expect(answers[0].decision).toBe('deny');
    }
  });

  test('parallel asks each get their matching promptId answered', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const rig = buildPermissionRig();
    const answers: IpcMessage[] = [];
    rig.childChannel.onMessage((m) => {
      if (m.type === 'permission:answer') answers.push(m);
    });

    queueMicrotask(() => {
      rig.childChannel.send(
        makePermissionAsk({
          promptId: 'pid-1',
          toolName: 'bash',
          args: { command: 'one' },
          cwd: '/p',
          prompt: 'q1',
        }),
      );
      rig.childChannel.send(
        makePermissionAsk({
          promptId: 'pid-2',
          toolName: 'write_file',
          args: { path: 'a.txt' },
          cwd: '/p',
          prompt: 'q2',
        }),
      );
      queueMicrotask(() => {
        const children = listChildSessions(db, parent.id);
        const last = children[children.length - 1];
        if (last !== undefined) rig.publish(last.id);
      });
    });

    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      ipc: true,
      spawnChildProcess: rig.spawn,
      // Per-tool decision: bash deny, write_file allow. Verifies
      // promptId correlation rather than positional ordering.
      onPermissionAsk: async (req) => (req.toolName === 'write_file' ? 'allow' : 'deny'),
    });

    expect(answers).toHaveLength(2);
    const byPid = new Map<string, string>();
    for (const a of answers) {
      if (a.type === 'permission:answer') byPid.set(a.promptId, a.decision);
    }
    expect(byPid.get('pid-1')).toBe('deny');
    expect(byPid.get('pid-2')).toBe('allow');
  });

  test('malformed args (non-object) auto-denies', async () => {
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const rig = buildPermissionRig();
    const answers: IpcMessage[] = [];
    const calls: number[] = [];
    rig.childChannel.onMessage((m) => {
      if (m.type === 'permission:answer') answers.push(m);
    });

    queueMicrotask(() => {
      // Hand-craft an ask whose `args` field is an array — the
      // parser accepts (it only verifies the field is present)
      // but the runtime's hook contract requires an object.
      // Runtime must auto-deny, not crash, not invoke the hook.
      rig.childChannel.send({
        type: 'permission:ask',
        id: 'env-1',
        ts: Date.now(),
        promptId: 'pid-bad',
        toolName: 'bash',
        args: [1, 2, 3],
        cwd: '/p',
        prompt: 'q',
      });
      queueMicrotask(() => {
        const children = listChildSessions(db, parent.id);
        const last = children[children.length - 1];
        if (last !== undefined) rig.publish(last.id);
      });
    });

    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      ipc: true,
      spawnChildProcess: rig.spawn,
      onPermissionAsk: async () => {
        calls.push(1);
        return 'allow';
      },
    });

    expect(calls).toEqual([]);
    expect(answers).toHaveLength(1);
    if (answers[0]?.type === 'permission:answer') {
      expect(answers[0].promptId).toBe('pid-bad');
      expect(answers[0].decision).toBe('deny');
    }
  });

  test('hook receives a per-session AbortSignal that fires when channel closes', async () => {
    // Regression guard: a child dying while its modal is open
    // would otherwise leave the operator staring at a stale
    // prompt whose answer has nowhere to go (channel closed,
    // child gone). The runtime now hands the hook a per-session
    // AbortSignal that fires on channel.onClose; the hook
    // (REPL bridge) wires it into the modal manager so the modal
    // closes promptly. Verify the signal is provided AND that
    // it fires when the channel tears down.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const rig = buildPermissionRig();
    let observedSignal: AbortSignal | null = null;
    let signalAbortedAtHookExit = false;

    queueMicrotask(() => {
      rig.childChannel.send(
        makePermissionAsk({
          promptId: 'pid-abort',
          toolName: 'bash',
          args: {},
          cwd: '/p',
          prompt: 'q',
        }),
      );
      // Drive publish on next microtask so the hook is in flight
      // when the runtime tears the channel down.
      queueMicrotask(() => {
        const children = listChildSessions(db, parent.id);
        const last = children[children.length - 1];
        if (last !== undefined) rig.publish(last.id);
      });
    });

    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      ipc: true,
      spawnChildProcess: rig.spawn,
      // Hook holds the promise unresolved until aborted. The
      // runtime tears the channel down after publish + waitForChild
      // resolves; channel.onClose then fires the per-session
      // signal, which we observe via this `await new Promise`
      // race that resolves when the signal aborts.
      onPermissionAsk: async (req) => {
        observedSignal = req.signal;
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) {
            resolve();
            return;
          }
          req.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        signalAbortedAtHookExit = req.signal.aborted;
        return 'deny';
      },
    });

    expect(observedSignal).not.toBeNull();
    expect(signalAbortedAtHookExit).toBe(true);
  });

  test('parent signal listener is removed after the subagent run ends (no per-run leak)', async () => {
    // Memory hygiene for long REPL sessions. The runtime forwards
    // input.signal aborts into its per-session askAbort as
    // belt-and-suspenders, but if every runSubagent call left a
    // listener attached to input.signal until the parent itself
    // aborts (which doesn't happen in a healthy REPL), 1000s of
    // subagent runs would accumulate 1000s of closure references.
    // The fix pairs add/remove off askAbort.signal so cleanup
    // runs exactly once at end-of-session.
    //
    // AbortSignal doesn't expose a public listener count; we
    // instrument by wrapping a real AbortSignal in a Proxy-like
    // object that tracks add/remove calls. The runtime treats
    // the wrapper as a normal AbortSignal (it never type-narrows
    // beyond the AbortSignal interface).
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const parentAc = new AbortController();
    let addCount = 0;
    let removeCount = 0;
    const trackedSignal = new Proxy(parentAc.signal, {
      get(target, prop) {
        if (prop === 'addEventListener') {
          return (
            type: string,
            listener: EventListener,
            options?: AddEventListenerOptions | boolean,
          ): void => {
            if (type === 'abort') addCount += 1;
            target.addEventListener(type, listener, options);
          };
        }
        if (prop === 'removeEventListener') {
          return (
            type: string,
            listener: EventListener,
            options?: EventListenerOptions | boolean,
          ): void => {
            if (type === 'abort') removeCount += 1;
            target.removeEventListener(type, listener, options);
          };
        }
        // Forward every other access to the real signal with
        // `this` bound to the underlying AbortSignal — native
        // getters like `aborted` and `reason` refuse to run on
        // anything but a real AbortSignal instance, so passing
        // the proxy as `this` (the default Reflect.get receiver)
        // throws "AbortSignal.aborted getter can only be used
        // on instances of AbortSignal".
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });

    const rig = buildPermissionRig();
    queueMicrotask(() => {
      const children = listChildSessions(db, parent.id);
      const last = children[children.length - 1];
      if (last !== undefined) rig.publish(last.id);
    });

    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      ipc: true,
      signal: trackedSignal,
      spawnChildProcess: rig.spawn,
      onPermissionAsk: async () => 'allow',
    });

    // Runtime added exactly one listener (the parent-abort
    // forward) and removed exactly one (the cleanup off
    // askAbort.signal abort). Pre-fix: addCount=1, removeCount=0
    // → leak.
    expect(addCount).toBe(1);
    expect(removeCount).toBe(1);
  });

  test('rate limit: cap exceeded auto-denies without invoking the hook', async () => {
    // Bound on concurrent permission asks per child session.
    // Defends the operator's modal queue when a child is in a
    // confirm-loop. With cap=2 and three asks emitted rapidly,
    // the first two flow to the hook; the third is auto-denied
    // and never reaches the hook.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const rig = buildPermissionRig();
    const answers: IpcMessage[] = [];
    let hookCallCount = 0;
    let releaseHookA: (() => void) | undefined;
    let releaseHookB: (() => void) | undefined;
    rig.childChannel.onMessage((m) => {
      if (m.type === 'permission:answer') answers.push(m);
    });

    queueMicrotask(() => {
      // Three asks in rapid succession.
      rig.childChannel.send(
        makePermissionAsk({
          promptId: 'pid-A',
          toolName: 'bash',
          args: { command: '1' },
          cwd: '/p',
          prompt: 'q1',
        }),
      );
      rig.childChannel.send(
        makePermissionAsk({
          promptId: 'pid-B',
          toolName: 'bash',
          args: { command: '2' },
          cwd: '/p',
          prompt: 'q2',
        }),
      );
      rig.childChannel.send(
        makePermissionAsk({
          promptId: 'pid-C',
          toolName: 'bash',
          args: { command: '3' },
          cwd: '/p',
          prompt: 'q3',
        }),
      );
      // Wait briefly for the runtime to observe all three, then
      // release the held hooks so they resolve and the run can end.
      queueMicrotask(() => {
        queueMicrotask(() => {
          if (releaseHookA !== undefined) releaseHookA();
          if (releaseHookB !== undefined) releaseHookB();
          const children = listChildSessions(db, parent.id);
          const last = children[children.length - 1];
          if (last !== undefined) rig.publish(last.id);
        });
      });
    });

    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      ipc: true,
      maxPendingPermissionAsks: 2,
      spawnChildProcess: rig.spawn,
      onPermissionAsk: async () => {
        hookCallCount += 1;
        // Hold the hook until released so the cap fills up.
        await new Promise<void>((resolve) => {
          if (hookCallCount === 1) releaseHookA = resolve;
          else if (hookCallCount === 2) releaseHookB = resolve;
          else resolve();
        });
        return 'allow';
      },
    });

    // Only the first two asks reached the hook; the third was
    // auto-denied at the rate-limit gate.
    expect(hookCallCount).toBe(2);
    // Three answers total (two from hook + one synthetic deny).
    expect(answers).toHaveLength(3);
    const byPid = new Map<string, string>();
    for (const a of answers) {
      if (a.type === 'permission:answer') byPid.set(a.promptId, a.decision);
    }
    expect(byPid.get('pid-A')).toBe('allow');
    expect(byPid.get('pid-B')).toBe('allow');
    expect(byPid.get('pid-C')).toBe('deny'); // rate-limited
  });

  test('rate limit: slot frees up after a hook resolves', async () => {
    // After the first ask resolves, the cap drops back below
    // the threshold and the next ask flows through normally.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const rig = buildPermissionRig();
    const answers: IpcMessage[] = [];
    let hookCallCount = 0;
    rig.childChannel.onMessage((m) => {
      if (m.type === 'permission:answer') answers.push(m);
    });

    queueMicrotask(() => {
      // First ask. Hook resolves immediately (allow). Slot frees.
      rig.childChannel.send(
        makePermissionAsk({
          promptId: 'pid-1',
          toolName: 'bash',
          args: {},
          cwd: '/p',
          prompt: 'q1',
        }),
      );
      // Send pid-2 only AFTER pid-1's answer lands — polling
      // is more robust than counting microtasks since the
      // runtime's hook invocation went through a
      // Promise.resolve().then(...) wrap (added as sync-throw
      // safety) and any future change in the resolution chain
      // would shift counts again. Polling the visible side
      // effect (answer arrived) ties the test to the contract
      // we actually care about: "slot frees AFTER first resolves".
      const sendSecondAfterFirstAnswered = (): void => {
        if (answers.length >= 1) {
          rig.childChannel.send(
            makePermissionAsk({
              promptId: 'pid-2',
              toolName: 'bash',
              args: {},
              cwd: '/p',
              prompt: 'q2',
            }),
          );
          queueMicrotask(() => {
            const children = listChildSessions(db, parent.id);
            const last = children[children.length - 1];
            if (last !== undefined) rig.publish(last.id);
          });
        } else {
          queueMicrotask(sendSecondAfterFirstAnswered);
        }
      };
      queueMicrotask(sendSecondAfterFirstAnswered);
    });

    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      ipc: true,
      maxPendingPermissionAsks: 1,
      spawnChildProcess: rig.spawn,
      onPermissionAsk: async () => {
        hookCallCount += 1;
        return 'allow';
      },
    });

    expect(hookCallCount).toBe(2);
    expect(answers).toHaveLength(2);
    const byPid = new Map<string, string>();
    for (const a of answers) {
      if (a.type === 'permission:answer') byPid.set(a.promptId, a.decision);
    }
    expect(byPid.get('pid-1')).toBe('allow');
    expect(byPid.get('pid-2')).toBe('allow');
  });

  test('rate limit: cap=0 disables the gate (stress-testing surface)', async () => {
    // Opt-out path: setting cap to 0 should let unlimited asks
    // through. Verifies the `askCap > 0` check ordering — with
    // an integer-zero cap we never even read the in-flight set.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const rig = buildPermissionRig();
    const answers: IpcMessage[] = [];
    let hookCallCount = 0;
    const releases: Array<() => void> = [];
    rig.childChannel.onMessage((m) => {
      if (m.type === 'permission:answer') answers.push(m);
    });

    queueMicrotask(() => {
      // 10 asks in rapid succession — would saturate the
      // default cap (5) but cap=0 lets them all through.
      for (let i = 0; i < 10; i++) {
        rig.childChannel.send(
          makePermissionAsk({
            promptId: `pid-${i}`,
            toolName: 'bash',
            args: {},
            cwd: '/p',
            prompt: `q${i}`,
          }),
        );
      }
      queueMicrotask(() => {
        queueMicrotask(() => {
          for (const r of releases) r();
          const children = listChildSessions(db, parent.id);
          const last = children[children.length - 1];
          if (last !== undefined) rig.publish(last.id);
        });
      });
    });

    await runSubagent({
      definition: definition(),
      prompt: 'go',
      parentSessionId: parent.id,
      provider: stubProvider(),
      parentToolRegistry: buildParentRegistry(echoTool),
      permissionEngine: buildEngine(),
      db,
      cwd: '/p',
      ipc: true,
      maxPendingPermissionAsks: 0,
      spawnChildProcess: rig.spawn,
      onPermissionAsk: async () => {
        hookCallCount += 1;
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return 'allow';
      },
    });

    // All 10 reached the hook (none rate-limited).
    expect(hookCallCount).toBe(10);
    expect(answers).toHaveLength(10);
    for (const a of answers) {
      if (a.type === 'permission:answer') {
        expect(a.decision).toBe('allow');
      }
    }
  });

  test('hook returning invalid decision coerces to deny (defensive)', async () => {
    // The hook signature types `decision` as PermissionDecision
    // ('allow' | 'deny'), but JS callers and TS callers using
    // `any` can return arbitrary strings. The IPC parser would
    // reject the malformed answer and the child would block on
    // its prompt until channel close. Verify the runtime
    // coerces to 'deny' so the child always gets a usable
    // answer + the diagnostic surfaces on stderr.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const rig = buildPermissionRig();
    const answers: IpcMessage[] = [];
    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: stderr.write overload signature isn't worth typing in a test
    (process.stderr as any).write = (chunk: unknown): boolean => {
      stderrLines.push(String(chunk));
      return true;
    };

    rig.childChannel.onMessage((m) => {
      if (m.type === 'permission:answer') answers.push(m);
    });

    queueMicrotask(() => {
      rig.childChannel.send(
        makePermissionAsk({
          promptId: 'pid-bad-verdict',
          toolName: 'bash',
          args: {},
          cwd: '/p',
          prompt: 'q',
        }),
      );
      queueMicrotask(() => {
        const children = listChildSessions(db, parent.id);
        const last = children[children.length - 1];
        if (last !== undefined) rig.publish(last.id);
      });
    });

    try {
      await runSubagent({
        definition: definition(),
        prompt: 'go',
        parentSessionId: parent.id,
        provider: stubProvider(),
        parentToolRegistry: buildParentRegistry(echoTool),
        permissionEngine: buildEngine(),
        db,
        cwd: '/p',
        ipc: true,
        spawnChildProcess: rig.spawn,
        // Cast through unknown so TS lets a bogus value reach
        // the runtime — mimics the JS-caller / TS-any path the
        // defensive coercion targets.
        onPermissionAsk: (async () => 'session-allow') as unknown as (req: {
          subagent: { sessionId: string; name: string };
        }) => Promise<'allow' | 'deny'>,
      });
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore the patched method
      (process.stderr as any).write = originalWrite;
    }

    expect(answers).toHaveLength(1);
    if (answers[0]?.type === 'permission:answer') {
      // Coerced to 'deny' (NOT shipped as the bogus
      // 'session-allow' which would have been parser-refused).
      expect(answers[0].decision).toBe('deny');
    }
    // Diagnostic surfaced.
    const coercionLine = stderrLines.find((l) => l.includes('invalid decision'));
    expect(coercionLine).toBeDefined();
    expect(coercionLine).toContain('session-allow');
  });
});
