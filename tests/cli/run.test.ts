import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedArgs } from '../../src/cli/args.ts';
import type { OutputRenderer } from '../../src/cli/output/types.ts';
import { exitCodeFor, run } from '../../src/cli/run.ts';
import type { HarnessEvent, HarnessResult } from '../../src/harness/index.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';
import { closeDb, migrate, openDb } from '../../src/storage/index.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

const baseArgs = (overrides: Partial<ParsedArgs> = {}): ParsedArgs => ({
  prompt: 'hi',
  json: false,
  version: false,
  help: false,
  listSessions: false,
  includeSubagents: false,
  explainPermissions: false,
  yes: false,
  ...overrides,
});

const recordingRenderer = (): { renderer: OutputRenderer; events: HarnessEvent[] } => {
  const events: HarnessEvent[] = [];
  return {
    events,
    renderer: {
      onEvent: (e) => events.push(e),
      flush: () => undefined,
    },
  };
};

interface ScriptedStep {
  text?: string;
  tool_uses?: { id: string; name: string; input: Record<string, unknown> }[];
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
    reason: step.tool_uses?.length ? 'tool_use' : 'end_turn',
  };
};

const mockProvider = (script: ScriptedStep[]): Provider => {
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
      context_window: 1000,
      output_max_tokens: 100,
      cost_per_1k_input: 0,
      cost_per_1k_output: 0,
      notes: [],
    },
    async *generate() {
      const step = script[i++];
      if (step === undefined) throw new Error('mock script exhausted');
      for (const ev of replayStep(step)) yield ev;
    },
    generateConstrained: () => Promise.reject(new Error('n/a')),
    countTokens: () => Promise.resolve(0),
  };
};

let workdir: string;
let dbPath: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-run-'));
  dbPath = join(workdir, 'sessions.db');
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('run dispatch — --explain-permissions short-circuit', () => {
  test('explainPermissions=true → exit 0, no DB created, policy printed to stdout', async () => {
    // Pins the seam between args parsing and run() dispatch:
    // `args.explainPermissions === true` must trigger the
    // explain-permissions branch BEFORE bootstrap / DB / provider
    // setup. Without this test, accidentally moving the case
    // below the bootstrap block (or forgetting the case
    // entirely) would still pass typecheck and the unit-level
    // explain-permissions tests, but break the actual CLI.
    const errCaptured: string[] = [];
    const stdoutCaptured: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => {
      stdoutCaptured.push(s);
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await run({
        args: baseArgs({ explainPermissions: true, prompt: '' }),
        bootstrapOverride: { cwd: workdir, dbPath },
        errSink: (s) => errCaptured.push(s),
      });
      expect(code).toBe(0);
      const stdout = stdoutCaptured.join('');
      // Reached the renderer (it prints "policy: mode=..." for
      // every non-error path).
      expect(stdout).toContain('policy: mode=');
      expect(stdout).toContain('layers:');
      // Canary for "did NOT bootstrap": dbPath stayed unwritten.
      // Bootstrap eagerly migrates a DB at this path; the
      // explain-permissions short-circuit doesn't.
      expect(existsSync(dbPath)).toBe(false);
      // No errors on the happy path (empty cwd → default policy).
      expect(errCaptured.join('')).toBe('');
    } finally {
      process.stdout.write = origWrite;
    }
  });
});

