import { describe, expect, test } from 'bun:test';
import type {
  ConstrainedRequest,
  ConstrainedResult,
  Provider,
  ProviderCapabilities,
  StreamEvent,
  UsageInfo,
} from '../../src/providers/types.ts';
import { projectSlackDeterministic } from '../../src/recap/slack/deterministic.ts';
import { renderSlackViaLlm } from '../../src/recap/slack/llm.ts';
import { SLACK_SCHEMA_VERSION, type SlackRenderV1 } from '../../src/recap/slack/schema.ts';
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

describe('renderSlackViaLlm', () => {
  test('happy path: parses, validates, renders ASCII slack post', async () => {
    const intermediate = baseIntermediate();
    const structured: SlackRenderV1 = {
      schemaVersion: SLACK_SCHEMA_VERSION,
      title: 'Refactor queue',
      durationLabel: '4m32s',
      costLabel: '$0.04',
      achievements: ['Edited 1 file(s)'],
      files: ['/p/a.ts'],
      decisions: [],
    };
    const handle = makeMockProvider(JSON.stringify(structured));
    const result = await renderSlackViaLlm({
      intermediate,
      provider: handle.provider,
      promptVersion: 'slack-v1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('*Refactor queue*');
    expect(result.output).toContain('* Edited 1 file(s)');
    expect(result.output).not.toContain('✓');
  });

  test('fidelity-mismatch on hallucinated file path', async () => {
    const intermediate = baseIntermediate();
    const bad: SlackRenderV1 = {
      schemaVersion: SLACK_SCHEMA_VERSION,
      title: 'x',
      durationLabel: '1s',
      costLabel: '$0.00',
      achievements: ['a'],
      files: ['/never/seen.ts'],
      decisions: [],
    };
    const handle = makeMockProvider(JSON.stringify(bad));
    const result = await renderSlackViaLlm({
      intermediate,
      provider: handle.provider,
      promptVersion: 'slack-v1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('fidelity-mismatch');
    expect(result.detail).toContain('/never/seen.ts');
  });

  test('schema-violation rejects asterisk in title', async () => {
    const bad: SlackRenderV1 = {
      schemaVersion: SLACK_SCHEMA_VERSION,
      title: 'has *star* inside',
      durationLabel: '1s',
      costLabel: '$0.00',
      achievements: ['a'],
      files: [],
      decisions: [],
    };
    const handle = makeMockProvider(JSON.stringify(bad));
    const result = await renderSlackViaLlm({
      intermediate: baseIntermediate(),
      provider: handle.provider,
      promptVersion: 'slack-v1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('schema-violation');
  });

  test('forces tool with the right name', async () => {
    const intermediate = baseIntermediate();
    const structured: SlackRenderV1 = {
      schemaVersion: SLACK_SCHEMA_VERSION,
      title: 'x',
      durationLabel: '1s',
      costLabel: '$0',
      achievements: ['a'],
      files: [],
      decisions: [],
    };
    const handle = makeMockProvider(JSON.stringify(structured));
    await renderSlackViaLlm({
      intermediate,
      provider: handle.provider,
      promptVersion: 'slack-v1',
    });
    expect(handle.calls[0]?.output_schema_name).toBe('render_recap_slack');
  });

  test('eval gate: 5 fixtures pass schema + fidelity + concision with deterministic stub', async () => {
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
      const stubStructured = projectSlackDeterministic(intermediate);
      const handle = makeMockProvider(JSON.stringify(stubStructured));
      const result = await renderSlackViaLlm({
        intermediate,
        provider: handle.provider,
        promptVersion: 'slack-v1',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      // Concision cap (RECAP §7.4).
      expect(result.output.split('\n').length).toBeLessThanOrEqual(30);
      // Fidelity (paths in `files` must come from filesWritten).
      const written = new Set(intermediate.actions.filesWritten.map((f) => f.path));
      for (const path of result.structured.files) {
        expect(written.has(path)).toBe(true);
      }
    }
  });
});
