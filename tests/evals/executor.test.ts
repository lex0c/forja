import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFetchStubRegistry,
  executeCase,
  resolveEvalCacheRoot,
  summarize,
} from '../../src/evals/executor.ts';
import type { EvalCase } from '../../src/evals/types.ts';
import type { SandboxAvailability } from '../../src/permissions/sandbox-availability.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';
import { type ToolContext, isToolError } from '../../src/tools/types.ts';
import { seedModelCatalog } from '../helpers/seed-catalog.ts';

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

// Hermetic sandbox verdict. executeCase runs the real bootstrap(),
// whose detectSandboxAvailability() probes Bun.which('bwrap'). On a
// runner without bubblewrap (CI ubuntu-latest), the engine boots
// `degraded`, which downgrades automatic `allow` to `confirm` — that
// flips every approval-sensitive case (a bypass write that should
// land, a tool_denied that should report "invoked but allowed", an
// autonomous confirm that should auto-approve). Pinning the verdict
// keeps those cases testing the approval logic, not whether the host
// has bwrap installed.
const HERMETIC_SANDBOX: SandboxAvailability = {
  available: true,
  tool: 'bwrap',
  path: '/usr/bin/bwrap',
  trustLevel: 'canonical',
  reason: '',
  trustWarnings: [],
};