describe('exitCodeFor', () => {
  test('done → 0', () => {
    expect(
      exitCodeFor({
        status: 'done',
        reason: 'done',
        sessionId: 's',
        steps: 1,
        durationMs: 1,
        usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
        costUsd: 0,
        usageComplete: true,
      }),
    ).toBe(0);
  });
  test('exhausted → 2', () => {
    expect(
      exitCodeFor({
        status: 'exhausted',
        reason: 'maxSteps',
        sessionId: 's',
        steps: 1,
        durationMs: 1,
        usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
        costUsd: 0,
        usageComplete: true,
      }),
    ).toBe(2);
  });
  test('interrupted → 130', () => {
    expect(
      exitCodeFor({
        status: 'interrupted',
        reason: 'aborted',
        sessionId: 's',
        steps: 1,
        durationMs: 1,
        usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
        costUsd: 0,
        usageComplete: true,
      }),
    ).toBe(130);
  });
  test('error → 1', () => {
    expect(
      exitCodeFor({
        status: 'error',
        reason: 'maxToolErrors',
        sessionId: 's',
        steps: 1,
        durationMs: 1,
        usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
        costUsd: 0,
        usageComplete: true,
      }),
    ).toBe(1);
  });
});

describe('run end-to-end with mock provider', () => {
  test('happy path returns 0 and renderer sees session bracketing events', async () => {
    const { renderer, events } = recordingRenderer();
    const ctrl = new AbortController();
    const code = await run({
      args: baseArgs(),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'hello' }]),
        dbPath,
        cwd: workdir,
      },
      signal: ctrl.signal,
      rendererOverride: renderer,
    });
    expect(code).toBe(0);
    expect(events[0]?.type).toBe('session_start');
    expect(events[events.length - 1]?.type).toBe('session_finished');
    const finished = events[events.length - 1] as {
      type: 'session_finished';
      result: HarnessResult;
    };
    expect(finished.result.status).toBe('done');
  });

  test('cross-cwd literal --resume + --resume-mode summary is rejected BEFORE any work', async () => {
    // Regression: full/summary pre-hydrate (summary compacts → sends history to
    // the provider + writes cost/audit) BEFORE runAgent's cwd guard. A literal
    // id from ANOTHER project must be rejected at resolution, not after that
    // work leaked. Seed a session owned by a different cwd, then resume it from
    // `workdir` with summary mode.
    const seed = openDb(dbPath);
    migrate(seed);
    createSession(seed, { id: 'foreign-sess', model: 'mock/m', cwd: '/some/other/project' });
    closeDb(seed);

    const { renderer, events } = recordingRenderer();
    const errLines: string[] = [];
    const code = await run({
      args: baseArgs({ resume: 'foreign-sess', resumeMode: 'summary', prompt: 'go' }),
      bootstrapOverride: {
        // If this provider were ever reached, the leak already happened.
        providerOverride: mockProvider([{ text: 'must never run' }]),
        dbPath,
        cwd: workdir,
      },
      signal: new AbortController().signal,
      rendererOverride: renderer,
      errSink: (s) => errLines.push(s),
    });
    expect(code).toBe(1);
    expect(errLines.join('')).toContain('belongs to a different project');
    // Rejected before bootstrap → no harness work, no compaction, no provider.
    expect(events).toHaveLength(0);
  });

  test('budget exhaustion returns exit code 2', async () => {
    const { renderer } = recordingRenderer();
    const ctrl = new AbortController();
    // Mock keeps emitting tool_use forever; --max-steps caps at 2.
    const stepFactory = (i: number): ScriptedStep => ({
      tool_uses: [{ id: `tu${i}`, name: 'unknown_tool', input: { i } }],
    });
    const code = await run({
      args: baseArgs({ maxSteps: 2 }),
      bootstrapOverride: {
        providerOverride: mockProvider(Array.from({ length: 5 }, (_, i) => stepFactory(i))),
        dbPath,
        cwd: workdir,
      },
      signal: ctrl.signal,
      rendererOverride: renderer,
    });
    expect(code).toBe(2);
  });

  test('pre-aborted signal returns exit code 130', async () => {
    const { renderer } = recordingRenderer();
    const ctrl = new AbortController();
    ctrl.abort();
    const code = await run({
      args: baseArgs(),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'never reached' }]),
        dbPath,
        cwd: workdir,
      },
      signal: ctrl.signal,
      rendererOverride: renderer,
    });
    expect(code).toBe(130);
  });

  test('bootstrap failure (unknown model) returns 1 and prints to errSink', async () => {
    const { renderer } = recordingRenderer();
    const errLines: string[] = [];
    const code = await run({
      args: baseArgs({ model: 'fake/nope' }),
      bootstrapOverride: { dbPath, cwd: workdir },
      signal: new AbortController().signal,
      rendererOverride: renderer,
      errSink: (s) => errLines.push(s),
    });
    expect(code).toBe(1);
    expect(errLines.join('')).toContain('forja:');
    expect(errLines.join('')).toContain('unknown model');
  });

  test('subagent shadow surfaces a one-line warning on stderr (C3)', async () => {
    // Regression: bootstrap discovers definitions from user + project
    // dirs and computes `shadows` for cross-scope name collisions.
    // Prior behavior was to compute and DISCARD; authors editing the
    // user version while a project version exists would never see
    // their tweak take effect. Run-level wiring must echo each
    // shadow on stderr (gated on non-JSON for stdout purity).
    const userAgents = join(workdir, 'user-agents');
    const projectAgents = join(workdir, 'project', '.forja', 'playbooks');
    mkdirSync(userAgents, { recursive: true });
    mkdirSync(projectAgents, { recursive: true });
    const def = (name: string, desc: string) =>
      `---\nname: ${name}\ndescription: ${desc}\ntools: []\nbudget:\n  max_steps: 1\n  max_cost_usd: 0.01\n---\nbody`;
    writeFileSync(join(userAgents, 'explore.md'), def('explore', 'user version'));
    writeFileSync(join(projectAgents, 'explore.md'), def('explore', 'project version'));

    const errLines: string[] = [];
    await run({
      args: baseArgs(),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'ok' }]),
        dbPath,
        cwd: join(workdir, 'project'),
        userAgentsDir: userAgents,
        projectAgentsDir: projectAgents,
      },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
      errSink: (s) => errLines.push(s),
    });
    const out = errLines.join('');
    expect(out).toContain("subagent 'explore'");
    expect(out).toContain('(user)');
    expect(out).toContain('(project)');
    expect(out).toContain('shadowed by');
  });

  test('subagent shadow warning is suppressed in --json mode', async () => {
    // NDJSON consumers expect a clean stream on stdout; we keep
    // human admin lines off stderr too in JSON mode so any pipeline
    // that captures both streams stays parseable.
    const userAgents = join(workdir, 'user-agents');
    const projectAgents = join(workdir, 'project', '.forja', 'playbooks');
    mkdirSync(userAgents, { recursive: true });
    mkdirSync(projectAgents, { recursive: true });
    const def = (name: string) =>
      `---\nname: ${name}\ndescription: x\ntools: []\nbudget:\n  max_steps: 1\n  max_cost_usd: 0.01\n---\nbody`;
    writeFileSync(join(userAgents, 'explore.md'), def('explore'));
    writeFileSync(join(projectAgents, 'explore.md'), def('explore'));

    const errLines: string[] = [];
    await run({
      args: baseArgs({ json: true }),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'ok' }]),
        dbPath,
        cwd: join(workdir, 'project'),
        userAgentsDir: userAgents,
        projectAgentsDir: projectAgents,
      },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
      errSink: (s) => errLines.push(s),
    });
    const out = errLines.join('');
    expect(out).not.toContain('shadowed by');
  });

  test('renderer.flush is called after a successful run', async () => {
    let flushed = false;
    const renderer: OutputRenderer = {
      onEvent: () => undefined,
      flush: () => {
        flushed = true;
      },
    };
    await run({
      args: baseArgs(),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'ok' }]),
        dbPath,
        cwd: workdir,
      },
      signal: new AbortController().signal,
      rendererOverride: renderer,
    });
    expect(flushed).toBe(true);
  });

  test('--max-steps cap is enforced (exhausted exit code)', async () => {
    // Sanity: a small maxSteps caps exploration, returning
    // exhausted/maxSteps as expected.
    const { renderer } = recordingRenderer();
    const stepFactory = (i: number): ScriptedStep => ({
      tool_uses: [{ id: `tu${i}`, name: 'unknown_tool', input: { i } }],
    });
    const code = await run({
      args: baseArgs({ maxSteps: 2 }),
      bootstrapOverride: {
        providerOverride: mockProvider(Array.from({ length: 5 }, (_, i) => stepFactory(i))),
        dbPath,
        cwd: workdir,
      },
      signal: new AbortController().signal,
      rendererOverride: renderer,
    });
    expect(code).toBe(2); // exhausted exit code
  });

  test('hook config warnings are surfaced to errSink before the run starts', async () => {
    // Project-level hooks.toml with one valid entry + one invalid
    // (bad event name). Loader drops the invalid one and emits a
    // warning; run() must surface it on stderr so the operator
    // sees their config dropped silently otherwise.
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(path.join(workdir, '.forja'), { recursive: true });
    fs.writeFileSync(
      path.join(workdir, '.forja/hooks.toml'),
      [
        '[[hooks]]',
        'event = "Stop"',
        'command = "true"',
        '',
        '[[hooks]]',
        'event = "TotallyNotAnEvent"',
        'command = "true"',
        '',
      ].join('\n'),
    );

    const { renderer } = recordingRenderer();
    const errLines: string[] = [];
    await run({
      args: baseArgs(),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'ok' }]),
        dbPath,
        cwd: workdir,
      },
      signal: new AbortController().signal,
      rendererOverride: renderer,
      errSink: (s) => errLines.push(s),
    });
    const all = errLines.join('');
    expect(all).toContain('hook');
    expect(all).toContain('TotallyNotAnEvent');
    expect(all).toContain('project');
  });

  test('hook warnings suppressed in JSON mode (NDJSON contract)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(path.join(workdir, '.forja'), { recursive: true });
    fs.writeFileSync(
      path.join(workdir, '.forja/hooks.toml'),
      ['[[hooks]]', 'event = "BadEvent"', 'command = "true"', ''].join('\n'),
    );

    const { renderer } = recordingRenderer();
    const errLines: string[] = [];
    await run({
      args: baseArgs({ json: true }),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'ok' }]),
        dbPath,
        cwd: workdir,
      },
      signal: new AbortController().signal,
      rendererOverride: renderer,
      errSink: (s) => errLines.push(s),
    });
    // No `forja: ... hook ...` line in JSON mode (admin warnings
    // are suppressed so NDJSON consumers parsing stderr don't see
    // free-form text mixed with JSON lines).
    expect(errLines.join('')).not.toContain('hook');
  });

  test('lock conflicts are surfaced to errSink before the run starts', async () => {
    // Stage a layered policy where enterprise locks tools.bash and
    // a project file tries to override it. run() should print one
    // warning per conflict on errSink so the operator sees the
    // signal — silently swallowing it would defeat the locked
    // semantic.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const entFile = path.join(workdir, 'ent.yaml');
    fs.writeFileSync(entFile, 'tools:\n  bash:\n    deny:\n      - "rm *"\n    locked: true\n');
    fs.mkdirSync(path.join(workdir, '.forja'), { recursive: true });
    fs.writeFileSync(
      path.join(workdir, '.forja/permissions.yaml'),
      'tools:\n  bash:\n    allow:\n      - "ls *"\n',
    );

    const { renderer } = recordingRenderer();
    const errLines: string[] = [];
    await run({
      args: baseArgs(),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'ok' }]),
        dbPath,
        cwd: workdir,
        enterprisePolicyPath: entFile,
        userPolicyPath: null,
      },
      signal: new AbortController().signal,
      rendererOverride: renderer,
      errSink: (s) => errLines.push(s),
    });
    const all = errLines.join('');
    expect(all).toContain('tools.bash');
    expect(all).toContain('locked by enterprise');
    expect(all).toContain('project');
  });
});
