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
  updateSubagentHeartbeat,
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
    // would catch it eventually (10min), but heartbeat
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

  test('parent forwards planMode=true to spawn opts', async () => {
    // Defense-in-depth path: a programmatic caller invoking
    // runSubagent with planMode:true (or a future regression
    // re-enabling task() under plan mode) MUST see the child
    // harness gate writing tools too. Capture the spawn opts
    // and assert the flag round-tripped.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    const captured: { planMode?: boolean } = {};
    const recordingSpawn: SpawnChildProcess = (opts) => {
      if (opts.planMode === true) captured.planMode = opts.planMode;
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
      planMode: true,
      spawnChildProcess: recordingSpawn,
    });
    expect(captured.planMode).toBe(true);
  });

  test('planMode stays absent in spawn opts when input omits it', async () => {
    // Default behavior: omitting planMode at the input should
    // omit the spawn-opts key — same shape as temperature.
    // Locks the absent-by-default semantics so a future
    // regression doesn't silently inject planMode=true.
    const parent = (await import('../../src/storage/repos/sessions.ts')).createSession(db, {
      model: 'mock/m',
      cwd: '/p',
    });
    let observedKey = false;
    const recordingSpawn: SpawnChildProcess = (opts) => {
      observedKey = 'planMode' in opts;
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
      // no planMode
      spawnChildProcess: recordingSpawn,
    });
    expect(observedKey).toBe(false);
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
