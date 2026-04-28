import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedArgs } from '../../src/cli/args.ts';
import type { OutputRenderer } from '../../src/cli/output/types.ts';
import { exitCodeFor, run } from '../../src/cli/run.ts';
import type { HarnessEvent, HarnessResult } from '../../src/harness/index.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';

const baseArgs = (overrides: Partial<ParsedArgs> = {}): ParsedArgs => ({
  prompt: 'hi',
  json: false,
  version: false,
  help: false,
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

describe('exitCodeFor', () => {
  test('done → 0', () => {
    expect(
      exitCodeFor({ status: 'done', reason: 'done', sessionId: 's', steps: 1, durationMs: 1 }),
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
});
