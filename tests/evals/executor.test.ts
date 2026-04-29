import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCase, summarize } from '../../src/evals/executor.ts';
import type { EvalCase } from '../../src/evals/types.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';

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
  yield { kind: 'stop', reason: step.tool_uses?.length ? 'tool_use' : 'end_turn' };
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

const baseCase = (overrides: Partial<EvalCase> = {}): EvalCase => ({
  name: 'test case',
  sourcePath: '/tmp/case.yaml',
  prompt: 'do the thing',
  expect: [{ kind: 'status', status: 'done' }],
  ...overrides,
});

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-evexec-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('executeCase', () => {
  test('happy path with text-only response passes status:done', async () => {
    const c = baseCase();
    const r = await executeCase(c, {
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'all good' }]),
      },
    });
    expect(r.passed).toBe(true);
    expect(r.status).toBe('done');
    expect(r.expectations.every((e) => e.passed)).toBe(true);
  });

  test('output_contains matches accumulated text_delta', async () => {
    const c = baseCase({
      expect: [
        { kind: 'output_contains', pattern: 'TOKEN_42' },
        { kind: 'status', status: 'done' },
      ],
    });
    const r = await executeCase(c, {
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'the secret is TOKEN_42 ok' }]),
      },
    });
    expect(r.passed).toBe(true);
  });

  test('output_contains fails when text missing', async () => {
    const c = baseCase({
      expect: [{ kind: 'output_contains', pattern: 'NEVER' }],
    });
    const r = await executeCase(c, {
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'something else' }]),
      },
    });
    expect(r.passed).toBe(false);
    expect(r.expectations[0]?.detail).toContain('NEVER');
  });

  test('tool_called passes when mock emits the tool', async () => {
    const c = baseCase({
      expect: [
        { kind: 'tool_called', tool: 'write_file' },
        { kind: 'file_exists', path: 'out.txt' },
        { kind: 'file_contains', path: 'out.txt', pattern: 'forja-was-here' },
      ],
    });
    const r = await executeCase(c, {
      bootstrapOverride: {
        providerOverride: mockProvider([
          {
            tool_uses: [
              {
                id: 't1',
                name: 'write_file',
                input: { path: 'out.txt', content: 'forja-was-here\n' },
              },
            ],
          },
          { text: 'wrote the file' },
        ]),
      },
    });
    expect(r.passed).toBe(true);
  });

  test('tool_not_called fails when tool was invoked', async () => {
    const c = baseCase({
      expect: [{ kind: 'tool_not_called', tool: 'write_file' }],
    });
    const r = await executeCase(c, {
      bootstrapOverride: {
        providerOverride: mockProvider([
          {
            tool_uses: [{ id: 't1', name: 'write_file', input: { path: 'x.txt', content: 'x' } }],
          },
          { text: 'done' },
        ]),
      },
    });
    expect(r.passed).toBe(false);
    expect(r.expectations[0]?.detail).toContain("'write_file' was called");
  });

  test('plan mode blocks write_file: file_not_exists passes', async () => {
    const c = baseCase({
      plan: true,
      expect: [
        { kind: 'file_not_exists', path: 'leak.txt' },
        { kind: 'output_contains', pattern: 'attempted' },
      ],
    });
    const r = await executeCase(c, {
      bootstrapOverride: {
        providerOverride: mockProvider([
          {
            tool_uses: [
              { id: 't1', name: 'write_file', input: { path: 'leak.txt', content: 'leak' } },
            ],
          },
          { text: 'attempted but blocked' },
        ]),
      },
    });
    expect(r.passed).toBe(true);
  });

  test('setup.files materializes inline files into cwd', async () => {
    const c = baseCase({
      setup: { files: { 'fixture.txt': 'preexisting\n' } },
      expect: [
        { kind: 'tool_called', tool: 'read_file' },
        { kind: 'file_exists', path: 'fixture.txt' },
      ],
    });
    const r = await executeCase(c, {
      bootstrapOverride: {
        providerOverride: mockProvider([
          {
            tool_uses: [{ id: 't1', name: 'read_file', input: { path: 'fixture.txt' } }],
          },
          { text: 'read it' },
        ]),
      },
    });
    expect(r.passed).toBe(true);
  });

  test('setup.fixture copies a directory into cwd', async () => {
    // Stage a fixture on disk and reference it from the case.
    const sourcePath = join(workdir, 'case.yaml');
    writeFileSync(sourcePath, ''); // anchor for relative resolution
    const fixDir = join(workdir, 'fix');
    mkdirSync(fixDir, { recursive: true });
    writeFileSync(join(fixDir, 'a.txt'), 'fixture-content\n');
    const c = baseCase({
      sourcePath,
      setup: { fixture: './fix' },
      expect: [
        { kind: 'file_exists', path: 'a.txt' },
        { kind: 'file_contains', path: 'a.txt', pattern: 'fixture-content' },
      ],
    });
    const r = await executeCase(c, {
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'observed' }]),
      },
    });
    expect(r.passed).toBe(true);
  });

  test('tool_denied passes when plan mode blocks a write tool', async () => {
    // Plan mode unconditionally denies write_file (no planSafe).
    // The mock emits a write_file tool_use; the gate fires with
    // a deny decision; tool_denied: write_file matches.
    const c = baseCase({
      plan: true,
      expect: [
        { kind: 'tool_denied', tool: 'write_file' },
        { kind: 'file_not_exists', path: 'leak.txt' },
      ],
    });
    const r = await executeCase(c, {
      bootstrapOverride: {
        providerOverride: mockProvider([
          {
            tool_uses: [
              { id: 't1', name: 'write_file', input: { path: 'leak.txt', content: 'leak' } },
            ],
          },
          { text: 'attempted but blocked' },
        ]),
      },
    });
    expect(r.passed).toBe(true);
  });

  test('tool_denied fails when the tool was invoked AND allowed', async () => {
    // Default eval policy is bypass — write_file would be allowed.
    // Without plan mode, no deny fires; tool_denied must report
    // "invoked but allowed" so the case author can spot the gap.
    const c = baseCase({
      expect: [{ kind: 'tool_denied', tool: 'write_file' }],
    });
    const r = await executeCase(c, {
      bootstrapOverride: {
        providerOverride: mockProvider([
          {
            tool_uses: [
              { id: 't1', name: 'write_file', input: { path: 'out.txt', content: 'ok' } },
            ],
          },
          { text: 'wrote' },
        ]),
      },
    });
    expect(r.passed).toBe(false);
    expect(r.expectations[0]?.detail ?? '').toMatch(/invoked but allowed/);
  });

  test('tool_denied fails when the tool was never invoked', async () => {
    // Vacuous denies are a footgun: a tool_denied assertion that
    // passes because the model never tried gives false confidence
    // the gate fired. The expectation must distinguish "denied"
    // from "absent" and fail with "never invoked" wording.
    const c = baseCase({
      expect: [{ kind: 'tool_denied', tool: 'bash' }],
    });
    const r = await executeCase(c, {
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'no tools used' }]),
      },
    });
    expect(r.passed).toBe(false);
    expect(r.expectations[0]?.detail ?? '').toMatch(/never invoked/);
  });

  test('file_exists expectation that escapes cwd fails the assertion (no host probe)', async () => {
    // Direct EvalCase construction bypasses the loader. Without
    // the runtime guard, file_exists would probe arbitrary host
    // paths — both leaking host state into eval results AND
    // making the case non-portable. Must fail the assertion
    // cleanly with a workspace-escape message.
    const c = baseCase({
      expect: [{ kind: 'file_exists', path: '../../../etc/passwd' }],
    });
    const r = await executeCase(c, {
      bootstrapOverride: { providerOverride: mockProvider([{ text: 'ok' }]) },
    });
    expect(r.passed).toBe(false);
    expect(r.expectations[0]?.detail ?? '').toMatch(/escapes the eval workspace/);
  });

  test('file_contains with absolute path fails the assertion (no host read)', async () => {
    // /etc/passwd exists on every Linux/Mac host; without the
    // guard, file_contains would read it and the pattern check
    // would happen against real host content. The runtime guard
    // refuses to call readFileSync at all.
    const c = baseCase({
      expect: [{ kind: 'file_contains', path: '/etc/passwd', pattern: 'root' }],
    });
    const r = await executeCase(c, {
      bootstrapOverride: { providerOverride: mockProvider([{ text: 'ok' }]) },
    });
    expect(r.passed).toBe(false);
    expect(r.expectations[0]?.detail ?? '').toMatch(/escapes the eval workspace/);
  });

  test('file_not_exists escape returns workspace-escape, not "exists but should not"', async () => {
    // Subtle: /etc/passwd exists. Without the guard, file_not_exists
    // would say "exists but should not" — leaking host state into
    // the failure message. With the guard, the message is
    // workspace-escape regardless of whether the host file exists.
    const c = baseCase({
      expect: [{ kind: 'file_not_exists', path: '/etc/passwd' }],
    });
    const r = await executeCase(c, {
      bootstrapOverride: { providerOverride: mockProvider([{ text: 'ok' }]) },
    });
    expect(r.passed).toBe(false);
    expect(r.expectations[0]?.detail ?? '').toMatch(/escapes the eval workspace/);
    expect(r.expectations[0]?.detail ?? '').not.toMatch(/exists but should not/);
  });

  test('setup.fixture that escapes the case boundary is rejected at runtime', async () => {
    // sourcePath is /tmp/.../sub/case.yaml. Boundary is /tmp/.../
    // (parent of sub). A fixture '../../..' would resolve to /, way
    // outside. Without the guard, cpSync would happily clone whatever
    // is there into the temp eval workspace — could be repo root,
    // home dir, or worse.
    const subdir = join(workdir, 'sub');
    mkdirSync(subdir, { recursive: true });
    const sourcePath = join(subdir, 'case.yaml');
    writeFileSync(sourcePath, '');
    const c = baseCase({
      sourcePath,
      setup: { fixture: '../../..' },
      expect: [{ kind: 'status', status: 'done' }],
    });
    const r = await executeCase(c, {
      bootstrapOverride: { providerOverride: mockProvider([{ text: 'ok' }]) },
    });
    expect(r.passed).toBe(false);
    expect(r.failure ?? '').toMatch(/escapes the case boundary/);
  });

  test('setup.fixture with absolute path is rejected at runtime', async () => {
    // Loader normally rejects absolute fixtures at parse time;
    // direct EvalCase construction (this test) bypasses the
    // loader. Runtime guard must still catch it.
    const c = baseCase({
      setup: { fixture: '/etc' },
      expect: [{ kind: 'status', status: 'done' }],
    });
    const r = await executeCase(c, {
      bootstrapOverride: { providerOverride: mockProvider([{ text: 'ok' }]) },
    });
    expect(r.passed).toBe(false);
    expect(r.failure ?? '').toMatch(/escapes the case boundary/);
  });

  test('setup.files with .. escape is rejected at runtime even when loader is bypassed', async () => {
    // Direct EvalCase construction skips the loader's parse-time
    // sandbox guard. The executor must still refuse — defense in
    // depth catches programmatic callers and any future entry
    // point that builds EvalCase without going through parseEvalCase.
    const c = baseCase({
      setup: { files: { '../escape.txt': 'leak' } },
      expect: [{ kind: 'status', status: 'done' }],
    });
    const r = await executeCase(c, {
      bootstrapOverride: { providerOverride: mockProvider([{ text: 'ok' }]) },
    });
    expect(r.passed).toBe(false);
    expect(r.failure ?? '').toMatch(/escapes the eval workspace/);
  });

  test('setup.files with absolute path is rejected at runtime', async () => {
    const c = baseCase({
      setup: { files: { '/tmp/forja-eval-escape-test.txt': 'leak' } },
      expect: [{ kind: 'status', status: 'done' }],
    });
    const r = await executeCase(c, {
      bootstrapOverride: { providerOverride: mockProvider([{ text: 'ok' }]) },
    });
    expect(r.passed).toBe(false);
    expect(r.failure ?? '').toMatch(/escapes the eval workspace/);
    // Confirm nothing was actually written.
    const { existsSync } = await import('node:fs');
    expect(existsSync('/tmp/forja-eval-escape-test.txt')).toBe(false);
  });

  test('budget cap on cost is strict-greater: cost==budget passes', async () => {
    // Mock provider emits no usage events, so costUsd=0. With
    // maxCostUsd:0, cost equals budget — not exceeded — and the
    // case should still pass when expectations pass. Documents
    // the threshold semantics so a future refactor that flips it
    // to >= breaks loudly.
    const c = baseCase({
      budget: { maxCostUsd: 0 },
      expect: [{ kind: 'status', status: 'done' }],
    });
    const r = await executeCase(c, {
      bootstrapOverride: { providerOverride: mockProvider([{ text: 'ok' }]) },
    });
    expect(r.costUsd).toBe(0);
    expect(r.passed).toBe(true);
  });
});

describe('summarize', () => {
  test('aggregates pass/fail/p50', () => {
    const summary = summarize([
      {
        name: 'a',
        sourcePath: 'a',
        passed: true,
        durationMs: 100,
        costUsd: 0.01,
        steps: 1,
        usageComplete: true,
        expectations: [],
      },
      {
        name: 'b',
        sourcePath: 'b',
        passed: false,
        durationMs: 200,
        costUsd: 0.02,
        steps: 2,
        usageComplete: true,
        expectations: [],
      },
      {
        name: 'c',
        sourcePath: 'c',
        passed: true,
        durationMs: 150,
        costUsd: 0.03,
        steps: 1,
        usageComplete: false,
        expectations: [],
      },
    ]);
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.passRate).toBeCloseTo(2 / 3);
    expect(summary.p50CostUsd).toBeCloseTo(0.02);
    expect(summary.totalCostUsd).toBeCloseTo(0.06);
    expect(summary.totalDurationMs).toBe(450);
  });

  test('empty list yields 0/0', () => {
    const summary = summarize([]);
    expect(summary.total).toBe(0);
    expect(summary.passRate).toBe(0);
    expect(summary.p50CostUsd).toBeUndefined();
  });
});