let workdir: string;
// Snapshot env vars that the bootstrap chain reads from disk (the
// memory / providers / budget config loaders). Tests under this
// suite run real `bootstrap()` via `executeCase` → providerOverride;
// a dev's `~/.config/forja/config.toml` declaring project config
// could otherwise leak into the run and perturb the mock provider.
// Pinning XDG_CONFIG_HOME and HOME at the temp workdir guarantees the
// loaders see empty layers regardless of the host env.
let originalXdg: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-evexec-'));
  originalXdg = process.env.XDG_CONFIG_HOME;
  originalHome = process.env.HOME;
  process.env.XDG_CONFIG_HOME = workdir;
  process.env.HOME = workdir;
  // Catalog is mandatory at boot — materialize the seed at the
  // workdir-scoped user path so executeCase's bootstrap finds it.
  seedModelCatalog();
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
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

  test('bootstrapOverride.thinkingBudget reaches the provider request as thinking_budget', async () => {
    // Locks the BootstrapInput → HarnessConfig → GenerateRequest.thinking_budget
    // chain the reasoning-replay A/B depends on (the Anthropic adapter only emits
    // thinking when thinking_budget > 0). Captured via a request-recording mock.
    let captured: number | undefined;
    const base = mockProvider([{ text: 'ok' }]);
    const capturing: Provider = {
      ...base,
      async *generate(req: { thinking_budget?: number }): AsyncIterable<StreamEvent> {
        captured = req.thinking_budget;
        yield { kind: 'start', message_id: 'm' };
        yield { kind: 'text_delta', text: 'ok' };
        yield { kind: 'stop', reason: 'end_turn' };
      },
    };
    await executeCase(baseCase(), {
      bootstrapOverride: { providerOverride: capturing, thinkingBudget: 1234 },
    });
    expect(captured).toBe(1234);
  });

  test('min_steps fails when the run is too short', async () => {
    const c = baseCase({ expect: [{ kind: 'min_steps', count: 3 }] });
    const r = await executeCase(c, {
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'done in one turn' }]),
      },
    });
    expect(r.passed).toBe(false);
    expect(r.expectations[0]?.detail).toContain('ran 1 step');
  });

  test('min_steps passes when the run takes enough steps', async () => {
    const c = baseCase({ expect: [{ kind: 'min_steps', count: 2 }] });
    const r = await executeCase(c, {
      bootstrapOverride: {
        providerOverride: mockProvider([
          {
            tool_uses: [{ id: 't1', name: 'write_file', input: { path: 'a.txt', content: 'x\n' } }],
          },
          {
            tool_uses: [{ id: 't2', name: 'write_file', input: { path: 'b.txt', content: 'y\n' } }],
          },
          { text: 'done' },
        ]),
        sandboxAvailabilityOverride: HERMETIC_SANDBOX,
      },
    });
    expect(r.passed).toBe(true);
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
        sandboxAvailabilityOverride: HERMETIC_SANDBOX,
      },
    });
    expect(r.passed).toBe(true);
  });

  test('file_not_contains passes when the pattern is absent, fails when present', async () => {
    // Reuses the deterministic write (out.txt = "forja-was-here\n") so the only
    // variable is the negated pattern check.
    const run = (pattern: string) =>
      executeCase(baseCase({ expect: [{ kind: 'file_not_contains', path: 'out.txt', pattern }] }), {
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
          sandboxAvailabilityOverride: HERMETIC_SANDBOX,
        },
      });
    const absent = await run('goodbye');
    expect(absent.expectations[0]?.passed).toBe(true);
    const present = await run('forja-was-here');
    expect(present.expectations[0]?.passed).toBe(false);
    expect(present.expectations[0]?.detail).toContain('still contains');
  });

  test('hermetic w.r.t. FORJA_PROFILE: honors the case .forja/ policy, not .forja-<profile>/', async () => {
    // Regression: routing the eval policy through projectDirName() made a
    // dev-profile shell look for `.forja-dev/permissions.yaml`, miss the case's
    // `.forja/` policy, and silently run the executor's default (bypass) —
    // experiments on the wrong policy. The case here ships a strict `.forja/`
    // policy (write_file → default-deny). file_exists fails IFF the write was
    // denied, which only happens if the case's `.forja/` policy was read; a
    // `.forja-dev/` mis-read would get the default bypass → write allowed →
    // out.txt created → file_exists passes.
    const prev = process.env.FORJA_PROFILE;
    process.env.FORJA_PROFILE = 'dev';
    try {
      const c = baseCase({
        setup: { files: { '.forja/permissions.yaml': 'defaults:\n  mode: strict\n' } },
        expect: [{ kind: 'file_exists', path: 'out.txt' }],
      });
      const r = await executeCase(c, {
        bootstrapOverride: {
          providerOverride: mockProvider([
            {
              tool_uses: [
                { id: 't1', name: 'write_file', input: { path: 'out.txt', content: 'x\n' } },
              ],
            },
            { text: 'done' },
          ]),
          sandboxAvailabilityOverride: HERMETIC_SANDBOX,
        },
      });
      // write_file denied by the case's strict `.forja/` policy → out.txt
      // absent → file_exists fails. (A `.forja-dev/` mis-read → default bypass
      // → out.txt created → would pass.)
      expect(r.passed).toBe(false);
      // executeCase restores the ambient profile after the run.
      expect(process.env.FORJA_PROFILE).toBe('dev');
    } finally {
      if (prev === undefined) delete process.env.FORJA_PROFILE;
      else process.env.FORJA_PROFILE = prev;
    }
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

  test('tool_denied fails when the tool was invoked AND allowed', async () => {
    // Default eval policy is bypass — write_file would be allowed.
    // No deny fires, so tool_denied must report "invoked but
    // allowed" so the case author can spot the gap.
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
        sandboxAvailabilityOverride: HERMETIC_SANDBOX,
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

describe('resolveEvalCacheRoot', () => {
  // Resolution precedence guarded here so the production code's
  // env-var escape hatch + degraded-fallback semantics survive
  // future refactors. The function is pure (takes env + home,
  // returns path) so each branch tests cleanly without process-
  // env churn.
  test('FORJA_EVAL_CACHE_DIR env override wins over HOME', () => {
    // Operator in a constrained CI / container with read-only
    // home points the env var at any writable path the sandbox
    // can see. Override MUST take precedence — otherwise the
    // operator has no escape hatch when the default ~/.cache
    // path is unwritable.
    const out = resolveEvalCacheRoot({ FORJA_EVAL_CACHE_DIR: '/srv/forja-eval' }, '/home/op');
    expect(out).toBe('/srv/forja-eval');
  });

  test('falls back to ~/.cache/forja-eval when no env override', () => {
    // Default path for normal dev + CI environments. Joined
    // explicitly so platform differences (POSIX `/` vs Windows
    // `\`) round-trip through node:path/join correctly.
    const out = resolveEvalCacheRoot({}, '/home/op');
    expect(out).toBe(join('/home/op', '.cache', 'forja-eval'));
  });

  test('falls back to tmpdir when HOME is empty AND no env override', () => {
    // Degraded mode: fixture-backed cases will return zero
    // matches inside the sandbox (the runtime sandbox masks
    // /tmp), but the run starts cleanly instead of crashing at
    // import time. Operators landing here should set the
    // override; this branch keeps `bun test` runnable in
    // pathological CI shapes that strip HOME entirely.
    const out = resolveEvalCacheRoot({}, '');
    expect(out).toBe(tmpdir());
  });

  test('empty FORJA_EVAL_CACHE_DIR is treated as unset (falls through to HOME)', () => {
    // `length > 0` guard catches the operator who exported the
    // var without a value (`export FORJA_EVAL_CACHE_DIR=`).
    // Falling through to HOME beats writing into the process
    // cwd or `/` — both would be silent corruption surfaces.
    const out = resolveEvalCacheRoot({ FORJA_EVAL_CACHE_DIR: '' }, '/home/op');
    expect(out).toBe(join('/home/op', '.cache', 'forja-eval'));
  });

  test('env override wins even when HOME is also empty', () => {
    // Combination: container with HOME stripped but operator
    // provides override. Must still honor the override —
    // priority chain is "env > home > tmpdir" and HOME being
    // empty cannot shift priority back to tmpdir over an
    // explicit operator choice.
    const out = resolveEvalCacheRoot({ FORJA_EVAL_CACHE_DIR: '/var/cache/forja-eval' }, '');
    expect(out).toBe('/var/cache/forja-eval');
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

describe('executeCase — approval posture (operation mode, AGENTIC_CLI §8.1)', () => {
  // Evals run headless (no confirm bridge), so a `confirm` verdict
  // resolves to deny. These pin the posture security invariant
  // end-to-end through the eval machine, deterministically (mock
  // provider, no live model / no $) — and exercise the full
  // setup.approvalPosture → loader → executor → engine threading.
  const policyYaml = (body: string) => `defaults:\n  mode: strict\ntools:\n${body}`;

  test('autonomous auto-approves a routine policy confirm (write lands)', async () => {
    const c = baseCase({
      setup: {
        approvalPosture: 'autonomous',
        files: {
          '.forja/permissions.yaml': policyYaml(
            '  write_file:\n    confirm_paths:\n      - "out.txt"\n',
          ),
        },
      },
      expect: [
        { kind: 'tool_called', tool: 'write_file' },
        { kind: 'file_exists', path: 'out.txt' },
      ],
    });
    const r = await executeCase(c, {
      bootstrapOverride: {
        providerOverride: mockProvider([
          {
            tool_uses: [
              { id: 't1', name: 'write_file', input: { path: 'out.txt', content: 'hi' } },
            ],
          },
          { text: 'wrote it' },
        ]),
        sandboxAvailabilityOverride: HERMETIC_SANDBOX,
      },
    });
    expect(r.passed).toBe(true);
  });

  test('supervised leaves the same confirm a deny in headless (no write)', async () => {
    const c = baseCase({
      setup: {
        approvalPosture: 'supervised',
        files: {
          '.forja/permissions.yaml': policyYaml(
            '  write_file:\n    confirm_paths:\n      - "out.txt"\n',
          ),
        },
      },
      expect: [
        { kind: 'tool_called', tool: 'write_file' },
        { kind: 'tool_denied', tool: 'write_file' },
        { kind: 'file_not_exists', path: 'out.txt' },
      ],
    });
    const r = await executeCase(c, {
      bootstrapOverride: {
        providerOverride: mockProvider([
          {
            tool_uses: [
              { id: 't1', name: 'write_file', input: { path: 'out.txt', content: 'hi' } },
            ],
          },
          { text: 'tried' },
        ]),
      },
    });
    expect(r.passed).toBe(true);
  });

  test('autonomous does NOT auto-approve a compound with a non-repo-confined effect (headless → denied)', async () => {
    // Autonomous auto-approves a bash compound only when EVERY resolved
    // capability is repo-confined. `frobnicate` is an unknown binary →
    // `exec:arbitrary`, which is never repo-confined, so the compound stays
    // a modal; headless has no approver, so the confirm resolves to a deny.
    // (A repo-confined compound like `echo a && echo b` WOULD auto-approve —
    // pinned in tests/permissions/engine.test.ts.)
    const c = baseCase({
      setup: {
        approvalPosture: 'autonomous',
        files: { '.forja/permissions.yaml': policyYaml('  bash:\n    allow:\n      - "echo *"\n') },
      },
      expect: [
        { kind: 'tool_called', tool: 'bash' },
        { kind: 'tool_denied', tool: 'bash' },
      ],
    });
    const r = await executeCase(c, {
      bootstrapOverride: {
        providerOverride: mockProvider([
          { tool_uses: [{ id: 't1', name: 'bash', input: { command: 'frobnicate a && echo b' } }] },
          { text: 'tried' },
        ]),
      },
    });
    expect(r.passed).toBe(true);
  });
});

describe('buildFetchStubRegistry', () => {
  const fetchCtx = (): ToolContext =>
    ({
      signal: new AbortController().signal,
      cwd: process.cwd(),
      sessionId: 's',
      stepId: 'st',
      permissions: { mode: 'strict', posture: 'supervised', canReadPath: () => true },
      permissionCheck: () => ({ kind: 'allow', reason: 'test' }),
      isCwdTrusted: true,
    }) as unknown as ToolContext;

  test('the stubbed fetch_url serves the canned page (injected DNS + Host-mapped fetch)', async () => {
    // Proves the seam survives the DNS-rebinding pin: the tool resolves via the
    // injected lookup, pins to the test IP, fetches `https://<ip>/p` with the
    // Host header, and the stub maps it back to the canned URL.
    const reg = buildFetchStubRegistry({
      'https://docs.forja.test/p': {
        body: '<h1>Doc</h1><p>value 42</p>',
        contentType: 'text/html',
      },
    });
    const tool = reg.get('fetch_url');
    expect(tool).not.toBeNull();
    const out = await tool?.execute({ url: 'https://docs.forja.test/p' }, fetchCtx());
    expect(isToolError(out)).toBe(false);
    if (out !== undefined && !isToolError(out)) {
      const o = out as { content: string };
      expect(o.content).toContain('# Doc');
      expect(o.content).toContain('value 42');
    }
  });

  test('rejects a fetch_url url that was not stubbed', async () => {
    const reg = buildFetchStubRegistry({ 'https://x.test/a': { body: 'x' } });
    const tool = reg.get('fetch_url');
    const out = await tool?.execute({ url: 'https://y.test/b' }, fetchCtx());
    expect(isToolError(out)).toBe(true);
  });
});

describe('executeCase — httpStub seam', () => {
  test('runs fetch_url through the stubbed registry in the loop', async () => {
    const c = baseCase({
      prompt: 'fetch the doc',
      setup: {
        files: {
          '.forja/permissions.yaml': "tools:\n  fetch_url:\n    allow_hosts: ['docs.forja.test']\n",
        },
        httpStub: {
          'https://docs.forja.test/p': {
            body: '<h1>Doc</h1><p>value 42</p>',
            contentType: 'text/html',
          },
        },
      },
      expect: [
        { kind: 'tool_called', tool: 'fetch_url' },
        { kind: 'status', status: 'done' },
      ],
    });
    const r = await executeCase(c, {
      bootstrapOverride: {
        providerOverride: mockProvider([
          {
            tool_uses: [
              { id: 'f1', name: 'fetch_url', input: { url: 'https://docs.forja.test/p' } },
            ],
          },
          { text: 'done' },
        ]),
        sandboxAvailabilityOverride: HERMETIC_SANDBOX,
      },
    });
    expect(r.passed).toBe(true);
  });
});
