import { describe, expect, test } from 'bun:test';
import type {
  ConstrainedRequest,
  ConstrainedResult,
  Provider,
  ProviderCapabilities,
  StreamEvent,
  UsageInfo,
} from '../../src/providers/types.ts';
import { projectPrDeterministic } from '../../src/recap/pr/deterministic.ts';
import { renderPrViaLlm } from '../../src/recap/pr/llm.ts';
import { PR_SCHEMA_VERSION, type PrRenderV1 } from '../../src/recap/pr/schema.ts';
import { RECAP_SCHEMA_VERSION, type RecapIntermediate } from '../../src/recap/types.ts';

const baseCaps = (): ProviderCapabilities => ({
  tools: 'native',
  cache: 'server_5min',
  vision: false,
  streaming: true,
  constrained: 'tools',
  context_window: 200_000,
  output_max_tokens: 4_096,
  cost_per_1k_input: 1.0,
  cost_per_1k_output: 5.0,
  cost_per_1k_cached_input: 0.1,
  cost_per_1k_cache_write: 1.25,
  notes: [],
});

const baseUsage = (): UsageInfo => ({
  input: 1_000,
  output: 200,
  cache_read: 0,
  cache_creation: 0,
});

const baseIntermediate = (overrides: Partial<RecapIntermediate> = {}): RecapIntermediate => ({
  schemaVersion: RECAP_SCHEMA_VERSION,
  generatedAt: 0,
  scope: { kind: 'session_specific', sessionIds: ['s-1'], range: { start: 0, end: 0 } },
  completeness: { incomplete: false, incompleteSessions: [], incompleteReason: '' },
  goal: { text: 'do thing', sourceStepId: 'step-1' },
  goalStack: [],
  decisions: [],
  pinnedContext: [],
  actions: {
    filesRead: [],
    filesWritten: [{ path: '/p/a.ts', linesAdded: 5, linesRemoved: 1, semanticSummary: '' }],
    commandsRun: [],
    webFetches: [],
    subagentsSpawned: [],
  },
  outcomes: { testsRun: [], checkpoints: [], artifacts: [] },
  timeline: [],
  costs: {
    tokens: { in: 0, out: 0, cached: 0 },
    usd: 0,
    durationMs: 0,
    model: '',
    cacheHitRatio: 0,
  },
  errors: [],
  notDone: [],
  unresolvedQuestions: [],
  memoryProposed: [],
  ...overrides,
});

const validStructuredFor = (intermediate: RecapIntermediate): PrRenderV1 => {
  // Valid structure that passes the fidelity check (paths must
  // exist in the projection's filesWritten).
  return {
    schemaVersion: PR_SCHEMA_VERSION,
    summary: ['did the thing'],
    changes: intermediate.actions.filesWritten.map((f) => ({
      path: f.path,
      bullets: [`+${f.linesAdded} / -${f.linesRemoved} lines`],
    })),
    testPlan: [],
    notes: [],
  };
};

interface MockProviderHandle {
  provider: Provider;
  calls: ConstrainedRequest[];
}

const makeMockProvider = (
  output: string,
  usage: UsageInfo = baseUsage(),
  caps: ProviderCapabilities = baseCaps(),
): MockProviderHandle => {
  const calls: ConstrainedRequest[] = [];
  const provider: Provider = {
    id: 'anthropic/claude-haiku-4-5',
    family: 'anthropic',
    capabilities: caps,
    generate: async function* (): AsyncIterable<StreamEvent> {
      // unused
    },
    generateConstrained: async (req): Promise<ConstrainedResult> => {
      calls.push(req);
      return { output, usage };
    },
    countTokens: async () => 0,
  };
  return { provider, calls };
};

