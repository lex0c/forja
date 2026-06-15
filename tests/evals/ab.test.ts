import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ArmStats,
  aggregateArm,
  deltaOf,
  flagForModel,
  parseArgs,
  runAbComparison,
  verdictLine,
} from '../../src/evals/ab.ts';
import type { EvalCase, EvalCaseResult } from '../../src/evals/types.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';

const runResult = (over: Partial<EvalCaseResult>): EvalCaseResult => ({
  name: 'c',
  sourcePath: '/tmp/c.yaml',
  passed: false,
  durationMs: 100,
  costUsd: 0.01,
  steps: 5,
  usageComplete: true,
  expectations: [],
  ...over,
});

describe('flagForModel', () => {
  test('maps anthropic + openai families to their replay flags', () => {
    expect(flagForModel('anthropic/claude-opus-4-8')).toBe('FORJA_ANTHROPIC_REASONING_REPLAY');
    expect(flagForModel('openai/gpt-5.4-mini')).toBe('FORJA_OPENAI_REASONING_REPLAY');
  });

  test('throws for a provider with no replay wiring', () => {
    expect(() => flagForModel('google/gemini-2.5-pro')).toThrow(/only defined for/);
  });
});

describe('aggregateArm', () => {
  test('computes pass count, rate, and per-run averages', () => {
    const runs = [
      runResult({ passed: true, costUsd: 0.1, steps: 12, durationMs: 200 }),
      runResult({ passed: false, costUsd: 0.3, steps: 4, durationMs: 400 }),
    ];
    const s = aggregateArm('on', runs);
    expect(s).toEqual({
      arm: 'on',
      total: 2,
      passCount: 1,
      passRate: 0.5,
      costAvg: 0.2,
      stepsAvg: 8,
      durationAvg: 300,
    });
  });

  test('empty arm → zero rate, no divide-by-zero', () => {
    const s = aggregateArm('off', []);
    expect(s.passRate).toBe(0);
    expect(s.costAvg).toBe(0);
  });
});

describe('deltaOf', () => {
  test('delta is ON minus OFF', () => {
    const off: ArmStats = {
      arm: 'off',
      total: 4,
      passCount: 1,
      passRate: 0.25,
      costAvg: 0.1,
      stepsAvg: 6,
      durationAvg: 100,
    };
    const on: ArmStats = {
      arm: 'on',
      total: 4,
      passCount: 3,
      passRate: 0.75,
      costAvg: 0.15,
      stepsAvg: 9,
      durationAvg: 130,
    };
    expect(deltaOf(off, on)).toEqual({
      passRate: 0.5,
      costAvg: expect.closeTo(0.05, 5),
      stepsAvg: 3,
    });
  });
});

describe('verdictLine', () => {
  const armOf = (passRate: number): ArmStats => ({
    arm: 'off',
    total: 10,
    passCount: Math.round(passRate * 10),
    passRate,
    costAvg: 0.1,
    stepsAvg: 10,
    durationAvg: 100,
  });
  test('positive delta → candidate for flip', () => {
    const v = verdictLine({
      flag: 'F',
      repeat: 10,
      caseCount: 1,
      off: armOf(0.5),
      on: { ...armOf(0.8), arm: 'on' },
      delta: { passRate: 0.3, costAvg: 0, stepsAvg: 0 },
    });
    expect(v).toContain('candidate for flipping F');
  });
  test('zero delta → keep OFF (#25 disposition)', () => {
    const v = verdictLine({
      flag: 'F',
      repeat: 10,
      caseCount: 1,
      off: armOf(0.9),
      on: { ...armOf(0.9), arm: 'on' },
      delta: { passRate: 0, costAvg: 0, stepsAvg: 0 },
    });
    expect(v).toContain('keep F default OFF');
  });
  test('regression → keep OFF', () => {
    const v = verdictLine({
      flag: 'F',
      repeat: 10,
      caseCount: 1,
      off: armOf(0.8),
      on: { ...armOf(0.5), arm: 'on' },
      delta: { passRate: -0.3, costAvg: 0, stepsAvg: 0 },
    });
    expect(v).toContain('regressed');
  });
});

describe('parseArgs', () => {
  test('defaults: target evals/long-horizon, repeat 5', () => {
    const a = parseArgs(['--model', 'anthropic/claude-opus-4-8']);
    expect(a).toEqual({
      target: 'evals/long-horizon',
      modelId: 'anthropic/claude-opus-4-8',
      repeat: 5,
    });
  });
  test('--model is required', () => {
    expect(() => parseArgs(['evals/long-horizon'])).toThrow(/--model is required/);
  });
  test('--repeat must be a positive integer', () => {
    expect(() => parseArgs(['--model', 'openai/gpt-5.4-mini', '--repeat', '0'])).toThrow(
      /positive integer/,
    );
  });
});

// --- integration: env-flip orchestration with a flag-sensitive mock provider ---

const FLAG = 'FORJA_TEST_REPLAY_AB';

// Emits 'WIN' only when the flag is set at generate-time, so the OFF arm fails
// the output_contains expectation and the ON arm passes — letting us assert the
// runner flips the env per arm and restores it afterward, with no live API.
const flagSensitiveProvider = (): Provider => ({
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
  async *generate(): AsyncIterable<StreamEvent> {
    const on = process.env[FLAG] === '1';
    yield { kind: 'start', message_id: `mock_${crypto.randomUUID()}` };
    yield { kind: 'text_delta', text: on ? 'WIN' : 'LOSE' };
    yield { kind: 'stop', reason: 'end_turn' };
  },
  generateConstrained: () => Promise.reject(new Error('n/a')),
  countTokens: () => Promise.resolve(0),
});

const abCase = (): EvalCase => ({
  name: 'flag-sensitive',
  sourcePath: '/tmp/ab.yaml',
  prompt: 'answer',
  expect: [{ kind: 'output_contains', pattern: 'WIN' }],
});

let workdir: string;
let originalXdg: string | undefined;
let originalHome: string | undefined;
let originalFlag: string | undefined;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-ab-'));
  originalXdg = process.env.XDG_CONFIG_HOME;
  originalHome = process.env.HOME;
  originalFlag = process.env[FLAG];
  process.env.XDG_CONFIG_HOME = workdir;
  process.env.HOME = workdir;
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
});

describe('runAbComparison (orchestration)', () => {
  test('flips the flag per arm: OFF fails, ON passes, delta = 1', async () => {
    const provider = flagSensitiveProvider();
    const { result, offRuns, onRuns } = await runAbComparison({
      cases: [abCase()],
      flag: FLAG,
      repeat: 3,
      execute: { bootstrapOverride: { providerOverride: provider } },
    });
    expect(offRuns).toHaveLength(3);
    expect(onRuns).toHaveLength(3);
    expect(result.off.passRate).toBe(0);
    expect(result.on.passRate).toBe(1);
    expect(result.delta.passRate).toBe(1);
  });

  test('OFF arm ignores a flag already exported in the shell (baseline isolation)', async () => {
    // Contaminate the env before the run; the OFF arm must still measure OFF.
    process.env[FLAG] = '1';
    const provider = flagSensitiveProvider();
    const { result } = await runAbComparison({
      cases: [abCase()],
      flag: FLAG,
      repeat: 2,
      execute: { bootstrapOverride: { providerOverride: provider } },
    });
    expect(result.off.passRate).toBe(0);
    expect(result.on.passRate).toBe(1);
    // Prior value restored after the run.
    expect(process.env[FLAG]).toBe('1');
  });
});
