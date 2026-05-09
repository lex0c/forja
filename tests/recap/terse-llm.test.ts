import { describe, expect, test } from 'bun:test';
import type {
  ConstrainedRequest,
  ConstrainedResult,
  Provider,
  ProviderCapabilities,
  StreamEvent,
  UsageInfo,
} from '../../src/providers/types.ts';
import { projectTerseDeterministic } from '../../src/recap/terse/deterministic.ts';
import { renderTerseViaLlm } from '../../src/recap/terse/llm.ts';
import {
  TERSE_LIMITS,
  TERSE_SCHEMA_VERSION,
  type TerseRenderV1,
} from '../../src/recap/terse/schema.ts';
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

const baseUsage = (): UsageInfo => ({ input: 200, output: 30, cache_read: 0, cache_creation: 0 });

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
    filesWritten: [],
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

const makeMockProvider = (
  output: string,
  usage: UsageInfo = baseUsage(),
  caps: ProviderCapabilities = baseCaps(),
): { provider: Provider; calls: ConstrainedRequest[] } => {
  const calls: ConstrainedRequest[] = [];
  const provider: Provider = {
    id: 'anthropic/claude-haiku-4-5',
    family: 'anthropic',
    capabilities: caps,
    generate: async function* (): AsyncIterable<StreamEvent> {},
    generateConstrained: async (req): Promise<ConstrainedResult> => {
      calls.push(req);
      return { output, usage };
    },
    countTokens: async () => 0,
  };
  return { provider, calls };
};

describe('renderTerseViaLlm', () => {
  test('happy path: parses, validates, renders the sentence + newline', async () => {
    const structured: TerseRenderV1 = {
      schemaVersion: TERSE_SCHEMA_VERSION,
      sentence: 'Refactored queue retry. 4m32s, $0.04.',
    };
    const handle = makeMockProvider(JSON.stringify(structured));
    const result = await renderTerseViaLlm({
      intermediate: baseIntermediate(),
      provider: handle.provider,
      promptVersion: 'terse-v1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toBe('Refactored queue retry. 4m32s, $0.04.\n');
  });

  test('schema-violation on too-long sentence', async () => {
    const bad: TerseRenderV1 = {
      schemaVersion: TERSE_SCHEMA_VERSION,
      sentence: 'x'.repeat(TERSE_LIMITS.sentenceMaxChars + 1),
    };
    const handle = makeMockProvider(JSON.stringify(bad));
    const result = await renderTerseViaLlm({
      intermediate: baseIntermediate(),
      provider: handle.provider,
      promptVersion: 'terse-v1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('schema-violation');
  });

  test('uses smaller default max_tokens than other renderers', async () => {
    const structured: TerseRenderV1 = {
      schemaVersion: TERSE_SCHEMA_VERSION,
      sentence: 'x.',
    };
    const handle = makeMockProvider(JSON.stringify(structured));
    await renderTerseViaLlm({
      intermediate: baseIntermediate(),
      provider: handle.provider,
      promptVersion: 'terse-v1',
    });
    expect(handle.calls[0]?.max_tokens).toBe(256);
  });

  test('forces tool with the right name', async () => {
    const handle = makeMockProvider(
      JSON.stringify({ schemaVersion: TERSE_SCHEMA_VERSION, sentence: 'x.' }),
    );
    await renderTerseViaLlm({
      intermediate: baseIntermediate(),
      provider: handle.provider,
      promptVersion: 'terse-v1',
    });
    expect(handle.calls[0]?.output_schema_name).toBe('render_recap_terse');
  });

  test('eval gate: 5 fixtures pass schema + concision with deterministic stub', async () => {
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
      const stubStructured = projectTerseDeterministic(intermediate);
      const handle = makeMockProvider(JSON.stringify(stubStructured));
      const result = await renderTerseViaLlm({
        intermediate,
        provider: handle.provider,
        promptVersion: 'terse-v1',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.output.split('\n').length).toBeLessThanOrEqual(4);
      // The output sentence stays inside the schema cap.
      expect(result.structured.sentence.length).toBeLessThanOrEqual(TERSE_LIMITS.sentenceMaxChars);
    }
  });
});
