// LLM-mode coverage for the `changelog` renderer. Mirrors the
// shape of `pr-llm.test.ts`: each unit test exercises one
// failure-mode of the shared pipeline; the eval gate at the
// bottom asserts the 5-fixture happy path with a deterministic
// stub provider (the strongest possible LLM output: it cannot
// fail by construction, so any failure means the pipeline
// regressed).

import { describe, expect, test } from 'bun:test';
import type {
  ConstrainedRequest,
  ConstrainedResult,
  Provider,
  ProviderCapabilities,
  StreamEvent,
  UsageInfo,
} from '../../src/providers/types.ts';
import { projectChangelogDeterministic } from '../../src/recap/changelog/deterministic.ts';
import { renderChangelogViaLlm } from '../../src/recap/changelog/llm.ts';
import {
  CHANGELOG_SCHEMA_VERSION,
  type ChangelogRenderV1,
} from '../../src/recap/changelog/schema.ts';
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

const baseUsage = (): UsageInfo => ({ input: 800, output: 100, cache_read: 0, cache_creation: 0 });

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
    generate: async function* (): AsyncIterable<StreamEvent> {},
    generateConstrained: async (req): Promise<ConstrainedResult> => {
      calls.push(req);
      return { output, usage };
    },
    countTokens: async () => 0,
  };
  return { provider, calls };
};

describe('renderChangelogViaLlm', () => {
  test('happy path: parses, validates, renders Keep-a-Changelog markdown', async () => {
    const intermediate = baseIntermediate();
    const structured: ChangelogRenderV1 = {
      schemaVersion: CHANGELOG_SCHEMA_VERSION,
      entries: [{ category: 'Changed', bullet: 'Update queue retry logic' }],
    };
    const handle = makeMockProvider(JSON.stringify(structured));
    const result = await renderChangelogViaLlm({
      intermediate,
      provider: handle.provider,
      promptVersion: 'changelog-v1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('### Changed');
    expect(result.output).toContain('Update queue retry logic');
    expect(result.costUsd).toBeGreaterThan(0);
  });

  test('forces tool with the right name', async () => {
    const intermediate = baseIntermediate();
    const structured: ChangelogRenderV1 = {
      schemaVersion: CHANGELOG_SCHEMA_VERSION,
      entries: [{ category: 'Added', bullet: 'x' }],
    };
    const handle = makeMockProvider(JSON.stringify(structured));
    await renderChangelogViaLlm({
      intermediate,
      provider: handle.provider,
      promptVersion: 'changelog-v1',
    });
    expect(handle.calls[0]?.output_schema_name).toBe('render_recap_changelog');
  });

  test('capability-missing short-circuits', async () => {
    const caps = { ...baseCaps(), constrained: false as const };
    const handle = makeMockProvider('{}', baseUsage(), caps);
    const result = await renderChangelogViaLlm({
      intermediate: baseIntermediate(),
      provider: handle.provider,
      promptVersion: 'changelog-v1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('capability-missing');
    expect(handle.calls).toHaveLength(0);
  });

  test('schema-violation on unknown category', async () => {
    const bad = {
      schemaVersion: CHANGELOG_SCHEMA_VERSION,
      entries: [{ category: 'Cool', bullet: 'x' }],
    };
    const handle = makeMockProvider(JSON.stringify(bad));
    const result = await renderChangelogViaLlm({
      intermediate: baseIntermediate(),
      provider: handle.provider,
      promptVersion: 'changelog-v1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('schema-violation');
  });

  test('invalid-json on garbage output', async () => {
    const handle = makeMockProvider('not-json');
    const result = await renderChangelogViaLlm({
      intermediate: baseIntermediate(),
      provider: handle.provider,
      promptVersion: 'changelog-v1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-json');
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
      const stubStructured = projectChangelogDeterministic(intermediate);
      const handle = makeMockProvider(JSON.stringify(stubStructured));
      const result = await renderChangelogViaLlm({
        intermediate,
        provider: handle.provider,
        promptVersion: 'changelog-v1',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.output.split('\n').length).toBeLessThanOrEqual(40);
    }
  });
});