describe('renderPrViaLlm', () => {
  test('happy path: structured JSON parses, validates, fidelity-checks, and renders', async () => {
    const intermediate = baseIntermediate();
    const structured = validStructuredFor(intermediate);
    const handle = makeMockProvider(JSON.stringify(structured));
    const result = await renderPrViaLlm({
      intermediate,
      provider: handle.provider,
      promptVersion: 'pr-v1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('## Summary');
    expect(result.output).toContain('did the thing');
    expect(result.structured.schemaVersion).toBe(PR_SCHEMA_VERSION);
    expect(result.usage.input).toBe(1_000);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  test('passes the PR schema as the forced tool input_schema', async () => {
    const intermediate = baseIntermediate();
    const handle = makeMockProvider(JSON.stringify(validStructuredFor(intermediate)));
    await renderPrViaLlm({
      intermediate,
      provider: handle.provider,
      promptVersion: 'pr-v1',
    });
    expect(handle.calls).toHaveLength(1);
    const call = handle.calls[0];
    expect(call?.output_schema_name).toBe('render_recap_pr');
    expect(
      (call?.output_schema as { properties: Record<string, unknown> }).properties,
    ).toHaveProperty('summary');
  });

  test('passes canonical sampling (temperature, top_p) per TOKEN_TUNING §9', async () => {
    // Spec table line 436: `recap (LLM render): temperature 0.2,
    // top_p 0.95, max_tokens 4096`. Pre-fix the request omitted
    // both, so providers used their default (Anthropic = 1.0) and
    // the consistency eval (5×byte-identical) couldn't hold once
    // the LLM path was active. Pin the values at the request
    // boundary; provider adapter forwards them to the API.
    const intermediate = baseIntermediate();
    const handle = makeMockProvider(JSON.stringify(validStructuredFor(intermediate)));
    await renderPrViaLlm({
      intermediate,
      provider: handle.provider,
      promptVersion: 'pr-v1',
    });
    const call = handle.calls[0];
    expect(call?.temperature).toBe(0.2);
    expect(call?.top_p).toBe(0.95);
    expect(call?.max_tokens).toBeGreaterThanOrEqual(2_048);
  });

  test('redacts secrets in the JSON sent to the provider (SECURITY §6.2)', async () => {
    // Pre-fix the prompt builder did `JSON.stringify(intermediate)`
    // raw, so a goal text or command line carrying a pasted API
    // key leaked to the LLM endpoint even though the rendered
    // markdown was redacted by the template. The fix routes the
    // intermediate through `redactSecretsInIntermediate` before
    // serialization. Pin it here at the request boundary so any
    // future prompt rewrite that drops the redaction trips this.
    const intermediate = baseIntermediate();
    intermediate.goal.text = `use ANTHROPIC_API_KEY=sk-ant-api03-${'X'.repeat(40)}`;
    const handle = makeMockProvider(JSON.stringify(validStructuredFor(intermediate)));
    await renderPrViaLlm({
      intermediate,
      provider: handle.provider,
      promptVersion: 'pr-v1',
    });
    const call = handle.calls[0];
    const userPrompt = call?.messages[0]?.content as string;
    expect(userPrompt).not.toContain('sk-ant-api03-XXX');
    expect(userPrompt).toContain('<redacted:');
  });

  test('capability-missing short-circuits without a provider call', async () => {
    const caps = { ...baseCaps(), constrained: false as const };
    const handle = makeMockProvider('{}', baseUsage(), caps);
    const result = await renderPrViaLlm({
      intermediate: baseIntermediate(),
      provider: handle.provider,
      promptVersion: 'pr-v1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('capability-missing');
    expect(handle.calls).toHaveLength(0);
  });

  test('provider-error reason is propagated', async () => {
    const provider: Provider = {
      id: 'anthropic/x',
      family: 'anthropic',
      capabilities: baseCaps(),
      generate: async function* () {},
      generateConstrained: () => Promise.reject(new Error('rate limited')),
      countTokens: async () => 0,
    };
    const result = await renderPrViaLlm({
      intermediate: baseIntermediate(),
      provider,
      promptVersion: 'pr-v1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('provider-error');
    expect(result.detail).toContain('rate limited');
  });

  test('invalid-json reason on garbage output', async () => {
    const handle = makeMockProvider('not-json-at-all');
    const result = await renderPrViaLlm({
      intermediate: baseIntermediate(),
      provider: handle.provider,
      promptVersion: 'pr-v1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-json');
  });

  test('schema-violation reason on extra top-level field', async () => {
    const intermediate = baseIntermediate();
    const bad = { ...validStructuredFor(intermediate), tone: 'cheerful' };
    const handle = makeMockProvider(JSON.stringify(bad));
    const result = await renderPrViaLlm({
      intermediate,
      provider: handle.provider,
      promptVersion: 'pr-v1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('schema-violation');
    expect(result.detail).toContain('tone');
  });

  test('fidelity-mismatch on a hallucinated path', async () => {
    const intermediate = baseIntermediate();
    const bad: PrRenderV1 = {
      schemaVersion: PR_SCHEMA_VERSION,
      summary: ['x'],
      changes: [{ path: '/never/seen/this.ts', bullets: ['+0 / -0'] }],
      testPlan: [],
      notes: [],
    };
    const handle = makeMockProvider(JSON.stringify(bad));
    const result = await renderPrViaLlm({
      intermediate,
      provider: handle.provider,
      promptVersion: 'pr-v1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('fidelity-mismatch');
    expect(result.detail).toContain('/never/seen/this.ts');
  });

  test('concision-violation when the rendered markdown exceeds the line cap', async () => {
    // Hard to hit because of per-field caps — we synthesize an
    // intermediate with many filesWritten and matching changes.
    const filesWritten = Array.from({ length: 30 }, (_, i) => ({
      path: `/p/file-${i}.ts`,
      linesAdded: 1,
      linesRemoved: 0,
      semanticSummary: '',
    }));
    const intermediate = baseIntermediate({
      actions: {
        filesRead: [],
        filesWritten,
        commandsRun: [],
        webFetches: [],
        subagentsSpawned: [],
      },
    });
    const structured: PrRenderV1 = {
      schemaVersion: PR_SCHEMA_VERSION,
      summary: ['x'],
      changes: filesWritten.map((f) => ({
        path: f.path,
        bullets: ['a', 'b', 'c', 'd'],
      })),
      testPlan: [],
      notes: [],
    };
    const handle = makeMockProvider(JSON.stringify(structured));
    const result = await renderPrViaLlm({
      intermediate,
      provider: handle.provider,
      promptVersion: 'pr-v1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('concision-violation');
  });

  // ─── Eval gate (RECAP.md §7.4) ────────────────────────────────
  // Fidelity 100%, coverage ≥ 90%, concision 100% across the
  // golden fixtures, with a stub provider that returns the
  // deterministic projection's PrRenderV1 (i.e. the strongest
  // possible LLM output: it cannot fail fidelity because it IS
  // the projection itself).

  test('eval gate: all 5 fixtures pass fidelity + coverage + concision with a deterministic stub', async () => {
    const { fixture: f01 } = await import('../../evals/recap/fixtures/01-read-only.ts');
    const { fixture: f02 } = await import('../../evals/recap/fixtures/02-write-refactor.ts');
    const { fixture: f03 } = await import('../../evals/recap/fixtures/03-with-decisions.ts');
    const { fixture: f04 } = await import('../../evals/recap/fixtures/04-with-subagent.ts');
    const { fixture: f05 } = await import('../../evals/recap/fixtures/05-incomplete-session.ts');
    const fixtures = [f01, f02, f03, f04, f05];
    const { openMemoryDb } = await import('../../src/storage/db.ts');
    const { migrate } = await import('../../src/storage/migrate.ts');
    const { projectRecap } = await import('../../src/recap/projection.ts');
    for (const fx of fixtures) {
      const db = openMemoryDb();
      migrate(db);
      const scope = fx.seed(db);
      const intermediate = projectRecap(db, { scope, now: fx.now });
      const stubStructured = projectPrDeterministic(intermediate);
      const handle = makeMockProvider(JSON.stringify(stubStructured));
      const result = await renderPrViaLlm({
        intermediate,
        provider: handle.provider,
        promptVersion: 'pr-v1',
      });
      // Fidelity: render succeeds (paths from projection always
      // exist in projection — by construction). Schema valid by
      // construction. Concision under the line cap.
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      // Coverage: every filesWritten path must show up as a
      // changes[] entry. ≥ 90% threshold per §7.4 — for the
      // deterministic stub it should be 100%.
      const written = new Set(intermediate.actions.filesWritten.map((f) => f.path));
      const rendered = new Set(result.structured.changes.map((c) => c.path));
      const covered = [...written].filter((p) => rendered.has(p)).length;
      const ratio = written.size === 0 ? 1 : covered / written.size;
      expect(ratio).toBeGreaterThanOrEqual(0.9);
    }
  });
});
